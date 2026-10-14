// Background tab: audio + foley + clock must stop with the page and resume where they were. node web/qa/hidden.mjs → web/review/m3/hidden.json
import fs from "node:fs";
import { connect } from "../tools/cdpkit.mjs";
const root = new URL("../../", import.meta.url).pathname;
const base = "http://127.0.0.1:8731";
const c = await connect("");
const info = () => c.eval("JSON.stringify({T:+__walk.audio.currentTime.toFixed(2), paused:__walk.audio.paused, hidden:document.hidden, vis:document.visibilityState, foleyPaused:__walk.foley.a ? __walk.foley.a.paused : null, foleyT:__walk.foley.a ? +__walk.foley.a.currentTime.toFixed(2) : null})").then(JSON.parse);
await c.emulate(1440, 900, 2, false);
await c.goto(`${base}/walk.html?tier=2`); await c.waitReady(); await c.sleep(500);
await c.eval("(async()=>{ await __walk.start(); return 1 })()"); await c.sleep(3000);
const res = { playing: await info() };
const tid = (await c.send("Target.getTargets")).targetInfos.find((t) => t.type === "page" && t.url.includes("walk.html")).targetId;
const nt = (await c.send("Target.createTarget", { url: "about:blank" })).targetId; // a second tab in front
await c.sleep(2500);
res.whileHidden1 = await info(); await c.sleep(2000); res.whileHidden2 = await info();
await c.send("Target.activateTarget", { targetId: tid }); await c.sleep(1500);
res.back = await info(); await c.sleep(1500); res.backLater = await info();
await c.send("Target.closeTarget", { targetId: nt });
res.checks = {
  hiddenWasDetected: res.whileHidden1.hidden === true,
  audioPausedWhileHidden: res.whileHidden1.paused === true && res.whileHidden2.T === res.whileHidden1.T,
  resumedOnReturn: res.back.hidden === false && res.backLater.T > res.back.T + 0.5 && res.backLater.paused === false,
};
console.log(JSON.stringify(res, null, 1)); fs.writeFileSync(root + "web/review/m3/hidden.json", JSON.stringify(res, null, 1)); c.close(); process.exit(Object.values(res.checks).every(Boolean) ? 0 : 1);
