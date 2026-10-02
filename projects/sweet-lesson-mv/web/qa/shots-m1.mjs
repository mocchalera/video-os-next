// Acceptance screenshots for M1: scripted viewer (keys / drags) in real time, frames captured as drawn.
// node web/qa/shots-m1.mjs  → web/review/m1/shots/<scenario>/NN-label.jpg + meta.json
import { execFileSync } from "node:child_process";
import fs from "node:fs";
const root = new URL("../../", import.meta.url).pathname;
const cdp = (...a) => execFileSync("node", ["web/tools/cdp.mjs", ...a], { encoding: "utf8", cwd: root, maxBuffer: 1 << 29 }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// steps: [T, "js to run when the song clock reaches T"]; shots: [T, label]
const SCEN = {
  "room-walk-night": { from: 12.0, until: 24.5, shots: [[12.3, "flow (before)"], [13.6, "W held 1.2 s"], [14.9, "W held 2.5 s"], [16.2, "drag left"], [17.4, "looking round"], [19.6, "returning to the flow"], [23.0, "back on the flow"]],
    steps: [[12.4, "W.key('KeyW',true)"], [15.0, "W.key('KeyW',false)"], [15.6, "W.drag(260,-30,false)"], [17.6, "W.drag(-120,0,false)"]] },
  "room-overhead-drop": { from: 42.4, until: 52.0, shots: [[42.9, "flow (above the ceiling)"], [44.0, "S held 1 s"], [45.0, "S held 2 s"], [46.4, "drag down (look ahead)"], [48.4, "drag left (look round)"], [50.5, "returning"]],
    steps: [[43.0, "W.key('KeyS',true)"], [44.6, "W.key('KeyS',false)"], [45.2, "W.drag(0,380,false)"], [46.8, "W.drag(-380,0,false)"]] },
  "room-dawn": { from: 168.5, until: 177.0, shots: [[168.8, "flow"], [170.0, "A held (strafe)"], [171.4, "W held"], [173.0, "drag"], [174.5, "looking at the window light"], [176.2, "returning"]],
    steps: [[169.0, "W.key('KeyA',true)"], [170.6, "W.key('KeyA',false)"], [170.7, "W.key('KeyW',true)"], [172.0, "W.key('KeyW',false)"], [172.4, "W.drag(-300,60,false)"]] },
  "white-walk": { from: 61.6, until: 77.0, shots: [[62.0, "flow (low, behind a door)"], [64.0, "walking: a door"], [65.8, "walking: next room"], [67.6, "walking: next room"], [69.0, "turn (drag)"], [70.8, "looking back down the row"], [75.0, "returning"]],
    steps: [[62.3, "W.stand({x:0.675,y:1.55,z:0.4,yaw:0,pitch:0}); W.release(); W.key('KeyW',true)"], [68.2, "W.key('KeyW',false)"], [68.4, "W.drag(-1400,0,false)"], [70.0, "W.drag(0,120,false)"]] },
  "forced-boundary": { from: 25.4, until: 33.4, free: true, shots: [[26.6, "free: standing away from the flow"], [28.0, "returning"], [29.6, "returning (pre-pull)"], [30.5, "ramp (f≈0.6)"], [31.0, "forced starts (f=0)"], [32.0, "forced: exactly the flow"]],
    steps: [[26.0, "W.release()"]] },
};
const only = process.argv.slice(2);
const outRoot = root + "web/review/m1/shots";
for (const [name, sc] of Object.entries(SCEN)) {
  if (only.length && !only.includes(name)) continue;
  for (const variant of sc.free ? ["free", "flow"] : ["free"]) {
    cdp("goto", "http://127.0.0.1:8731/walk.html?qa=1&auto=1&muted=1&t=1");
    for (let i = 0; i < 100 && cdp("eval", "typeof __walk!=='undefined' && __walk.ready ? 1 : 0") !== "1"; i++) await sleep(300);
    await sleep(800);
    const steps = JSON.stringify(variant === "flow" ? [] : sc.steps), shots = JSON.stringify(sc.shots);
    const standJs = sc.free && variant === "free" ? "W.stand({x:-0.95,y:1.55,z:0.95,yaw:1.9,pitch:-0.12});" : "";
    const js = `(async()=>{const W=__walk, sl=ms=>new Promise(r=>setTimeout(r,ms)); W.pause(); await W.seek(${sc.from}); await sl(400); W.shots=[]; W.shotQ=[]; for (const [t,l] of ${shots}) W.queueShot(t,l); const steps=${steps}; await W.play();
      ${standJs}
      let i=0; while (W.audio.currentTime < ${sc.until}) { while (i<steps.length && W.audio.currentTime>=steps[i][0]) { eval(steps[i][1]); i++; } await sl(15); } W.pause(); W.key('KeyW',false); W.key('KeyA',false);
      return JSON.stringify(W.shots.map(s=>({label:s.label,T:s.T,st:s.st,img:s.img})))})()`;
    const res = JSON.parse(cdp("eval", js));
    const dir = `${outRoot}/${name}${sc.free ? "-" + variant : ""}`; fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
    res.forEach((s, i) => fs.writeFileSync(`${dir}/${String(i + 1).padStart(2, "0")}.jpg`, Buffer.from(s.img.split(",")[1], "base64")));
    fs.writeFileSync(`${dir}/meta.json`, JSON.stringify(res.map(({ img, ...r }) => r), null, 1));
    console.log(name, variant, res.map((s) => `${s.T}:${s.st.mode}`).join(" "));
  }
}
