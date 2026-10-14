// Keyboard only, to the end — with prefers-reduced-motion on. Real key events through CDP; no mouse, no touch.
//   node web/qa/keyboard.mjs → web/review/m3/keyboard.json
import fs from "node:fs";
import { connect } from "../tools/cdpkit.mjs";
const root = new URL("../../", import.meta.url).pathname;
const base = "http://127.0.0.1:8731"; const c = await connect(""); const res = { steps: [] };
const st = () => c.eval("JSON.stringify(__walk.state())").then(JSON.parse);
const ok = (name, pass, info) => { res.steps.push({ name, pass: !!pass, info }); console.log(pass ? "ok  " : "FAIL", name, info ?? ""); };
const hold = async (code, ms) => { await c.key(code, true); await c.sleep(ms); await c.key(code, false); };
await c.emulate(1440, 900, 2, false); await c.media(true);
await c.goto(`${base}/walk.html?tier=2`); await c.waitReady(); await c.sleep(600);
ok("reduced-motion detected", await c.eval("__walk.P.reduced"), await c.eval("JSON.stringify({handheld:__walk.shim.dbg.web.handheld, flash:__walk.shim.dbg.web.flashScale})"));
ok("the entrance button has the focus (Enter enters)", await c.eval("document.activeElement && document.activeElement.id === 'enter'"));
await c.key("Enter"); await c.sleep(2500); await c.eval("__walk.audio.muted=true");
let s = await st(); ok("Enter started the song", s.T > 1 && !(await c.eval("__walk.audio.paused")), `T=${s.T.toFixed(1)}`);
await c.eval("(async()=>{ await __walk.seek(20); return 1 })()"); await c.sleep(800);
const p0 = (await st()).pos; await hold("KeyW", 1200); await c.sleep(300); s = await st(); const d1 = Math.hypot(s.pos[0] - p0[0], s.pos[2] - p0[2]); ok("W walks", d1 > 0.5, `moved ${d1.toFixed(2)} m`);
const p1 = s.pos; await hold("ArrowDown", 600); await c.sleep(300); s = await st(); ok("ArrowDown walks back", Math.hypot(s.pos[0] - p1[0], s.pos[2] - p1[2]) > 0.2);
const y0 = (await st()).yaw; await c.key("Shift", true).catch(() => {}); await c.send("Input.dispatchKeyEvent", { type: "rawKeyDown", code: "ShiftLeft", key: "Shift", windowsVirtualKeyCode: 16, modifiers: 8 });
for (let i = 0; i < 6; i++) { await c.send("Input.dispatchKeyEvent", { type: "rawKeyDown", code: "ArrowLeft", key: "ArrowLeft", windowsVirtualKeyCode: 37, modifiers: 8 }); await c.send("Input.dispatchKeyEvent", { type: "keyUp", code: "ArrowLeft", key: "ArrowLeft", windowsVirtualKeyCode: 37, modifiers: 8 }); await c.sleep(60); }
await c.send("Input.dispatchKeyEvent", { type: "keyUp", code: "ShiftLeft", key: "Shift", windowsVirtualKeyCode: 16 }); await c.sleep(400);
s = await st(); ok("Shift+Arrow looks (turns the view)", Math.abs(s.yaw - y0) > 0.1, `yaw ${y0.toFixed(2)} → ${s.yaw.toFixed(2)}`);
const yq = s.yaw; await hold("KeyE", 500); await c.sleep(300); s = await st(); ok("E turns", Math.abs(s.yaw - yq) > 0.05);
await c.key("KeyT"); await c.sleep(500); ok("T shows the time line", await c.eval("__walk.ui.visible")); await c.key("KeyT"); await c.sleep(300);
let T0 = (await st()).T; await c.key("BracketRight"); await c.sleep(700); let T1 = (await st()).T; ok("] seeks +10 s", T1 - T0 > 8, `${T0.toFixed(1)} → ${T1.toFixed(1)}`);
await c.key("BracketLeft"); await c.sleep(700); let T2 = (await st()).T; ok("[ seeks −10 s", T1 - T2 > 8, `${T1.toFixed(1)} → ${T2.toFixed(1)}`);
await c.key("KeyC"); await c.sleep(300); ok("C cycles the captions", (await c.eval("__walk.ui.cc")) !== "off", await c.eval("__walk.ui.cc")); await c.key("KeyC"); await c.key("KeyC"); await c.sleep(200);
await c.key("Space"); await c.sleep(400); const paused = await c.eval("__walk.audio.paused"); await c.key("Space"); await c.sleep(400); ok("Space pauses and resumes", paused && !(await c.eval("__walk.audio.paused")));
await c.key("KeyM"); await c.sleep(200); ok("M toggles mute", (await c.eval("__walk.audio.muted")) === false); await c.key("KeyM");
// to the end by the clock: let the song's last seconds play (the one thing a keyboard cannot skip is time), then the epilogue
await c.eval("__walk.seekTo(1e9)"); for (let i = 0; i < 40 && !(await c.eval("!!__walk.epi")); i++) await c.sleep(500);
ok("the song ended into the epilogue", await c.eval("!!__walk.epi")); await c.sleep(7000);
const pe = (await st()).pos; await hold("KeyW", 700); await c.sleep(300); ok("walking in the epilogue (keys)", Math.hypot((await st()).pos[0] - pe[0], (await st()).pos[2] - pe[2]) > 0.1);
await c.key("Enter"); await c.sleep(9000); ok("Enter opens the window", await c.eval("__walk.epi.state === 'gone'"), await c.eval("__walk.epi.state"));
ok("again / log appear", (await c.eval("document.getElementById('cues').textContent")).includes("again"), await c.eval("document.getElementById('cues').textContent"));
await c.key("KeyL"); await c.sleep(500); ok("L opens the log", await c.eval("document.getElementById('log').classList.contains('on')"));
await c.key("Escape"); await c.sleep(400); ok("Escape closes the log", !(await c.eval("document.getElementById('log').classList.contains('on')")));
const t0 = await c.eval("performance.timeOrigin"); await c.key("KeyR"); await c.sleep(1500); try { await c.waitReady(); } catch { /* */ } ok("R starts again", (await c.eval("performance.timeOrigin")) !== t0);
await c.media(false);
res.allPass = res.steps.every((x) => x.pass); fs.writeFileSync(root + "web/review/m3/keyboard.json", JSON.stringify(res, null, 1)); console.log(res.allPass ? "ALL PASS" : "SOME FAILED"); c.close(); process.exit(res.allPass ? 0 : 1);
