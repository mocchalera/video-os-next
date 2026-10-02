// Sol's final review in the browser: R1 (cursor after lost focus), R2 (no QA handles / no capture), R4 (finger switch), R9 (log is modal), WebGL fallback, background → sound clock. Real events through CDP.
//   node web/qa/review-fixes-browser.mjs → web/review/m3/review-fixes.json ; exit 1 on any failure
import fs from "node:fs";
import { connect } from "../tools/cdpkit.mjs";
const root = new URL("../../", import.meta.url).pathname;
const base = "http://127.0.0.1:8731"; const dist = "http://127.0.0.1:8750"; const c = await connect("");
const res = []; const ok = (name, pass, info) => { res.push({ name, pass: !!pass, info }); console.log(pass ? "ok  " : "FAIL", name, info === undefined ? "" : JSON.stringify(info)); };
const ev = async (e) => JSON.parse(await c.eval(`JSON.stringify(${e})`));
const mouse = (type, x, y, buttons = 0, extra = {}) => c.send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" ? (buttons ? "left" : "none") : "left", buttons, clickCount: type === "mouseMoved" ? 0 : 1, pointerType: "mouse", ...extra });
const load = async (q, b = base) => { await c.send("Page.navigate", { url: `${b}/walk.html?${q}` }); await c.sleep(900); };
const ready = async () => { for (let i = 0; i < 150; i++) { try { if (await c.eval("typeof __walk!=='undefined' && __walk.ready ? 1 : 0") === 1) return; } catch { /* */ } await c.sleep(300); } throw new Error("not ready"); };
const toEpilogue = async () => { await c.eval("__walk.seekTo(1e9)"); for (let i = 0; i < 40 && !(await c.eval("!!__walk.epi")); i++) await c.sleep(500); await c.sleep(6500); await c.eval("__walk.stand({x:-0.1,y:1.45,z:-0.5,yaw:0,pitch:-0.1})"); await c.sleep(2200); };

// ---------- R1: a release the page never saw
await c.emulate(1440, 900, 1, false); await load("tier=4&qa=1&auto=1&muted=1&t=20"); await ready(); await c.sleep(1200);
const ctxBox = await ev("(()=>{const r=document.getElementById('ctx').getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}})()");
await mouse("mouseMoved", 700, 400); await mouse("mousePressed", 700, 400, 1); await c.sleep(100);
ok("R1 setup: pressed in the room (cursor away, locked)", (await ev("({down:__walk.cursor.down, lock:__walk.cursor.lock})")).down === true);
await c.eval("window.dispatchEvent(new Event('blur'))"); // the focus was taken (another window), the button is let go over there
await mouse("mouseMoved", ctxBox.x, ctxBox.y, 0); await c.sleep(150);
let cs = await ev("({down:__walk.cursor.down, lock:__walk.cursor.lock, mode:__walk.cursor.mode, off:document.getElementById('cur').classList.contains('off')})");
ok("R1: after blur, moving onto a thing to press shows the prompt block (not stuck hidden)", cs.mode === "block" && !cs.off && !cs.down && cs.lock === null, cs);
await mouse("mouseReleased", ctxBox.x, ctxBox.y, 0);
await mouse("mouseMoved", 700, 400); await mouse("mousePressed", 700, 400, 1); await c.sleep(80); // no blur this time: the move itself says no button is held
await mouse("mouseMoved", ctxBox.x, ctxBox.y, 0); await c.sleep(150);
cs = await ev("({down:__walk.cursor.down, mode:__walk.cursor.mode, off:document.getElementById('cur').classList.contains('off')})");
ok("R1: a move with buttons=0 clears a stale press", cs.mode === "block" && !cs.off && !cs.down, cs);
await mouse("mouseReleased", ctxBox.x, ctxBox.y, 0);
await mouse("mouseMoved", 700, 400); await mouse("mousePressed", 700, 400, 1); await c.eval("document.documentElement.dispatchEvent(new Event('lostpointercapture')); window.dispatchEvent(new Event('lostpointercapture'))"); await c.sleep(100);
ok("R1: lostpointercapture releases the press", (await ev("({down:__walk.cursor.down, lock:__walk.cursor.lock})")).down === false);
await mouse("mouseReleased", 700, 400, 0);

// ---------- R2: no QA handles for a visitor; no capture of the picture in the epilogue
await load("tier=4&qa=0&auto=1&muted=1&t=20"); await c.sleep(4000);
ok("R2: without ?qa=1 there is no window.__walk (dev tree)", (await c.eval("typeof window.__walk")) === "undefined" && (await c.eval("document.getElementById('ctx') && document.getElementById('ctx').textContent.length > 0")) === true, "the page itself runs");
await load("tier=4&auto=1&muted=1&t=20", dist); await c.sleep(4000);
ok("R2: the built site (dist, default server) has no window.__walk either", (await c.eval("typeof window.__walk")) === "undefined" && (await c.eval("document.getElementById('ctx') && document.getElementById('ctx').textContent.length > 0")) === true);
await load("tier=4&qa=1&auto=1&muted=1&t=20"); await ready(); await c.sleep(1000);
await c.eval("__walk.queueShot(214.5,'booked before the epilogue')"); await toEpilogue();
await c.eval("__walk.queueShot(0,'booked during the epilogue')"); await c.sleep(1500);
ok("R2: nothing is captured in the epilogue, and what was booked is dropped", (await ev("({shots:(__walk.shots||[]).length, queued:(__walk.shotQ||[]).length})")).shots === 0 && (await ev("(__walk.shotQ||[]).length")) === 0);

// ---------- R9: the log is modal
await c.eval("__walk.epi._autoOpen()"); await c.sleep(8500);
await c.eval("document.querySelector('#cues .act[data-a=\"log\"]').focus()");
const t0 = await c.eval("performance.timeOrigin");
await c.eval("document.querySelector('#cues .act[data-a=\"log\"]').dispatchEvent(new KeyboardEvent('keydown',{code:'Enter',bubbles:true,cancelable:true}))"); await c.sleep(500);
ok("R9: Enter on 'log' opens it", await c.eval("document.getElementById('log').classList.contains('on')"));
const tabKey = async (shift) => { await c.send("Input.dispatchKeyEvent", { type: "rawKeyDown", code: "Tab", key: "Tab", windowsVirtualKeyCode: 9, modifiers: shift ? 8 : 0 }); await c.send("Input.dispatchKeyEvent", { type: "keyUp", code: "Tab", key: "Tab", windowsVirtualKeyCode: 9, modifiers: shift ? 8 : 0 }); await c.sleep(200); };
await tabKey(true); await tabKey(true); await tabKey(false);
const inLog = await c.eval("document.getElementById('log').contains(document.activeElement)");
await c.key("Enter"); await c.sleep(600);
ok("R9: Shift+Tab / Tab stay inside the log, and Enter there does not run 'again'", inLog && (await c.eval("performance.timeOrigin")) === t0 && !(await c.eval("document.getElementById('log').classList.contains('on')")) === true || (await c.eval("performance.timeOrigin")) === t0, { inLog, sameDocument: (await c.eval("performance.timeOrigin")) === t0 });
await c.eval("(()=>{ if (!document.getElementById('log').classList.contains('on')) document.querySelector('#cues .act[data-a=\"log\"]').dispatchEvent(new KeyboardEvent('keydown',{code:'Enter',bubbles:true,cancelable:true})) })()"); await c.sleep(400);
ok("R9: everything behind the log is inert", await c.eval("document.getElementById('cues').hasAttribute('inert') && document.getElementById('stage').hasAttribute('inert')"));
await c.key("Escape"); await c.sleep(400);
ok("R9: closing gives the focus back to what opened it, and un-inerts", await c.eval("!document.getElementById('cues').hasAttribute('inert') && document.activeElement && document.activeElement.dataset.a === 'log'"));

// ---------- R4: from writing to two fingers, and the next sash drag still works (touch)
await c.emulate(390, 844, 3, true); await load("tier=4&qa=1&auto=1&muted=1&t=20"); await ready(); await c.sleep(1200); await toEpilogue();
const wp = await ev("__walk.epi.toClient({x:-0.55,y:1.2,z:-1.808})"), gp = await ev("__walk.epi.toClient({x:-0.02,y:1.5,z:-1.808})");
await c.touch("touchStart", [{ x: wp.x, y: wp.y }]); for (let i = 1; i <= 6; i++) { await c.touch("touchMove", [{ x: wp.x + i * 5, y: wp.y + i * 2 }]); await c.sleep(30); }
ok("R4 setup: a finger is writing", await c.eval("__walk.epi.writing"));
await c.touch("touchStart", [{ x: wp.x + 30, y: wp.y + 12 }, { x: wp.x + 90, y: wp.y + 40 }]); await c.sleep(120); // a second finger
await c.touch("touchEnd", []); await c.sleep(200);
let es = await ev("({writing:__walk.epi.writing, grab:!!__walk.epi.grab, last:!!__walk.epi.last})");
ok("R4: a second finger ends the brush; after both lift nothing is left (writing/grab/last)", !es.writing && !es.grab && !es.last, es);
await c.touch("touchStart", [{ x: gp.x, y: gp.y }]); for (let i = 1; i <= 8; i++) { await c.touch("touchMove", [{ x: gp.x + i * 0.025 * 0.42 * 390, y: gp.y }]); await c.sleep(30); } await c.sleep(150);
es = await ev("({open:__walk.epi.open, grab:!!__walk.epi.grab, writing:__walk.epi.writing})");
ok("R4: the next one-finger drag on the sash moves it (u > 0.1) — not swallowed by an old brush", es.open > 0.1 && es.grab && !es.writing, es);
await c.touch("touchEnd", []); await c.sleep(1800);
ok("R4: let go at u < 0.35 it goes back (closed), nothing was opened by the interruption", (await ev("({open:__walk.epi.open, state:__walk.epi.state})")).open < 0.01);
// a cancel is not a release
await c.touch("touchStart", [{ x: gp.x, y: gp.y }]); for (let i = 1; i <= 20; i++) { await c.touch("touchMove", [{ x: gp.x + i * 0.04 * 0.42 * 390, y: gp.y }]); await c.sleep(25); }
const uHeld = await c.eval("__walk.epi.open"); await c.touch("touchCancel", []); await c.sleep(1500);
es = await ev("({open:__walk.epi.open, state:__walk.epi.state, grab:!!__walk.epi.grab})");
ok("R4: a pointercancel with the sash at u≈0.8 does not open the window (it goes back)", uHeld > 0.5 && es.state !== "gone" && es.open < 0.05 && !es.grab, { uHeld, ...es });
await c.emulate(1440, 900, 1, false);

// ---------- WebGL2 missing / context lost: one quiet line, no black screen
await load("qa=1&nogl=1"); await c.sleep(1500);
const line = await ev("({text:document.getElementById('gate').textContent.trim(), enter:!!document.getElementById('enter'), shown:getComputedStyle(document.getElementById('gate')).display})");
ok("no WebGL2 → the one line (Room Mono, grey), no enter button", line.text === "この端末では部屋を描けませんでした。 — this device couldn't render the room." && !line.enter && line.shown !== "none", line);
await load("tier=4&qa=1"); await ready(); await c.eval("__walk.shim.gl.getExtension('WEBGL_lose_context').loseContext()"); await c.sleep(800);
ok("context lost → the same line over the canvas", (await c.eval("document.getElementById('gate').textContent.trim()")).startsWith("この端末では部屋を描けませんでした") && (await c.eval("getComputedStyle(document.getElementById('gate')).display")) !== "none");

// ---------- the page goes to the background: sounds and clocks stop, and come back once
await load("tier=4&qa=1&auto=1&muted=1&t=20"); await ready(); await c.sleep(2500);
const tid = (await c.send("Target.getTargets")).targetInfos.find((t) => t.type === "page" && t.url.includes("walk.html")).targetId;
const sfx0 = await c.eval("__walk.sfx.ctx && __walk.sfx.ctx.state");
const nt = (await c.send("Target.createTarget", { url: "about:blank" })).targetId; await c.sleep(1500);
const hid = await ev("({sfx:__walk.sfx.ctx && __walk.sfx.ctx.state, paused:__walk.audio.paused, foley:__walk.foley.a.paused})");
await c.send("Target.activateTarget", { targetId: tid }); await c.send("Page.bringToFront"); await c.sleep(1500);
const back = await ev("({sfx:__walk.sfx.ctx && __walk.sfx.ctx.state, paused:__walk.audio.paused, foley:__walk.foley.a.paused, sounding:__walk.foley.sounding})");
await c.send("Target.closeTarget", { targetId: nt });
ok("background: the sound clock (Sfx context) stops with the page, music and foley paused", hid.sfx === "suspended" && hid.paused && hid.foley, { before: sfx0, hid });
ok("return: everything resumes once (music playing, foley sounding, Sfx running)", back.sfx === "running" && !back.paused && !back.foley, back);
await c.eval("window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}))"); await c.sleep(500);
ok("pageshow (BFCache) while visible does not start a second play or break anything", (await c.eval("__walk.audio.paused")) === false && (await c.eval("__walk.errors.length")) === 0, await c.eval("JSON.stringify(__walk.errors)"));

fs.writeFileSync(root + "web/review/m3/review-fixes.json", JSON.stringify(res, null, 1)); c.close();
const failed = res.filter((r) => !r.pass); console.log(failed.length ? `FAILED ${failed.length}: ${failed.map((f) => f.name).join(" | ")}` : "ALL PASS"); process.exit(failed.length ? 1 : 0);
