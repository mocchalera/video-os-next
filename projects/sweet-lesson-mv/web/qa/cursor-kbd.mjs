// Keyboard focus in the cursor's words, and "no cursor on a touch screen". node web/qa/cursor-kbd.mjs → web/review/cursor/kbd-*.png, cursor-kbd.json
import fs from "node:fs";
import { connect } from "../tools/cdpkit.mjs";
const root = new URL("../../", import.meta.url).pathname, out = root + "web/review/cursor";
const base = "http://127.0.0.1:8731"; const c = await connect(""); const res = {};
const tab = async () => { await c.send("Input.dispatchKeyEvent", { type: "rawKeyDown", code: "Tab", key: "Tab", windowsVirtualKeyCode: 9 }); await c.send("Input.dispatchKeyEvent", { type: "keyUp", code: "Tab", key: "Tab", windowsVirtualKeyCode: 9 }); await c.sleep(300); };
const focusInfo = () => c.eval("(()=>{const e=document.activeElement; return e? (e.id||e.className||e.tagName)+' | '+e.textContent.slice(0,20)+' | focus-visible='+e.matches(':focus-visible')+' | outline='+getComputedStyle(e).outlineStyle : null})()");
const rectOf = (sel) => c.eval(`(()=>{const r=document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
// keyboard: the entrance, the CC button, the epilogue's again/log
await c.emulate(1440, 900, 2, false); await c.goto(`${base}/walk.html?tier=2`); await c.waitReady(); await c.sleep(800);
res.gate = await focusInfo(); await c.shot(`${out}/kbd-1-gate.png`); res.gateAt = await rectOf("#enter");
await c.key("Enter"); await c.sleep(2500); await c.eval("__walk.audio.muted=true"); res.afterEnter = await c.eval("JSON.stringify({T:__walk.audio.currentTime, paused:__walk.audio.paused, gate:getComputedStyle(document.getElementById('gate')).display})"); console.log(JSON.stringify(res));
await c.key("KeyT"); await c.sleep(600); await tab(); await tab(); res.cc = await focusInfo(); res.ccAt = await rectOf("#tl .ccbtn"); await c.shot(`${out}/kbd-2-cc.png`);
await c.eval("document.activeElement.blur()"); await c.eval("__walk.seekTo(1e9)"); for (let i = 0; i < 40 && !(await c.eval("!!__walk.epi")); i++) await c.sleep(500);
await c.sleep(500); await c.eval("__walk.epi._autoOpen()"); await c.sleep(8500);
for (let i = 0; i < 5 && !(await c.eval("document.activeElement && document.activeElement.dataset && document.activeElement.dataset.a === 'again'")); i++) await tab(); res.again = await focusInfo(); res.againAt = await rectOf('#cues .act[data-a="again"]'); await c.shot(`${out}/kbd-3-again.png`);
await tab(); res.log = await focusInfo(); console.log(JSON.stringify(res)); res.logAt = await rectOf('#cues .act[data-a="log"]'); await c.shot(`${out}/kbd-4-log.png`);
await c.key("Enter"); await c.sleep(500); res.logOpenedByEnter = await c.eval("document.getElementById('log').classList.contains('on')"); res.focusInLog = await focusInfo(); res.xAt = await rectOf("#log .x"); await c.shot(`${out}/kbd-5-log-x.png`);
await c.key("Enter"); await c.sleep(400); res.logClosedByEnter = !(await c.eval("document.getElementById('log').classList.contains('on')"));
// touch: no cursor
await c.emulate(390, 844, 3, true); await c.goto(`${base}/walk.html?tier=4`); await c.waitReady(); await c.sleep(600);
const b = await rectOf("#enter"); await c.tap(b.x, b.y); await c.sleep(2000);
await c.tap(195, 400); await c.sleep(500); await c.touch("touchStart", [{ x: 100, y: 400 }]); for (let i = 1; i <= 8; i++) { await c.touch("touchMove", [{ x: 100 + i * 14, y: 400 }]); await c.sleep(20); } await c.touch("touchEnd", []);
res.touch = JSON.parse(await c.eval("JSON.stringify({curOff:document.getElementById('cur').classList.contains('off'), htmlCurOn:document.documentElement.classList.contains('cur-on'), alive:__walk.cursor.alive})"));
fs.writeFileSync(`${out}/cursor-kbd.json`, JSON.stringify(res, null, 1)); console.log(JSON.stringify(res, null, 1)); c.close();
