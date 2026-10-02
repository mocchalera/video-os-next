// FreeCam behaviours that Sol's M1 review (and the director's rules) pin down, run in Node with the real modules and the vendored three.js.
//   node web/qa/freecam.test.mjs
import fs from "node:fs";
import { createRequire } from "node:module";
globalThis.window = globalThis.window || {};
const require = createRequire(import.meta.url);
require("../../../../src/runtime/three.js"); // defines window.THREE
const { FreeCam, P } = await import("../walk/freecam.js");
const { space, ROOM } = await import("../walk/colliders.js");
const cam = JSON.parse(fs.readFileSync(new URL("../../data/camera.json", import.meta.url), "utf8"));
let bad = 0; const check = (ok, m) => { if (!ok) { bad++; console.log("FAIL", m); } else console.log("ok  ", m); };
const flowOf = (k) => ({ p: k.p, l: k.l, fov: k.fov ?? 46, ap: k.ap ?? 0.8, focus: k.focus ?? -1, up: k.up });
const roomKey = (t) => cam.room.find((k) => Math.abs(k.t - t) < 0.01), whiteKey = (t) => cam.white.find((k) => Math.abs(k.t - t) < 0.01);
const step = (c, T, dt, now, ctx, flow) => { c.tick(dt, T, now); c.compose(ctx, T, flow); };

// R4: what the viewer does during a forced segment is dropped, not applied when it ends
{ const c = new FreeCam(cam), flow = flowOf(roomKey(32.7)); let now = 100;
  step(c, 38.25, 1 / 60, now, "room", flow); c.in.dragDx = 500; now += 0.016; step(c, 38.27, 1 / 60, now, "room", flow); // inside window-out (31.0 – 38.3)
  check(c.in.dragDx === 0, "R4: a drag given during a forced segment is consumed (dragDx = 0 after the tick)");
  const f2 = flowOf(roomKey(38.28)); for (let i = 0; i < 20; i++) { now += 0.016; step(c, 38.31 + i / 60, 1 / 60, now, "room", f2); }
  check(!c.eng && c.yaw === 0 && !c.offset, `R4: after the segment the camera is still the flow (eng=${c.eng}, yaw=${c.yaw.toFixed(3)})`); }

// R1 (in the controller): engaging from a flow pose that lies inside furniture / outside the walkable area ends inside the room
{ const sp = space("room"); const c = new FreeCam(cam), flow = flowOf(roomKey(131.8)); let now = 200; // p = [1.07, 0.9, -0.885]: at the desk, inside what a person cannot enter
  step(c, 131.9, 1 / 60, now, "room", flow); c.in.dragging = true;
  for (let i = 0; i < 240; i++) { now += 1 / 60; c.in.dragDx += 0.2; step(c, 131.9, 1 / 60, now, "room", flow); }
  const p = { x: c.pF.x, z: c.pF.z }, B = ROOM.bounds;
  check(p.x >= B.x0 - 1e-6 && p.x <= B.x1 + 1e-6 && p.z >= B.z0 - 1e-6 && p.z <= B.z1 + 1e-6 && sp.valid(p, c.pF.y), `R1: engaged from the desk-side flow pose → eye at (${p.x.toFixed(2)}, ${c.pF.y.toFixed(2)}, ${p.z.toFixed(2)}) inside the room and out of the furniture`); }

// R5: in the white rooms there is a soft rope to the flow — also while the song is paused (T does not move). W held for 200 s, from a flow pose in the rooms.
{ const c = new FreeCam(cam), k = whiteKey(63.5), flow = flowOf(k); let now = 300, T = 63.5, far = 0;
  step(c, T, 1 / 60, now, "white", flow); c.in.fw = 1;
  for (let i = 0; i < 200 * 60; i++) { now += 1 / 60; c.in.fw = 1; step(c, T, 1 / 60, now, "white", flow); far = Math.max(far, Math.hypot(c.pF.x - k.p[0], c.pF.z - k.p[2])); }
  check(far < 12.5, `R5: paused in the white rooms, W held 200 s: furthest from the flow ${far.toFixed(1)} m (the rope: ≈ 10 m, never a wall)`);
  check(Math.abs(c.pF.z) < 60, `R5: and nowhere near the lattice edge (z = ${c.pF.z.toFixed(1)}, edge at ±75)`); }

// the same rope when the song is running (flow moves): the viewer is not left behind by the rush
{ const c = new FreeCam(cam); let now = 400, T = 78, max = 0;
  const pathAt = (t) => { const ks = cam.white, i = Math.max(0, ks.findIndex((k) => k.t > t) - 1), a = ks[i], b = ks[Math.min(ks.length - 1, i + 1)], u = b.t === a.t ? 0 : Math.min(1, (t - a.t) / (b.t - a.t)); const m = (x, y) => x.map((v, j) => v + (y[j] - v) * u); return { p: m(a.p, b.p), l: m(a.l, b.l), fov: 44, ap: 0.3, focus: -1 }; };
  step(c, T, 1 / 60, now, "white", pathAt(T)); c.in.fw = 1;
  for (; T < 84; T += 1 / 60) { now += 1 / 60; c.in.fw = 1; const f = pathAt(T); step(c, T, 1 / 60, now, "white", f); max = Math.max(max, Math.hypot(c.pF.x - f.p[0], c.pF.z - f.p[2])); }
  check(max < 14, `rope while the song plays (78 → 84 s): furthest from the flow ${max.toFixed(1)} m`); }

console.log(bad ? `FAILED (${bad})` : "all ok"); process.exit(bad ? 1 : 0);
