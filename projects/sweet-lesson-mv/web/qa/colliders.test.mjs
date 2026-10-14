// Collision resolution (Sol M1 R1): whatever point it is given, resolve() must return a place that is inside the room and not inside anything.
//   node web/qa/colliders.test.mjs
import fs from "node:fs";
import { space, ROOM, BODY_ROOM, PXc, PZc } from "../walk/colliders.js";
const cam = JSON.parse(fs.readFileSync(new URL("../../data/camera.json", import.meta.url), "utf8"));
let bad = 0; const fail = (m) => { bad++; if (bad < 20) console.log("FAIL", m); };
const room = space("room"), white = space("white");
const inside = (p) => p.x >= ROOM.bounds.x0 - 1e-9 && p.x <= ROOM.bounds.x1 + 1e-9 && p.z >= ROOM.bounds.z0 - 1e-9 && p.z <= ROOM.bounds.z1 + 1e-9;
let n = 0;
// 1. a dense grid over the room and well outside it, at several eye heights
for (const y of [0.35, 0.8, 1.2, 1.55, 1.9, 2.1]) for (let x = -2.4; x <= 2.4; x += 0.04) for (let z = -2.4; z <= 2.4; z += 0.04) {
  const p = { x, z }; room.resolve(p, y); n++;
  if (!inside(p)) fail(`room y=${y} (${x.toFixed(2)},${z.toFixed(2)}) → (${p.x.toFixed(3)},${p.z.toFixed(3)}) is outside the bounds`);
  else if (!room.valid(p, y)) fail(`room y=${y} (${x.toFixed(2)},${z.toFixed(2)}) → (${p.x.toFixed(3)},${p.z.toFixed(3)}) is inside something`);
}
// 2. the cases Sol found
for (const [x, z, y] of [[1.12, -1.55, 1.55], [1.07, -0.885, 0.9], [1.3, -1.7, 1.55]]) { const p = { x, z }; room.resolve(p, y); n++; if (!inside(p) || !room.valid(p, y)) fail(`Sol case (${x},${z},${y}) → (${p.x},${p.z})`); }
// 3. every pose the MV's own camera takes (the flow can start anywhere, and a viewer engages from it)
for (const k of cam.room) { for (const y of [k.p[1], 1.55]) { const p = { x: k.p[0], z: k.p[2] }; room.resolve(p, y); n++; if (!inside(p) || !room.valid(p, y)) fail(`flow key t=${k.t} → (${p.x.toFixed(3)},${p.z.toFixed(3)})`); } }
// 4. the white rooms: a grid across several cells, and the flow's own keys
for (let x = -6; x <= 6; x += 0.05) for (let z = -8; z <= 8; z += 0.05) { const p = { x, z }; white.resolve(p, 1.55); n++; if (!white.valid(p)) fail(`white (${x.toFixed(2)},${z.toFixed(2)}) → (${p.x.toFixed(3)},${p.z.toFixed(3)}) is in a wall`); }
for (const k of cam.white) { const p = { x: k.p[0], z: k.p[2] }; white.resolve(p, 1.55); n++; if (!white.valid(p)) fail(`white flow key t=${k.t} → (${p.x.toFixed(3)},${p.z.toFixed(3)})`); }
// 5. idempotent: a second resolve must not move a resolved point
for (let i = 0; i < 4000; i++) { const p = { x: (Math.sin(i * 12.9898) * 3), z: (Math.sin(i * 78.233) * 3) }, y = 1.55; room.resolve(p, y); const q = { ...p }; const moved = room.resolve(q, y); n++; if (moved) fail(`not idempotent at (${p.x.toFixed(3)},${p.z.toFixed(3)})`); }
console.log(`${n} resolves checked; ` + (bad ? `FAILED (${bad})` : "all ok"));
process.exit(bad ? 1 : 0);
