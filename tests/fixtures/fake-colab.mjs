#!/usr/bin/env node
// Stand-in for both `scripts/colab/vos-colab` (guard) and `colab` in tests. No network, no CU.
// The "VM" is a directory: /content/... maps to $FAKE_VM/content/... State lives in $FAKE_VM/state.json.
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
state.calls.push([cmd, ...args].join(" "));

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
    if (code.trim() === "bootstrap()") {
      put("/content/vosgen/boot.json", JSON.stringify({ state: process.env.FAKE_BOOT_FAIL ? "error" : "ready", error: "boom", torch: "2.11.0+cu130 13.0", sec: 1 }));
      put("/content/vosgen/boot.done", "");
    }
    const m = /^submit\((.*)\)\s*$/s.exec(code.trim());
    if (m) {
      const r = JSON.parse(m[1]);
      state.submitted = (state.submitted ?? 0) + 1;
      state.last = r;
      if (process.env.FAKE_NEVER_STARTS) { save(); console.log(JSON.stringify({ ok: true })); break; }
      put(`/content/vosgen/jobs/${r.id}.started`, "");
      if (process.env.FAKE_JOB_FAIL) {
        put(`/content/vosgen/jobs/${r.id}.json`, JSON.stringify({ id: r.id, state: "error", error: "CUDA OOM", log_tail: "..." }));
      } else {
        put(`/content/vosgen/out/${r.id}.mp4`, fs.readFileSync(FIXTURE));
        put(`/content/vosgen/jobs/${r.id}.json`, JSON.stringify({ id: r.id, state: "ok", output: `/content/vosgen/out/${r.id}.mp4`, sec: 81.2, s_per_it: 10.03, gpu: "NVIDIA A100-SXM4-40GB", torch: "2.11.0+cu130 13.0", flags: [], comfy_rev: "1568e6cf", weights_rev: "1c41cfca" }));
      }
      put(`/content/vosgen/jobs/${r.id}.done`, "");
    }
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
  case "download": {
    const [, , remote, dest] = args; // -s name remote dest
    save();
    if (!fs.existsSync(local(remote))) process.exit(1);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(local(remote), dest);
    break;
  }
  default:
    save();
    process.exit(2);
}
