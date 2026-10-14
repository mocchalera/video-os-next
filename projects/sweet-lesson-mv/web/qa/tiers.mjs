// What each quality tier costs: allocations (qa/glmem.js ledger), the browser's own footprint of the GPU process and the page (macOS `footprint`),
// GPU time at heavy moments, load times. A fresh Chrome per tier (a reused GPU process keeps what it had).
//   node web/qa/tiers.mjs [--tiers 0,1,2,3,4] [--base http://127.0.0.1:8731]  → web/review/m3/tiers.json
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
const root = new URL("../../", import.meta.url).pathname;
const arg = (n, d) => { const i = process.argv.indexOf(n); return i < 0 ? d : process.argv[i + 1]; };
const tiers = arg("--tiers", "0,1,2,3,4").split(",").map(Number), base = arg("--base", "http://127.0.0.1:8731");
const cdp = (...a) => execFileSync("node", ["web/tools/cdp.mjs", ...a], { encoding: "utf8", cwd: root, maxBuffer: 1 << 28 }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fp = (pid) => { const o = spawnSync("footprint", [String(pid)], { encoding: "utf8" }).stdout || ""; const m = /Footprint:\s+([\d.]+)\s+(MB|GB|KB)/.exec(o); return m ? Math.round(Number(m[1]) * (m[2] === "GB" ? 1024 : m[2] === "KB" ? 1 / 1024 : 1)) : null; };
const out = {};
for (const t of tiers) {
  spawnSync("pkill", ["-f", "remote-debugging-port=9333"]); await sleep(1500); spawnSync("rm", ["-rf", "/tmp/sl-chrome-profile"]);
  const t0 = Date.now(); cdp("launch", `${base}/walk.html?qa=1&tier=${t}&glmem=1&auto=1&muted=1&t=155`);
  for (let i = 0; i < 150 && cdp("eval", "typeof __walk!=='undefined' && __walk.ready ? 1 : 0") !== "1"; i++) await sleep(300);
  await sleep(6000);
  const info = JSON.parse(cdp("eval", "JSON.stringify({tier:__walk.tier.name, ready:__walk.readyMs, warmMs:__walk.warmMs, build:__walk.buildMs, programs:__walk.programs, errs:__walk.errors, mem:__glmem.report(14), bench:__walk.benchMeasure(), js:performance.memory&&Math.round(performance.memory.usedJSHeapSize/1048576)})"));
  const main = spawnSync("pgrep", ["-f", "remote-debugging-port=9333"], { encoding: "utf8" }).stdout.trim().split("\n")[0];
  const ps = spawnSync("ps", ["-axo", "pid,ppid,pcpu,command"], { encoding: "utf8" }).stdout.split("\n").filter((l) => l.trim().split(/\s+/)[1] === main);
  const gpu = ps.find((l) => /type=gpu-process/.test(l)), rend = ps.filter((l) => /type=renderer/.test(l)).sort((a, b) => Number(b.trim().split(/\s+/)[2]) - Number(a.trim().split(/\s+/)[2]))[0];
  info.footprintMB = { gpu: gpu ? fp(gpu.trim().split(/\s+/)[0]) : null, renderer: rend ? fp(rend.trim().split(/\s+/)[0]) : null };
  info.footprintMB.total = (info.footprintMB.gpu || 0) + (info.footprintMB.renderer || 0);
  out[t] = info; console.log(`tier ${info.tier}: ledger ${info.mem.totalMB} MB, browser footprint ${info.footprintMB.total} MB (gpu ${info.footprintMB.gpu} + page ${info.footprintMB.renderer}), GPU worst ${info.bench.worst} ms, ready ${info.ready} ms`);
}
fs.mkdirSync(root + "web/review/m3", { recursive: true }); fs.writeFileSync(root + "web/review/m3/tiers.json", JSON.stringify(out, null, 1));
