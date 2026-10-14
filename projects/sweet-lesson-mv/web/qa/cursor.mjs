// The cursor (BRIEF §2 v1.1) and "can I still operate it at the end?": real mouse events through CDP, three ways into the epilogue (seek, played to the end, after the log was opened and closed).
//   node web/qa/cursor.mjs → web/review/cursor/*.png, cursor.json   (then: python3 web/qa/cursor-sheet.py)
import fs from "node:fs";
import { connect } from "../tools/cdpkit.mjs";
const root = new URL("../../", import.meta.url).pathname, out = root + "web/review/cursor"; fs.mkdirSync(out, { recursive: true });
const base = "http://127.0.0.1:8731";
const c = await connect(""); const res = { paths: {} }; const shots = [];
const mouse = (type, x, y, extra = {}) => c.send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" ? ((extra.buttons ?? 0) ? "left" : "none") : "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: type === "mouseMoved" ? 0 : 1, pointerType: "mouse", ...extra });
const move = async (x, y) => { await mouse("mouseMoved", x, y); await c.sleep(60); };
const click = async (x, y) => { await move(x, y); await mouse("mousePressed", x, y); await c.sleep(50); await mouse("mouseReleased", x, y); await c.sleep(120); };
const cur = async () => JSON.parse(await c.eval(`JSON.stringify({cls:document.getElementById('cur')&&document.getElementById('cur').className, mode:__walk.cursor.mode, off:document.getElementById('cur').classList.contains('off'), on:document.documentElement.classList.contains('cur-on'), pageCursor:getComputedStyle(document.body).cursor, lock:!!document.pointerLockElement})`));
const shot = async (name, x, y, note) => { await c.sleep(260); await c.shot(`${out}/${name}.png`); shots.push({ name, x, y, note, ...(await cur()) }); };
const centre = async (sel) => JSON.parse(await c.eval(`JSON.stringify((()=>{const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return null; const r=e.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2,w:r.width,h:r.height}})())`));
const topAt = async (x, y) => c.eval(`(()=>{const e=document.elementFromPoint(${x},${y}); return e? (e.id? '#'+e.id : e.tagName.toLowerCase()+(e.className&&e.className.baseVal===undefined?'.'+e.className:'')+(e.dataset&&e.dataset.a?'[data-a='+e.dataset.a+']':'')) : null})()`);
const load = async (q) => { await c.emulate(1440, 900, 2, false); await c.goto(`${base}/walk.html?${q}`); await c.waitReady(); await c.sleep(600); };

// ---------- 1. the entrance and the room
await load("tier=2");
const en = await centre("#enter"); await move(en.x, en.y); await shot("01-gate-block", en.x, en.y, "the entrance's button: the prompt block");
await click(en.x, en.y); await c.eval("__walk.audio.muted=true"); await c.sleep(2500);
await move(760, 380); await shot("02-room-ring", 760, 380, "in the room, just moved: the hollow ring");
await c.sleep(2300); res.ringGoneAfter2s = (await cur()).off; await shot("03-room-ring-gone", 760, 380, "2 s without moving: gone");
await move(780, 400); await mouse("mousePressed", 780, 400); for (let i = 1; i <= 6; i++) { await mouse("mouseMoved", 780 + i * 14, 400 + i * 3, { buttons: 1 }); await c.sleep(30); }
await shot("04-room-drag-hidden", 864, 418, "dragging (looking around): not shown"); res.dragHidden = (await cur()).off; await mouse("mouseReleased", 864, 418); await c.sleep(100);
const cx = await centre("#ctx"); await move(cx.x, cx.y); await shot("05-context-block", cx.x, cx.y, "over 'context n%': the prompt block");
await c.eval("__walk.ui.show()"); await c.sleep(500);
const hit = await centre("#tl .hit"); await move(hit.x + 160, hit.y); await shot("06-timeline-bar", hit.x + 160, hit.y, "over the time line: a 1 px vertical line");
const cc = await centre("#tl .ccbtn"); await move(cc.x, cc.y); await shot("07-cc-block", cc.x, cc.y, "over CC: the prompt block");
await c.eval("__walk.ui.hide()");

// ---------- 2. into the epilogue, three ways; each ends in "again" / "log" being operable with the mouse
async function afterState(label) {
  const r = { label };
  r.again = await centre('#cues .act[data-a="again"]'); r.log = await centre('#cues .act[data-a="log"]');
  r.topAtAgain = r.again && await topAt(r.again.x, r.again.y); r.topAtLog = r.log && await topAt(r.log.x, r.log.y);
  r.cues = await c.eval("document.getElementById('cues').className+' | '+document.getElementById('cues').textContent");
  r.pageState = await cur(); return r;
}
async function toEpilogueAfter(how) {
  if (how === "seek") { await load("auto=1&muted=1&t=20"); await c.sleep(1500); await c.eval("__walk.seekTo(1e9)"); }
  else { await load("auto=1&muted=1&t=209"); await c.eval("__walk.audio.playbackRate=1"); }
  for (let i = 0; i < 60 && !(await c.eval("!!__walk.epi")); i++) await c.sleep(500);
  await c.sleep(6500);
  if (how === "seek") { // also the fogged window itself (writing)
    await c.eval("__walk.stand({x:-0.1,y:1.45,z:-0.5,yaw:0,pitch:-0.1})"); await c.sleep(2200);
    const p = JSON.parse(await c.eval("JSON.stringify(__walk.epi.toClient({x:-0.55,y:1.62,z:-1.808}))")); res.fogPoint = p;
    await move(p.x, p.y); await shot("08-fog-cursor", p.x, p.y, "over the fogged window: the soft circle, the fog beneath it thinner");
    await mouse("mousePressed", p.x, p.y); for (let i = 1; i <= 18; i++) { await mouse("mouseMoved", p.x + i * 6, p.y + Math.sin(i / 2) * 22, { buttons: 1 }); await c.sleep(24); }
    await shot("09-fog-writing", p.x + 108, p.y, "pressed: the circle closes down to the finger and the trace is written"); await mouse("mouseReleased", p.x + 108, p.y); await c.sleep(300);
    res.canOpen = await c.eval("!!__walk.epi.canOpen");
  }
  await c.eval("__walk.epi._autoOpen()"); await c.sleep(8500);
}
for (const how of ["seek", "end"]) {
  await toEpilogueAfter(how);
  const s = await afterState(how); res.paths[how] = s;
  await move(s.again.x, s.again.y); await shot(`10-${how}-again-block`, s.again.x, s.again.y, `${how}: over 'again': the prompt block`);
  await move(s.log.x, s.log.y); await shot(`11-${how}-log-block`, s.log.x, s.log.y, `${how}: over 'log'`);
  if (how === "end") {
    await click(s.log.x, s.log.y); await c.sleep(400); s.logOpened = await c.eval("document.getElementById('log').classList.contains('on')");
    const x = await centre("#log .x"); await move(x.x - 120, x.y + 120); await shot("12-log-ring", x.x - 120, x.y + 120, "inside the log: the ring");
    await move(x.x, x.y); await shot("13-log-close-block", x.x, x.y, "over the log's ×: the prompt block");
    await click(x.x, x.y); await c.sleep(400); s.logClosed = !(await c.eval("document.getElementById('log').classList.contains('on')"));
    s.afterLog = await afterState("after-log"); // path 3: after the log was opened and closed, again is still reachable
    await move(s.afterLog.again.x, s.afterLog.again.y); await shot("14-after-log-again-block", s.afterLog.again.x, s.afterLog.again.y, "after opening and closing the log: 'again' still there, still operable");
  }
  const t0 = await c.eval("performance.timeOrigin"); const a = s.afterLog ? s.afterLog.again : s.again;
  await click(a.x, a.y); await c.sleep(1200); try { await c.waitReady(); } catch { /* not reloaded */ }
  const t1 = await c.eval("performance.timeOrigin"); s.reloadedByClick = t1 !== t0;
}
fs.writeFileSync(`${out}/cursor.json`, JSON.stringify({ ...res, shots }, null, 1)); const expect = { "01-gate-block": "block", "02-room-ring": "ring", "05-context-block": "block", "06-timeline-bar": "bar", "07-cc-block": "block", "08-fog-cursor": "fog", "10-seek-again-block": "block", "13-log-close-block": "block" };
const wrong = shots.filter((s) => expect[s.name] && s.mode !== expect[s.name]).map((s) => s.name); if (!res.ringGoneAfter2s || !res.dragHidden) wrong.push("ring timing"); for (const [k, v] of Object.entries(res.paths)) if (!v.reloadedByClick || !/again/.test(v.topAtAgain || "")) wrong.push("again not operable: " + k);
if (wrong.length) { console.error("CURSOR CHECK FAILED:", wrong.join(", ")); process.exitCode = 1; }
console.log(JSON.stringify({ ...res, shots: shots.map((s) => [s.name, s.mode, s.off, s.on, s.pageCursor]) }, null, 1)); c.close();
