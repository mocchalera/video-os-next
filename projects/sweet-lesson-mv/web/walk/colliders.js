// What a person can and cannot walk through. 2-D footprints (x, z) for walking, 3-D boxes for the focus ray.
// Numbers are from graphics/room.html (RX 1.35, RZ 1.8, RH 2.4, WT 0.12; bed, desk, chair, backpack, bin; white cell walls with door gaps).
const RX = 1.35, RZ = 1.8, RH = 2.4, WT = 0.12;
// The eye keeps 0.3 m from every surface in the room (walls, bed, desk, chair, bag, bin) — nothing is closer than that to the lens.
// The white rooms' doors are 0.75 m wide, so there a smaller radius (0.22) lets one through.
export const BODY_ROOM = 0.3, BODY_WHITE = 0.22;
export const PXc = 2 * RX + WT, PZc = 2 * RZ + WT, GN = 20; // white cells: pitch 2.82 × 3.72, lattice ±20 (41×41)

// boxes: [x0, x1, y0, y1, z0, z1]; circles: [x, z, r, y1]
const bed = [-RX + 0.02, -0.37, 0, 0.58, -RZ + 0.03, 0.22];
const desk = [0.75, RX - 0.01, 0, 0.75, -RZ + 0.05, -0.55];
const monitor = [1.12, 1.22, 0.75, 1.24, -1.45, -0.85];
const shelf = [RX - 0.26, RX, 1.5, 1.62, -1.7, -0.62];
const backpack = [-1.28, -0.96, 0, 0.42, 1.54, 1.72];
const chair = [0.5, -1.2, 0.28, 1.1];
const bin = [1.16, -0.7, 0.14, 0.3];

function room() {
  const solid = [bed, desk, monitor, shelf, backpack].map((b) => b.slice());
  const circles = [chair, bin];
  // walls as thin boxes (for the ray) — the walk is bounded by `bounds`
  const walls = [[-RX - WT, -RX, 0, RH, -RZ - WT, RZ + WT], [RX, RX + WT, 0, RH, -RZ - WT, RZ + WT], [-RX, RX, 0, RH, -RZ - WT, -RZ], [-RX, RX, 0, RH, RZ, RZ + WT]];
  return { name: "room", solid, circles, walls, bounds: { x0: -RX + BODY_ROOM, x1: RX - BODY_ROOM, z0: -RZ + BODY_ROOM, z1: RZ - BODY_ROOM }, ceil: RH };
}

// white cell (cell-local), mirrors cellWalls / cellFurn in room.html: left wall with a side door, back wall with the window and a door
const SD0 = -0.3, SD1 = 0.45, WW0 = -0.8, WW1 = 0.2, DX0 = 0.3, DX1 = 1.05;
function whiteCell() {
  const lwx0 = -RX - WT, lwx1 = -RX;
  const walls = [
    [lwx0, lwx1, 0, RH, -RZ - WT, SD0], [lwx0, lwx1, 0, RH, SD1, RZ],
    [-RX - WT, WW1 + 0.0, 0, RH, -RZ - WT, -RZ], // back wall: corner … window (glowing, treated as wall) … up to the door
    [WW1, DX0, 0, RH, -RZ - WT, -RZ], [DX1, RX, 0, RH, -RZ - WT, -RZ],
  ];
  // The white rooms are a maze of walls with door gaps; their furniture (bed, desk, chair) would shut every door to a person with a body
  // (the doors are 0.75 m wide, the desk and chair stand beside them) — and the eye at 1.55 m is above all of it anyway. So it is seen by
  // the focus ray (`solid`, `circles`) but does not stop the walk.
  const solid = [bed, desk, monitor].map((b) => b.slice());
  return { walls, solid, circles: [chair] };
}
const WC = whiteCell();

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
// push a point (radius r) out of an expanded box / circle
function pushBox(p, b, r) {
  const x0 = b[0] - r, x1 = b[1] + r, z0 = b[4] - r, z1 = b[5] + r;
  if (p.x <= x0 || p.x >= x1 || p.z <= z0 || p.z >= z1) return false;
  const dl = p.x - x0, dr = x1 - p.x, df = p.z - z0, db = z1 - p.z, m = Math.min(dl, dr, df, db);
  if (m === dl) p.x = x0; else if (m === dr) p.x = x1; else if (m === df) p.z = z0; else p.z = z1;
  return true;
}
function pushCircle(p, c, r) {
  const dx = p.x - c[0], dz = p.z - c[1], d = Math.hypot(dx, dz), R = c[2] + r;
  if (d >= R) return false;
  if (d < 1e-6) { p.x = c[0] + R; return true; }
  p.x = c[0] + (dx / d) * R; p.z = c[1] + (dz / d) * R; return true;
}
// a person is a column from the knees to the head, whatever height the eye is at: every box that reaches into 0.15–1.62 m blocks (bed, desk, monitor, shelf, bag, chair)
const inY = (b) => b[3] > 0.15 && b[2] < 1.62;
const cellOf = (x, z) => [Math.round(x / PXc), Math.round(z / PZc)];

export const ROOM = room();

const EPS = 1e-6;
const insideBox = (p, b, r) => p.x > b[0] - r + EPS && p.x < b[1] + r - EPS && p.z > b[4] - r + EPS && p.z < b[5] + r - EPS;
const insideCircle = (p, c, r) => Math.hypot(p.x - c[0], p.z - c[1]) < c[2] + r - EPS;

/** nearest point to p (within 3 m) that `valid` accepts: rings of growing radius. Rare (only when the iterative push-out ends somewhere invalid). */
function nearestValid(p, y, valid, fallback) {
  const q = { x: p.x, z: p.z };
  for (let r = 0.02; r <= 3.0; r += 0.02) {
    const n = Math.max(16, Math.ceil(r * 90)); let best = null, bd = 1e9;
    for (let k = 0; k < n; k++) { q.x = p.x + Math.cos((k / n) * Math.PI * 2) * r; q.z = p.z + Math.sin((k / n) * Math.PI * 2) * r; if (valid(q, y)) { best = { x: q.x, z: q.z }; break; } }
    if (best) return best;
  }
  return fallback;
}

/** a Space = { resolve(p, y), valid(p, y), ray(o, d, max), bounds } for 'room' or 'white'.
 *  resolve() pushes p out of what blocks it and returns true if it moved p; its result is always a valid place (inside the room's bounds AND not in
 *  anything): a push-out can end in a corner where wall and furniture overlap, so it is checked and, if need be, moved to the nearest valid point. */
export function space(name) {
  if (name === "room") {
    const lean = (b, y) => (y >= b[3] + 0.3 ? -0.15 : BODY_ROOM);   // a low thing under the eye may be leaned over; else the full 0.3 m
    const leanC = (c, y) => (y >= c[3] + 0.3 ? -0.1 : BODY_ROOM);
    const valid = (p, y) => {
      const B = ROOM.bounds; if (p.x < B.x0 - EPS || p.x > B.x1 + EPS || p.z < B.z0 - EPS || p.z > B.z1 + EPS) return false;
      for (const b of ROOM.solid) if (inY(b) && insideBox(p, b, lean(b, y))) return false;
      for (const c of ROOM.circles) if (insideCircle(p, c, leanC(c, y))) return false;
      return true;
    };
    return {
      name, valid,
      resolve(p, y) { // returns true when it had to move p
        const x0 = p.x, z0 = p.z;
        for (let it = 0; it < 4; it++) {
          let m = false;
          p.x = clamp(p.x, ROOM.bounds.x0, ROOM.bounds.x1); p.z = clamp(p.z, ROOM.bounds.z0, ROOM.bounds.z1);
          for (const b of ROOM.solid) if (inY(b) && pushBox(p, b, lean(b, y))) m = true;
          for (const c of ROOM.circles) if (pushCircle(p, c, leanC(c, y))) m = true;
          if (!m) break;
        }
        if (!valid(p, y)) { const q = nearestValid(p, y, valid, { x: 0, z: 0 }); p.x = q.x; p.z = q.z; }
        return Math.abs(p.x - x0) > 1e-9 || Math.abs(p.z - z0) > 1e-9;
      },
      ray: (o, d, max) => rayScene(o, d, max, ROOM.solid, ROOM.circles, ROOM.walls, 0, ROOM.ceil, [0, 0]),
    };
  }
  const limX = (v) => clamp(v, -GN * PXc - RX + BODY_WHITE, GN * PXc + RX - BODY_WHITE), limZ = (v) => clamp(v, -GN * PZc - RZ + BODY_WHITE, GN * PZc + RZ - BODY_WHITE);
  const inWall = (p) => {
    const [ci, cj] = cellOf(p.x, p.z);
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) { const lx = p.x - (ci + di) * PXc, lz = p.z - (cj + dj) * PZc; const q = { x: lx, z: lz }; for (const b of WC.walls) if (insideBox(q, b, BODY_WHITE)) return true; }
    return false;
  };
  const valid = (p) => p.x >= -GN * PXc - RX + BODY_WHITE - EPS && p.x <= GN * PXc + RX - BODY_WHITE + EPS && p.z >= -GN * PZc - RZ + BODY_WHITE - EPS && p.z <= GN * PZc + RZ - BODY_WHITE + EPS && !inWall(p);
  return {
    name: "white", valid,
    resolve(p, y) {
      const x0 = p.x, z0 = p.z;
      for (let it = 0; it < 4; it++) {
        let m = false;
        p.x = limX(p.x); p.z = limZ(p.z);
        const [ci, cj] = cellOf(p.x, p.z);
        for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
          const ox = (ci + di) * PXc, oz = (cj + dj) * PZc;
          p.x -= ox; p.z -= oz;
          for (const b of WC.walls) if (pushBox(p, b, BODY_WHITE)) m = true;
          p.x += ox; p.z += oz;
        }
        if (!m) break;
      }
      if (!valid(p)) { const q = nearestValid(p, y, valid, { x: x0, z: z0 }); p.x = q.x; p.z = q.z; }
      return Math.abs(p.x - x0) > 1e-9 || Math.abs(p.z - z0) > 1e-9;
    },
    ray(o, d, max) {
      const [ci, cj] = cellOf(o.x, o.z); let best = max;
      for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
        const ox = (ci + di) * PXc, oz = (cj + dj) * PZc;
        best = Math.min(best, rayScene(o, d, best, WC.solid, WC.circles, WC.walls, 0, RH, [ox, oz], di === 0 && dj === 0));
      }
      return best;
    },
  };
}

// distance along ray (origin o, unit direction d) to the first thing, ≤ max. Floor and ceiling are planes; the cell/room is closed by walls.
function rayScene(o, d, max, solid, circles, walls, floorY, ceilY, off) {
  let best = max;
  const ox = o.x - off[0], oz = o.z - off[1];
  const hit = (b) => { // slab test, box [x0,x1,y0,y1,z0,z1]
    let t0 = 0, t1 = best;
    for (const [oo, dd, lo, hi] of [[ox, d.x, b[0], b[1]], [o.y, d.y, b[2], b[3]], [oz, d.z, b[4], b[5]]]) {
      if (Math.abs(dd) < 1e-9) { if (oo < lo || oo > hi) return; continue; }
      let a = (lo - oo) / dd, c = (hi - oo) / dd; if (a > c) [a, c] = [c, a];
      t0 = Math.max(t0, a); t1 = Math.min(t1, c); if (t0 > t1) return;
    }
    if (t0 > 0.02 && t0 < best) best = t0;
  };
  for (const b of solid) hit(b);
  for (const b of walls) hit(b);
  for (const c of circles) hit([c[0] - c[2], c[0] + c[2], 0, c[3], c[1] - c[2], c[1] + c[2]]);
  if (d.y < -1e-6 && o.y > floorY) best = Math.min(best, (floorY - o.y) / d.y);
  if (d.y > 1e-6 && o.y < ceilY) best = Math.min(best, (ceilY - o.y) / d.y);
  return best;
}
