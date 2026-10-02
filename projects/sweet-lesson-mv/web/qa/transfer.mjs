// First-visit transfer from the built site (web/dist, served with gzip like a static host): bytes on the wire by kind, to "ready" and after 40 s of playing.
//   node web/serve.mjs 8750 --root web/dist --gzip &   node web/qa/transfer.mjs → web/review/m3/transfer.json
import fs from "node:fs";
import { connect } from "../tools/cdpkit.mjs";
const root = new URL("../../", import.meta.url).pathname;
const base = "http://127.0.0.1:8750"; const c = await connect("");
const kind = (u) => /Sweet%20Lesson\.mp3|Sweet Lesson\.mp3/.test(u) ? "song (mp3)" : /foley\.m4a/.test(u) ? "foley (AAC)" : /\/tex-512\//.test(u) ? "textures 512²" : /refs\/tex\//.test(u) ? "textures full" : /\.woff2/.test(u) ? "fonts" : /three\.js/.test(u) ? "three.js" : /room\.html/.test(u) ? "room.html" : /\.srt/.test(u) ? "captions" : /\.json/.test(u) ? "json" : /\.js|\.html|\.css/.test(u) ? "site code" : "other";
let rows = new Map(); const reqs = new Map();
await c.send("Network.enable"); await c.send("Network.setCacheDisabled", { cacheDisabled: true });
c.on("Network.requestWillBeSent", (p) => reqs.set(p.requestId, p.request.url));
c.on("Network.loadingFinished", (p) => { const u = reqs.get(p.requestId) || ""; if (!u.startsWith(base)) return; const k = kind(u), r = rows.get(k) || { n: 0, bytes: 0 }; r.n++; r.bytes += p.encodedDataLength; rows.set(k, r); });
async function run(label, emulate, q = "") {
  rows = new Map(); reqs.clear();
  await emulate(); await c.goto(`${base}/walk.html${q ? q + "&qa=1" : "?qa=1"}`); const t0 = Date.now(); await c.waitReady(); const readyMs = Date.now() - t0;
  const snap = () => Object.fromEntries([...rows].map(([k, v]) => [k, { files: v.n, MB: +(v.bytes / 1048576).toFixed(2) }]));
  await c.sleep(1500); const atReady = snap(); const sum = (o) => +Object.values(o).reduce((a, v) => a + v.MB, 0).toFixed(2);
  await c.eval("__walk.start({muted:true})"); await c.sleep(40000); const after = snap();
  const media = JSON.parse(await c.eval("JSON.stringify(performance.getEntriesByType('resource').filter(e=>/mp3|m4a/.test(e.name)).map(e=>({name:decodeURIComponent(e.name.split('/').pop()), initiator:e.initiatorType, transferMB:+(e.transferSize/1048576).toFixed(2), encodedMB:+(e.encodedBodySize/1048576).toFixed(2)})))"));
  const tier = await c.eval("__walk.tier.name");
  return { label, tier, media, readyMs, atReady, atReadyMB: sum(atReady), after40s: after, after40sMB: sum(after) };
}
const out = {};
out.phone = await run("phone (390×844 emulated, tier chosen by the page)", async () => { await c.emulate(390, 844, 3, true); await c.eval("try{sessionStorage.clear()}catch(e){}"); });
out.desktop = await run("desktop (1440×900, tier 1080: ?tier=0)", async () => { await c.emulate(1440, 900, 2, false); await c.eval("try{sessionStorage.clear()}catch(e){}"); }, "?tier=0");
fs.writeFileSync(root + "web/review/m3/transfer.json", JSON.stringify(out, null, 1)); console.log(JSON.stringify(out, null, 1)); c.close();
