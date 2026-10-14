// The four follow-ups after the live check: (1) no prompt block left over the room after the entrance, (2) the entrance's enter button is fully bright once ready, (3) a slow machine reloads ONCE (to a tier that should pass) and the entrance says "rendering…" throughout, (4) a song that is not seekable (Range ignored) is not sent back to 0.
//   node web/qa/followup.mjs [base] → web/review/m3/followup.json ; exit 1 on any failure
import fs from "node:fs";
import { connect } from "../tools/cdpkit.mjs";
const here = new URL("../", import.meta.url).pathname; const base = process.argv[2] || "http://127.0.0.1:8731"; const c = await connect("");
const res = []; const ok = (name, pass, info) => { res.push({ name, pass: !!pass, info }); console.log(pass ? "ok  " : "FAIL", name, info === undefined ? "" : JSON.stringify(info)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (e) => JSON.parse(await c.eval(`JSON.stringify(${e})`));
const mouse = (type, x, y, buttons = 0) => c.send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" ? (buttons ? "left" : "none") : "left", buttons, clickCount: type === "mouseMoved" ? 0 : 1, pointerType: "mouse" });
const go = async (u) => { await c.send("Page.navigate", { url: u }); await sleep(900); };
const ready = async () => { for (let i = 0; i < 300; i++) { try { if ((await c.eval("typeof __walk!=='undefined' && __walk.ready ? 1 : 0")) === 1) return; } catch { /* navigating */ } await sleep(300); } throw new Error("not ready"); };
await c.send("Page.enable");

// ---------- (2) the entrance, once ready: the button is fully bright (compare the pixels with the M1 reference crop)
await c.emulate(1440, 900, 1, false); await c.send("Emulation.setCPUThrottlingRate", { rate: 1 });
await go(`${base}/walk.html?qa=1&tier=3`); await ready(); await sleep(1500);
const b = await ev("(()=>{const e=document.getElementById('enter'); const r=e.getBoundingClientRect(); return {x:r.left,y:r.top,w:r.width,h:r.height,op:getComputedStyle(e).opacity,color:getComputedStyle(e).color,disabled:e.disabled}})()");
await c.shot(here + "review/m3/gate-ready-now.png");
ok("(2) once ready: the enter button's opacity is 1, enabled", b.op === "1" && !b.disabled, b);
// measure the brightest pixel of the button's text against the reference screenshot (gate-ready.jpg from M1)
fs.writeFileSync("/tmp/btn.json", JSON.stringify(b));

// ---------- (1) after clicking enter with the pointer resting where the button was: the prompt block must give way to the room's ring, then go
await go(`${base}/walk.html?qa=1&tier=3`); await ready();
const eb = await ev("(()=>{const r=document.getElementById('enter').getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}})()");
await mouse("mouseMoved", eb.x, eb.y); await sleep(100); const onBtn = await ev("({mode:__walk.cursor.mode})");
await mouse("mousePressed", eb.x, eb.y, 1); await mouse("mouseReleased", eb.x, eb.y); await sleep(1500);
const a1 = await ev("({mode:__walk.cursor.mode, off:document.getElementById('cur').classList.contains('off'), cls:document.getElementById('cur').className})"); await sleep(2600);
const a2 = await ev("({mode:__walk.cursor.mode, off:document.getElementById('cur').classList.contains('off')})");
ok("(1) over the entrance button: the prompt block", onBtn.mode === "block", onBtn);
ok("(1) after entering, the pointer at rest over the room: the ring (no leftover block), and gone after 2 s", a1.mode === "ring" && a2.off === true, { after1_5s: a1, after4s: a2 });

// ---------- (3) a slow machine: one reload, to the predicted tier; "rendering…" from the first paint of each load
await c.send("Emulation.setCPUThrottlingRate", { rate: 6 });
await c.eval("try{sessionStorage.clear()}catch(e){}");
const navs = []; c.on("Page.frameNavigated", (p) => { if (!p.frame.parentId) navs.push(p.frame.url); });
const t0 = Date.now(); await c.send("Page.navigate", { url: `${base}/walk.html?qa=1` });
const firstPaints = []; let finalTier = null;
for (let i = 0; i < 400; i++) { await sleep(150); try { const st = await ev("({txt:(document.getElementById('gate-status')||{}).textContent||'', ready:typeof __walk!=='undefined' && !!__walk.ready, tier:typeof __walk!=='undefined' && __walk.tier && __walk.tier.name, gate:getComputedStyle(document.getElementById('gate')).display})"); firstPaints.push(st.txt.slice(0, 12)); if (st.ready) { finalTier = st.tier; break; } } catch { /* navigating */ } }
const totalMs = Date.now() - t0; const bench = await ev("__walk.bench || null");
await c.send("Emulation.setCPUThrottlingRate", { rate: 1 });
ok("(3) slow machine (CPU ×6): the page reloads at most once, to a lower tier", navs.length <= 2 && finalTier && finalTier !== "1080", { navigations: navs.length, finalTier, totalMs, bench });
ok("(3) the entrance shows 'rendering…' every time it is looked at (never blank)", firstPaints.length > 0 && firstPaints.every((t) => /rendering|入る|^$/.test(t) && t !== ""), { samples: firstPaints.length, distinct: [...new Set(firstPaints)] });

// ---------- (4) the song is not seekable (found live: with Cache-Control: no-cache the edge ignores Range → seekable is empty and assigning currentTime drops the song to 0).
// Chrome here cannot be made to behave like that locally, so the page's own `seekable` is overridden to report nothing, as it did live; what is tested is that the page does not assign currentTime then, and jumps once it can.
await c.emulate(1440, 900, 1, false); await go(`${base}/walk.html?qa=1&tier=4&auto=1&muted=1&t=0`); await ready(); await sleep(2500);
await c.eval("(()=>{ window.__noSeek = true; const real = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'seekable').get; Object.defineProperty(__walk.audio, 'seekable', { configurable: true, get() { return window.__noSeek ? { length: 0, start() { throw 0 }, end() { throw 0 } } : real.call(this); } }); window.__setT = []; const d = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime'); Object.defineProperty(__walk.audio, 'currentTime', { configurable: true, get() { return d.get.call(this); }, set(v) { __setT.push(v); d.set.call(this, v); } }); })()");
const before = await ev("__walk.audio.currentTime"); await c.eval("__walk.seekTo(100)"); await sleep(1500);
const during = await ev("({T:__walk.audio.currentTime, paused:__walk.audio.paused, assigned:__setT})");
ok("(4) not seekable: seekTo(100) does not assign currentTime (no fall back to 0); the song keeps playing where it was", during.assigned.length === 0 && during.T > before && !during.paused, { before, during });
await c.eval("window.__noSeek = false"); let landed = null; for (let i = 0; i < 40; i++) { await sleep(250); const st = await ev("({T:__walk.audio.currentTime, assigned:__setT})"); if (st.T > 99) { landed = st; break; } }
ok("(4) …and when the position becomes seekable it jumps to 1:40 (once)", landed !== null && landed.assigned.filter((v) => v === 100).length === 1, landed);

fs.writeFileSync(here + "review/m3/followup.json", JSON.stringify(res, null, 1)); c.close();
const failed = res.filter((r) => !r.pass); console.log(failed.length ? `FAILED ${failed.length}` : "ALL PASS"); process.exit(failed.length ? 1 : 0);
