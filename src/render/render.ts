import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { compile, compileDigest, type CompileOptions } from "../compile/hyperframes.ts";
import { hyperframesBin } from "../core/config.ts";
import { sha256File } from "../core/hash.ts";
import { ffmpegVersion, probe } from "../core/media.ts";
import { P, type Project } from "../core/project.ts";
import type { Resolved } from "../core/timeline.ts";
import { run, runOk, VosError, writeJson } from "../core/util.ts";
import { mixAudio, muxAudio, type MixReport } from "./mix.ts";

export interface RenderOptions extends CompileOptions {
  draft?: boolean;
  output?: string;
  quiet?: boolean;
}

export interface Receipt {
  format: "vos.receipt/1";
  output: string;
  output_sha256: string;
  output_duration: number;
  timeline: { path: string; sha256: string; frames: number; fps: number };
  compile_digest: string;
  inputs: unknown;
  settings: { quality: string; fps: number; graphics_only: boolean; format: string; engine?: "hyperframes" | "ffmpeg-passthrough" };
  tools: { hyperframes: string; ffmpeg: string; node: string };
  audio: MixReport | null; // the final audio was mixed by vos (null = no audible clips / graphics-only)
  created_at: string; // informational only; excluded from any digest
}

function hfVersion(bin: string): string {
  try {
    return run(bin, ["--version"]).stdout.trim().split("\n").pop() ?? "unknown";
  } catch {
    return "unknown";
  }
}

export function lintBuild(buildDir: string): { errors: string[]; warnings: string[] } {
  const bin = hyperframesBin();
  if (!bin) throw new VosError("no_hyperframes", "HyperFrames CLI not found", "set VOS_HYPERFRAMES_BIN or run `vos doctor --write`");
  const r = run(bin, ["lint", buildDir, "--json"], { cwd: buildDir });
  try {
    const j = JSON.parse(r.stdout.slice(r.stdout.indexOf("{")));
    const f: any[] = j.findings ?? [];
    return {
      errors: f.filter((x) => x.severity === "error").map((x) => `${x.code}: ${x.message}`),
      warnings: f.filter((x) => x.severity === "warning").map((x) => `${x.code}: ${x.message}`),
    };
  } catch {
    return { errors: r.status === 0 ? [] : [r.stderr.trim() || r.stdout.trim()], warnings: [] };
  }
}

/**
 * A timeline that is just one full-frame video (plus audio) needs no browser: HyperFrames would
 * screenshot every frame and re-encode it (slow, lossy, memory-hungry on long pieces).
 * Returns the source to copy, or why the fast path does not apply.
 */
export function passthroughSource(r: Resolved, opts: { graphicsOnly?: boolean } = {}): { ok: true; path: string; srcIn: number; copy: boolean } | { ok: false; reason: string } {
  if (opts.graphicsOnly) return { ok: false, reason: "graphics-only render" };
  if (r.graphics.length) return { ok: false, reason: "timeline has graphics" };
  const muted = new Set(r.tracks.filter((t) => t.mute).map((t) => t.id));
  const pics = r.media.filter((m) => m.kind !== "audio" && !muted.has(m.track) && m.frames > 0);
  if (pics.length !== 1) return { ok: false, reason: `${pics.length} picture clips (fast path needs exactly one)` };
  const m = pics[0];
  if (m.kind !== "video") return { ok: false, reason: "the picture is a still" };
  if (m.slot) return { ok: false, reason: "the clip plays in a slot" };
  if (m.start !== 0 || m.frames !== r.frames) return { ok: false, reason: "the clip does not cover the whole timeline" };
  const fx = m.fx ?? {};
  if ((fx.opacity ?? 1) !== 1 || fx.filter || (fx.scale ?? 1) !== 1) return { ok: false, reason: "the clip has fx" };
  if (m.fade.in > 0 || m.fade.out > 0) return { ok: false, reason: "the clip fades" };
  if (!m.asset.path || !fs.existsSync(m.asset.path)) return { ok: false, reason: "the source is offline" };
  const j = JSON.parse(run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,pix_fmt,width,height,avg_frame_rate:format=duration", "-of", "json", m.asset.path]).stdout || "{}");
  const v = j.streams?.[0];
  if (!v) return { ok: false, reason: "no video stream" };
  const [n, d] = String(v.avg_frame_rate ?? "0/1").split("/").map(Number);
  if (v.width !== r.canvas.width || v.height !== r.canvas.height) return { ok: false, reason: `source is ${v.width}x${v.height}, canvas is ${r.canvas.width}x${r.canvas.height}` };
  if (!d || Math.abs(n / d - r.canvas.fps) > 0.01) return { ok: false, reason: `source is ${d ? Math.round((n / d) * 1000) / 1000 : "?"} fps, canvas is ${r.canvas.fps}` };
  const need = m.srcIn + r.frames / r.canvas.fps;
  if (!(Number(j.format?.duration) >= need - 0.5 / r.canvas.fps)) return { ok: false, reason: "the source is shorter than the clip" };
  // stream copy keeps every pixel; a non-zero in-point or an odd codec is re-encoded (still no browser)
  return { ok: true, path: m.asset.path, srcIn: m.srcIn, copy: m.srcIn === 0 && v.codec_name === "h264" && v.pix_fmt === "yuv420p" };
}

function passthroughVideo(src: { path: string; srcIn: number; copy: boolean }, seconds: number, output: string, draft: boolean): void {
  const t = String(Math.round(seconds * 1000) / 1000);
  const args = src.copy
    ? ["-v", "error", "-y", "-i", src.path, "-map", "0:v:0", "-an", "-c:v", "copy", "-t", t, "-movflags", "+faststart", output]
    : ["-v", "error", "-y", "-ss", String(src.srcIn), "-i", src.path, "-map", "0:v:0", "-an", "-t", t, "-c:v", "libx264",
       "-preset", draft ? "veryfast" : "slow", "-crf", draft ? "23" : "12", "-pix_fmt", "yuv420p", "-movflags", "+faststart", output];
  const r = run("ffmpeg", args);
  if (r.status !== 0 || !fs.existsSync(output)) throw new VosError("render_failed", `ffmpeg passthrough failed (exit ${r.status}):\n${r.stderr.trim().split("\n").slice(-8).join("\n")}`);
}

/** Heap for the HyperFrames process: Node's default (~4 GB) is exhausted by multi-minute renders. */
export function renderHeapMb(env: NodeJS.ProcessEnv = process.env, totalBytes = os.totalmem()): number {
  const want = Number(env.VOS_RENDER_HEAP_MB);
  if (Number.isFinite(want) && want > 0) return Math.round(want);
  return Math.max(4096, Math.min(16384, Math.floor(totalBytes / 2 ** 20 / 2)));
}

function withHeap(env: NodeJS.ProcessEnv, mb: number): NodeJS.ProcessEnv {
  const cur = env.NODE_OPTIONS ?? "";
  if (/--max-old-space-size/.test(cur)) return env; // an explicit setting wins
  return { ...env, NODE_OPTIONS: `${cur} --max-old-space-size=${mb}`.trim() };
}

/** Pick the lines that say why a render died; native stack frames and progress bars bury them. */
export function failureCause(log: string): { lines: string[]; oom: boolean } {
  const clean = log.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").split(/\r?\n|\r/).map((l) => l.trimEnd());
  const useful = clean.filter((l) => l.trim() && !/^\s*\d+: 0x[0-9a-f]+ /i.test(l) && !/^\s+at /.test(l) && !/[█░]/.test(l) && !/^-{3,}|^<-{3}/.test(l.trim()));
  const oom = clean.some((l) => /heap out of memory|Reached heap limit/i.test(l));
  const errs = useful.filter((l) => /fatal|error|failed|exception|stalled|killed|ENOSPC/i.test(l) && !/^\[INFO\]/.test(l));
  return { lines: (errs.length ? errs : useful).slice(-8), oom };
}

function runHyperframes(bin: string, args: string[], cwd: string, log: string, quiet: boolean): number {
  // tee stderr to a log so a failure can be explained even when the output streams to the terminal
  const script = 'set -o pipefail; { "$@" 2>&1 1>&3 3>&- | tee "$VOS_HF_LOG" 1>&2; } 3>&1';
  const r = run("/bin/bash", ["-c", script, "vos-hyperframes", bin, ...args], {
    cwd,
    env: withHeap({ ...process.env, VOS_HF_LOG: log }, renderHeapMb()),
    stdio: quiet ? "pipe" : ["ignore", "inherit", "inherit"],
  });
  return r.status;
}

export function render(p: Project, opts: RenderOptions = {}): { output: string; receipt: Receipt; receiptPath: string; lintWarnings: string[]; engine: "hyperframes" | "ffmpeg-passthrough" } {
  const bin = hyperframesBin();
  if (!bin) throw new VosError("no_hyperframes", "HyperFrames CLI not found", "set VOS_HYPERFRAMES_BIN or run `vos doctor --write`");
  const c = compile(p, opts);
  const lint = lintBuild(c.buildDir);
  // "composition_file_too_large" etc. are authoring advice for hand-written pages, not for generated ones.
  const blocking = lint.errors;
  if (blocking.length) throw new VosError("lint_failed", `HyperFrames lint rejected the compiled page:\n- ${blocking.join("\n- ")}`, "fix the timeline/graphics; the compiled page is generated");

  const fps = c.resolved.canvas.fps;
  const format = opts.graphicsOnly ? "mov" : "mp4";
  const digest = compileDigest(c).slice(0, 10);
  const outDir = P.out(p.root);
  fs.mkdirSync(outDir, { recursive: true });
  const output = path.resolve(opts.output ?? path.join(outDir, `${c.resolved.name}${opts.graphicsOnly ? ".overlay" : ""}${opts.draft ? ".draft" : ""}.${digest}.${format}`));
  const quality = opts.draft ? "draft" : "high";
  const fast = process.env.VOS_RENDER_ENGINE === "hyperframes" ? ({ ok: false, reason: "VOS_RENDER_ENGINE=hyperframes" } as const) : passthroughSource(c.resolved, opts);
  const engine = fast.ok ? "ffmpeg-passthrough" : "hyperframes";
  if (fast.ok) {
    if (!opts.quiet) console.error(`vos: single full-frame video — ${fast.copy ? "copying the picture as is" : "re-encoding the picture"} with ffmpeg (no browser render)`);
    passthroughVideo(fast, c.resolved.frames / fps, output, !!opts.draft);
  } else {
    const args = ["render", c.buildDir, "-q", quality, "-f", String(fps), "-o", output];
    if (opts.graphicsOnly) args.push("--format", "mov");
    if (!opts.draft) args.push("--video-frame-format", "png");
    const log = path.join(c.buildDir, "render.log");
    const status = runHyperframes(bin, args, c.buildDir, log, !!opts.quiet);
    if (status !== 0 || !fs.existsSync(output)) {
      const why = failureCause(fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "");
      const heap = renderHeapMb();
      throw new VosError(
        "render_failed",
        `HyperFrames render failed (exit ${status})${why.oom ? ` — out of JavaScript heap (${heap} MB)` : ""}${why.lines.length ? ":\n" + why.lines.join("\n") : ""}`,
        `${why.oom ? `raise it with VOS_RENDER_HEAP_MB=${Math.min(heap * 2, 32768)}; ` : ""}full log: ${log}`,
      );
    }
  }
  let audio: MixReport | null = null;
  if (!opts.graphicsOnly) {
    const tmp = fs.mkdtempSync(path.join(c.buildDir, "mix-"));
    const wav = path.join(tmp, "mix.wav");
    audio = mixAudio(c.resolved, wav, tmp);
    if (audio) {
      const muxed = path.join(tmp, `muxed.${format}`);
      muxAudio(output, wav, muxed, c.resolved.frames / fps);
      fs.renameSync(muxed, output);
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const pr = probe(output);
  const receipt: Receipt = {
    format: "vos.receipt/1",
    output: path.relative(p.root, output),
    output_sha256: sha256File(output),
    output_duration: pr.duration ?? 0,
    timeline: { path: c.inputs.timeline.path, sha256: c.inputs.timeline.sha256, frames: c.resolved.frames, fps },
    compile_digest: compileDigest(c),
    inputs: c.inputs,
    settings: { quality, fps, graphics_only: !!opts.graphicsOnly, format, engine },
    tools: { hyperframes: hfVersion(bin), ffmpeg: ffmpegVersion(), node: process.version },
    audio,
    created_at: new Date().toISOString(),
  };
  const receiptPath = output.replace(/\.(mp4|mov)$/, ".receipt.json");
  writeJson(receiptPath, receipt);
  return { output, receipt, receiptPath, lintWarnings: lint.warnings, engine };
}

export function latestRender(p: Project, kind: "mp4" | "mov" = "mp4"): string | null {
  const dir = P.out(p.root);
  if (!fs.existsSync(dir)) return null;
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(`.${kind}`) && fs.existsSync(path.join(dir, f.replace(/\.(mp4|mov)$/, ".receipt.json"))))
    .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return files.length ? path.join(dir, files[0].f) : null;
}

export { runOk };
