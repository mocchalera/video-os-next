// The sash is ONE state, u (0 closed … 1 open); fog, the written words, the morning veil, the lace are functions of u. Real mouse drags: u = 0 → 0.3 → (let go: it goes back) → 0 → 0.6 → 0.2 → 0.3 → (let go) → 0 → 1 (let go: it opens, final).
//   node web/qa/sash.mjs → web/review/m3/sash/*.png, sash.json   (then python3 web/qa/sash-check.py)
import fs from "node:fs";
import { connect } from "../tools/cdpkit.mjs";
const root = new URL("../../", import.meta.url).pathname, out = root + "web/review/m3/sash"; fs.mkdirSync(out, { recursive: true });
const c = await connect(""); const log = [];
const mouse = (type, x, y, extra = {}) => c.send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" ? ((extra.buttons ?? 0) ? "left" : "none") : "left", buttons: type === "mouseReleased" || type === "mouseMoved" ? (extra.buttons ?? 0) : 1, clickCount: type === "mouseMoved" ? 0 : 1, pointerType: "mouse", ...extra });
await c.emulate(1440, 900, 1, false); await c.goto("http://127.0.0.1:8731/walk.html?auto=1&muted=1&t=20"); await c.waitReady(); await c.sleep(1500);
await c.eval("__walk.seekTo(1e9)"); for (let i = 0; i < 40 && !(await c.eval("!!__walk.epi")); i++) await c.sleep(500);
await c.sleep(6500); await c.eval("__walk.stand({x:-0.1,y:1.45,z:-0.5,yaw:0,pitch:-0.1})"); await c.sleep(2500);
const E = "__walk.epi", P = (o) => JSON.parse(o);
const stateOf = async () => P(await c.eval(`JSON.stringify({u:${E}.open, state:${E}.state, fog:${E}.mat.opacity, veil:${E}.veilMat.opacity, laceSx:${E}.lace?${E}.lace.scale.x:null, laceZ:${E}.lace?${E}.lace.position.z:null, settling:!!${E}.settle})`));
// write a few strokes (with the mouse) so there is something to lose
const w0 = P(await c.eval(`JSON.stringify(${E}.toClient({x:-0.6,y:1.15,z:-1.808}))`));
await mouse("mouseMoved", w0.x, w0.y); await mouse("mousePressed", w0.x, w0.y); for (let i = 1; i <= 16; i++) { await mouse("mouseMoved", w0.x + i * 9, w0.y + Math.sin(i / 2) * 14, { buttons: 1 }); await c.sleep(24); } await mouse("mouseReleased", w0.x + 144, w0.y); await c.sleep(500);
const grab = P(await c.eval(`JSON.stringify(${E}.toClient({x:-0.02,y:1.5,z:-1.808}))`)); const U = (u) => grab.x + u * 0.42 * 1440;
const shot = async (name, note) => { await c.sleep(700); await c.shot(`${out}/${name}.png`); const st = await stateOf(); log.push({ name, note, ...st }); console.log(name, note, JSON.stringify(st)); };
const dragTo = async (u, steps = 10) => { const cur = (await stateOf()).u; for (let i = 1; i <= steps; i++) { await mouse("mouseMoved", U(cur + ((u - cur) * i) / steps), grab.y, { buttons: 1 }); await c.sleep(25); } };
const press = async () => { await mouse("mouseMoved", grab.x, grab.y); await mouse("mousePressed", grab.x, grab.y); await c.sleep(80); };
const release = async (u) => { await mouse("mouseReleased", U(u), grab.y); };
await shot("00-closed", "u=0, written");
await press(); await dragTo(0.3); await shot("01-u0.3-held", "u=0.3 (held)"); await release(0.3); await c.sleep(2200); await shot("02-back-to-0", "let go at 0.3: back to 0");
await press(); await dragTo(0.6); await shot("03-u0.6-held", "u=0.6 (held)"); await dragTo(0.2); await shot("04-u0.2-held", "u=0.2 (held)"); await dragTo(0.3); await shot("05-u0.3-held-again", "u=0.3 again (held)"); await release(0.3); await c.sleep(2200); await shot("06-back-to-0-again", "let go at 0.3: back to 0 again");
await press(); await dragTo(0.6); await dragTo(0.0, 14); await shot("07-u0-held", "dragged back to 0 (held)"); await release(0); await c.sleep(600); await shot("08-u0-released", "u=0 released");
await press(); await dragTo(1.0, 14); await release(1.0); await c.sleep(1200); await shot("09-opening", "let go at 1: opening"); await c.sleep(4500); await shot("10-open", "open, final");
log.push({ cues: await c.eval("document.getElementById('cues').textContent"), epiState: await c.eval(`${E}.state`) });
fs.writeFileSync(`${out}/sash.json`, JSON.stringify(log, null, 1)); c.close();
