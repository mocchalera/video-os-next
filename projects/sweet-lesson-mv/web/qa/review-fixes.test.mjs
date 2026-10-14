// Sol's M2–M3 final review (R5–R8, R10), as reproduction tests that run in Node with the real modules. exit 1 on any failure.
//   node web/qa/review-fixes.test.mjs
import fs from "node:fs";
import { createRequire } from "node:module";
globalThis.window = globalThis.window || globalThis;
const listeners = {}; globalThis.addEventListener = (t, f) => { (listeners[t] = listeners[t] || []).push(f); };
const fire = (t) => (listeners[t] || []).forEach((f) => f({}));
const require = createRequire(import.meta.url);
require("../../../../src/runtime/three.js");
let bad = 0; const check = (ok, m) => { if (!ok) { bad++; console.log("FAIL", m); } else console.log("ok  ", m); };

// ---- R5: a double-tapped destination does not survive reset() (a seek, a forced segment, a change of space)
{
  const { FreeCam } = await import("../walk/freecam.js");
  const cam = JSON.parse(fs.readFileSync(new URL("../../data/camera.json", import.meta.url), "utf8"));
  const k = cam.room.find((x) => Math.abs(x.t - 38.28) < 0.01) || cam.room[5], flow = { p: k.p, l: k.l, fov: k.fov ?? 46, ap: 0.8, focus: -1, up: k.up };
  const c = new FreeCam(cam); let now = 100;
  c.tick(1 / 60, 20, now); c.compose("room", 20, flow); c.goTo(0, 0.8); c.reset(); // reset = what seekTo() does
  check(c.goal === null, "R5: reset() clears the destination");
  for (let i = 0; i < 3; i++) { now += 1 / 60; c.tick(1 / 60, 40, now); c.compose("room", 40, flow); }
  check(!c.goal && !c.walking && !c.eng, `R5: three ticks after the seek: goal=${JSON.stringify(c.goal)} walking=${c.walking} eng=${c.eng} (no input given → the flow)`);
}

// ---- R6 / R7: the foley's states, and its sync tolerance (< one frame)
{
  const mkAudio = () => { const l = {}; const a = { seekable: { length: 1, start: () => 0, end: () => 300 }, paused: true, muted: false, currentTime: 0, seeking: false, playsInline: true, preload: "", src: "", plays: 0, rejectWith: null,
    addEventListener(t, f) { (l[t] = l[t] || []).push(f); }, emit(t) { (l[t] || []).forEach((f) => f()); },
    play() { a.plays++; if (a.rejectWith) return Promise.reject(Object.assign(new Error("not allowed"), { name: a.rejectWith })); a.paused = false; setTimeout(() => a.emit("playing"), 0); return Promise.resolve(); },
    pause() { a.paused = true; a.emit("pause"); } }; return a; };
  const A = mkAudio(); globalThis.Audio = function () { return A; };
  const prevNow = performance.now.bind(performance); let t = 1000; performance.now = () => t;
  const { Foley } = await import("../walk/foley.js"); const music = { muted: false };
  const f = new Foley(music, 24); f.load(); A.emit("canplay");
  check(f.loaded && !f.sounding, "R6: canplay means loaded, not sounding");
  // refusal: no per-frame retry; the next gesture clears it
  A.rejectWith = "NotAllowedError"; for (let i = 0; i < 6; i++) { t += 17; f.update(100 + i / 60, true); await new Promise((r) => setTimeout(r, 0)); }
  check(A.plays === 1 && f.refused && !f.sounding, `R6: play() rejected → tried once (${A.plays}), refused=${f.refused}, sounding=${f.sounding} (no retry loop; the Esc click will be synthesized)`);
  A.rejectWith = null; fire("pointerdown"); t += 17; f.update(100.2, true); await new Promise((r) => setTimeout(r, 5));
  check(A.plays === 2 && f.sounding && !f.refused, "R6: after the next gesture it tries once more and sounds");
  // R7: 70 ms behind is corrected (> one frame); 30 ms is not (< one frame, no needless jumps)
  t += 300; A.currentTime = 99.93; f.update(100, true); check(Math.abs(A.currentTime - 100) < 1e-9, "R7: 70 ms behind → put back on the song's clock");
  t += 300; A.currentTime = 99.97; f.update(100, true); check(Math.abs(A.currentTime - 99.97) < 1e-9, "R7: 30 ms (under one frame) → left alone");
  t += 300; A.currentTime = 99.95; f.update(100, true); check(Math.abs(A.currentTime - 100) < 1e-9, "R7: 50 ms (over one frame at 24 fps = 41.7 ms) → corrected");
  // after a seek / a return the check is immediate (not on the 250 ms timer)
  t += 10; A.currentTime = 50; f.seek(150); A.currentTime = 149.9; f.update(150, true); check(Math.abs(A.currentTime - 150) < 1e-9, "R7: right after seek() the sync is checked at once");
  t += 10; f.halt(); A.currentTime = 20; t += 10; f.update(30, true); check(A.currentTime === 30 && !A.paused, "R7: after a return (halt → update) it restarts at the song's time");
  // a song/foley that is not seekable (the server ignored Range): no jump to 0, no silent corruption
  t += 400; A.seekable = { length: 0, start: () => 0, end: () => 0 }; A.currentTime = 100.5; f.seek(150); check(A.currentTime === 100.5, "seek(): not seekable → currentTime is left alone (it would have fallen to 0)");
  t += 400; f.update(150, true); check(A.currentTime === 100.5, "update(): not seekable → no resync attempt either"); A.seekable = { length: 1, start: () => 0, end: () => 300 };
  // the unlock promise must not stop a real start
  const A2 = mkAudio(); globalThis.Audio = function () { return A2; }; const g = new Foley({ muted: false }, 24); g.load(); A2.emit("canplay");
  g.unlock(); g.update(10, true); await new Promise((r) => setTimeout(r, 10)); check(!A2.paused, "R6: an old unlock() promise does not pause a real playback that started after it");
  performance.now = prevNow;
}

// ---- R8: ?tier= is a manual fix; the automatic step-down (?autotier= / the saved value) is not, and the lower of the two wins
{
  const store = {}; globalThis.sessionStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
  Object.defineProperty(globalThis, "navigator", { value: { userAgent: "Mozilla/5.0 (Macintosh)", platform: "MacIntel", maxTouchPoints: 0, deviceMemory: 8, hardwareConcurrency: 10 }, configurable: true });
  globalThis.location = { search: "" };
  const { pickTier, stepDown } = await import("../walk/tiers.js");
  check(pickTier(new URLSearchParams("autotier=1")).tier.id === 1, "R8: ?autotier=1 → tier 1");
  stepDown(1); check(pickTier(new URLSearchParams("autotier=1")).tier.id === 2, "R8: autotier=1 in the URL and 2 saved (the page found it slow again) → 2 wins");
  check(pickTier(new URLSearchParams("tier=0")).tier.id === 0 && pickTier(new URLSearchParams("tier=0")).why === "?tier=", "R8: a manual ?tier=0 is honoured as a manual fix");
  const { tierFor } = await import("../walk/tiers.js");
  check(tierFor(0, 17.4) === 2 && tierFor(0, 12) === 1 && tierFor(1, 16.9) === 2 && tierFor(3, 30) === 4, `R8+: a slow 1080 (17.4 ms) goes straight to ${tierFor(0, 17.4)} (720), one reload instead of two; a mild one only one step; the floor is the floor`);
  const bench = fs.readFileSync(new URL("../walk/walk.js", import.meta.url), "utf8");
  check(/Q\.get\("tier"\) !== null/.test(bench) && /searchParams\.set\("autotier"/.test(bench) && !/searchParams\.set\("tier"/.test(bench), "R8: the benchmark is skipped only for a manual ?tier=, and the page's own reload puts ?autotier= (never ?tier=) in the URL");
}

// ---- R10: a texStorage allocation is not multiplied again by generateMipmap
{
  const C = { RGBA8: 0x8058, TEXTURE_2D: 0x0DE1, TEXTURE0: 0x84C0, TEXTURE_CUBE_MAP: 0x8513, TEXTURE_3D: 0x806F, TEXTURE_2D_ARRAY: 0x8C1A, TEXTURE_CUBE_MAP_POSITIVE_X: 0x8515, TEXTURE_CUBE_MAP_NEGATIVE_Z: 0x851A };
  const P = {}; function GL() {} GL.prototype = P; Object.assign(GL, C);
  for (const n of ["activeTexture", "bindTexture", "texStorage2D", "texStorage3D", "texImage2D", "texImage3D", "generateMipmap", "renderbufferStorage", "renderbufferStorageMultisample", "bindRenderbuffer", "bindBuffer", "bufferData", "deleteTexture", "deleteRenderbuffer", "deleteBuffer"]) P[n] = function () {};
  globalThis.window.WebGL2RenderingContext = GL; const gl = new GL();
  (0, eval)(fs.readFileSync(new URL("./glmem.js", import.meta.url), "utf8"));
  const tex = {}; gl.activeTexture(C.TEXTURE0); gl.bindTexture(C.TEXTURE_2D, tex); gl.texStorage2D(C.TEXTURE_2D, 11, C.RGBA8, 1024, 1024); const before = globalThis.__glmem.report().totalMB; gl.generateMipmap(C.TEXTURE_2D); const after = globalThis.__glmem.report().totalMB;
  check(before === after && Math.abs(before - 5.3) < 0.1, `R10: 1024² RGBA8, 11 levels via texStorage2D = ${before} MB, after generateMipmap ${after} MB (was 7.1)`);
  const t2 = {}; gl.bindTexture(C.TEXTURE_2D, t2); gl.texImage2D(C.TEXTURE_2D, 0, C.RGBA8, 1024, 1024, 0, C.RGBA8, 0, null); const b2 = globalThis.__glmem.report().totalMB; gl.generateMipmap(C.TEXTURE_2D); const a2 = globalThis.__glmem.report().totalMB;
  check(Math.abs((a2 - b2) - 4 / 3 * 4 * 0.25) < 0.05 || a2 > b2, `R10: a base-level-only texImage2D still gets its mip chain added by generateMipmap (${(a2 - b2).toFixed(2)} MB)`);
}
process.exit(bad ? 1 : 0);
