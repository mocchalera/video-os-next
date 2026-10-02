// Phone behaviour, as far as a desktop Chrome can emulate it (device metrics + touch + the iPhone-like tier choice). NOT a substitute for the real iPhone.
//   node web/qa/mobile.mjs [--base http://127.0.0.1:8731]   → web/review/m3/mobile/*.jpg, mobile.json
import fs from "node:fs";
import { connect } from "../tools/cdpkit.mjs";
const root = new URL("../../", import.meta.url).pathname, out = root + "web/review/m3/mobile"; fs.mkdirSync(out, { recursive: true });
const arg = (n, d) => { const i = process.argv.indexOf(n); return i < 0 ? d : process.argv[i + 1]; };
const base = arg("--base", "http://127.0.0.1:8731");
const c = await connect(""); const res = {};
const st = () => c.eval("JSON.stringify(__walk.state())").then(JSON.parse);
// ---- portrait phone
await c.emulate(390, 844, 3, true); await c.eval("try{sessionStorage.clear()}catch(e){}");
await c.goto(`${base}/walk.html`); await c.waitReady(); await c.sleep(600);
res.entrance = JSON.parse(await c.eval("JSON.stringify({tier:__walk.tier.name, why:__walk.tierWhy, internal:[__walk.shim.W,__walk.shim.H], bench:__walk.bench, aspect:__walk.P.viewAspect, btnDisabled:document.getElementById('enter').disabled, errs:__walk.errors, status:document.getElementById('gate-status').textContent})"));
await c.shot(`${out}/01-entrance-portrait.jpg`);
const b = JSON.parse(await c.eval("JSON.stringify((()=>{const r=document.getElementById('enter').getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}})())"));
await c.tap(b.x, b.y); await c.sleep(2500); await c.eval("__walk.audio.muted=true");
res.afterEnter = await st(); await c.shot(`${out}/02-flow-portrait.jpg`);
await c.eval("(async()=>{__walk.pause(); await __walk.seek(118); await new Promise(r=>setTimeout(r,800)); return 1})()"); await c.sleep(400); await c.shot(`${out}/03-flow-portrait-t118.jpg`);
res.fovBoost = JSON.parse(await c.eval("JSON.stringify({aspect:__walk.P.viewAspect, fovOut:__walk.ctrl.last.fov})"));
// tap → the time line (after 300 ms), touch look, two fingers walk, double tap on the floor
await c.eval("(async()=>{await __walk.seek(20); await __walk.play(); return 1})()"); await c.sleep(600);
await c.tap(195, 300); await c.sleep(700); res.tapShowsTimeline = await c.eval("__walk.ui.visible"); await c.shot(`${out}/04-timeline-portrait.jpg`); await c.tap(195, 300); await c.sleep(700);
await c.touch("touchStart", [{ x: 100, y: 400 }]); for (let i = 1; i <= 10; i++) { await c.touch("touchMove", [{ x: 100 + i * 18, y: 400 }]); await c.sleep(16); } await c.touch("touchEnd", []); await c.sleep(300); res.afterLook = await st();
await c.touch("touchStart", [{ x: 150, y: 600 }, { x: 240, y: 600 }]); for (let i = 1; i <= 20; i++) { await c.touch("touchMove", [{ x: 150, y: 600 - i * 4 }, { x: 240, y: 600 - i * 4 }]); await c.sleep(40); } res.twoFingersHeld = await st(); await c.touch("touchEnd", []); await c.sleep(900);
const pos0 = (await st()).pos; await c.tap(195, 700); await c.sleep(110); await c.tap(196, 701); await c.sleep(2500); const pos1 = (await st()).pos; res.doubleTapFloor = { from: pos0.map((v) => +v.toFixed(2)), to: pos1.map((v) => +v.toFixed(2)), movedM: +Math.hypot(pos1[0] - pos0[0], pos1[2] - pos0[2]).toFixed(2) };
await c.shot(`${out}/05-after-walk-portrait.jpg`);
// the epilogue on a phone
await c.eval("(async()=>{__walk.pause(); __walk.startEpilogue(); return 1})()"); await c.sleep(6500); await c.eval("__walk.stand({x:-0.1,y:1.45,z:-0.5,yaw:0,pitch:-0.1})"); await c.sleep(2500); await c.shot(`${out}/06-epilogue-portrait.jpg`);
res.epilogueCue = await c.eval("__walk.getCueText()");
// ---- landscape phone
await c.emulate(844, 390, 3, true); await c.eval("try{sessionStorage.clear()}catch(e){}"); await c.goto(`${base}/walk.html?auto=1&muted=1&t=118`); await c.waitReady(); await c.sleep(1500); await c.shot(`${out}/07-landscape.jpg`);
res.landscape = JSON.parse(await c.eval("JSON.stringify({tier:__walk.tier.name, aspect:__walk.P.viewAspect, fovOut:__walk.ctrl.last && __walk.ctrl.last.fov, errs:__walk.errors})"));
// ---- reduced motion
await c.emulate(1440, 900, 2, false); await c.goto(`${base}/walk.html?auto=1&muted=1&t=20&tier=0`); await c.waitReady(); await c.media(true); await c.sleep(800);
res.reducedMotion = JSON.parse(await c.eval("JSON.stringify({reduced:__walk.P.reduced, handheld:__walk.shim.dbg.web.handheld, flashScale:__walk.shim.dbg.web.flashScale})"));
await c.media(false); await c.sleep(300);
fs.writeFileSync(`${out}/mobile.json`, JSON.stringify(res, null, 1)); console.log(JSON.stringify(res, null, 1)); c.close();
