// Scripted epilogue with REAL mouse events: arrive, stand at the window, write with a finger, swipe the sash, see the last lines. Screenshots → web/review/m2/epilogue/
import { execFileSync } from "node:child_process";
import fs from "node:fs";
const root = new URL("../../", import.meta.url).pathname;
const cdp = (...a) => execFileSync("node", ["web/tools/cdp.mjs", ...a], { encoding: "utf8", cwd: root, maxBuffer: 1 << 28 }).trim();
const ev = (js) => cdp("eval", js);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = root + "web/review/m2/epilogue"; fs.mkdirSync(out, { recursive: true });
const shot = (name) => { cdp("shot", `${out}/${name}.jpg`); return name; };
cdp("goto", "http://127.0.0.1:8731/walk.html?qa=1&auto=1&muted=1&t=1");
for (let i = 0; i < 100 && ev("typeof __walk!=='undefined' && __walk.ready ? 1 : 0") !== "1"; i++) await sleep(300);
await sleep(1200);
const net0 = JSON.parse(ev("JSON.stringify({res: performance.getEntriesByType('resource').length, ls: localStorage.length, ss: sessionStorage.length, names: performance.getEntriesByType('resource').map(r=>r.name)})"));
ev("(async()=>{__walk.pause(); __walk.startEpilogue(); return 1})()");
await sleep(600); shot("00-fade-in");
await sleep(4200); shot("01-arrived (drifting toward the window)");
ev("__walk.stand({x:-0.1,y:1.45,z:-0.5,yaw:0.0,pitch:-0.1})"); await sleep(2200);
shot("02-near the window (cue)");
const cue1 = ev("__walk.getCueText()");
// the pointer positions of the writing zone (below the MV's finger writing) from the real camera
const pts = JSON.parse(ev(`JSON.stringify([[-0.70,1.20],[-0.55,1.12],[-0.40,1.22],[-0.25,1.12],[-0.10,1.2],[-0.65,1.04],[-0.45,1.07],[-0.28,1.03],[-0.12,1.08],[-0.66,1.86],[-0.5,1.95],[-0.34,1.84],[-0.18,1.93]].map(([x,y])=>__walk.epi.toClient({x,y,z:-1.808})))`));
const stroke = (a, b) => cdp("drag", String(Math.round(a.x)), String(Math.round(a.y)), String(Math.round(b.x)), String(Math.round(b.y)), "14");
stroke(pts[0], pts[1]); stroke(pts[1], pts[2]); stroke(pts[2], pts[3]); stroke(pts[3], pts[4]); stroke(pts[5], pts[6]); stroke(pts[6], pts[7]); stroke(pts[7], pts[8]); stroke(pts[9], pts[10]); stroke(pts[10], pts[11]); stroke(pts[11], pts[12]);
await sleep(300); shot("03-written (cue: open)");
const st1 = ev("JSON.stringify(__walk.getEpiState())"), cue2 = ev("__walk.getCueText()");
await sleep(2500); shot("04-drips");
// the sash: grab the top rail of the left pane and pull sideways
const g = JSON.parse(ev("JSON.stringify(__walk.epi.toClient({x:-0.04,y:1.5,z:-1.808}))"));
cdp("drag", String(Math.round(g.x)), String(Math.round(g.y)), String(Math.round(g.x + 520)), String(Math.round(g.y)), "26");
await sleep(500); shot("05-opening");
await sleep(2000); shot("06-open (morning air)");
const cue3 = ev("__walk.getCueText()"); await sleep(5200); const cue4 = ev("__walk.getCueText()"); shot("07-after");
// the log, as plain text, by clicking the cue (a real click)
const lg = JSON.parse(ev("JSON.stringify((()=>{const r=document.querySelector('#cues .act[data-a=log]').getBoundingClientRect(); return {x:r.left+r.width/2, y:r.top+r.height/2}})())"));
cdp("click", String(Math.round(lg.x)), String(Math.round(lg.y))); await sleep(700); shot("08-log (plain text)");
const logRows = JSON.parse(ev("JSON.stringify({rows: document.querySelectorAll('#log .row').length, events: __walk.shim.props.credits.events.length, firstRow: document.querySelector('#log .row')?.textContent.slice(0,60), lastRow: [...document.querySelectorAll('#log .row')].pop()?.textContent.slice(0,80), open: __walk.ui.logOpen})"));
ev("__walk.ui.closeLog()");
const net1 = JSON.parse(ev("JSON.stringify({res: performance.getEntriesByType('resource').length, ls: localStorage.length, ss: sessionStorage.length, names: performance.getEntriesByType('resource').map(r=>r.name)})"));
net1.newRequests = net1.names.filter((n) => !net0.names.includes(n)); delete net0.names; delete net1.names;
const idb = ev("(async()=>{ try { return JSON.stringify(await indexedDB.databases()); } catch(e) { return 'n/a'; } })()");
const st2 = ev("JSON.stringify(__walk.getEpiState())");
const errs = ev("JSON.stringify(__walk.errors)");
fs.writeFileSync(`${out}/run.json`, JSON.stringify({ cue_near: cue1, cue_written: cue2, cue_open: cue3, cue_after: cue4, state_written: JSON.parse(st1), state_end: JSON.parse(st2), network_and_storage: { before: net0, after: net1, indexedDB: idb }, log_overlay: logRows, errors: JSON.parse(errs) }, null, 1));
console.log(fs.readFileSync(`${out}/run.json`, "utf8"));
