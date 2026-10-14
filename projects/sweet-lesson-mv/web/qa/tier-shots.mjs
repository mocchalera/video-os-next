// The same moment (T = 118, the desk) at each quality tier, 16:9 at the same screen size: what the phone tiers give up. → web/review/m3/tiers/tier-N.jpg
import fs from "node:fs";
import { connect } from "../tools/cdpkit.mjs";
const root = new URL("../../", import.meta.url).pathname, out = root + "web/review/m3/tiers"; fs.mkdirSync(out, { recursive: true });
const c = await connect(""); await c.emulate(1280, 720, 1, false);
for (const t of [0, 1, 2, 3, 4]) {
  await c.goto(`http://127.0.0.1:8731/walk.html?tier=${t}&auto=1&muted=1&t=118`); await c.waitReady(); await c.sleep(2500); await c.eval("__walk.pause()"); await c.sleep(400);
  await c.shot(`${out}/tier-${t}.jpg`); console.log(t, await c.eval("__walk.tier.name"));
}
c.close();
