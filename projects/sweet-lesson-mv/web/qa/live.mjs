// Read-only check of the deployed site with the real Chrome (CDP): entrance → enter → 10 s of real playback → seek 1:00 / 3:20 → epilogue (write, open, again) → CSP / failures / off-origin; then a phone emulation.
//   node web/qa/live.mjs → web/review/live/*.png, live.json   (reads only; changes nothing)
import fs from "node:fs";
import { connect } from "../tools/cdpkit.mjs";
const here = new URL("../", import.meta.url).pathname, out = here + "review/live"; fs.mkdirSync(out, { recursive: true });
const SITE = "https://sweet-lesson.mocchalera.app"; const ORIGIN = new URL(SITE).origin;
const c = await connect("");
await c.send("Network.enable"); /* the cache stays ON, as for a visitor: with Cache-Control: no-cache (devtools "Disable cache", a hard reload) the edge ignores Range and the song is not seekable (found in this check) */ await c.send("Log.enable"); await c.send("Runtime.enable"); await c.send("Page.enable");
await c.send("Page.addScriptToEvaluateOnNewDocument", { source: "window.__csp=[]; document.addEventListener('securitypolicyviolation',e=>__csp.push([e.violatedDirective,e.blockedURI,e.sourceFile||'',e.lineNumber||0].join(' | ')));" });
const reqs = new Map(), problems = [], consoleV = [], off = new Set(), beacon = new Set(), seen = new Map(); let docHeaders = null, errors = [];
c.on("Network.requestWillBeSent", (p) => { reqs.set(p.requestId, p.request.url); if (!p.request.url.startsWith(ORIGIN) && !p.request.url.startsWith("data:") && !p.request.url.startsWith("blob:")) { if (/^https:\/\/(static\.cloudflareinsights\.com|cloudflareinsights\.com)\//.test(p.request.url)) beacon.add(p.request.url.split("?")[0]); else off.add(p.request.url); } });
c.on("Network.responseReceived", (p) => { const u = p.response.url; if (u.startsWith(ORIGIN)) { seen.set(u.slice(ORIGIN.length).split("?")[0], p.response.status); if (p.response.status >= 400) problems.push(`${p.response.status} ${u}`); if (p.type === "Document" && !docHeaders) docHeaders = p.response.headers; } });
c.on("Network.loadingFailed", (p) => { if (p.errorText === "net::ERR_ABORTED" && !p.blockedReason) return; problems.push(`failed ${reqs.get(p.requestId)} ${p.errorText} ${p.blockedReason || ""}`); });
c.on("Log.entryAdded", (p) => { if (/Content Security Policy|Refused to/i.test(p.entry.text || "")) consoleV.push(p.entry.text); if (p.entry.level === "error") errors.push(p.entry.text); });
c.on("Runtime.consoleAPICalled", (p) => { const t = (p.args || []).map((a) => a.value ?? a.description ?? "").join(" "); if (/Content Security Policy|Refused to/i.test(t)) consoleV.push(t); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (e) => JSON.parse(await c.eval(`JSON.stringify(${e})`));
const ready = async () => { for (let i = 0; i < 300; i++) { try { if ((await c.eval("typeof __walk!=='undefined' && __walk.ready ? 1 : 0")) === 1) return; } catch { /* navigating */ } await sleep(300); } throw new Error("not ready"); };
const go = async (u) => { await c.send("Page.navigate", { url: u }); await sleep(1200); };
const mouse = (type, x, y, buttons = 0) => c.send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" ? (buttons ? "left" : "none") : "left", buttons, clickCount: type === "mouseMoved" ? 0 : 1, pointerType: "mouse" });
const res = { site: SITE, steps: [] }; const step = (name, info) => { res.steps.push({ name, ...info }); console.log(name, JSON.stringify(info)); };

// ---------- (1) desktop: entrance → enter → 10 s of real playback
await c.emulate(1440, 900, 1, false); await c.eval("try{sessionStorage.clear()}catch(e){}");
await go(`${SITE}/?qa=1`); await sleep(500); const t0 = Date.now(); await ready(); const readyMs = Date.now() - t0;
const tier = await c.eval("__walk.tier.name"), why = await c.eval("__walk.tierWhy");
await c.shot(`${out}/01-entrance.png`);
const doc = await ev("({title:document.title, lang:document.documentElement.lang, og:document.querySelector('meta[property=\"og:image\"]').content, inline:[...document.scripts].filter(s=>!s.src).length})");
const eb = await ev("(()=>{const r=document.getElementById('enter').getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}})()");
await mouse("mouseMoved", eb.x, eb.y); await mouse("mousePressed", eb.x, eb.y, 1); await mouse("mouseReleased", eb.x, eb.y); await sleep(10000);
const s1 = await ev("({T:__walk.audio.currentTime, paused:__walk.audio.paused, muted:__walk.audio.muted, ctx:__walk.ctrl.ctx, errs:__walk.errors, foleySounding:__walk.foley.sounding, sfx:__walk.sfx.ctx&&__walk.sfx.ctx.state})");
const cur = await ev("({mode:__walk.cursor.mode, off:document.getElementById('cur').classList.contains('off'), cls:document.getElementById('cur').className})");
await c.shot(`${out}/02-play-10s.png`); step("(1) entrance → enter → 10 s", { readyMs, tier, why, document: doc, ...s1, cursor: cur, ok: s1.T > 8 && !s1.paused });
step("(1b) the pointer rests where the enter button was: no prompt block over the room (the ring, gone after 2 s)", { ...cur, ok: cur.off === true && cur.mode !== "block" });

// ---------- (2) seek 1:00 (the white room) and 3:20
for (const [T, name] of [[60, "03-seek-1m00"], [200, "04-seek-3m20"]]) {
  await c.eval(`__walk.seekTo(${T})`); await sleep(3500); await c.shot(`${out}/${name}.png`);
  { const st = await ev("({T:+__walk.audio.currentTime.toFixed(2), ctx:__walk.ctrl.ctx, paused:__walk.audio.paused})"); step(`(2) seek ${Math.floor(T / 60)}:${String(T % 60).padStart(2, "0")}`, { ...st, ok: st.T > T - 1 && st.T < T + 8 }); }
}

// ---------- (3) epilogue: write → open → again
await c.eval("__walk.seekTo(1e9)"); for (let i = 0; i < 60 && !(await c.eval("!!__walk.epi")); i++) await sleep(500); await sleep(6500);
await c.eval("__walk.stand({x:-0.1,y:1.45,z:-0.5,yaw:0,pitch:-0.1})"); await sleep(2200); await c.shot(`${out}/05-epilogue-fog.png`);
const wp = await ev("__walk.epi.toClient({x:-0.55,y:1.2,z:-1.808})"), gp = await ev("__walk.epi.toClient({x:-0.02,y:1.5,z:-1.808})");
await mouse("mouseMoved", wp.x, wp.y); await mouse("mousePressed", wp.x, wp.y, 1); for (let i = 1; i <= 16; i++) { await mouse("mouseMoved", wp.x + i * 9, wp.y + Math.sin(i / 2) * 14, 1); await sleep(24); } await mouse("mouseReleased", wp.x + 144, wp.y); await sleep(500);
await c.shot(`${out}/06-epilogue-written.png`);
// the sash with the mouse: drag it (u ≈ 0.5), let go (opens), watch it settle
await mouse("mouseMoved", gp.x, gp.y); await mouse("mousePressed", gp.x, gp.y, 1); await sleep(60); for (let i = 1; i <= 12; i++) { await mouse("mouseMoved", gp.x + i * 0.05 * 0.42 * 1440, gp.y, 1); await sleep(25); } await mouse("mouseReleased", gp.x + 0.6 * 0.42 * 1440, gp.y); await sleep(1500);
await c.shot(`${out}/07-epilogue-opening.png`); await sleep(8000); await c.shot(`${out}/08-epilogue-open.png`);
const e3 = await ev("({state:__walk.epi.state, cues:document.getElementById('cues').textContent, canvasCleared:__walk.epi.cv.width})");
const ab = await ev("(()=>{const e=document.querySelector('#cues .act[data-a=again]'); if(!e) return null; const r=e.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}})()");
const o0 = await c.eval("performance.timeOrigin"); if (ab) { await mouse("mouseMoved", ab.x, ab.y); await mouse("mousePressed", ab.x, ab.y, 1); await mouse("mouseReleased", ab.x, ab.y); }
await sleep(1500); await ready(); const reloaded = (await c.eval("performance.timeOrigin")) !== o0; await c.shot(`${out}/09-again-entrance.png`);
step("(3) epilogue: write → open → again", { ...e3, again: !!ab, reloaded, ok: e3.state === "gone" && reloaded });
const cspDesktop = JSON.parse(await c.eval("JSON.stringify(__csp)"));

// ---------- (5) phone emulation: the entrance and 10 s later
await c.emulate(390, 844, 3, true); await c.eval("try{sessionStorage.clear()}catch(e){}"); await go(`${SITE}/?qa=1`); await ready();
const ptier = await c.eval("__walk.tier.name"), pwhy = await c.eval("__walk.tierWhy"); await c.shot(`${out}/10-phone-entrance.png`);
const pb = await ev("(()=>{const r=document.getElementById('enter').getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}})()");
await c.touch("touchStart", [{ x: pb.x, y: pb.y }]); await sleep(60); await c.touch("touchEnd", []); await sleep(10000); await c.shot(`${out}/11-phone-10s.png`);
const ps = await ev("({T:__walk.audio.currentTime, paused:__walk.audio.paused, errs:__walk.errors})"); step("(5) phone (390×844 touch emulation)", { tier: ptier, why: pwhy, ...ps, ok: ps.T > 8 && !ps.paused });
const cspPhone = JSON.parse(await c.eval("JSON.stringify(__csp)"));

// ---------- (4) CSP / failures / off-origin
await c.eval("fetch('https://example.invalid/leak').catch(()=>{})"); await sleep(600); const probe = JSON.parse(await c.eval("JSON.stringify(__csp)")).filter((v) => /example\.invalid/.test(v)).length;
const viol = [...new Set([...cspDesktop, ...cspPhone, ...consoleV])].filter((v) => !/example\.invalid/.test(v));
const hk = (k) => docHeaders && (docHeaders[k] || docHeaders[Object.keys(docHeaders).find((x) => x.toLowerCase() === k)]);
res.headers = Object.fromEntries(["content-security-policy", "x-content-type-options", "referrer-policy", "permissions-policy", "cache-control", "content-type"].map((k) => [k, hk(k) || null]));
res.csp = { cloudflareAnalyticsRequests: [...beacon], violations: viol, enforcedProbeBlocked: probe > 0, failedOrBadRequests: problems, requestsLeavingTheOrigin: [...off].filter((u) => !/example\.invalid/.test(u)), consoleErrors: errors.slice(0, 10), distinctUrls: seen.size };
res.foley = { m4a: [...seen].filter(([u]) => /foley\.m4a/.test(u)) };
fs.writeFileSync(`${out}/live.json`, JSON.stringify(res, null, 1)); console.log(JSON.stringify({ csp: res.csp, headers: res.headers }, null, 1)); c.close();
process.exit(viol.length || problems.length || res.csp.requestsLeavingTheOrigin.length || !probe || res.steps.some((s) => s.ok === false) ? 1 : 0);
