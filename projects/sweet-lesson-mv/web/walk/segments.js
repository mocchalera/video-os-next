// Forced segments — where time (the flow) is not negotiable (BRIEF §1-3, bible §3-2).
// The ONE place that lists them. Times are song seconds, taken from data/camera.json and graphics/room.html (see `src`).
//   a … b : the camera is exactly the MV's. Free amount is 0, input is ignored, the free state is thrown away.
//   a − RAMP … a : the free amount falls from 1 to 0 (smoothstep) — "about 0.8 s before".
//   a − RAMP − PREPULL … a − RAMP : inputs are ignored and the camera is carried back toward the flow (faster spring), so that
//   the 0.8 s ramp has little left to hide (without this, someone 20 m away in the white rooms would be flung back in 0.8 s).
export const RAMP = 0.8;
export const PREPULL = 3.0;

// optional per segment: pre = seconds of "carry back" before the ramp (default PREPULL); wind = the carry builds like a gust (ω 0.5 → 2.6)
export const FORCED = [
  { id: "window-out", a: 31.0, b: 38.3,
    why: "the camera leaves through the window glass, down over the city to the data centre, and comes back through the monitor's power LED",
    src: "camera.json room 31.0→38.28 (z −1.05 → −2.6 crosses the glass at ≈33.0); dc keys 34.5–37.25; dcMix 34.55–37.13; flash 36.85–37.6; room key 37.1 is a cut" },
  { id: "monitor-in", a: 58.4, b: 61.0,
    why: "the camera goes into the monitor glass; the screen becomes the white rooms",
    src: "camera.json room 58.4→59.9 (to the monitor); room.html portal starts wEnter−1.4 = 58.5; flash 59.5–60.25; whiteSpan[0] = white[0].t = 59.9; first white keys 59.9→61.0" },
  { id: "monitor-out", a: 84.1, b: 90.5, pre: 3.2, wind: true, // the way back out of the white rooms is a gust: it builds, then carries (see prePullAt)
    why: "the white camera rushes along the row of rooms to the window that opens, papers blow out, the room returns on the monitor glass",
    src: "camera.json white 84.1→87.4 (x 5.6 → 27.8); room.html gust window g0 = whiteSpan[1]−1.7 = 87.2; room key 88.9 is a cut (monitor fills the screen); portal out ends whiteSpan[1]+1.4 = 90.3; room key 90.45" },
  { id: "plane-flight", a: 94.25, b: 97.4,
    why: "the paper plane is thrown and flown once round the room; the camera follows it while the room goes from dusk into night",
    src: "room.html follow-camera fw = sstep(94.25,94.65)·(1−sstep(96.75,97.25)); camera.json plane keys 94.34→97.2; nightFall 94.3–97.3" },
  { id: "window-monitor-end", a: 197.0, b: 1e9,
    why: "the camera goes out through the opened window and back, then pushes into the monitor and into its glass (3:18 →, title at 3:31)",
    src: "camera.json room 195.2→197.8 (window), 199.4→214.8 (monitor dolly); room.html window slide 195.6–197.2; bible §7 (3:18–3:34.8)" },
];

const sstep = (x) => { x = Math.min(1, Math.max(0, x)); return x * x * (3 - 2 * x); };

/** 1 = free as far as the user likes, 0 = exactly the flow */
export function freeAmount(T) {
  let f = 1;
  for (const s of FORCED) {
    if (T >= s.a && T < s.b) return 0;
    if (T >= s.a - RAMP && T < s.a) f = Math.min(f, 1 - sstep((T - (s.a - RAMP)) / RAMP));
  }
  return f;
}
const preOf = (s) => s.pre ?? PREPULL;
/** inputs ignored (carry-back + ramp + forced) */
export function inputLocked(T) { for (const s of FORCED) if (T >= s.a - RAMP - preOf(s) && T < s.b) return true; return false; }
/** in the carry-back window before a ramp: { k: 0→1 progress through it, wind } or null */
export function prePullAt(T) { for (const s of FORCED) { const t0 = s.a - RAMP - preOf(s); if (T >= t0 && T < s.a) return { k: Math.min(1, (T - t0) / preOf(s)), wind: !!s.wind, seg: s }; } return null; }
export const prePull = (T) => !!prePullAt(T);
export function forcedAt(T) { for (const s of FORCED) if (T >= s.a && T < s.b) return s; return null; }

/** warn when data/camera.json no longer agrees with the table (the table is hand-derived from those times) */
export function validate(cam) {
  const w = [], has = (arr, t, tol = 0.02) => (arr || []).some((k) => Math.abs((k.t ?? k[0]) - t) < tol);
  if (!has(cam.room, 31.0)) w.push("room key 31.0 missing");
  if (!has(cam.room, 38.28)) w.push("room key 38.28 missing");
  if (!has(cam.room, 37.1)) w.push("room cut key 37.1 missing");
  if (!has(cam.room, 58.4)) w.push("room key 58.4 missing");
  if (Math.abs((cam.whiteSpan || [])[0] - 59.9) > 0.02 || Math.abs((cam.whiteSpan || [])[1] - 88.9) > 0.02) w.push("whiteSpan changed: " + JSON.stringify(cam.whiteSpan));
  if (!has(cam.white, 84.1)) w.push("white key 84.1 missing");
  if (!has(cam.plane, 94.34)) w.push("plane key 94.34 missing");
  if (!has(cam.room, 197.8)) w.push("room key 197.8 missing");
  for (const m of cam.dcMix || []) if (m[1] > 0 && m[0] < 31.0 - 1e-6) w.push("dcMix before 31.0");
  return w;
}
