// Sweet Lesson web — M2: the room as a work. Audio position = song time; the flow is the MV's camera; the viewer may leave it (M1);
// and now: the context number, the time line, captions, Esc, traces (dust, steps, breath), and the epilogue at the window.
import { FreeCam, P, portraitFov } from "./freecam.js";
import { floorPoint } from "./pick.js";
import { Cursor } from "./cursor.js";
import { FORCED, validate } from "./segments.js";
import { UI, SONG_END } from "./ui.js";
import { Sfx } from "./sfx.js";
import { Foley } from "./foley.js";
import { TIERS, pickTier, stepDown, tierFor } from "./tiers.js";
import { Traces, isCold } from "./traces.js";
import { Epilogue, T_CLOSED, T_OPEN } from "./epilogue.js";

const Q = new URLSearchParams(location.search);
const audio = document.getElementById("song"), gate = document.getElementById("gate"), gateStatus = document.getElementById("gate-status");
const enterBtn = document.getElementById("enter"), hint = document.getElementById("hint"), hud = document.getElementById("hud");
const QA = Q.get("qa") === "1"; // the QA handles (window.__walk, screenshots, synthetic input) exist only when asked for, never in what a visitor gets
const W = { ready: false, errors: [] }; if (QA) window.__walk = W;
window.addEventListener("error", (e) => W.errors.push(String(e.message)));
window.addEventListener("unhandledrejection", (e) => W.errors.push("rej: " + String(e.reason)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r1 = (x) => Math.round(x * 10) / 10;
const THREE = window.THREE;

let shim = null, ctrl = null, ui = null, sfx = null, foley = null, traces = null, epi = null, raf = 0, last = 0, running = false;
const inp = { fw: 0, st: 0, turn: 0 };
const keyDown = new Set();
const roomView = document.getElementById("room-view"), stage = document.getElementById("stage");
const player = document.getElementById("player"), playToggle = document.getElementById("play-toggle"), replayBtn = document.getElementById("replay"), volume = document.getElementById("volume"), muteBtn = document.getElementById("mute"), roomMode = document.getElementById("room-mode"), playerStatus = document.getElementById("player-status");
player.hidden = false;
let roomInteracting = false, replaying = false;
function updatePlayer() {
  playToggle.disabled = !started || W.noRoom || epiOn;
  replayBtn.disabled = !started || W.noRoom || replaying;
  roomMode.disabled = !started || W.noRoom;
  playToggle.textContent = audio.paused ? "再生" : "一時停止";
  playerStatus.textContent = W.noRoom ? "部屋の描画不可" : epiOn ? "曲終了・余韻" : !started ? "入室前" : audio.paused ? "一時停止中" : "再生中";
  muteBtn.textContent = audio.muted ? "音を出す" : "ミュート";
  muteBtn.setAttribute("aria-pressed", String(audio.muted));
}
function setRoomMode(on, focus = false) {
  roomInteracting = !!on && started && !W.noRoom;
  roomView.classList.toggle("interacting", roomInteracting);
  roomMode.setAttribute("aria-pressed", String(roomInteracting));
  roomMode.textContent = roomInteracting ? "操作を終える（スクロール）" : "部屋を操作する";
  if (!roomInteracting) abortGesture(true);
  if (focus && roomInteracting) stage.focus({ preventScroll: true });
}
async function togglePlayback() {
  if (!started || W.noRoom || epiOn) return;
  if (audio.paused) { sfx.resume(); await audio.play().catch(() => { playerStatus.textContent = "再生できませんでした。再生ボタンで再試行できます。"; }); }
  else { audio.pause(); foley.halt(); }
}
function setVolume() {
  const v = Number(volume.value); audio.volume = v;
  if (foley?.a) foley.a.volume = v;
  if (sfx) sfx.setVolume(v);
}
playToggle.addEventListener("click", togglePlayback);
replayBtn.addEventListener("click", replay);
roomMode.addEventListener("click", () => setRoomMode(!roomInteracting, true));
volume.addEventListener("input", setVolume);
muteBtn.addEventListener("click", () => { audio.muted = !audio.muted; if (sfx) sfx.setMuted(audio.muted); if (foley?.a) foley.a.muted = audio.muted; updatePlayer(); });
for (const ev of ["play", "pause", "volumechange", "ended"]) audio.addEventListener(ev, updatePlayer);

// Esc (BRIEF §1-5): the machine offers to forget (monitor, 132.9 →). Any key or tap in 133.0 … 134.38 is the Esc, at that very moment; none: the MV's own at 134.38.
const ESC0 = 133.0, ESC_MV = 134.38;
let escAt = null, escSounded = false;
// the epilogue
let epiOn = false, epiT0 = 0, epiOpenAt = null, epiCuePhase = "", epiStartedAt = 0;
// the cursor as a trace (BRIEF §2 v1.1): alive from the entrance on, so there is no state without one
const cursor = new Cursor({ ctx: () => document.getElementById("ctx"), epi: () => (epiOn ? epi : null) }); W.cursor = cursor;

const NO_ROOM = "この端末では部屋を描けませんでした。 — this device couldn't render the room.";
function noRoom() { // Only the room fails; the ordinary page remains readable.
  W.noRoom = true; running = false; cancelAnimationFrame(raf); try { audio.pause(); if (foley) foley.halt(); if (sfx) sfx.suspend(); } catch { /* ok */ }
  setRoomMode(false); updatePlayer(); gate.style.display = "flex"; gate.innerHTML = `<div class="sub" id="gate-status" role="status">${NO_ROOM}</div>`; W.noRoom = true;
}
function glSupported() { // WebGL2 and a float render target: what the post chain needs. (?qa=1&nogl=1 pretends it is not there.)
  if (QA && Q.get("nogl") === "1") return false;
  try {
    const c = document.createElement("canvas"), g = c.getContext("webgl2"); if (!g) return false;
    const ok = !!(g.getExtension("EXT_color_buffer_float") || g.getExtension("EXT_color_buffer_half_float"));
    const lose = g.getExtension("WEBGL_lose_context"); if (lose) lose.loseContext(); return ok;
  } catch { return false; }
}
async function boot() {
  if (!glSupported()) return noRoom();
  const rm = matchMedia("(prefers-reduced-motion: reduce)"); P.reduced = rm.matches; rm.addEventListener?.("change", () => { P.reduced = rm.matches; applyReduced(); });
  const onResize = () => { const r = stage.getBoundingClientRect(); P.viewAspect = r.width / Math.max(1, r.height); }; onResize(); addEventListener("resize", onResize); addEventListener("orientationchange", onResize); if (window.visualViewport) visualViewport.addEventListener("resize", onResize); new ResizeObserver(onResize).observe(stage);
  const pick = Q.get("res") ? { tier: { ...TIERS[0], res: Number(Q.get("res")) }, why: "?res=" } : pickTier(); W.tier = pick.tier; W.tierWhy = pick.why;
  shim = await SweetShim.load({ host: document.getElementById("stage"), res: pick.tier.res, q: pick.tier.q, tex: pick.tier.tex, dprCap: 1 });
  W.shim = shim;
  shim.canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); noRoom(); }); // the GPU took the context away (memory pressure): say so quietly, do not leave a frozen black frame
  shim.dbg.web = { lyricGC: pick.tier.id >= 2 }; applyReduced(); // WEB hooks on: pure state(T), free-camera hooks, scene list (lyricGC: the phone tiers give a finished lyric card's GPU texture back)
  const cam = shim.props.cam;
  const warn = validate(cam); if (warn.length) { console.warn("[walk] forced-segment table vs camera.json:", warn); W.tableWarnings = warn; }
  ctrl = new FreeCam(cam); W.ctrl = ctrl;
  shim.dbg.web.cam = (T, flow) => ctrl.compose("room", T, flow);
  shim.dbg.web.wcam = (T, flow) => ctrl.compose("white", T, flow);
  shim.renderer.info.autoReset = false;
  ui = new UI({ ctx: shim.props.inventory.ctx, seek: seekTo, duration: SONG_END }); W.ui = ui; ui.loadCaptions();
  sfx = new Sfx(); W.sfx = sfx; ctrl.onStep = () => sfx.step();
  foley = new Foley(audio); foley.escEarly = () => escAt !== null; foley.load(); W.foley = foley;
  // first frame builds the scene (room.html builds lazily on the first update)
  const b0 = performance.now(); shim.update(0); W.buildMs = Math.round(performance.now() - b0);
  traces = new Traces(shim.dbg.web.scenes.world); W.traces = traces;
  await warmup();
  if (await bench(pick.tier)) return; // too slow for this tier: the page reloads one tier lower
  if (audio.readyState < 3) await new Promise((r) => { audio.addEventListener("canplaythrough", r, { once: true }); setTimeout(r, 1500); }); // iOS does not preload before a tap: do not wait for it
  W.readyMs = Math.round(performance.now()); W.ready = true;
  gateStatus.textContent = gateStatus.dataset.n ? `rendering… ${gateStatus.dataset.n} objects` : "";
  enterBtn.disabled = false; enterBtn.classList.add("on");
  if (Q.get("auto") === "1") start({ t: Number(Q.get("t") || 0), muted: Q.get("muted") === "1" });
}

// prefers-reduced-motion: the hand-held sway to a quarter, the white-outs to 30%, no inertia, a slower return, no drift in the epilogue (freecam.js)
function applyReduced() { if (!shim) return; shim.dbg.web.handheld = P.reduced ? 0.25 : 1; shim.dbg.web.flashScale = P.reduced ? 0.3 : 1; }

// ---- warm-up: draw one frame at times spread over the song (and from a few standing eyes), so no shader is compiled while the song plays.
// The count on the entrance is real: objects that have actually been drawn at least once.
async function warmup() {
  const sc = shim.dbg.web.scenes, roots = [sc.world, sc.wsc, sc.dc, sc.studio, sc.overlay.world, sc.overlay.white, sc.overlay.dc];
  const seen = new Set(), wrapped = [];
  for (const r of roots) r.traverse((o) => { if (o.isMesh || o.isPoints || o.isLine) { const orig = o.onBeforeRender; o.onBeforeRender = function (...a) { seen.add(o); return orig && orig.apply(this, a); }; wrapped.push([o, orig]); } });
  const px = new Uint8Array(4), gl = shim.gl, show = () => { const n = seen.size.toLocaleString("en-US"); gateStatus.dataset.n = n; gateStatus.textContent = `rendering… ${n} objects`; };
  const t0 = performance.now(); let frames = 0;
  const draw = async () => { gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); frames++; if (frames % 3 === 0) { show(); await sleep(0); } };
  for (let T = 0; T < 214.8; T += 4) { shim.update(T); await draw(); }
  // free eyes (standing, looking round and down) at a few kinds of light — the flow never looks at some of these walls
  const dbg = shim.dbg;
  for (const T of [5, 40, 120, 155, 200]) for (const [yaw, pitch] of [[0, 0], [Math.PI / 2, 0], [Math.PI, 0], [-Math.PI / 2, 0], [0.6, -1.1]]) {
    const fx = -Math.sin(yaw) * Math.cos(pitch), fz = -Math.cos(yaw) * Math.cos(pitch), fy = Math.sin(pitch), p = [0.1, 1.55, 0.3];
    dbg.cam = { p, l: [p[0] + fx * 3, p[1] + fy * 3, p[2] + fz * 3], fov: 52 }; shim.update(T); await draw();
  }
  dbg.cam = undefined;
  // the traces and the epilogue's pieces, once each, so their programs exist: the dust that gives way, a breath patch, the window at 195.6
  dbg.web.me = { p: [0.1, 1.55, 0.3], dir: [0, 0, -1], on: 1 }; for (const it of traces.items) { it.m.visible = true; it.m.material.opacity = 0.3; } shim.update(190); await draw();
  for (const it of traces.items) it.m.visible = false; dbg.web.me = undefined; dbg.noLyr = true; shim.update(T_CLOSED); await draw(); shim.update(T_OPEN); await draw(); dbg.noLyr = false;
  shim.update(0); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  for (const [o, orig] of wrapped) o.onBeforeRender = orig || (() => {}); // back to the default no-op
  show(); W.warmMs = Math.round(performance.now() - t0); W.warmFrames = frames; W.objectsDrawn = seen.size; W.programs = (shim.renderer.info.programs || []).length;
}

// ---- benchmark: a few heavy moments, GPU-synced, once the shaders are warm. If the worst is over ~80% of a 60 fps frame, step one tier down and reload (once per entry).
function benchMeasure() {
  const gl = shim.gl, px = new Uint8Array(4), res = {};
  for (const T of [118, 155, 75]) { const ms = []; for (let i = 0; i < 7; i++) { const t0 = performance.now(); shim.update(T + i / 24); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); ms.push(performance.now() - t0); } ms.splice(0, 2); ms.sort((a, b) => a - b); res[T] = ms[Math.floor(ms.length / 2)]; }
  shim.update(0); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const worst = Math.max(...Object.values(res)); return { ms: Object.fromEntries(Object.entries(res).map(([k, v]) => [k, Math.round(v * 10) / 10])), worst: Math.round(worst * 10) / 10 };
}
async function bench(tier) {
  if (Q.get("tier") !== null || Q.get("res") || Q.get("bench") === "0") return false;
  const b = benchMeasure(); W.bench = { tier: tier.id, ...b };
  if (b.worst > 16 && tier.id < TIERS.length - 1) { const n = stepDown(tier.id, tierFor(tier.id, b.worst)); W.bench.stepDownTo = n; if (Q.get("nobenchreload") !== "1") { const u = new URL(location.href); u.searchParams.delete("autotier"); u.searchParams.set("autotier", String(n)); location.replace(u); return true; } }
  return false;
}

// ---- clock and loop
function frame(now) {
  if (!running) return;
  raf = requestAnimationFrame(frame);
  const dt = last ? Math.min(0.1, (now - last) / 1000) : 1 / 60; last = now; slowWatch(dt);
  const dbg = shim.dbg.web;
  let T, Tv;
  if (!epiOn) {
    T = Tv = audio.currentTime; if (pendingSeek !== null) tryPendingSeek();
    if (audio.ended) { startEpilogue(); return; }
    escTick(T);
    foley.update(T, !audio.paused && !document.hidden);
  } else {
    foley.update(0, false);
    const tau = (now - epiT0) / 1000;
    Tv = epi.update(dt) + (epiOpenAt !== null ? 2.3 * smooth(0, 8, (now - epiOpenAt) / 1000) : 0); T = Tv;
    dbg.dustT = T_CLOSED + tau; dbg.frame = Math.round(tau * 24) + 5000; dbg.monT = Math.min(197.2 + tau * 0.2, 209.9);
  }
  ctrl.in.fw = inp.fw; ctrl.in.st = inp.st; ctrl.in.turn = inp.turn;
  ctrl.tick(dt, T, now / 1000);
  // you in the dust: the dust gives way round the eye and a little off the line of sight (room.html, DBG.web.me)
  // traces (dust that gives way, breath) belong to YOU as the camera: weight = how free the eye is (0 in a forced segment and while riding the flow, so the unattended playback is the MV as rendered)
  const youW = epiOn ? 1 : Math.min(1, Math.max(0, (Math.min(ctrl.f, ctrl.e) - 0.15) / 0.5)); W.youW = youW;
  const L = ctrl.last; let eye = null, fwd = null; if (W.noMe) dbg.me = undefined; // QA: the traces off, to see what they do
  if (L && !W.noMe && youW > 0.001) { eye = L.p; fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(L.q); dbg.me = { p: [eye.x, eye.y, eye.z], dir: [fwd.x, fwd.y, fwd.z], on: Math.min(1, (now / 1000 - (W.t0 || 0)) / 2) * youW }; } else dbg.me = undefined; // not you: the MV's own dust material, untouched
  const c0 = performance.now(); shim.update(T); W.frameCpuMs = performance.now() - c0;
  if (QA && !epiOn && W.shotQ && W.shotQ.length && T >= W.shotQ[0].at) { const q = W.shotQ.shift(); (W.shots = W.shots || []).push({ label: q.label, T: T, st: W.state(), img: shim.canvas.toDataURL("image/jpeg", 0.9) }); } // QA: a frame as drawn, taken right after update
  if (W.trace) { const L2 = ctrl.last; if (L2) W.trace.push([now, T, L2.p.x, L2.p.y, L2.p.z, L2.q.x, L2.q.y, L2.q.z, L2.q.w, ctrl.f, ctrl.e]); }
  // the breath on the glass (cold hours only; not in the white rooms)
  const L3 = ctrl.last; if (L3 && ctrl.ctx === "room") traces.update(dt, L3.p, new THREE.Vector3(0, 0, -1).applyQuaternion(L3.q), isCold(epiOn ? 195.6 : T), youW > 0.5); if (!epiOn && ctrl.f <= 0) traces.clear();
  ui.frame(epiOn ? null : T, epiOn ? 195.6 : T);
  if (epiOn) epiCues(now, L3);
  cursor.tick(now);
  if (Q.get("hud") === "1") drawHud(T);
}
// if the frames stay slow while playing (p95 > 40 ms over 6 s, twice), the NEXT entry in this tab starts one tier lower (a tier cannot change under a running song)
const slow = { buf: [], bad: 0 };
function slowWatch(dt) { if (document.hidden || audio.paused) { slow.buf.length = 0; return; } slow.buf.push(dt * 1000); if (slow.buf.length < 360) return; const a = slow.buf.slice().sort((x, y) => x - y), p95 = a[Math.floor(a.length * 0.95)]; slow.buf.length = 0; slow.bad = p95 > 40 ? slow.bad + 1 : 0; W.slowP95 = Math.round(p95); if (slow.bad >= 2 && !W.slowFlagged) { W.slowFlagged = true; stepDown(W.tier.id); } }
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
function drawHud(T) {
  const d = ctrl.debug || {}; hud.style.display = "block";
  hud.textContent = `T ${r1(T)}  ctx ${ctrl.ctx}  ${d.mode || ""}  f ${d.f === undefined ? "" : r1(d.f * 100) / 100}  e ${d.e === undefined ? "" : r1(d.e * 100) / 100}\npos ${[ctrl.pF.x, ctrl.pF.y, ctrl.pF.z].map(r1).join(", ")}  yaw ${r1((ctrl.yaw * 180) / Math.PI)} pitch ${r1((ctrl.pitch * 180) / Math.PI)}\ndP ${d.dP === undefined ? "" : r1(d.dP * 100) / 100}  dR ${d.dR === undefined ? "" : r1(d.dR * 100) / 100}  esc ${escAt}`;
}
let started = false; // the entrance's start is once: a second tap (or key) while the first is still awaiting audio.play() must not make a second loop
async function start(o = {}) {
  if (started || !W.ready) return; started = true;
  gate.style.display = "none"; W.t0 = performance.now() / 1000;
  sfx.init(); foley.unlock(); setVolume(); // the first tap: audio may start now
  if (o.muted !== undefined) { audio.muted = !!o.muted; sfx.setMuted(!!o.muted); }
  if (o.t) await seek(o.t);
  try { await audio.play(); } catch (e) { W.errors.push("play: " + e.message); audio.muted = true; sfx.setMuted(true); await audio.play().catch(() => {}); }
  running = true; last = 0; cancelAnimationFrame(raf); raf = requestAnimationFrame(frame);
  updatePlayer(); stage.focus({ preventScroll: true });
  hint.textContent = matchMedia("(pointer:coarse)").matches ? "スクロールで読む。見回すときは「部屋を操作する」" : "drag — 見る　WASD — 歩く　離すと、流れに戻る";
  hint.classList.add("on"); setTimeout(() => hint.classList.remove("on"), 6000);
}
function seek(T) { return new Promise((res) => { if (Math.abs(audio.currentTime - T) < 0.01) return res(); audio.addEventListener("seeked", () => res(), { once: true }); audio.currentTime = T; setTimeout(res, 3000); }); }
// a seek (the time line) starts again from the flow, whatever the size of the jump.
// If the song is not seekable to T yet (the server answered a range request with the whole file — e.g. a cache-bypassing request — or the metadata has not arrived), assigning currentTime would drop it to 0:
// so the song is left where it is playing, the wish is kept, and the jump is made as soon as the position is loaded.
const covers = (el, T) => { const s = el.seekable; for (let i = 0; i < s.length; i++) if (s.start(i) <= T + 0.02 && s.end(i) >= T) return true; return false; };
let pendingSeek = null;
function applySeek(T) { audio.currentTime = T; if (foley) foley.seek(T); escAt = null; escSounded = false; shim.dbg.web.escAt = null; if (ctrl) ctrl.reset(); }
function seekTo(T) { T = Math.max(0, Math.min(SONG_END - 0.5, T)); if (!covers(audio, T)) { pendingSeek = T; return; } pendingSeek = null; applySeek(T); }
function tryPendingSeek() { if (pendingSeek !== null && !epiOn && covers(audio, pendingSeek)) { const T = pendingSeek; pendingSeek = null; applySeek(T); } }
for (const ev of ["progress", "loadedmetadata", "loadeddata", "canplay", "canplaythrough", "durationchange"]) audio.addEventListener(ev, tryPendingSeek);
enterBtn.addEventListener("click", () => start({}));
// the tab going to the background stops the song (BRIEF §4-4)
let wasPlaying = false, suspended = false, hiddenAt = 0;
function suspend() { // however it happens (a tab switch, pagehide, the app going to the background): sample the state ONCE, then stop every sound and every clock
  if (suspended) return; suspended = true; hiddenAt = performance.now(); wasPlaying = !audio.paused; audio.pause();
  if (foley) foley.halt(); if (sfx) sfx.suspend(); abortGesture(true);
}
function resume() {
  if (!suspended) return; suspended = false; const gap = performance.now() - hiddenAt; last = 0; // the frame clock starts again (no giant dt)
  if (epiOn) { epiT0 += gap; epiStartedAt += gap; if (epiOpenAt !== null) epiOpenAt += gap; epiCueT += gap; } // the epilogue's own clocks (credits, dust, cues, the morning) did not run while it was away
  if (foley) foley.dirty(); if (sfx) sfx.resume();
  if (running && wasPlaying && !epiOn) audio.play().catch(() => {});
}
addEventListener("pagehide", suspend);
document.addEventListener("visibilitychange", () => { if (document.hidden) suspend(); else resume(); });
addEventListener("pageshow", () => { if (!document.hidden) resume(); }); // the back/forward cache brings the page back without a visibilitychange

// ---- Esc: the viewer's own key (or tap) in 133.0 … 134.38 is the Esc, now. Otherwise the MV's, at 134.38 (sounded here, since the foley stem is not played).
function escTick(T) {
  if (T < ESC0 - 0.001 || T > ESC_MV + 6) { if (escAt !== null || escSounded) { escAt = null; escSounded = false; shim.dbg.web.escAt = null; } return; }
  const at = escAt ?? ESC_MV; if (!escSounded && T >= at) { escSounded = true; if (escAt === null && T < at + 0.3 && !foley.sounding) sfx.escClick(); } // the stem has the MV's own Esc click at 134.42; ours only if the stem is not playing (not when a seek lands past it)
}
function anyInput() {
  if (!running || epiOn || escAt !== null) return false;
  const T = audio.currentTime; if (T < ESC0 || T >= ESC_MV) return false;
  escAt = T; escSounded = true; shim.dbg.web.escAt = T; sfx.escClick(); return true;
}

// ---- the epilogue
function startEpilogue() {
  if (epiOn) return; epiOn = true; W.shotQ = []; W.shots = []; /* "not saved. not sent.": no capture of the picture from here on, and none kept */ audio.pause(); epiT0 = last || performance.now(); epiStartedAt = performance.now();
  shim.dbg.noLyr = true; shim.dbg.web.escAt = null; shim.dbg.web.monT = 197.2;
  ui.fade(1, 1); ui.cueClear(); ui.hide();
  epi = new Epilogue({ scenes: shim.dbg.web.scenes, canvas: shim.canvas, ui, reduced: () => P.reduced, pose: () => { const L = ctrl.last; return { p: L.p, q: L.q, fov: L.fov || P.fovEpi }; }, onOpened: () => { epiOpenAt = performance.now(); epiCuePhase = "saved"; epiCueT = performance.now(); } });
  W.epi = epi;
  updatePlayer(); foley.halt();
  ctrl.epiStart({ x: 0.0, y: 1.5, z: 0.35, yaw: 0.05, pitch: -0.04 }); sfx.quiet = true;
  setTimeout(() => ui.fade(0, 2600), 80);
}
async function replay() {
  if (!started || !W.ready || W.noRoom || replaying) return;
  replaying = true; updatePlayer();
  try {
    audio.pause(); foley.halt(); abortGesture(true);
    epi?.dispose(); epi = null; W.epi = null; epiOn = false;
    epiOpenAt = null; epiCuePhase = epiCueLast = "";
    ctrl.epi = null; ctrl.reset(); ctrl.lastT = null;
    pendingSeek = null; escAt = null; escSounded = false;
    shim.dbg.noLyr = false;
    for (const k of ["escAt", "monT", "dustT", "frame", "me"]) delete shim.dbg.web[k];
    sfx.quiet = false; sfx.resume(); traces.clear();
    ui.cueClear(); ui.hide(); ui.fade(0, 1);
    applySeek(0); shim.update(0); await audio.play();
    // frame() already owns the only animation loop, even while paused or in the epilogue.
  } catch (e) { W.errors.push("replay: " + e.message); }
  finally { replaying = false; updatePlayer(); }
}
let epiCueT = 0;
function epiCues(now, L) {
  const fwd = L ? new THREE.Vector3(0, 0, -1).applyQuaternion(L.q) : null;
  const near = L && epi.nearGlass(L.p, fwd);
  let want = "";
  if (epiCuePhase === "saved") { want = "saved"; if (performance.now() - epiCueT > 5200) { epiCuePhase = "after"; } }
  else if (epiCuePhase === "after") want = "after";
  else if (performance.now() - epiStartedAt > 3200 && near) want = epi.canOpen ? "open" : "write";
  if (want === epiCueLast) return; epiCueLast = want;
  if (want === "write") ui.cue("指で、窓に。");
  else if (want === "open") ui.cue("窓を開ける — 横にスワイプ");
  else if (want === "saved") ui.cue("not saved. not sent.");
  else if (want === "after") ui.cue(`<span class="act" data-a="again" data-cur="block" role="button" tabindex="0">もう一度 — again</span><span class="act" data-a="log" data-cur="block" role="button" tabindex="0">制作ログ — log</span>`);
  else ui.cueClear();
}
let epiCueLast = "";
const doAct = (a) => { if (ui && ui.logOpen) return; if (a === "again") replay(); else if (a === "log") ui.openLog(shim.props.credits.events || []); };
document.addEventListener("pointerdown", (e) => doAct(e.target?.dataset?.a));
document.addEventListener("keydown", (e) => { const a = e.target?.dataset?.a; if (a && (e.code === "Enter" || e.code === "Space")) { e.preventDefault(); e.stopPropagation(); doAct(a); } }, true);
// the same two as keys: R again, L log
function epiKey(code) { if (!epiOn) return false; if (epiCuePhase === "after") { if (code === "KeyR") replay(); else if (code === "KeyL") ui.openLog(shim.props.credits.events || []); } if (code === "Enter" && epi.state !== "gone") epi.openKey(); return false; }

// ---- input: drag = look, WASD / arrows = walk, Q/E = turn, two fingers = walk, Space = pause, M = mute, C = captions, tap = time line
// keyboard only, to the end: arrows / WASD walk, Q E turn; Shift + arrows look (turn, up, down); T the time line, [ ] seek ∓10 s, C captions, Space, M; in the epilogue Enter opens the window, R again, L log
const SHIFT_LOOK = { ArrowLeft: () => { ctrl.in.dragDx += 28; }, ArrowRight: () => { ctrl.in.dragDx -= 28; }, ArrowUp: () => { ctrl.in.dragDy -= 22; }, ArrowDown: () => { ctrl.in.dragDy += 22; } };
const KEYS = { KeyW: ["fw", 1], ArrowUp: ["fw", 1], KeyS: ["fw", -1], ArrowDown: ["fw", -1], KeyA: ["st", -1], ArrowLeft: ["st", -1], KeyD: ["st", 1], ArrowRight: ["st", 1], KeyQ: ["turn", 1], KeyE: ["turn", -1] };
function recomputeKeys() {
  inp.fw = inp.st = inp.turn = 0;
  for (const c of keyDown) { const k = KEYS[c]; if (k) inp[k[0]] += k[1]; }
  for (const k of ["fw", "st", "turn"]) inp[k] = Math.max(-1, Math.min(1, inp[k]));
}
addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (ui && ui.logOpen) { if (e.code === "Escape") ui.closeLog(); return; }
  if (!running || e.target !== stage) return;
  if (e.code === "Escape") { setRoomMode(false); roomMode.focus({ preventScroll: true }); return; }
  if (!e.repeat) anyInput();
  if (e.shiftKey && SHIFT_LOOK[e.code]) { SHIFT_LOOK[e.code](); e.preventDefault(); }
  else if (KEYS[e.code]) { keyDown.add(e.code); recomputeKeys(); e.preventDefault(); }
  else if (e.code === "Space" && running && !epiOn) { e.preventDefault(); if (!e.repeat) togglePlayback(); }
  else if (e.code === "KeyM" && !e.repeat) { audio.muted = !audio.muted; sfx.setMuted(audio.muted); updatePlayer(); }
  else if (e.code === "KeyC" && !e.repeat && !epiOn && ui) ui.cycleCC();
  else if (e.code === "KeyT" && !e.repeat && !epiOn && ui) ui.toggle();
  else if ((e.code === "BracketLeft" || e.code === "BracketRight") && running && !epiOn) { seekTo(audio.currentTime + (e.code === "BracketLeft" ? -10 : 10)); ui.show(); }
  else if (!e.repeat) epiKey(e.code);
});
addEventListener("keyup", (e) => { if (keyDown.delete(e.code)) recomputeKeys(); });
const touches = new Map();
let joy0 = null, down0 = null, epiTake = false, lastTap = null, owner = null; // owner = { id, kind } of the pointer that owns the single-finger gesture (look / brush / sash)
/** every interruption of a gesture (a second finger, focus lost, the capture lost, a cancel, the page hidden) ends in here: nothing is left half-done — and an interruption never opens the window */
function abortGesture(all) {
  if (epi && epi.abort) epi.abort(); epiTake = false; owner = null; down0 = null; joy0 = null;
  if (lastTap) { clearTimeout(lastTap.timer); lastTap = null; }
  if (ctrl) { ctrl.in.dragging = false; ctrl.in.dragDx = ctrl.in.dragDy = 0; }
  if (all) { keyDown.clear(); touches.clear(); } recomputeKeys(); inp.fw = inp.st = 0; recomputeKeys();
}
addEventListener("blur", () => setRoomMode(false));
stage.addEventListener("focusout", (e) => { abortGesture(true); if (e.relatedTarget !== roomMode) setRoomMode(false); });
// A page scroll never seeks, changes playback, or resets the camera. It just releases any held input.
addEventListener("scroll", () => { setRoomMode(false); if (document.activeElement === stage) stage.blur(); }, { passive: true });

stage.addEventListener("pointerdown", (e) => {
  if (!running || (e.pointerType === "mouse" && e.button !== 0) || (e.pointerType === "touch" && !roomInteracting)) return;
  stage.focus({ preventScroll: true });
  try { stage.setPointerCapture(e.pointerId); } catch { /* ok */ } touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (touches.size === 1) { down0 = { x: e.clientX, y: e.clientY, t: performance.now(), moved: false };
    if (epiOn && epi && epi.pointerDown(e.clientX, e.clientY)) { epiTake = true; owner = { id: e.pointerId, kind: "epi" }; return; }
    owner = { id: e.pointerId, kind: "look" }; ctrl.in.dragging = true; }
  else if (touches.size === 2) { // a second finger: the first one's gesture (look, brush, sash) is over — finished properly — and the two of them walk
    if (epi && epi.abort) epi.abort(); epiTake = false; owner = null; down0 = null; ctrl.in.dragging = false; ctrl.in.dragDx = ctrl.in.dragDy = 0; joy0 = centroid(); }
});
stage.addEventListener("pointermove", (e) => {
  const t = touches.get(e.pointerId); if (!t) return;
  const dx = e.clientX - t.x, dy = e.clientY - t.y; t.x = e.clientX; t.y = e.clientY;
  if (down0 && Math.hypot(e.clientX - down0.x, e.clientY - down0.y) > 6) down0.moved = true;
  if (epiTake) { if (owner && owner.id === e.pointerId) epi.pointerMove(e.clientX, e.clientY); return; }
  if (touches.size === 1) { ctrl.in.dragDx += dx; ctrl.in.dragDy += dy; }
  else if (touches.size >= 2 && joy0) { const c = centroid(); inp.st = Math.max(-1, Math.min(1, (c.x - joy0.x) / 70)); inp.fw = Math.max(-1, Math.min(1, -(c.y - joy0.y) / 70)); }
});
const up = (e) => {
  if (!touches.has(e.pointerId)) return;
  if (e.type === "pointercancel") { touches.delete(e.pointerId); abortGesture(false); if (touches.size >= 2) joy0 = centroid(); return; } // a cancel is not a release
  touches.delete(e.pointerId);
  if (epiTake) { if (owner && owner.id === e.pointerId) { epi.pointerUp(); } else if (epi.abort) epi.abort(); epiTake = false; owner = null; down0 = null; if (touches.size === 0) ctrl.in.dragging = false; return; }
  const tap = down0 && !down0.moved && performance.now() - down0.t < 380 && touches.size === 0; const tp = down0; down0 = null;
  if (tap && !epiOn) { // a tap is an Esc if it falls in 133.0 … 134.38; otherwise it shows or hides the time line (on touch: a second tap close by, within 0.3 s, is "walk to that spot on the floor" instead)
    if (anyInput()) { /* that tap was the Esc */ } else if (e.pointerType === "touch") {
      if (lastTap && performance.now() - lastTap.t < 320 && Math.hypot(tp.x - lastTap.x, tp.y - lastTap.y) < 40) { clearTimeout(lastTap.timer); lastTap = null; const L = ctrl.last, fp = L && floorPoint(shim.canvas, { p: L.p, q: L.q, fov: L.fov || 46 }, tp.x, tp.y); if (fp) ctrl.goTo(fp.x, fp.z); }
      else
      lastTap = { t: performance.now(), x: tp.x, y: tp.y, timer: setTimeout(() => { lastTap = null; ui.toggle(); }, 300) };
    } else ui.toggle();
  }
  if (touches.size < 2) { inp.fw = inp.st = 0; recomputeKeys(); joy0 = null; } if (touches.size === 0) ctrl.in.dragging = false;
};
stage.addEventListener("pointerup", up); stage.addEventListener("pointercancel", up);
stage.addEventListener("lostpointercapture", (e) => { if (touches.has(e.pointerId)) { touches.delete(e.pointerId); abortGesture(false); } }); // the capture went away without a release
function centroid() { let x = 0, y = 0; for (const t of touches.values()) { x += t.x; y += t.y; } return { x: x / touches.size, y: y / touches.size }; }
stage.addEventListener("contextmenu", (e) => e.preventDefault());

// ---- QA / automation (window.__walk): only with ?qa=1
if (QA) Object.assign(W, {
  start, replay, seek, seekTo, audio, P, FORCED, startEpilogue, anyInput, benchMeasure,
  key(code, down = true) { if (down) { if (!keyDown.has(code)) anyInput(); keyDown.add(code); } else keyDown.delete(code); recomputeKeys(); },
  /** synthetic drag in CSS px, applied on the next tick (no pointer events needed) */
  drag(dx, dy, hold = true) { ctrl.in.dragDx += dx; ctrl.in.dragDy += dy; ctrl.in.dragging = hold; },
  endDrag() { ctrl.in.dragging = false; },
  state() { const d = ctrl.debug || {}; return { T: epiOn ? null : audio.currentTime, ctx: ctrl.ctx, eng: ctrl.eng, f: ctrl.f, e: ctrl.e, mode: d.mode, pos: ctrl.pF.toArray(), yaw: ctrl.yaw, pitch: ctrl.pitch, dP: ctrl.dP.length(), dR: ctrl.dR.length(), vel: ctrl.vel.length(), escAt }; },
  /** QA: capture the canvas when the song clock passes `at` */
  queueShot(at, label) { if (epiOn) return; /* never in the epilogue */ (W.shotQ = W.shotQ || []).push({ at, label }); W.shotQ.sort((a, b) => a.at - b.at); },
  pause() { audio.pause(); }, play() { return audio.play(); },
  /** stand somewhere: engages the free eye at an absolute pose (m, radians) at the current T */
  stand({ x, y = 1.55, z, yaw = 0, pitch = 0 }) { if (epiOn) { ctrl.pF.set(x, y, z); ctrl.yaw = yaw; ctrl.pitch = pitch; ctrl.epi.hold = true; return; } ctrl._engage(performance.now() / 1000); ctrl.pF.set(x, y, z); ctrl.pending.set(0, 0, 0); ctrl.yaw = yaw; ctrl.pitch = pitch; ctrl.lastInput = performance.now() / 1000 + 1e6; /* hold until released by hand */ },
  release() { ctrl.lastInput = -1e9; if (ctrl.epi) ctrl.epi.hold = false; },
  getEpiState() { return epi ? { state: epi.state, open: epi.open, strokeLen: epi.strokeLen, canOpen: !!epi.canOpen } : null; },
  getCueText() { return document.getElementById("cues")?.textContent || ""; },
});
boot().catch((e) => { W.errors.push(e.stack || e.message); console.error(e); if (/webgl|context/i.test(String(e && e.message))) noRoom(); else { noRoom(); console.error("room initialization failed", e); } });
