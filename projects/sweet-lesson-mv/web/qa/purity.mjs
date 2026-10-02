// node web/qa/purity.mjs [--double] [--seed N] [--out file.json] [--verbose] [--n 20]
// Fresh page → reference (vos-style forward 24 fps stepping) → random-order jumps → pixel + scene-state comparison.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
const args = process.argv.slice(2), opt = (n, d) => { const i = args.indexOf(n); return i < 0 ? d : args[i + 1] ?? true; };
const root = new URL("../../", import.meta.url).pathname;
const cdp = (...a) => execFileSync("node", ["web/tools/cdp.mjs", ...a], { encoding: "utf8", cwd: root, maxBuffer: 1 << 28 }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const url = opt("--url", "http://127.0.0.1:8731/m0.html?qa=1");
cdp("goto", url);
for (let i = 0; i < 100 && cdp("eval", "typeof __m0!=='undefined' && __m0.marks.readyFromNav ? 1 : 0") !== "1"; i++) await sleep(300);
cdp("eval", fs.readFileSync(root + "web/qa/purity-page.js", "utf8"));
// 20 random frames + targeted thresholds (state changes in room.html)
const seed = Number(opt("--seed", 1)); let a = seed >>> 0; const rnd = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const n = Number(opt("--n", 20)), Ts = Array.from({ length: n }, () => Math.round(rnd() * Number(opt("--tmax", 214.7)) * Number(opt("--fps", 24))) / Number(opt("--fps", 24)));
if (opt("--only", null)) { Ts.length = 0; Ts.push(...String(opt("--only")).split(",").map(Number)); } else if (!args.includes("--random-only")) Ts.push(0, 1 / 24, 10.2, 38.4, 56.5, 57, 57.6, 62, 70, 75, 80, 85, 88.5, 89.5, 90.5, 91.3, 92.5, 94.5, 97.5, 104, 110.7, 122.8, 134.5, 139.5, 143, 146.5, 148.5, 150, 153.6, 160, 185, 196, 205, 214.7);
const cfg = { refOff: args.includes("--ref-off"), prec: Number(opt("--prec", 4)), fps: Number(opt("--fps", 24)), web: args.includes("--web"), Ts, seed, double: args.includes("--double"), verbose: args.includes("--verbose"), maxList: Number(opt("--max-list", 8)) };
const out = JSON.parse(cdp("eval", `__purity(${JSON.stringify(cfg)}).then(r=>JSON.stringify(r))`));
if (opt("--out", null)) fs.writeFileSync(opt("--out"), JSON.stringify(out, null, 1));
console.log(`frames=${out.frames} objects=${out.objects} bad=${out.bad} (reference ${out.tRefMs} ms)`);
const maxBad = Number(opt("--max-bad", 0)); // a known, recorded difference may be allowed explicitly (e.g. --max-bad 1 for the 164.04 s one); anything beyond fails
process.exitCode = out.bad > maxBad ? 1 : 0;
for (const r of out.results) if (r.pixDiffBytes || args.includes("--all")) console.log(`T=${r.T} px=${r.pixDiffBytes} max=${r.maxDiff} stateDiffs=${r.stateDiffs} ${r.sample.map((s) => s.obj).slice(0, 3).join(" | ")}`);
