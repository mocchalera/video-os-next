#!/usr/bin/env node
// Stand-in for both `scripts/colab/vos-colab` (guard) and `colab` in tests. No network, no CU.
// The "VM" is a directory: /content/... maps to $FAKE_VM/content/... State lives in $FAKE_VM/state.json.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const VM = process.env.FAKE_VM;
const FIXTURE = process.env.FAKE_CLIP; // an mp4 the "GPU" returns
const statePath = path.join(VM, "state.json");
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : { sessions: {}, calls: [], balance: 150 };
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
const local = (remote) => path.join(VM, remote);
const put = (remote, data) => { fs.mkdirSync(path.dirname(local(remote)), { recursive: true }); fs.writeFileSync(local(remote), data); };
const [cmd, ...args] = process.argv.slice(2);
// mirrors the VM's submit(): a token already seen is a retried exec, not a new job
// FAKE_EXEC_DROPS_AFTER=N: the VM accepts the first N submits, then the connection drops before the reply
const afterDrop = (code) => {
  if (!process.env.FAKE_EXEC_DROPS_AFTER || !/^(analysis_)?submit\(/.test(code.trim())) return false;
  if ((state.dropsAfter ?? 0) >= Number(process.env.FAKE_EXEC_DROPS_AFTER)) return false;
  state.dropsAfter = (state.dropsAfter ?? 0) + 1; save(); console.error("RuntimeError: Connection was lost."); return true;
};
const seenToken = (t) => { if (!t) return false; state.tokens ??= []; if (state.tokens.includes(t)) return true; state.tokens.push(t); return false; };
state.calls.push([cmd, ...args].join(" "));

// ---- the analysis VM (python/colab_analysis_vm.py), same file contract under /content/vosana
const ANA = "/content/vosana";
const hashOf = (f) => createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const call = (fn, code) => {
  const m = new RegExp(`^${fn}\\(__import__\\("json"\\)\\.loads\\((.*)\\)\\)\\s*$`, "s").exec(code.trim());
  return m ? JSON.parse(JSON.parse(m[1])) : null;
};
const inPath = (it) => `${ANA}/in/${it.sha256}.${it.ext}`;
const check = (it) => {
  const f = local(inPath(it));
  if (!fs.existsSync(f)) return false;
  if (fs.statSync(f).size !== it.size || hashOf(f) !== it.sha256) { fs.rmSync(f); return false; }
  return true;
};
function analysis(code) {
  let r;
  if ((r = call("analysis_bootstrap", code))) {
    put(`${ANA}/boot.started`, "");
    const profiles = Object.fromEntries(r.profiles.map((x) => [x.name, { model: x.model, revision: process.env.FAKE_ANALYSIS_REV ?? x.revision, dir: `${ANA}/models/${x.name}` }]));
    put(`${ANA}/boot.json`, JSON.stringify({ state: process.env.FAKE_BOOT_FAIL ? "error" : "ready", error: "boom", profiles,
      versions: { gpu: "NVIDIA L4", bf16: true, torch: "2.9.0+cu126", transformers: "5.12.1" }, sec: 1 }));
    put(`${ANA}/boot.done`, "");
    (state.analysisBoots ??= []).push(r);
  } else if ((r = call("analysis_have", code))) {
    put(`${ANA}/have/${r.token}.json`, JSON.stringify({ token: r.token, present: r.items.filter(check).map((x) => x.sha256) }));
  } else if ((r = call("analysis_cancel", code))) {
    (state.cancels ??= []).push(r.id);
  } else if ((r = call("analysis_submit", code))) {
    if (seenToken(r.token)) return;
    (state.analysisRuns ??= {})[r.id] = (state.analysisRuns[r.id] ?? 0) + 1;
    state.lastAnalysis = r;
    put(`${ANA}/jobs/${r.id}.started`, "");
    if (process.env.FAKE_NEVER_FINISHES) return;
    const bad = [r.worker, ...r.inputs].filter((x) => !check(x)).map((x) => x.sha256);
    const rep = { id: process.env.FAKE_ANALYSIS_WRONG_ID ? "someoneelse" : r.id, kind: r.kind, state: "ok", versions: { gpu: "NVIDIA L4", bf16: true, torch: "2.9.0+cu126" }, sec: 3.5 };
    const publish = (name, buf) => {
      put(`${ANA}/jobs/${r.id}.${name}`, buf);
      (rep.files ??= {})[name] = { path: `${ANA}/jobs/${r.id}.${name}`, bytes: buf.length,
        sha256: process.env.FAKE_ANALYSIS_BAD_SUM ? "0".repeat(64) : createHash("sha256").update(buf).digest("hex") };
    };
    if (bad.length) Object.assign(rep, { state: "error", error: `${bad.length} input(s) missing or corrupt on the VM`, missing_inputs: bad });
    else if (r.kind === "embed") {
      // deterministic 8-d vectors; a text shares components with an image whose member name holds the same words
      const vec = (key) => { const h = createHash("sha256").update(key).digest(); return Array.from({ length: 8 }, (_, i) => h[i] / 255 - 0.5); };
      const known = new Set(r.inputs.map((x) => x.sha256));
      const rows = r.items.map((it) => {
        if (it.kind === "text") return vec(`text:${it.text}`);
        if (!known.has(it.input)) throw new Error("item for an input not sent");
        return vec(`image:${it.input}:${it.member ?? ""}`);
      });
      if (process.env.FAKE_EMBED_NAN) rows[0][0] = NaN;
      if (process.env.FAKE_EMBED_SHORT) rows.pop();
      const buf = Buffer.alloc(rows.length * 8 * 4);
      rows.flat().forEach((v, i) => buf.writeFloatLE(v, i * 4));
      publish("f32", buf);
      Object.assign(rep, { n: rows.length, dim: 8, device: "cuda" });
      (state.embedItems ??= []).push(r.items);
    } else {
      const lines = r.inputs.map((x, i) => (process.env.FAKE_ANALYSIS_ITEM_FAIL && i === 0)
        ? { sha256: x.sha256, ok: false, error: "decode failed" }
        : { sha256: x.sha256, ok: true, model: "/content/vosana/models/m", result: { scene: `fake scene ${x.sha256.slice(0, 8)}`, events: [{ start: 0, end: 1, description: "a fake event" }] } });
      if (process.env.FAKE_ANALYSIS_STRAY) lines.push({ sha256: "f".repeat(64), ok: true, result: {} });
      publish("jsonl", Buffer.from(lines.map((l) => JSON.stringify(l)).join("\n") + "\n"));
      rep.n = lines.length;
    }
    put(`${ANA}/jobs/${r.id}.json`, JSON.stringify(rep));
    put(`${ANA}/jobs/${r.id}.done`, "");
  }
}

switch (cmd) {
  case "start": {
    const name = args[0];
    state.sessions[name] = { name, state: "running", endpoint: "gpu-fake", budget_cu: Number(args[args.indexOf("--budget-cu") + 1]), spent_cu: 0, lease_left_min: 20, deadline_left_min: 120 };
    save();
    console.log(JSON.stringify({ ok: true, name, endpoint: "gpu-fake" }));
    break;
  }
  case "status":
    save();
    console.log(JSON.stringify({ ok: true, balance: state.balance, rate_cu_h: 5.3, orphans: [], sessions: Object.values(state.sessions) }, null, 1));
    break;
  case "stop":
    if (state.sessions[args[0]]) state.sessions[args[0]].state = "stopped";
    save();
    console.log(JSON.stringify({ ok: true, state: "stopped" }));
    break;
  case "exec": {
    const code = fs.readFileSync(args[args.indexOf("-f") + 1], "utf8");
    if (state.sessions[args[0]]?.state !== "running") { save(); process.exit(1); }
    if (process.env.FAKE_EXEC_DROPS && (state.drops ?? 0) < Number(process.env.FAKE_EXEC_DROPS)) {
      state.drops = (state.drops ?? 0) + 1; save(); console.error("RuntimeError: Connection was lost."); process.exit(124);
    }
    if (/^bootstrap\(.*\)$/.test(code.trim())) {
      if (!process.env.FAKE_BOOT_NEVER) put("/content/vosgen/boot.started", "");
      if (!process.env.FAKE_BOOT_NEVER) put("/content/vosgen/boot.json", JSON.stringify({ state: process.env.FAKE_BOOT_FAIL ? "error" : "ready", error: "boom", torch: "2.11.0+cu130 13.0", sec: 1 }));
      if (!process.env.FAKE_BOOT_NEVER) put("/content/vosgen/boot.done", "");
    }
    const m = /^submit\(__import__\("json"\)\.loads\((.*)\)\)\s*$/s.exec(code.trim());
    if (m && !(m[1] && seenToken(JSON.parse(JSON.parse(m[1])).token))) {
      const r = JSON.parse(JSON.parse(m[1]));
      state.submitted = (state.submitted ?? 0) + 1;
      state.last = r;
      if (process.env.FAKE_NEVER_STARTS) { save(); console.log(JSON.stringify({ ok: true })); break; }
      put(`/content/vosgen/jobs/${r.id}.started`, "");
      if (process.env.FAKE_JOB_FAIL) {
        put(`/content/vosgen/jobs/${r.id}.json`, JSON.stringify({ id: r.id, state: "error", error: "CUDA OOM", log_tail: "..." }));
      } else {
        put(`/content/vosgen/out/${r.id}.mp4`, Buffer.concat([fs.readFileSync(FIXTURE), Buffer.from(`${r.kind ?? "gen"}:${r.id}`)]));
        put(`/content/vosgen/jobs/${r.id}.json`, JSON.stringify({ id: r.id, state: "ok", output: `/content/vosgen/out/${r.id}.mp4`, sec: 81.2, s_per_it: 10.03, gpu: "NVIDIA A100-SXM4-40GB", torch: "2.11.0+cu130 13.0", flags: [], comfy_rev: "1568e6cf", weights_rev: "1c41cfca" }));
      }
      put(`/content/vosgen/jobs/${r.id}.done`, "");
    }
    analysis(code);
    if (afterDrop(code)) process.exit(124);
    save();
    console.log(JSON.stringify({ ok: true }));
    break;
  }
  case "wait": {
    save();
    const found = fs.existsSync(local(args[1]));
    console.log(JSON.stringify(found ? { ok: true, found: args[1] } : { ok: false, error: "wait timed out" }));
    process.exit(found ? 0 : 124);
  }
  case "upload": {
    const [, , src, remote] = args; // -s name local remote
    fs.mkdirSync(path.dirname(local(remote)), { recursive: true });
    fs.copyFileSync(src, local(remote));
    if (process.env.FAKE_CORRUPT_UPLOAD && !state.corrupted) { fs.appendFileSync(local(remote), "x"); state.corrupted = true; }
    (state.uploads ??= []).push(remote);
    save();
    break;
  }
  case "download": {
    const [, , remote, dest] = args; // -s name remote dest
    save();
    if (!fs.existsSync(local(remote))) process.exit(1);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(local(remote), dest);
    break;
  }
  case "renew":
    (state.renews ??= []).push(args[0]);
    save();
    console.log(JSON.stringify({ ok: true }));
    break;
  default:
    save();
    process.exit(2);
}
