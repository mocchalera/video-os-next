#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { analyzeBeats } from "./analyze/beats.ts";
import { describe, describeMany, describeRemote, findInAsset, readDescribe } from "./analyze/marlin.ts";
import { CHANNELS, find as findAll, indexChannel, modelStatus, pullModel, type Channel } from "./analyze/embed.ts";
import { compile, compileDigest } from "./compile/hyperframes.ts";
import { CONFIG_PATH, hyperframesBin, loadConfig, marlinPython, saveConfig } from "./core/config.ts";
import { importVos2Analysis } from "./core/import-vos2.ts";
import { ffmpegVersion, probe } from "./core/media.ts";
import { ingest, initProject, loadProject, P, requireOnline, resolveAsset, saveAssets, type Project } from "./core/project.ts";
import { status } from "./core/status.ts";
import * as gen from "./gen/colab.ts";
import * as remote from "./remote/analysis.ts";
import { initLibrary, listLibrary } from "./gen/library.ts";
import { renderPreviz } from "./gen/previz.ts";
import { readTranscript, transcribe } from "./analyze/transcribe.ts";
import { alignLyrics, parseSheet } from "./lyrics/align.ts";
import { lyricFonts } from "./lyrics/fonts.ts";
import { lyricPlans, writeMarkers } from "./lyrics/plan.ts";
import { lockLyrics } from "./lyrics/lock.ts";
import { parseTime } from "./core/time.ts";
import { loadTimeline, resolveTimeline, timelinePath } from "./core/timeline.ts";
import { readJson, which, VosError, writeJson } from "./core/util.ts";
import { exportFcp7 } from "./export/fcp7.ts";
import { inspect } from "./inspect/inspect.ts";
import { evenTimes, look } from "./inspect/look.ts";
import { latestRender, render } from "./render/render.ts";
import { judgeCommand } from "./judge/cli.ts";

const HELP = `vos — a video editing toolbox for capable agents (video-os-next v0.1)

memory   vos init <dir> [--name n] [--fps 30 --width 1920 --height 1080]
         vos ingest <files…> [--as alias] [--note text] [--replace]
         vos status
eyes     vos look <alias|file|render> (--at 1,2.5 | --every 2 | --count 12) [--width 480] [--out f.png]
         vos describe <alias…> | --all [--force] [--on colab]   Marlin-2B scene + events (local by default; one model load)
         vos index [aliases…] [--channels text,visual,audio] [--step 1] [--force] [--verbose] [--on colab]   one model load per channel (--on colab: visual on the VM)
         vos find "<query>" [--channels …] [--image f.jpg] [--limit 10] [--on colab]   fused text/visual/audio + lexical search
         vos find "<event>" --asset alias           Marlin temporal find inside one clip
         vos models [pull <visual|audio>]           embedding models: status / download (network)
judge    vos judge pool|score|report|rubric|doctor   rank candidate spans per use + in/out with evidence (d1 PoC; vos judge help)
ears     vos beats <alias> [--hint 120]
         vos transcribe <alias…> [--model small] [--lang ja] [--vocab "紙の船, 路地"] [--singing] [--force]   speech → segments + word times (local faster-whisper; --singing: sung vocals over music)
make     vos gen up --budget-cu N [--model minimax-h3|fasth3-omni] [--max-hours 2] [--lease-min 20] [--wait] [--light --gpu T4]   rent a guarded Colab GPU (costs money: ask the human for N)
         vos gen clip --prompt "…"|--prompt-file f.txt [--model minimax-h3|fasth3-omni] [--from alias@sec] [--to alias@sec] [--refs a@s,b] [--guides a@s=t,…] [--ref-size match|max] [--quality turbo|full] [--control depth_alias [--control-strength 1] [--control-end 1]] [--seconds 5] [--size 768p|draft|WxH] [--seed 1] [--dense] [--as alias]
         fasth3-omni: 1–9 image refs; frame/audio guides and ControlNet are not enabled
         vos previz render <scene.py> [--as name] [--seconds 5] [--size 768p]   Blender layout → beauty + depth passes (for --control)
         vos gen status | down                      MiniMax-H3 text/image→video+audio; cached per request; ingested with provenance
         vos gen upscale [--dry-run] [--model realesrgan-x2|x4] [--only a,b]   finishing pass: upscale the generated clips the timeline uses
         vos gen library [--search words] [--init <dir>] · vos gen pull <id> [--as alias]   shared takes (e.g. Google Drive)
offload  vos remote up --budget-cu N [--profile marlin|visual|marlin,visual] [--gpu L4] [--max-hours 2] [--wait]   guarded analysis VM (costs money: ask the human for N)
         vos remote status | down                   then \`vos describe --all --on colab\` / \`vos index --channels visual --on colab\`; results carry where they ran
lyrics   vos lyrics time <sheet.txt> --from <alias> [--out data/lyrics.json]   lyric sheet + transcript word times → timed lines (after \`vos transcribe <alias> --singing\`)
         vos lyrics plan [--clip id] [--markers write]   cut plan of the lyric-motion clips (timeline seconds, parts, キメ) without rendering; flash / black markers
         vos lyrics fonts [--download] [--check]   JIZURA's faces subset to the lyrics → design/jizura-fonts.css ("fonts": "jizura"); reports missing glyphs
         vos lyrics lock [--lines 0,2-5|all] [--except 3] [--clip id]   keep what those lines show now while others change (stored in the lyric data)
         vos lyrics unlock [--lines …] [--clip id]   let them be replanned again
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

/** Where an analysis runs: local (default) or colab (the `vos remote` session). */
function onOf(a: Args): "local" | "colab" {
  const on = a.on === undefined ? "local" : String(a.on);
  if (on !== "local" && on !== "colab") throw new VosError("usage", `--on ${on}: use local (default) or colab`);
  return on;
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
        console.log(`search    ${Object.entries(s.search).map(([k, v]) => `${k} ${v.model ? `${v.indexed}/${s.assets.total} indexed` : "no model"}`).join(" · ")}`);
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
      if (onOf(a) === "colab") {
        const targets = a.all ? Object.entries(p.assets.assets).filter(([, x]) => x.kind === "video").map(([al]) => al) : rest;
        if (!targets.length) throw new VosError("usage", "vos describe <alias…> | --all --on colab");
        const res = describeRemote(p, targets, { session: a.session, force: !!a.force, timeoutSec: a.timeout ? Number(a.timeout) : undefined });
        out(res, () => res.forEach((r) => console.log(`${r.status === "failed" ? "FAILED   " : r.status === "fresh" ? "fresh    " : "described"} ${r.alias}${r.error ? "  " + r.error : ""}`)));
        return;
      }
      if (rest.length > 1 || a.all) {
        const targets = a.all ? Object.entries(p.assets.assets).filter(([al, x]) => x.kind === "video" && (a.force || !readDescribe(p, x.id))).map(([al]) => al) : rest;
        const res = describeMany(p, targets);
        out(res, () => res.forEach((r) => console.log(`${r.ok ? "described" : "FAILED   "} ${r.alias}${r.error ? "  " + r.error : ""}`)));
        return;
      }
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
        return;
      }
      const channels = a.channels ? (String(a.channels).split(",") as Channel[]) : undefined;
      const r = findAll(p, q, { channels, limit: Number(a.limit ?? 10), image: a.image, on: onOf(a), session: a.session });
      out(r, () => {
        console.log(`channels: ${r.channels_used.join(", ") || "none"}${r.channels_unavailable.length ? `   (unavailable: ${r.channels_unavailable.map((u) => `${u.channel} — ${u.reason}`).join("; ")})` : ""}`);
        for (const h of r.hits) {
          const ch = Object.entries(h.channels).map(([k, v]) => `${k} ${v}`).join(" · ");
          console.log(`${h.score.toFixed(2).padStart(6)}  ${h.alias}  ${h.start.toFixed(1)}–${h.end.toFixed(1)}s  [${ch}]${h.text ? "  " + h.text.slice(0, 90) : ""}`);
        }
      });
      return;
    }

    case "index": {
      const p = proj(a);
      const channels = a.channels ? (String(a.channels).split(",") as Channel[]) : CHANNELS;
      const aliases = rest.length ? rest : Object.keys(p.assets.assets);
      const results = [];
      for (const ch of channels) {
        try {
          // --on colab moves the visual channel to the analysis VM; text (tiny ONNX) and audio stay here
          const on = onOf(a) === "colab" && ch === "visual" ? "colab" : "local";
          for (const r of indexChannel(p, aliases, ch, { step: a.step ? Number(a.step) : undefined, force: !!a.force, on, session: a.session, timeoutSec: a.timeout ? Number(a.timeout) : undefined })) {
            results.push(r);
            if (!JSON_OUT && (r.status !== "skipped" || a.verbose)) console.log(`${ch.padEnd(6)} ${r.status.padEnd(7)} ${r.alias}${r.windows ? `  (${r.windows} windows)` : ""}${r.reason ? `  — ${r.reason}` : ""}`);
          }
          const sk = results.filter((r) => r.channel === ch && r.status === "skipped").length;
          if (!JSON_OUT && sk && !a.verbose) console.log(`${ch.padEnd(6)} skipped ${sk} asset(s) (--verbose for reasons)`);
        } catch (e: any) {
          if (e.code !== "model_missing") throw e;
          results.push({ alias: "*", channel: ch, status: "skipped", reason: e.message });
          if (!JSON_OUT) console.log(`${ch.padEnd(6)} skipped (all) — ${e.message}\n       hint: ${e.hint}`);
        }
      }
      if (JSON_OUT) out(results);
      return;
    }

    case "previz": {
      if (rest[0] !== "render" || !rest[1]) throw new VosError("usage", "vos previz render <scene.py> [--as name] [--seconds 5] [--size 768p|draft|WxH] [--encoding disparity|log|linear]");
      const r = renderPreviz(proj(a), rest[1], { as: a.as, seconds: a.seconds ? Number(a.seconds) : undefined, size: a.size, encoding: a.encoding });
      out(r, () => {
        console.log(`${r.cached ? "cached" : "rendered"}  ${r.name} (beauty) + ${r.name}_depth${r.pose ? ` + ${r.name}_pose` : ""}  ${r.size.join("x")} ${r.frames} frames  ${r.dir}`);
        for (const m of r.markers) console.log(`  ${m.sec.toFixed(2)}s  f${m.frame}  ${m.label}`);
      });
      return;
    }

    case "transcribe": {
      const p = proj(a);
      if (!rest.length) throw new VosError("usage", "vos transcribe <alias…>");
      const rs = rest.map((al) => transcribe(p, al, { model: a.model, lang: a.lang, vocab: a.vocab, force: !!a.force, singing: !!a.singing }));
      out(rs.map((r) => ({ alias: r.alias, status: r.status, language: r.record.language, segments: r.record.segments })), () => {
        for (const r of rs) {
          console.log(`${r.status.padEnd(6)} ${r.alias}  ${r.record.language}  ${r.record.segments.length} segment(s)  ${r.record.provenance.model}`);
          for (const s of r.record.segments) console.log(`  ${s.start.toFixed(2)}–${s.end.toFixed(2)}  ${s.text}`);
        }
      });
      return;
    }

    case "remote": {
      const sub = rest[0];
      if (sub === "up") {
        const r = remote.up({ budgetCu: Number(a["budget-cu"]), profile: a.profile, gpu: a.gpu, maxHours: a["max-hours"] ? Number(a["max-hours"]) : undefined, leaseMin: a["lease-min"] ? Number(a["lease-min"]) : undefined, wait: !!a.wait, session: a.session });
        out(r, () => console.log(`${r.status ?? "up"}  ${r.session}${r.budget_cu ? `  budget ${r.budget_cu} CU  profiles ${r.profiles?.join(",")}` : ""}${r.bootstrap ? `  bootstrap ${r.boot ? `${r.boot.state} in ${r.boot.sec}s` : "started (vos remote status)"}` : ""}`));
        return;
      }
      if (sub === "status") {
        const r = remote.status(a.session);
        out(r, () => {
          console.log(`balance   ${r.balance} CU  (rate ${r.rate_cu_h}/h)${r.orphans?.length ? `  ⚠ orphans: ${r.orphans.join(", ")}` : ""}`);
          if (!r.session) return console.log("session   none");
          const s = r.session;
          console.log(`session   ${s.name} ${s.state}${s.stop_reason ? ` (${s.stop_reason})` : ""}  spent ${s.spent_cu ?? "-"} / ${s.budget_cu} CU  lease ${s.lease_left_min} min  deadline ${s.deadline_left_min} min`);
          if (r.boot) console.log(`boot      ${r.boot.state}${r.boot.profiles ? ` ${Object.keys(r.boot.profiles).join(",")}` : ""}${r.boot.sec ? ` in ${r.boot.sec}s` : ""}${r.boot.versions?.gpu ? `  ${r.boot.versions.gpu}` : ""}`);
        });
        return;
      }
      if (sub === "down") {
        const r = remote.down(a.session);
        out(r, () => console.log(r.ok ? "stopped" : `NOT confirmed stopped (${r.state}) — run \`vos remote status\``));
        return;
      }
      throw new VosError("usage", "vos remote up --budget-cu N | status | down");
    }

    case "gen": {
      const sub = rest[0];
      if (sub === "up") {
        const r = gen.up({ model: a.model, budgetCu: Number(a["budget-cu"]), maxHours: a["max-hours"] ? Number(a["max-hours"]) : undefined, leaseMin: a["lease-min"] ? Number(a["lease-min"]) : undefined, gpu: a.gpu, wait: !!a.wait, light: !!a.light });
        out(r, () => {
          console.log(`${r.status ?? "up"}  ${gen.SESSION}${r.budget_cu ? `  budget ${r.budget_cu} CU` : ""}${r.bootstrap ? `  bootstrap ${r.boot ? `${r.boot.state} in ${r.boot.sec}s` : "started (vos gen status)"}` : ""}`);
          for (const w of r.boot?.weights ?? []) console.log(`  weights  ${w.file}  ${w.gb} GB in ${w.sec}s`);
        });
        return;
      }
      if (sub === "status") {
        const r = gen.status();
        out(r, () => {
          console.log(`balance   ${r.balance} CU  (rate ${r.rate_cu_h}/h)${r.orphans?.length ? `  ⚠ orphans: ${r.orphans.join(", ")}` : ""}`);
          console.log(`library   ${r.library ?? "none (vos gen library --init <dir>)"}`);
          if (!r.session) return console.log("session   none");
          const s = r.session;
          console.log(`session   ${s.name} ${s.state}${s.stop_reason ? ` (${s.stop_reason})` : ""}  spent ${s.spent_cu ?? "-"} / ${s.budget_cu} CU  lease ${s.lease_left_min} min  deadline ${s.deadline_left_min} min`);
          if (r.boot) console.log(`boot      ${r.boot.state}${r.boot.model ? `  ${r.boot.model}` : ""}${r.boot.sec ? ` in ${r.boot.sec}s` : ""}${r.boot.torch ? `  torch ${r.boot.torch}` : ""}`);
        });
        return;
      }
      if (sub === "down") {
        const r = gen.down();
        out(r, () => console.log(r.ok ? "stopped" : `NOT confirmed stopped (${r.state}) — run \`vos gen status\``));
        return;
      }
      if (sub === "clip") {
        const p = proj(a);
        const prompt = a["prompt-file"] ? fs.readFileSync(String(a["prompt-file"]), "utf8") : a.prompt;
        const r = gen.clip(p, { prompt, model: a.model, from: a.from, to: a.to, refs: a.refs, guides: a.guides, refSize: a["ref-size"], quality: a.quality, controlVideo: a.control, controlStrength: a["control-strength"] ? Number(a["control-strength"]) : undefined, controlEnd: a["control-end"] ? Number(a["control-end"]) : undefined, seconds: a.seconds ? Number(a.seconds) : undefined, size: a.size, seed: a.seed ? Number(a.seed) : undefined, steps: a.steps ? Number(a.steps) : undefined, dense: !!a.dense, as: a.as, note: a.note, replace: !!a.replace });
        out(r, () => {
          console.log(`${r.cached ? `cached (${r.cached})` : `generated in ${r.sec}s`}  ${r.alias}  ${r.file}${r.library ? "  → library" : ""}`);
          for (const w of r.warnings ?? []) console.log(`  note: ${w}`);
        });
        return;
      }
      if (sub === "upscale") {
        const r = gen.upscale(proj(a), { model: a.model, only: a.only ? String(a.only).split(",") : undefined, dryRun: !!a["dry-run"] });
        out(r, () => {
          for (const x of r.plans) console.log(`${String(x.status).padEnd(8)} ${x.alias.padEnd(20)} ${x.size.join("x")} → ${x.target.join("x")}  ${x.model}${x.reason ? `  (${x.reason})` : ""}${x.sec ? `  ${x.sec}s` : ""}${x.cached ? `  cached (${x.cached})` : ""}`);
          if (!r.dry_run && r.plans.some((x: any) => x.status === "done")) console.log("aliases now point to the upscaled takes — re-render to see them");
        });
        return;
      }
      if (sub === "library") {
        if (a.init) {
          const dir = initLibrary(String(a.init));
          out({ ok: true, library: dir }, () => console.log(`library ${dir}`));
          return;
        }
        const r = listLibrary({ search: a.search, limit: a.limit ? Number(a.limit) : undefined });
        out(r, () => {
          console.log(`library ${r.dir}  (${r.entries.length} shown)`);
          for (const e of r.entries) console.log(`${e.id}  ${e.size} ${e.seconds}s seed ${e.seed}${e.from ? ` from ${e.from}` : ""}${e.ready ? "" : "  (syncing)"}\n    ${String(e.prompt).slice(0, 110)}`);
        });
        return;
      }
      if (sub === "pull") {
        if (!rest[1]) throw new VosError("usage", "vos gen pull <id> [--as alias]");
        const r = gen.pull(proj(a), rest[1], { as: a.as, note: a.note, replace: !!a.replace });
        out(r, () => console.log(`pulled  ${r.alias}  ${r.file}`));
        return;
      }
      throw new VosError("usage", "vos gen up|clip|status|down|library|pull", "see `vos help`");
    }

    case "models": {
      if (rest[0] === "pull") {
        const ch = rest[1] as Channel;
        if (!["visual", "audio"].includes(ch)) throw new VosError("usage", "vos models pull <visual|audio>");
        const dir = pullModel(ch);
        out({ channel: ch, path: dir }, () => console.log(`downloaded → ${dir}`));
        return;
      }
      const st = modelStatus();
      out(st, () => st.forEach((m) => console.log(`${m.channel.padEnd(7)} ${m.present ? "present" : "MISSING"}  ${m.id}  (${m.approx_size})  ${m.what}`)));
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

    case "lyrics": {
      const p = proj(a);
      const sub = rest[0];
      if (sub === "time") {
        if (!rest[1] || !a.from) throw new VosError("usage", "vos lyrics time <sheet.txt> --from <alias> [--out data/lyrics.json]");
        const sheet = parseSheet(fs.readFileSync(path.resolve(rest[1]), "utf8"));
        const asset = resolveAsset(p, String(a.from));
        const tr = readTranscript(p, asset.id);
        const words = (tr?.segments ?? []).flatMap((sg) => (sg.words?.length ? sg.words : [{ start: sg.start, end: sg.end, word: sg.text, p: 1 }]));
        if (!words.length) throw new VosError("no_transcript", `no transcribed words for "${asset.alias}"`, `run \`vos transcribe ${asset.alias} --singing --lang ja\` (sung vocals need --singing: the speech filter drops them)`);
        const r = alignLyrics(sheet.lines, words);
        const file = path.resolve(p.root, String(a.out ?? "data/lyrics.json"));
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, "[\n" + r.lines.map((l) => "  " + JSON.stringify(l)).join(",\n") + "\n]\n");
        const report = { out: path.relative(p.root, file), lines: r.lines.length, flagged: r.flagged.map((i) => ({ at: r.lines[i].at, text: r.lines[i].text, confidence: r.lines[i].confidence })), skipped: sheet.skipped, transcript: tr?.provenance };
        out(report, () => {
          console.log(`${report.out}: ${r.lines.length} lines timed from ${asset.alias} (${tr?.provenance.model}${tr?.provenance.singing ? ", singing" : ""})`);
          for (const l of r.lines) console.log(`  ${l.at.toFixed(2).padStart(7)}  ${l.interpolated ? "?" : l.confidence < 0.6 ? "~" : " "} ${String(Math.round(l.confidence * 100)).padStart(3)}%  ${l.text}`);
          if (r.lines.some((l) => !l.interpolated && l.confidence < 0.6)) console.log(`\n~ = heard with other spellings: the time is usually right, check it by ear`);
          if (r.flagged.length) console.log(`? = not heard in the transcript, interpolated between its neighbours — check these by ear and fix "at" by hand`);
          for (const k of sheet.skipped) console.log(`skipped line ${k.srcLine}: ${k.text} — ${k.why}`);
        });
        return;
      }
      if (sub === "plan") {
        const plans = lyricPlans(p, { timeline: a.timeline, clip: a.clip });
        const wrote = a.markers === "write" ? writeMarkers(p, plans, a.timeline) : null;
        out({ plans, markers_written: wrote }, () => {
          for (const pl of plans) {
            console.log(`${pl.clip}  ${pl.src}  style ${pl.style}  seed ${pl.seed}  ${pl.cuts.length} cuts / ${pl.lines.length} lines`);
            for (const c of pl.cuts) console.log(`${c.locked ? "🔒" : "  "}${c.t0.toFixed(2).padStart(7)}–${c.t1.toFixed(2).padEnd(7)} L${String(c.line).padEnd(3)} ${(c.kime ? "KIME " : c.recap ? "recap" : "").padEnd(5)} ${c.text.padEnd(14, "　")}  ${c.layout} / ${c.enter} / ${c.hold} / ${c.exit}${c.treat !== "none" ? "  treat " + c.treat : ""}${c.bg !== "none" ? "  bg " + c.bg : ""}  cam ${c.cam}${c.trans ? "  ← " + c.trans : ""}${c.morph ? "  ← morph" : ""}${c.decor.length ? "  + " + c.decor.join(",") : ""}`);
            if (pl.markers.length) console.log(`  markers: ${pl.markers.map((m) => `${m.kind}@${m.at}`).join("  ")}${wrote ? "  (written to " + wrote.file + ")" : "  (add them with --markers write)"}`);
            for (const w of pl.warnings) console.log(`  warning: ${w}`);
          }
        });
        return;
      }
      if (sub === "fonts") {
        const r = lyricFonts(p, { timeline: a.timeline, download: !!a.download, check: !!a.check, text: a.text });
        out(r, () => {
          console.log(`${r.written ? "wrote" : "checked"} ${r.faces.length} faces → ${r.design}/jizura-fonts.css (${r.glyphs} glyphs, ${Math.round(r.faces.reduce((s, f) => s + f.bytes, 0) / 1024)} KB)`);
          for (const [fam, cs] of Object.entries(r.missing)) console.log(`  ${fam} lacks ${cs}`);
          if (r.written) console.log(`use "fonts": "jizura" in the lyric-motion clip props`);
        });
        return;
      }
      if (sub === "lock" || sub === "unlock") {
        const r = lockLyrics(p, { timeline: a.timeline, clip: a.clip, lines: a.lines, except: a.except, unlock: sub === "unlock" });
        out(r, () => {
          if (sub === "lock") {
            console.log(`${r.clip}: locked ${r.locked.length} line(s) in ${r.file}`);
            for (const l of r.locked) console.log(`  🔒 L${String(l.line).padEnd(3)} ${l.text}  (${l.cuts} cut${l.cuts > 1 ? "s" : ""})`);
            console.log(`other lines can now be directed or rerolled; these keep exactly what they show (\`vos lyrics unlock --lines …\` to release)`);
          } else {
            console.log(`${r.clip}: unlocked ${r.unlocked.length} line(s) in ${r.file}`);
            for (const l of r.unlocked) console.log(`     L${String(l.line).padEnd(3)} ${l.text}`);
          }
          for (const s2 of r.skipped) console.log(`  skipped L${s2.line}: ${s2.why}`);
        });
        return;
      }
      throw new VosError("usage", "vos lyrics time | plan | fonts | lock | unlock", "run `vos help`");
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
        python: marlinPython(),
        embedding_models: Object.fromEntries(modelStatus().map((m) => [m.channel, m.present ? "present" : "missing"])),
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

    case "judge": {
      await judgeCommand(() => proj(a), a, rest, out);
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
