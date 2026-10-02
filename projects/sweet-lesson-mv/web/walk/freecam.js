// FreeCam — the viewer's eye in the room (BRIEF §1-3, M1).
//
// The MV's camera ("the flow") is the truth. The viewer may leave it with the eyes (drag) and the feet (WASD / arrows / two fingers),
// and is carried back when they let go. Time is never negotiable: segments.js says where the camera is exactly the flow's.
//
//   output pose = flow pose ⊕ f(T) · Δ          Δ = (position offset dP, rotation-vector offset dR), flow-local
//
// while engaged Δ is derived from the viewer's absolute pose (position pF, yaw/pitch), so the flow does not drag them along;
// when they let go Δ is relaxed to 0 by a critically damped spring (ω = 1.5 → settles in ≈ 4 s; not a lerp) — position and orientation both.
// f(T) is 1 except inside the 0.8 s before a forced segment (→ 0) and inside it (0).
// When there is nothing to show (not engaged, Δ = 0, or f = 0) the hook returns null and room.html renders the flow untouched.
//
// "A photographer's eye, not a game camera": walking is 1.1 m/s with acceleration, eye height 1.55 m, no head bob;
// looking has inertia and a pitch limit; the focus rests slowly on whatever is in the middle of the view, the aperture stays modest.
import { space } from "./colliders.js";
import { freeAmount, forcedAt, inputLocked, prePullAt } from "./segments.js";

const THREE = window.THREE;
export const P = {
  eyeY: 1.55, yMax: 2.1, yMin: 0.3,   // 0.3 m under the ceiling, 0.3 m above the floor
  vmax: 1.1, velTau: 0.22,
  lookSens: 0.0022, lookTau: 0.16, pitchMax: (75 * Math.PI) / 180, keyTurn: 1.6,
  hold: 0.2,              // s after the last input before the spring takes over
  omega: 1.5, omegaPre: 2.4, // return spring (settles ≈ 5.8/ω = 3.9 s) / the faster one before a forced segment
  fovFree: 52, apFree: 0.55, focusTau: 0.35, eTau: 0.3,
  focusMin: 0.35, focusMax: 9,
  reduced: false,         // prefers-reduced-motion: slower return, no inertia, no drift in the epilogue
  viewAspect: 16 / 9,     // the screen's width / height (walk.js keeps it); below 16/9 the picture is cropped at the sides and the lens is widened to compensate
  maxFov: 80,
  // the white rooms: a soft rope to the flow (no wall). Walking is as free as ever within D0; from D0 to D1 it gets heavy; past D1 it is slow,
  // and from D2 the rope gently draws the viewer back toward where the film is.
  tetherD0: 4, tetherD1: 10, tetherSlow: 0.12, ropeFrom: 6, ropeTo: 10, ropePull: 0.35,
  stride: 0.62,           // m per step (footsteps)
  epiDrift: 0.12, epiIdle: 2.5, epiTarget: [-0.1, 1.45, -0.55], // the epilogue's slow invitation toward the window
  epiMinZ: -1.805 + 0.72, // the eye stays ≥ 0.7 m from the glass in the epilogue: the picture is "a fogged window seen from inside the room", the city is for far away
  fovEpi: 50, apEpi: 1.5, // a little wider than the walking eye, and a shallower focus on the glass: what is outside goes soft
};

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const damp = (dt, tau) => 1 - Math.exp(-dt / tau);
/** a vertical fov widened for a screen whose shape is not 16:9 (the canvas is shown 'cover': the long side is cropped): tan(½fov) × (shape ratio)^0.55, never beyond maxFov.
 *  Narrower than 16:9 (a phone upright) crops the sides — widened a lot; wider than 16:9 crops the top and bottom — a little. */
export function portraitFov(fov) {
  const A = 16 / 9, a = P.viewAspect, f = a < A ? a / A : A / a; if (f >= 0.999) return fov;
  const t = Math.tan((fov * Math.PI) / 360) * Math.pow(1 / f, 0.55); return Math.min(P.maxFov, (2 * Math.atan(t) * 180) / Math.PI);
}
const _m = new THREE.Matrix4(), _e = new THREE.Euler(0, 0, 0, "YXZ"), _v = V(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();

function flowPose(flow) {
  const p = V(...flow.p), l = V(...flow.l), up = V(...(flow.up || [0, 1, 0])).normalize();
  _m.lookAt(p, l, up); const q = new THREE.Quaternion().setFromRotationMatrix(_m);
  return { p, q, fov: flow.fov, ap: flow.ap ?? 0.8, focus: flow.focus > 0 ? flow.focus : Math.max(0.3, p.distanceTo(l)) };
}
function rotVec(q) { // quaternion → rotation vector (shortest)
  const a = q.clone(); if (a.w < 0) { a.x = -a.x; a.y = -a.y; a.z = -a.z; a.w = -a.w; }
  const s = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
  if (s < 1e-9) return V();
  const ang = 2 * Math.atan2(s, a.w); return V(a.x / s, a.y / s, a.z / s).multiplyScalar(ang);
}
function fromRotVec(r, out) { const a = r.length(); if (a < 1e-9) return out.identity(); return out.setFromAxisAngle(_v.copy(r).multiplyScalar(1 / a), a); }

export class FreeCam {
  /** @param {{whiteSpan:number[]}} cam  data/camera.json */
  constructor(cam) {
    this.whiteSpan = cam.whiteSpan || [1e9, 1e9];
    this.spaces = { room: space("room"), white: space("white") };
    this.reset();
    this.in = { dragDx: 0, dragDy: 0, dragging: false, fw: 0, st: 0, turn: 0 }; // filled by the input layer
    this.lastT = null; this.lastTick = null;
    this.debug = {}; this.onStep = null; this.stepAcc = 0; this.epi = null;
  }
  ctxAt(T) { return T >= this.whiteSpan[0] && T < this.whiteSpan[1] ? "white" : "room"; }

  reset() {
    this.eng = false; this.lastInput = -1e9; this.e = 0; this.goal = null; // (a double-tapped destination does not survive a seek, a forced segment or a change of space)
    this.pF = V(); this.yaw = 0; this.pitch = 0; this.vel = V(); this.yawV = 0; this.pitchV = 0;
    this.dP = V(); this.dPv = V(); this.dR = V(); this.dRv = V();
    this.focusF = 2; this.last = null; this.flowPrev = null; this.flowVel = V();
    this.walking = false; this.pending = V(); this.dt = 1 / 60;
    if (this.in) this.in.dragDx = this.in.dragDy = 0; // a reset (seek, forced segment, context change) forgets drags not yet applied
  }
  /** the epilogue: no flow, the eye stays where it is put, and drifts (slowly) toward the window when left alone */
  epiStart(pose) {
    this.reset(); this.epi = { drift: true }; this.ctx = "room"; this.eng = true; this.e = 1; this.f = 1; this.lastInput = performance.now() / 1000;
    this.pF.set(pose.x, pose.y ?? P.eyeY, pose.z); this.yaw = pose.yaw ?? 0; this.pitch = pose.pitch ?? 0; this.focusF = 1.2;
    this.last = { p: this.pF.clone(), q: new THREE.Quaternion(), focusOut: 1.2 };
  }
  /** walk to a floor point (a double tap): the eye goes there at walking pace; any key, drag or finger of the viewer cancels it */
  goTo(x, z) { const sp = this.spaces[this.ctx]; if (!sp) return; const t = { x, z }; sp.resolve(t, this.pF.y || P.eyeY); this.goal = t; this.lastInput = performance.now() / 1000; }
  get offset() { return this.dP.lengthSq() > 1e-10 || this.dR.lengthSq() > 1e-10; }

  /** the viewer starts to act: take the pose that is on screen right now */
  _engage(now) {
    if (this.eng) return;
    const L = this.last; if (!L) return;
    this.eng = true; this.pF.copy(L.p);
    _v.set(0, 0, -1).applyQuaternion(L.q);
    this.pitch = Math.max(-P.pitchMax, Math.min(P.pitchMax, Math.asin(Math.max(-1, Math.min(1, _v.y)))));
    this.yaw = Math.atan2(-_v.x, -_v.z);
    if (Math.abs(_v.y) > 0.96) { // looking (almost) straight down: the heading is where the top of the picture points, so "forward" is up the screen
      const u = V(0, 1, 0).applyQuaternion(L.q); if (u.x * u.x + u.z * u.z > 1e-4) this.yaw = Math.atan2(-u.x, -u.z);
    }
    this.vel.set(0, 0, 0); this.yawV = this.pitchV = 0; this.focusF = L.focusOut;
    this.walking = false;
    // a start outside what a person can stand on (the doorway, outside the glass, in a wall) is eased inside, not snapped
    const sp = this.spaces[this.ctx], t = this.pF.clone(); sp.resolve(t, this.pF.y); this.pending.copy(t).sub(this.pF);
  }

  /** once per frame, before room.update(T). dt in seconds (wall clock), `now` in seconds (wall clock). */
  tick(dt, T, now) {
    dt = Math.min(dt, 0.1); this.dt = dt;
    if (this.epi) { this._tickEpi(dt, now); return; }
    const jump = this.lastT !== null && Math.abs(T - this.lastT) > 0.6;
    const ctx = this.ctxAt(T);
    if (jump || ctx !== this.ctx) { this.reset(); }
    this.ctx = ctx; this.lastT = T;
    const f = freeAmount(T), locked = inputLocked(T), pre = prePullAt(T);
    this.f = f;
    if (forcedAt(T) || f <= 0) { this.reset(); this.f = 0; this.in.dragDx = this.in.dragDy = 0; return; } // exactly the flow; the viewer's state does not survive the glass — and what they did during it is dropped, not saved up for afterwards
    const I = this.in;
    const wantsLook = I.dragging || Math.abs(I.turn) > 0 || Math.abs(this.yawV) > 0.02 || Math.abs(this.pitchV) > 0.02;
    const wantsMove = Math.abs(I.fw) > 0 || Math.abs(I.st) > 0 || this.vel.lengthSq() > 0.0009;
    if (this.goal && (wantsLook || Math.abs(I.fw) + Math.abs(I.st) > 0 || I.dragDx || I.dragDy)) this.goal = null; // the viewer took over
    const acting = !locked && (wantsLook || wantsMove || I.dragDx !== 0 || I.dragDy !== 0 || !!this.goal);
    if (acting) { this._engage(now); if (this.eng) this.lastInput = now; }
    if (this.eng && (locked || now - this.lastInput > P.hold)) this._release();

    if (this.eng) this._drive(dt, now);
    else if (this.offset) {
      let w = P.reduced ? 1.0 : P.omega;
      if (pre) { w = pre.wind ? 0.5 + (P.omegaPre + 0.2 - 0.5) * (pre.k * pre.k * (3 - 2 * pre.k)) : P.omegaPre; } // a gust builds; the room's carry-back is steady
      this._spring(dt, w);
    }
    // engagement weight for focus / aperture / fov: 1 while engaged, then follows the deviation so that it dies with the offset
    if (this.eng) this.e += (1 - this.e) * damp(dt, P.eTau);
    else { const dev = Math.min(1, Math.max(this.dP.length() / 0.5, this.dR.length() / 0.3)); this.e = Math.min(this.e, dev); }
    I.dragDx = I.dragDy = 0;
  }

  _release() {
    this.eng = false;
    // carry the viewer's momentum into the spring (relative to the flow)
    this.dPv.copy(this.vel).sub(this.flowVel); this.dRv.set(0, 0, 0);
    this.vel.set(0, 0, 0); this.yawV = this.pitchV = 0;
  }

  _drive(dt, now) {
    const I = this.in, sp = this.spaces[this.ctx]; let fwGoal = false;
    // look: drag moves the view directly (and feeds an inertia that decays), keys turn
    if (I.dragging || I.dragDx || I.dragDy) {
      const yd = I.dragDx * P.lookSens, pd = I.dragDy * P.lookSens;
      this.yaw += yd; this.pitch += pd;
      const k = Math.min(1, dt / 0.05); this.yawV += (yd / Math.max(dt, 1e-3) - this.yawV) * k; this.pitchV += (pd / Math.max(dt, 1e-3) - this.pitchV) * k;
    } else if (!P.reduced) {
      this.yaw += this.yawV * dt; this.pitch += this.pitchV * dt;
      const d = Math.exp(-dt / P.lookTau); this.yawV *= d; this.pitchV *= d;
    } else this.yawV = this.pitchV = 0;
    if (I.turn) this.yaw += I.turn * P.keyTurn * dt;
    this.pitch = Math.max(-P.pitchMax, Math.min(P.pitchMax, this.pitch));
    // walk: horizontal, along the view; speed eased (accelerates and stops like a person)
    const fw = I.fw, st = I.st, mag = Math.hypot(fw, st) || 1, sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    let tx = ((-sy * fw + cy * st) / mag) * P.vmax * Math.min(1, Math.hypot(fw, st)), tz = ((-cy * fw - sy * st) / mag) * P.vmax * Math.min(1, Math.hypot(fw, st));
    if (this.goal) { const gx = this.goal.x - this.pF.x, gz = this.goal.z - this.pF.z, gd = Math.hypot(gx, gz); if (gd < 0.12) this.goal = null; else { const sp0 = P.vmax * Math.min(1, gd / 0.9); tx = (gx / gd) * sp0; tz = (gz / gd) * sp0; fwGoal = true; } }
    if (this.ctx === "white" && this.flowPrev) { // the rope: heavier the further from the flow, never a wall; far out it also draws the viewer back, softly
      const dx = this.flowPrev.x - this.pF.x, dz = this.flowPrev.z - this.pF.z, d = Math.hypot(dx, dz), ss = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
      const g = d <= P.tetherD1 ? 1 - (1 - P.tetherSlow) * ss(P.tetherD0, P.tetherD1, d) : P.tetherSlow * (P.tetherD1 / d);
      tx *= g; tz *= g; const pull = P.ropePull * ss(P.ropeFrom, P.ropeTo, d); if (d > 1e-3) { tx += (dx / d) * pull; tz += (dz / d) * pull; }
      this.debug.tether = g;
    }
    const k = damp(dt, P.velTau);
    this.vel.x += (tx - this.vel.x) * k; this.vel.z += (tz - this.vel.z) * k; this.vel.y = 0;
    if (this.vel.lengthSq() < 1e-6) this.vel.set(0, 0, 0);
    const walking = Math.abs(fw) + Math.abs(st) > 0 || fwGoal; this.walking = walking;
    const x0 = this.pF.x, z0 = this.pF.z;
    // step with sliding collision (axis by axis), then eye height
    const p = this.pF, y = p.y;
    if (this.pending.lengthSq() > 1e-4) { // still easing in from outside: move, no collision for these few frames
      const d = this.pending.clone().multiplyScalar(damp(dt, 0.15)); p.add(d); this.pending.sub(d);
      p.x += this.vel.x * dt; p.z += this.vel.z * dt;
    } else {
      this.pending.set(0, 0, 0);
      // axis by axis: only a push along the axis that moved counts as "blocked" (so a person slides along a wall)
      p.x += this.vel.x * dt; let a = p.x; sp.resolve(p, y); if (Math.abs(p.x - a) > 1e-6) this.vel.x *= 0.2;
      p.z += this.vel.z * dt; a = p.z; sp.resolve(p, y); if (Math.abs(p.z - a) > 1e-6) this.vel.z *= 0.2;
    }
    if (walking) { p.y += (P.eyeY - p.y) * damp(dt, 0.6);
      // stood up from a view straight down (the overhead shots): walking brings the eyes up toward the horizon, slowly
      if (this.pitch < -0.6) this.pitch += (-0.2 - this.pitch) * damp(dt, 1.4); }
    if (p.y > P.yMax) p.y += (P.yMax - p.y) * damp(dt, 0.45);
    if (p.y < P.yMin) p.y += (P.yMin - p.y) * damp(dt, 0.2);
    this._steps(Math.hypot(p.x - x0, p.z - z0));
  }
  /** a footfall every `stride` metres walked — on the floor of the room only (the white rooms have no friction, so no sound), at standing height */
  _steps(dist) {
    if (this.ctx !== "room" || this.pF.y > 1.9) { this.stepAcc = 0; return; }
    this.stepAcc += dist; while (this.stepAcc >= P.stride) { this.stepAcc -= P.stride; if (this.onStep) this.onStep(); }
  }
  _tickEpi(dt, now) {
    const I = this.in, sp = this.spaces.room; this.f = 1;
    const acting = I.dragging || I.dragDx || I.dragDy || Math.abs(I.fw) + Math.abs(I.st) + Math.abs(I.turn) > 0 || this.vel.lengthSq() > 0.0009 || Math.abs(this.yawV) > 0.02;
    if (acting) this.lastInput = now;
    const idle = now - this.lastInput > P.epiIdle && !this.epi.hold && !P.reduced; // reduced motion: the eye stays where it is put
    if (acting || !idle) { this._drive(dt, now); this.pF.z = Math.max(this.pF.z, P.epiMinZ); }
    else { // alone: drift toward the window, slowly, and look at it
      const t = P.epiTarget, p = this.pF, dx = t[0] - p.x, dz = t[2] - p.z, d = Math.hypot(dx, dz);
      if (d > 0.08) { const v = P.epiDrift * Math.min(1, d / 0.8), x0 = p.x, z0 = p.z; p.x += (dx / d) * v * dt; p.z += (dz / d) * v * dt; sp.resolve(p, p.y); p.z = Math.max(p.z, P.epiMinZ); this._steps(Math.hypot(p.x - x0, p.z - z0)); }
      this.yaw += ((Math.atan2(-dx, -dz) || 0) - this.yaw) * damp(dt, 3.0) * (d > 0.08 ? 1 : 0); this.pitch += (-0.1 - this.pitch) * damp(dt, 3.0);
    }
    I.dragDx = I.dragDy = 0;
  }

  _spring(dt, w) {
    // x'' = −2ω x' − ω² x, semi-implicit; split in small steps so a long frame stays stable
    const n = Math.ceil(dt / 0.008), h = dt / n;
    for (let i = 0; i < n; i++) {
      this.dPv.addScaledVector(this.dP, -w * w * h).addScaledVector(this.dPv, -2 * w * h); this.dP.addScaledVector(this.dPv, h);
      this.dRv.addScaledVector(this.dR, -w * w * h).addScaledVector(this.dRv, -2 * w * h); this.dR.addScaledVector(this.dRv, h);
    }
    if (this.dP.lengthSq() < 1e-8 && this.dPv.lengthSq() < 1e-8) { this.dP.set(0, 0, 0); this.dPv.set(0, 0, 0); }
    if (this.dR.lengthSq() < 1e-8 && this.dRv.lengthSq() < 1e-8) { this.dR.set(0, 0, 0); this.dRv.set(0, 0, 0); }
  }

  _composeEpi() {
    const dt = this.dt; _e.set(this.pitch, this.yaw, 0, "YXZ"); const q = new THREE.Quaternion().setFromEuler(_e), p = this.pF.clone();
    const fwd = V(0, 0, -1).applyQuaternion(q), upv = V(0, 1, 0).applyQuaternion(q);
    const hit = Math.max(P.focusMin, Math.min(P.focusMax, this.spaces.room.ray(p, fwd, P.focusMax))); this.focusF += (hit - this.focusF) * damp(dt, P.focusTau);
    this.last = { p: p.clone(), q: q.clone(), focusOut: this.focusF, fov: portraitFov(P.fovEpi) }; this.debug = { mode: "epilogue", f: 1, e: 1 };
    return { p: [p.x, p.y, p.z], l: [p.x + fwd.x * 3, p.y + fwd.y * 3, p.z + fwd.z * 3], up: [upv.x, upv.y, upv.z], fov: portraitFov(P.fovEpi), ap: P.apEpi, focus: this.focusF };
  }
  /** the room.html hook: ctxName 'room' | 'white', flow = {p,l,fov,up,ap,focus}. Returns the pose to render, or null (= the flow). */
  compose(ctxName, T, flow) {
    if (ctxName !== this.ctx) return null; // the other camera is not the one on screen
    const dt = this.dt;
    if (this.epi) return this._composeEpi();
    const fl = flowPose(flow);
    if (this.flowPrev) this.flowVel.copy(fl.p).sub(this.flowPrev).multiplyScalar(1 / Math.max(dt, 1e-3)).clampLength(0, 30);
    this.flowPrev = fl.p.clone();
    const f = this.f ?? 1;
    const idle = !this.eng && !this.offset;
    if (f <= 0 || idle) { this.last = { p: fl.p.clone(), q: fl.q.clone(), focusOut: fl.focus, fov: portraitFov(fl.fov) }; this.debug = { mode: "flow", f }; return Math.abs(P.viewAspect - 16 / 9) > 0.01 ? { p: flow.p, l: flow.l, up: flow.up, fov: portraitFov(fl.fov), ap: flow.ap, focus: flow.focus } : null; }
    let p, q;
    if (this.eng) {
      _e.set(this.pitch, this.yaw, 0, "YXZ"); const qa = _q.setFromEuler(_e);
      this.dP.copy(this.pF).sub(fl.p); // flow-world offset (the flow's own motion does not drag the viewer)
      _q2.copy(fl.q).invert().multiply(qa); this.dR.copy(rotVec(_q2));
    }
    // output = flow ⊕ f·Δ
    p = fl.p.clone().addScaledVector(this.dP, f);
    q = fl.q.clone().multiply(fromRotVec(_v.copy(this.dR).multiplyScalar(f), new THREE.Quaternion()));
    const fwd = V(0, 0, -1).applyQuaternion(q), upv = V(0, 1, 0).applyQuaternion(q);
    // focus rests on what is in the middle of the view (ray against the room), slowly; aperture and fov follow the engagement
    const sp = this.spaces[this.ctx], hit = Math.max(P.focusMin, Math.min(P.focusMax, sp.ray(p, fwd, P.focusMax)));
    if (this.eng || this.e > 0) this.focusF += (hit - this.focusF) * damp(dt, P.focusTau);
    const e = this.e * f;
    const focusOut = fl.focus + (this.focusF - fl.focus) * e, fov = fl.fov + (P.fovFree - fl.fov) * e, ap = fl.ap + (P.apFree - fl.ap) * e;
    this.last = { p: p.clone(), q: q.clone(), focusOut, fov: portraitFov(fov) };
    this.debug = { mode: this.eng ? "engaged" : "returning", f, e, dP: this.dP.length(), dR: this.dR.length() };
    const L = 3; // the look-at point is only a direction (room.html adds a tiny handheld to it): keep it far enough that the sway stays an angle, not a distance
    return { p: [p.x, p.y, p.z], l: [p.x + fwd.x * L, p.y + fwd.y * L, p.z + fwd.z * L], up: [upv.x, upv.y, upv.z], fov: portraitFov(fov), ap, focus: focusOut };
  }
}
