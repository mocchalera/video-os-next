// Unattended playback, head to tail, no input at all: does the web page draw what the MV's own page draws? (web-only UI is DOM, not in the canvas.)
//   node web/qa/unattended.mjs → web/review/m3/unattended/{web,mv}-<T>.jpg, trace.json   (then python3 web/qa/unattended-check.py)
// Web: real time at the 1080 tier (?tier=0), shots queued at 12 times. MV: the pre-web room.html's own page (/_buildorig/), stepped at 24 fps up to each of the web's actual times.
import fs from "node:fs";
import { connect } from "../tools/cdpkit.mjs";
const root = new URL("../../", import.meta.url).pathname, out = root + "web/review/m3/unattended"; fs.mkdirSync(out, { recursive: true });
const base = "http://127.0.0.1:8731"; const c = await connect("");
const TS = [12, 40, 61, 75, 88, 96, 125, 133.5, 150, 175, 200, 210];
await c.emulate(1920, 1080, 1, false); // a 16:9 window: the page widens the field of view for other shapes (on purpose), which is not what is compared here
await c.goto(`${base}/walk.html?tier=0&auto=1&muted=1&t=0`); await c.waitReady();
await c.eval(`(()=>{ for (const t of ${JSON.stringify(TS)}) __walk.queueShot(t, 'T'+t); window.__tr = []; window.__trT = setInterval(()=>{ const tr=__walk.traces; __tr.push([+__walk.audio.currentTime.toFixed(2), +(__walk.youW||0).toFixed(3), +__walk.ctrl.f.toFixed(2), +__walk.ctrl.e.toFixed(2), ...tr.items.map(i=>i.alive?+i.m.material.opacity.toFixed(3):0)]); }, 500); })()`);
for (let i = 0; i < 700; i++) { await c.sleep(1000); const T = await c.eval("__walk.audio.currentTime"); if (T > 212.5) break; if (i % 30 === 0) console.log("T", T.toFixed(0)); }
const shots = JSON.parse(await c.eval("JSON.stringify((__walk.shots||[]).map(s=>({T:s.T,label:s.label,img:s.img})))"));
const tr = JSON.parse(await c.eval("JSON.stringify(__tr)")); await c.eval("clearInterval(__trT)");
const meta = []; for (const s of shots) { fs.writeFileSync(`${out}/web-${s.label}.jpg`, Buffer.from(s.img.split(",")[1], "base64")); meta.push({ label: s.label, T: s.T }); }
const maxTrace = tr.reduce((m, r) => Math.max(m, ...r.slice(4)), 0); const anyYou = tr.some((r) => r[1] > 0);
fs.writeFileSync(`${out}/trace.json`, JSON.stringify({ meta, samples: tr.length, maxBreathOpacity: maxTrace, anyYouWeight: anyYou, rows: tr }, null, 0));
console.log("web shots", meta.length, "breath max", maxTrace, "you-weight ever >0:", anyYou);
// the MV's own page
await c.goto(`${base}/_buildorig/index.html`);
for (let k = 0; k < 60; k++) { await c.sleep(500); if ((await c.eval("typeof __timelines!=='undefined' && document.querySelector('canvas') ? 1 : 0")) === 1) break; } await c.sleep(2000);
for (const m of meta) {
  const jpg = await c.eval(`(()=>{ const cv=document.querySelector('canvas'); const T=${m.T}; let r=''; for (let j=23;j>=0;j--){ __timelines.main.seek(T-j/24,false); } return cv.toDataURL('image/jpeg',0.9); })()`);
  fs.writeFileSync(`${out}/mv-${m.label}.jpg`, Buffer.from(jpg.split(",")[1], "base64"));
}
c.close();
