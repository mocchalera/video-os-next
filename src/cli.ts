#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { analyzeBeats } from "./analyze/beats.ts";
import { describe, findInAsset, readDescribe, searchDescriptions } from "./analyze/marlin.ts";
import { compile, compileDigest } from "./compile/hyperframes.ts";
import { CONFIG_PATH, hyperframesBin, loadConfig, marlinPython, saveConfig } from "./core/config.ts";
import { importVos2Analysis } from "./core/import-vos2.ts";
import { ffmpegVersion, probe } from "./core/media.ts";
import { ingest, initProject, loadProject, P, requireOnline, resolveAsset, saveAssets, type Project } from "./core/project.ts";
import { status } from "./core/status.ts";
import { parseTime } from "./core/time.ts";
import { loadTimeline, resolveTimeline, timelinePath } from "./core/timeline.ts";
import { readJson, which, VosError, writeJson } from "./core/util.ts";
import { exportFcp7 } from "./export/fcp7.ts";
import { inspect } from "./inspect/inspect.ts";
import { evenTimes, look } from "./inspect/look.ts";
import { latestRender, render } from "./render/render.ts";

const HELP = `vos — a video editing toolbox for capable agents (video-os-next v0.1)

memory   vos init <dir> [--name n] [--fps 30 --width 1920 --height 1080]
         vos ingest <files…> [--as alias] [--note text] [--replace]
         vos status
eyes     vos look <alias|file|render> (--at 1,2.5 | --every 2 | --count 12) [--width 480] [--out f.png]
         vos describe <alias>                       Marlin-2B scene + events (local)
         vos find "<query>" [--asset alias]          search descriptions; with --asset runs Marlin find
ears     vos beats <alias> [--hint 120]
hands    vos compile [--timeline f]                  timeline + graphics → HyperFrames page
         vos render [--draft] [--graphics-only] [--out f]
verify   vos inspect [render.mp4]                    evidence: findings with times + frame sheets
return   vos export fcp7 [--overlay f.mov] [--out f.xml]
migrate  vos import vos2 <v2-project-dir>            attach v2 Marlin analysis to ingested assets
setup    vos doctor [--write]

global   --project <dir>   --json`;

interface Args {
  _: string[];
  [k: string]: any;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith("--")) {
      const k = t.slice(2);
      const nxt = argv[i + 1];
      if (nxt === undefined || nxt.startsWith("--")) a[k] = true;
      else {
        a[k] = nxt;
        i++;
      }
    } else a._.push(t);
  }
  return a;
}

let JSON_OUT = false;
function out(data: unknown, human?: () => void) {
  if (JSON_OUT || !human) console.log(JSON.stringify(data, null, 2));
  else human();
}

function proj(a: Args): Project {
  return loadProject(a.project);
}

function timesFrom(a: Args, duration: number | null): number[] {
  if (a.at) return String(a.at).split(",").map(Number).filter(Number.isFinite);
  if (!duration) return [0];
  if (a.every) {
    const e = Number(a.every);
    const ts: number[] = [];
    for (let t = e / 2; t < duration; t += e) ts.push(Math.round(t * 1000) / 1000);
    return ts;
  }
  return evenTimes(duration, Number(a.count ?? 12));
}

function resolveMediaTarget(p: Project, target: string): { file: string; duration: number | null } {
  if (target === "render" || target === "latest") {
    const f = latestRender(p);
    if (!f) throw new VosError("no_render", "no render yet", "run `vos render --draft`");
    return { file: f, duration: probe(f).duration };
  }
  if (fs.existsSync(target)) return { file: path.resolve(target), duration: probe(target).duration };
  const a = resolveAsset(p, target);
  return { file: requireOnline(a), duration: a.duration };
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  JSON_OUT = !!a.json;
  const [cmd, ...rest] = a._;
  switch (cmd) {
    case undefined:
    case "help":
      console.log(HELP);
      return;

    case "init": {
      const dir = path.resolve(rest[0] ?? ".");
      const p = initProject(dir, a.name ?? path.basename(dir), { width: Number(a.width ?? 1920), height: Number(a.height ?? 1080), fps: Number(a.fps ?? 30) });
      out({ ok: true, root: p.root }, () => console.log(`initialized ${p.root}`));
      return;
    }

    case "ingest": {
      const p = proj(a);
      if (a.as && rest.length !== 1) throw new VosError("usage", "--as needs exactly one file");
      const results = rest.map((f) => ingest(p, f, a.as, a.note, !!a.replace));
      saveAssets(p);
      out(results, () => results.forEach((r) => console.log(`${r.status.padEnd(9)} ${r.alias.padEnd(28)} ${r.id}${r.duplicate_of ? `  ⚠ identical to ${r.duplicate_of}` : ""}`)));
      return;
    }

    case "status": {
      const s = status(proj(a));
      out(s, () => {
        console.log(`${s.project.name}  ${s.project.canvas.width}x${s.project.canvas.height}@${s.project.canvas.fps}`);
        console.log(`assets    ${s.assets.total} (${Object.entries(s.assets.by_kind).map(([k, v]) => `${v} ${k}`).join(", ")}); described ${s.assets.described}; offline ${s.assets.offline.length}`);
        console.log(`timeline  ${s.timeline.ok ? `ok  ${s.timeline.duration}s  ${s.timeline.clips} media clips, ${s.timeline.graphics} graphics` : `NOT OK  ${s.timeline.error ?? ""}`}`);
        console.log(`render    ${s.render.latest ?? "none"}${s.render.stale ? "  (STALE)" : ""}${s.render.latest ? (s.render.inspected ? "  inspected" : "  not inspected") : ""}`);
        if (s.attention.length) console.log("\nattention\n" + s.attention.map((x) => `  • ${x}`).join("\n"));
      });
      return;
    }

    case "look": {
      const p = proj(a);
      const { file, duration } = resolveMediaTarget(p, rest[0] ?? "render");
      const r = look(p, file, { times: timesFrom(a, duration), width: a.width ? Number(a.width) : undefined, columns: a.cols ? Number(a.cols) : undefined, out: a.out, fps: p.file.canvas.fps, keepFrames: !!a.frames });
      out(r, () => console.log(r.sheet));
      return;
    }

    case "describe": {
      const p = proj(a);
      const rec = a.cached ? readDescribe(p, resolveAsset(p, rest[0]).id) : describe(p, rest[0]);
      out(rec, () => {
        if (!rec) return console.log("no description yet");
        console.log(rec.scene + "\n");
        rec.events.forEach((e) => console.log(`  ${e.start.toFixed(1)}–${e.end.toFixed(1)}s  ${e.description}`));
        console.log(`\n(${rec.provenance.producer} · ${rec.provenance.model})`);
      });
      return;
    }

    case "find": {
      const p = proj(a);
      const q = rest.join(" ");
      if (a.asset) {
        const hit = findInAsset(p, a.asset, q);
        out({ asset: a.asset, query: q, ...hit }, () => console.log(`${a.asset}  ${hit.start}–${hit.end}s`));
      } else {
        const hits = searchDescriptions(p, q, Number(a.limit ?? 10));
        out(hits, () => hits.forEach((h) => console.log(`${h.score.toFixed(2)}  ${h.alias}  ${h.start.toFixed(1)}–${h.end.toFixed(1)}s  ${h.text}`)));
      }
      return;
    }

    case "beats": {
      const p = proj(a);
      const asset = resolveAsset(p, rest[0]);
      const r = analyzeBeats(requireOnline(asset), { hint: a.hint ? Number(a.hint) : undefined });
      writeJson(path.join(P.analysis(p.root, asset.id), "beats.json"), { ...r, asset: asset.id });
      out({ ...r, beats: `${r.beats.length} beats` }, () => console.log(`${asset.alias}: ${r.bpm} BPM, offset ${r.offset}s, confidence ${r.confidence}`));
      return;
    }

    case "compile": {
      const p = proj(a);
      const c = compile(p, { timeline: a.timeline, graphicsOnly: !!a["graphics-only"] });
      out({ build: c.buildDir, digest: compileDigest(c), frames: c.resolved.frames, warnings: c.resolved.warnings, assets: c.inputs.assets }, () => {
        console.log(`compiled → ${path.relative(p.root, c.buildDir)}/index.html  (digest ${compileDigest(c).slice(0, 12)})`);
        c.resolved.warnings.forEach((w) => console.log(`  warn: ${w}`));
      });
      return;
    }

    case "render": {
      const p = proj(a);
      const r = render(p, { timeline: a.timeline, draft: !!a.draft, graphicsOnly: !!a["graphics-only"], output: a.out, quiet: JSON_OUT });
      out({ output: r.output, receipt: r.receiptPath, lint_warnings: r.lintWarnings }, () => console.log(`\n${r.output}\nreceipt ${r.receiptPath}`));
      return;
    }

    case "inspect": {
      const p = proj(a);
      const file = rest[0] ? path.resolve(rest[0]) : latestRender(p);
      if (!file) throw new VosError("no_render", "nothing to inspect", "run `vos render --draft` first");
      const rc = fs.existsSync(file.replace(/\.(mp4|mov)$/, ".receipt.json")) ? readJson(file.replace(/\.(mp4|mov)$/, ".receipt.json")) : null;
      const resolved = resolveTimeline(p, loadTimeline(path.resolve(p.root, rc?.timeline?.path ?? "timeline.json")));
      const rep = inspect(p, file, resolved, { loudnessTarget: a.lufs ? Number(a.lufs) : undefined });
      out(rep, () => {
        console.log(`${rep.render}${rep.stale ? "  (STALE)" : ""}`);
        console.log(`measurements ${JSON.stringify(rep.measurements)}`);
        for (const f of rep.findings) console.log(`  ${f.severity.padEnd(5)} ${f.check.padEnd(10)} ${f.at !== undefined ? `@${f.at}s${f.until !== undefined ? `–${f.until}s` : ""}  ` : ""}${f.message}`);
        console.log(`sheets\n  ${rep.sheets.cuts ?? "(no cuts)"}\n  ${rep.sheets.overview}`);
      });
      return;
    }

    case "export": {
      const p = proj(a);
      const fmt = rest[0] ?? "fcp7";
      if (fmt !== "fcp7") throw new VosError("usage", `unknown export format ${fmt}`, "supported: fcp7");
      const r = resolveTimeline(p, loadTimeline(timelinePath(p, a.timeline)));
      const overlay = a.overlay ? path.resolve(a.overlay) : latestRender(p, "mov");
      const xml = exportFcp7(p, r, { overlay });
      const file = path.resolve(a.out ?? path.join(P.out(p.root), `${r.name}.fcp7.xml`));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, xml);
      out({ output: file, overlay }, () => console.log(`${file}${overlay ? `\n  + overlay ${overlay}` : "\n  (no graphics overlay; run `vos render --graphics-only` to include one)"}`));
      return;
    }

    case "import": {
      if (rest[0] !== "vos2") throw new VosError("usage", "vos import vos2 <v2-project-dir>");
      const p = proj(a);
      const r = importVos2Analysis(p, path.resolve(rest[1]));
      out(r, () => {
        console.log(`imported: ${r.imported.join(", ") || "none"}`);
        r.skipped.forEach((s) => console.log(`  skipped ${path.basename(s.source ?? "?")}: ${s.reason}`));
      });
      return;
    }

    case "doctor": {
      const cfg = loadConfig();
      const hf = hyperframesBin();
      let py = marlinPython();
      const found: Record<string, string> = {};
      if (!hf) {
        const guess = [path.join(process.env.HOME ?? "", "Dev")].flatMap((d) => (fs.existsSync(d) ? fs.readdirSync(d).map((x) => path.join(d, x, "node_modules", ".bin", "hyperframes")) : [])).find((x) => fs.existsSync(x));
        if (guess) found.hyperframes_bin = guess;
      }
      if (!py) {
        const guess = [path.join(process.env.HOME ?? "", "Dev")].flatMap((d) => (fs.existsSync(d) ? fs.readdirSync(d).map((x) => path.join(d, x, "python", ".venv-marlin", "bin", "python3")) : [])).find((x) => fs.existsSync(x));
        if (guess) found.marlin_python = guess;
      }
      if (a.write && Object.keys(found).length) {
        saveConfig({ ...cfg, ...found });
        py = marlinPython();
      }
      const report = {
        node: process.version,
        ffmpeg: which("ffmpeg") ? ffmpegVersion() : null,
        ffprobe: !!which("ffprobe"),
        hyperframes: hyperframesBin(),
        marlin_python: marlinPython(),
        marlin_snapshot: fs.existsSync(path.join(process.env.HOME ?? "", ".cache/huggingface/hub/models--NemoStation--Marlin-2B")),
        config: CONFIG_PATH,
        discovered: found,
        written: !!a.write && Object.keys(found).length > 0,
      };
      out(report, () => {
        for (const [k, v] of Object.entries(report)) console.log(`${k.padEnd(16)} ${typeof v === "object" ? JSON.stringify(v) : v}`);
        if (Object.keys(found).length && !a.write) console.log("\nrun `vos doctor --write` to save discovered tools");
      });
      return;
    }

    case "time": {
      // tiny helper: vos time 16b --bpm 120
      const v = parseTime(rest[0], { fps: Number(a.fps ?? 30), grid: a.bpm ? { bpm: Number(a.bpm), offset: Number(a.offset ?? 0) } : undefined }, a.length ? "length" : "position");
      out({ seconds: v }, () => console.log(v));
      return;
    }

    default:
      throw new VosError("usage", `unknown command "${cmd}"`, "run `vos help`");
  }
}

main().catch((e: any) => {
  if (JSON_OUT) console.log(JSON.stringify({ ok: false, error: { code: e.code ?? "error", message: e.message, hint: e.hint } }, null, 2));
  else {
    console.error(`vos: ${e.message}`);
    if (e.hint) console.error(`hint: ${e.hint}`);
    if (!e.code) console.error(e.stack);
  }
  process.exit(1);
});
