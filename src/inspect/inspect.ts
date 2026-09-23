import * as fs from "node:fs";
import * as path from "node:path";
import { sha256File } from "../core/hash.ts";
import { probe } from "../core/media.ts";
import type { Project } from "../core/project.ts";
import { framesToSeconds } from "../core/time.ts";
import { cutPoints, type Resolved } from "../core/timeline.ts";
import { readJson, round, run, writeJson } from "../core/util.ts";
import { look } from "./look.ts";

export type Severity = "error" | "warn" | "info";

export interface Finding {
  check: string;
  severity: Severity;
  at?: number; // seconds
  until?: number;
  message: string;
  data?: Record<string, unknown>;
}

export interface InspectReport {
  format: "vos.inspect/1";
  render: string;
  timeline_sha256: string | null;
  stale: boolean;
  measurements: Record<string, unknown>;
  findings: Finding[];
  sheets: { cuts?: string; overview?: string };
}

function ranges(stderr: string, startKey: string, endKey: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let cur: number | null = null;
  for (const line of stderr.split("\n")) {
    const s = new RegExp(`${startKey}[:=]\\s*([\\d.]+)`).exec(line);
    if (s) cur = Number(s[1]);
    const e = new RegExp(`${endKey}[:=]\\s*([\\d.]+)`).exec(line);
    if (e && cur !== null) {
      out.push({ start: cur, end: Number(e[1]) });
      cur = null;
    }
  }
  return out;
}

function overlapsMarker(r: Resolved, kind: string, a: number, b: number): boolean {
  const fps = r.canvas.fps;
  return r.markers.some((m) => {
    if (m.kind !== kind) return false;
    const ms = framesToSeconds(m.frame, fps);
    const me = framesToSeconds(m.frame + Math.max(m.frames, 1), fps);
    return a < me + 0.05 && b > ms - 0.05;
  });
}

export interface InspectOptions {
  loudnessTarget?: number; // LUFS
  sheetEvery?: number; // seconds for overview sheet
}

/** Evidence, not a score. Every finding carries a time so the agent can `look` at it. */
export function inspect(p: Project, renderPath: string, resolved: Resolved, opts: InspectOptions = {}): InspectReport {
  const fps = resolved.canvas.fps;
  const findings: Finding[] = [];
  const meas: Record<string, unknown> = {};
  const receiptPath = renderPath.replace(/\.(mp4|mov)$/, ".receipt.json");
  const receipt = fs.existsSync(receiptPath) ? readJson(receiptPath) : null;

  // --- staleness: is this render from the current timeline? ---
  const tlFile = path.resolve(p.root, receipt?.timeline?.path ?? "timeline.json");
  const currentSha = fs.existsSync(tlFile) ? sha256File(tlFile) : null;
  const changedAssets = receipt ? Object.entries(receipt.inputs?.assets ?? {}).filter(([alias, a]: [string, any]) => p.assets.assets[alias] && p.assets.assets[alias].id !== a.id).map(([alias]) => alias) : [];
  if (changedAssets.length) findings.push({ check: "provenance", severity: "warn", message: `render used content that has since been replaced: ${changedAssets.join(", ")}` });
  const stale = !!receipt && (receipt.timeline.sha256 !== currentSha || changedAssets.length > 0);
  if (!receipt) findings.push({ check: "provenance", severity: "warn", message: "no receipt next to this render; provenance unknown" });
  if (stale) findings.push({ check: "provenance", severity: "warn", message: "render is STALE: timeline.json changed since this render", data: { render_timeline: receipt.timeline.sha256.slice(0, 12), current: currentSha?.slice(0, 12) } });

  // --- duration parity ---
  const pr = probe(renderPath);
  const expected = framesToSeconds(resolved.frames, fps);
  meas.duration = { expected, actual: pr.duration };
  if (pr.duration != null && Math.abs(pr.duration - expected) > 1.5 / fps + 0.02) {
    findings.push({ check: "duration", severity: "error", message: `render is ${pr.duration.toFixed(3)}s, timeline is ${expected.toFixed(3)}s` });
  }

  // --- loudness ---
  if (pr.has_audio) {
    const r = run("ffmpeg", ["-hide_banner", "-nostats", "-i", renderPath, "-af", "ebur128=peak=true", "-f", "null", "-"]);
    const I = /I:\s+(-?[\d.]+) LUFS/.exec(r.stderr.split("Summary:").pop() ?? "");
    const TP = /Peak:\s+(-?[\d.]+) dBFS/.exec(r.stderr.split("True peak:").pop() ?? "");
    const lufs = I ? Number(I[1]) : null;
    const tp = TP ? Number(TP[1]) : null;
    meas.loudness = { integrated_lufs: lufs, true_peak_dbfs: tp };
    const target = opts.loudnessTarget ?? -14;
    if (lufs != null && Math.abs(lufs - target) > 1.5) findings.push({ check: "loudness", severity: "warn", message: `integrated ${lufs} LUFS vs target ${target}` });
    if (tp != null && tp > -1) findings.push({ check: "loudness", severity: "warn", message: `true peak ${tp} dBFS exceeds -1 dBTP` });
    // silence gaps
    const s = run("ffmpeg", ["-hide_banner", "-nostats", "-i", renderPath, "-af", "silencedetect=n=-55dB:d=0.5", "-f", "null", "-"]);
    for (const g of ranges(s.stderr, "silence_start", "silence_end")) {
      if (g.end - g.start < expected - 0.1) findings.push({ check: "silence", severity: "info", at: round(g.start), until: round(g.end), message: `silence ${(g.end - g.start).toFixed(2)}s` });
    }
  } else {
    findings.push({ check: "audio", severity: resolved.media.some((m) => m.kind === "audio") ? "error" : "info", message: "render has no audio stream" });
  }

  // --- black / white frames ---
  const black = run("ffmpeg", ["-hide_banner", "-nostats", "-i", renderPath, "-vf", "blackdetect=d=0.1:pix_th=0.08", "-an", "-f", "null", "-"]);
  for (const b of ranges(black.stderr, "black_start", "black_end")) {
    const expectedBlack = overlapsMarker(resolved, "expect-black", b.start, b.end);
    findings.push({ check: "black", severity: expectedBlack ? "info" : "warn", at: round(b.start), until: round(b.end), message: `black ${(b.end - b.start).toFixed(2)}s${expectedBlack ? " (declared)" : ""}` });
  }
  const white = run("ffmpeg", ["-hide_banner", "-nostats", "-i", renderPath, "-vf", "negate,blackdetect=d=0.03:pix_th=0.12", "-an", "-f", "null", "-"]);
  for (const w of ranges(white.stderr, "black_start", "black_end")) {
    const declared = overlapsMarker(resolved, "expect-flash", w.start, w.end);
    findings.push({ check: "white", severity: declared ? "info" : "warn", at: round(w.start), until: round(w.end), message: `near-white frame(s) ${(w.end - w.start).toFixed(2)}s${declared ? " (declared)" : ""}` });
  }

  // --- freezes during full-frame video clips: likely a media playback failure ---
  const fr = run("ffmpeg", ["-hide_banner", "-nostats", "-i", renderPath, "-vf", "freezedetect=n=0.002:d=0.6", "-an", "-f", "null", "-"]);
  for (const z of ranges(fr.stderr, "freeze_start", "freeze_end")) {
    const clips = resolved.media.filter((m) => m.kind === "video" && !m.slot && framesToSeconds(m.start, fps) < z.end - 0.1 && framesToSeconds(m.start + m.frames, fps) > z.start + 0.1);
    const declared = overlapsMarker(resolved, "expect-still", z.start, z.end);
    findings.push({
      check: "freeze",
      severity: clips.length && !declared ? "error" : "info",
      at: round(z.start),
      until: round(z.end),
      message: clips.length ? `picture frozen ${(z.end - z.start).toFixed(2)}s during video clip(s) ${clips.map((c) => c.id).join(", ")} — check media playback` : `static picture ${(z.end - z.start).toFixed(2)}s`,
    });
  }

  // --- cuts on grid ---
  const cuts = cutPoints(resolved);
  if (resolved.grid) {
    const spbF = (60 / resolved.grid.bpm) * fps;
    const off = resolved.grid.offset * fps;
    const offGrid = cuts
      .map((f) => {
        const k = Math.round((f - off) / spbF);
        const d = f - (off + k * spbF);
        return { f, d: round(d, 2) };
      })
      .filter((x) => Math.abs(x.d) > 1.01);
    meas.cuts = { count: cuts.length, off_grid: offGrid.length };
    for (const x of offGrid) findings.push({ check: "grid", severity: "info", at: framesToSeconds(x.f, fps), message: `cut ${x.d > 0 ? "+" : ""}${x.d} frames from nearest beat` });
  }

  // --- evidence sheets: every cut (+2 frames) and an even overview ---
  const sheets: InspectReport["sheets"] = {};
  const base = renderPath.replace(/\.(mp4|mov)$/, "");
  if (cuts.length) {
    const ts = cuts.map((f) => framesToSeconds(f + 2, fps));
    sheets.cuts = look(p, renderPath, { times: ts, width: 360, columns: 6, fps, out: `${base}.inspect.cuts.png` }).sheet;
  }
  const every = opts.sheetEvery ?? Math.max(1, Math.round(expected / 24));
  const ov: number[] = [];
  for (let t = every / 2; t < expected; t += every) ov.push(round(t, 3));
  sheets.overview = look(p, renderPath, { times: ov, width: 360, columns: 6, fps, out: `${base}.inspect.overview.png` }).sheet;

  const order: Record<Severity, number> = { error: 0, warn: 1, info: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity] || (a.at ?? 0) - (b.at ?? 0));
  const report: InspectReport = {
    format: "vos.inspect/1",
    render: path.relative(p.root, renderPath),
    timeline_sha256: receipt?.timeline?.sha256 ?? null,
    stale,
    measurements: meas,
    findings,
    sheets,
  };
  writeJson(`${base}.inspect.json`, report, false);
  return report;
}

