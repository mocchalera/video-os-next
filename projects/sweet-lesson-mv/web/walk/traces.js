// What shows that you are in the room (BRIEF §2): you are not drawn — no body, no hand, no cursor — only traces, small, at a human's speed, physical.
//   (a) the dust in the light gives way: round the body and a little off the line of sight   → room.html (DBG.web.me), this file only feeds it
//   (b) footsteps on the wooden floor of the room, none in the white rooms (friction-less)    → sfx.js, freecam.js (_steps)
//   (c) your breath on cold glass: the window and the monitor, only in the cold hours         → this file
const THREE = window.THREE;
const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// cold hours (BRIEF §2: "the cold morning and before dawn"): before the first light (until 0:38) and from the second night's end (2:15) through the morning
export const isCold = (T) => T < 38.3 || T >= 135;

// the glass of the room (graphics/room.html: window panes at z ≈ −1.82 spanning x ±0.8, y 0.93–2.07; the monitor's face at x = 1.17, z −1.45…−0.85, y 0.89…1.23)
const GLASS = [
  { id: "window", n: [0, 0, 1], c: [0, 1.5, -1.805], u: [1, 0, 0], v: [0, 1, 0], hw: 0.74, hh: 0.52, size: 0.2, max: 0.28, tint: 0xb8c0c9 },
  { id: "monitor", n: [-1, 0, 0], c: [1.163, 1.06, -1.15], u: [0, 0, 1], v: [0, 1, 0], hw: 0.27, hh: 0.14, size: 0.05, max: 0.16, tint: 0x5f666e },
];

function patchTexture() {
  const c = document.createElement("canvas"); c.width = c.height = 128; const x = c.getContext("2d");
  x.fillStyle = "#000"; x.fillRect(0, 0, 128, 128);
  const g = x.createRadialGradient(64, 64, 4, 64, 64, 62); g.addColorStop(0, "rgba(255,255,255,0.95)"); g.addColorStop(0.45, "rgba(255,255,255,0.55)"); g.addColorStop(1, "rgba(255,255,255,0)");
  x.fillStyle = g; x.fillRect(0, 0, 128, 128);
  let s = 7; const r = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  x.globalCompositeOperation = "multiply"; for (let i = 0; i < 260; i++) { x.fillStyle = `rgba(0,0,0,${0.1 + r() * 0.35})`; x.beginPath(); x.arc(r() * 128, r() * 128, 0.6 + r() * 1.8, 0, 7); x.fill(); }
  const t = new THREE.CanvasTexture(c); return t;
}

export class Traces {
  constructor(world) {
    this.world = world; this.tex = patchTexture(); this.items = [];
    for (const g of GLASS) {
      const mat = new THREE.MeshStandardMaterial({ color: g.tint, emissive: 0x000000, alphaMap: this.tex, transparent: true, opacity: 0, roughness: 0.3, depthWrite: false });
      const m = new THREE.Mesh(new THREE.PlaneGeometry(g.size, g.size), mat); m.visible = false; m.renderOrder = 5; world.add(m);
      if (g.n[0] === -1) m.rotation.y = -Math.PI / 2;
      this.items.push({ g, m, dwell: 0, alive: false, age: 0, away: 0, pos: [0, 0] });
    }
  }
  /** eye, fwd: THREE.Vector3; cold: bool; active: you are the camera (free-look weight high) — otherwise nothing starts and what is there goes; dt s. Breath: within 0.5 m of the glass, looking at it, for a second → a small fog grows where you look; it clears when you leave. */
  update(dt, eye, fwd, cold, active) {
    for (const it of this.items) {
      const g = it.g, n = new THREE.Vector3(...g.n), c = new THREE.Vector3(...g.c);
      const d = eye.clone().sub(c).dot(n), facing = -fwd.dot(n);
      let hit = null;
      if (d > 0.04 && facing > 0.3) { const t = d / facing; const P = eye.clone().addScaledVector(fwd, t); const rel = P.sub(c); const a = rel.dot(new THREE.Vector3(...g.u)), b = rel.dot(new THREE.Vector3(...g.v)); if (Math.abs(a) < g.hw && Math.abs(b) < g.hh) hit = [a, b]; }
      const near = active && cold && d <= 0.5 && hit;
      it.dwell = near ? it.dwell + dt : Math.max(0, it.dwell - 1.5 * dt);
      if (!it.alive && it.dwell >= 1.0 && hit) { it.alive = true; it.age = 0; it.away = 0; it.pos = hit; }
      if (it.alive) {
        it.age += dt; it.away = near ? Math.max(0, it.away - dt * 0.5) : it.away + dt * (active ? 1 : 3.2);
        const k = sstep(0, 1.8, it.age), life = 1 - sstep(0, 3.2, it.away);
        const op = g.max * k * life, s = 0.4 + 0.6 * sstep(0, 2.2, it.age);
        it.m.visible = op > 0.004; it.m.material.opacity = op; it.m.scale.setScalar(s);
        const u = new THREE.Vector3(...g.u), v = new THREE.Vector3(...g.v), off = n.clone().multiplyScalar(0.004);
        it.m.position.copy(c).addScaledVector(u, it.pos[0]).addScaledVector(v, it.pos[1]).add(off);
        if (it.away >= 3.2) { it.alive = false; it.m.visible = false; }
      } else it.m.visible = false;
    }
  }
  /** drop every patch at once (a forced segment, a seek) */
  clear() { for (const it of this.items) { it.alive = false; it.dwell = 0; it.m.visible = false; it.m.material.opacity = 0; } }
  dispose() { for (const it of this.items) { this.world.remove(it.m); it.m.geometry.dispose(); it.m.material.dispose(); } this.tex.dispose(); }
}
