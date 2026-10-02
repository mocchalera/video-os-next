// The epilogue (BRIEF §1-6): after the song the morning room stays. The window is fogged, with what a finger wrote in the MV — 何を／手放せる？ —
// and below it you can write with a finger (the mouse). Then you open the window, and the fog, with what you wrote, goes out into the morning air.
// What you write is a canvas in memory and nothing else: no storage, no network, no copy. It is thrown away when the window is open.
const THREE = window.THREE;
const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// The room's left sliding pane (frontPane in room.html) is the one the MV's finger wrote on and the one that slides open (x += 0.76 m, 195.6 → 197.2 s).
// Geometry from room.html: the glass is 0.77 × 1.09 m centred at x = −0.4, y = 1.5, z ≈ −1.82 (room side +z); its frame bars are 0.035 m.
const PANE = { cx: -0.4, cy: 1.5, z: -1.808, w: 0.77, h: 1.09 };
// where a finger may write (below the MV's own writing, which sits in the 0.5 m square patch above y ≈ 1.21–1.32) and where the sash may be grabbed
const WRITE = { x0: -0.78, x1: -0.14, y0: 0.96, y1: 2.03 }; // the whole left pane's glass: strokes show best where the morning behind them is dark
const GRAB = { x0: -0.84, x1: 0.82, y0: 0.9, y1: 2.12, rail: [-0.14, 0.1] }; // the sash: the left pane's meeting rail (and its frame); once something is written, a swipe over any of the window's glass opens it
const WIPED = "#383838"; // wiped glass keeps a trace of veil (≈ 22%): the far side is seen clearly, never as a black hole: what is behind is seen clearly, but never as a black hole
const CW = 768, CH = Math.round((768 * PANE.h) / PANE.w); // canvas px (1 px ≈ 1 mm)

const OPEN_AT = 0.35; // let go before this and the sash goes back; at or after it, it opens the rest of the way and is final
export const T_CLOSED = 195.6, T_OPEN = 197.2; // room.html: frontPane = 0.76·sstep(195.6, 197.2, T), the fog clears 195.6–196.6

export class Epilogue {
  /** @param {{scenes:any, pose:()=>{p:THREE.Vector3,q:THREE.Quaternion,fov:number}, canvas:HTMLCanvasElement, ui:any, onOpened:()=>void}} o */
  constructor(o) {
    this.o = o; this.state = "idle"; this.open = 0; this.strokeLen = 0; this.drips = []; this.writing = false; this.grab = null; this.last = null; this.cue = "";
    const world = o.scenes.world;
    this.pane = world.children.find((c) => c.isGroup && c.children.some((m) => m.name === "glass" && m.position.x < 0));
    const mk = () => { const c = document.createElement("canvas"); c.width = CW; c.height = CH; return c; };
    this.cv = mk(); this.cx = this.cv.getContext("2d"); this.base = mk(); this.rim = mk(); this.core = mk(); this.rx = this.rim.getContext("2d"); this.kx = this.core.getContext("2d"); this.inn = mk(); this.ix = this.inn.getContext("2d"); this.tmp = mk(); this.tx = this.tmp.getContext("2d");
    this._fog(this.base.getContext("2d")); this._compose();
    this.tex = new THREE.CanvasTexture(this.cv);
    this.emiCv = mk(); this.emx = this.emiCv.getContext("2d"); this.emTex = new THREE.CanvasTexture(this.emiCv); this._compose(); // self-light map: even (85/255 = 0.33 × intensity 3.0 = the old flat glow; the map is not colour-decoded) with a 1-2 px brighter water edge along a wiped trace
    this.mat = new THREE.MeshStandardMaterial({ color: 0xf6f8fb, emissive: 0xa9b2bc, emissiveMap: this.emTex, emissiveIntensity: 3.0, alphaMap: this.tex, transparent: true, opacity: 0.95, roughness: 0.3, depthWrite: false }); // a little self-light: the morning room is dim, and the finger's trace must read
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(PANE.w, PANE.h), this.mat); this.mesh.renderOrder = 6;
    // the other pane (it stays put; the left one slides over it) has the same morning breath, without writing
    this.cv2 = document.createElement("canvas"); this.cv2.width = CW; this.cv2.height = CH; this.cx2 = this.cv2.getContext("2d"); this._fogOnly(this.cx2);
    this.tex2 = new THREE.CanvasTexture(this.cv2); this.mat2 = this.mat.clone(); this.mat2.alphaMap = this.tex2; { const f = document.createElement("canvas"); f.width = f.height = 2; const g = f.getContext("2d"); g.fillStyle = "rgb(85,85,85)"; g.fillRect(0, 0, 2, 2); this.flatTex = new THREE.CanvasTexture(f); this.mat2.emissiveMap = this.flatTex; }
    this.mesh2 = new THREE.Mesh(new THREE.PlaneGeometry(PANE.w, PANE.h), this.mat2); this.mesh2.renderOrder = 5; this.mesh2.position.set(0.4, PANE.cy, -1.848); world.add(this.mesh2);
    // after the window opens the outside is shown as morning LIGHT, not as buildings: a veil of near-white in the opening, just outside the wall (the wall and the building's skin hide its edges),
    // so the city behind it is softly bleached — the shapes stay faintly, the flat sunlit faces stop reading as solid walls. Nothing of the MV's render changes (this is a mesh added to the scene).
    { const c = document.createElement("canvas"); c.width = 4; c.height = 128; const g = c.getContext("2d"), gr = g.createLinearGradient(0, 0, 0, 128);
      gr.addColorStop(0, "rgba(255,255,255,0.55)"); gr.addColorStop(0.5, "rgba(255,255,255,0.78)"); gr.addColorStop(1, "rgba(255,255,255,0.95)"); g.fillStyle = gr; g.fillRect(0, 0, 4, 128);
      this.veilTex = new THREE.CanvasTexture(c); this.veilMat = new THREE.MeshBasicMaterial({ map: this.veilTex, transparent: true, depthWrite: false, opacity: 0, toneMapped: false });
      this.veilMat.color.setRGB(2.3, 2.2, 2.05); // HDR white (the render's exposure brings it down; the sky shader likewise writes ×3), a little warm — the colour of the grade's own daylight, not a sweet tint
      this.veil = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1.2), this.veilMat); this.veil.position.set(0, 1.5, -1.95); this.veil.renderOrder = 7; this.veil.visible = false; world.add(this.veil); }
    this.lace = world.children.find((c) => c.name === "lace") || null; if (this.lace) this.lace0 = { x: this.lace.position.x, z: this.lace.position.z, sx: this.lace.scale.x };
    this.tw = 0;
    if (this.pane) { this.mesh.position.set(PANE.cx, PANE.cy, PANE.z - (this.pane.position.z || 0)); this.pane.add(this.mesh); } else { this.mesh.position.set(PANE.cx, PANE.cy, PANE.z); world.add(this.mesh); }
  }
  // the morning's breath on the glass: a soft white veil (alphaMap reads the green channel: black is clear glass, light is fog), and in it what the MV's finger wrote
  _fog(x) {
    x.globalCompositeOperation = "source-over"; x.fillStyle = "rgb(205,205,205)"; x.fillRect(0, 0, CW, CH);
    let s = 11; const r = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    for (let i = 0; i < 60; i++) { const px = r() * CW, py = r() * CH, rad = 70 + r() * 150, gg = x.createRadialGradient(px, py, 4, px, py, rad), k = r() < 0.5 ? 255 : 0; gg.addColorStop(0, `rgba(${k},${k},${k},0.06)`); gg.addColorStop(1, `rgba(${k},${k},${k},0)`); x.fillStyle = gg; x.fillRect(px - rad, py - rad, rad * 2, rad * 2); }
    const im = x.getImageData(0, 0, CW, CH), d = im.data; for (let i = 0; i < d.length; i += 4) { const n = (r() - 0.5) * 14; d[i] += n; d[i + 1] += n; d[i + 2] += n; } x.putImageData(im, 0, 0);
    // 何を／手放せる？ — the MV's finger (room.html: handCan on a 0.5 m patch centred at x = −0.36, y = 1.46; 512 px per 0.5 m): the same letters, in the same place, as clear glass
    const k = 1 / 1.024, at = (px, py) => [((-0.36 + (px - 256) / 1024 - (PANE.cx - PANE.w / 2)) / PANE.w) * CW, ((PANE.cy + PANE.h / 2 - (1.46 + (256 - py) / 1024)) / PANE.h) * CH];
    x.fillStyle = "#000"; x.shadowColor = "rgba(0,0,0,0.9)"; x.shadowBlur = 5; x.textAlign = "center"; x.textBaseline = "middle";
    x.font = `600 ${118 * k}px 'Room Hand', 'Room Serif', serif`; let [tx, ty] = at(256, 170); x.fillText("何を", tx, ty);
    x.font = `600 ${92 * k}px 'Room Hand', 'Room Serif', serif`; [tx, ty] = at(256, 330); x.fillText("手放せる？", tx, ty);
    x.shadowBlur = 0;
  }
  _fogOnly(x) { // same veil, different seed, no letters
    x.globalCompositeOperation = "source-over"; x.fillStyle = "rgb(205,205,205)"; x.fillRect(0, 0, CW, CH);
    let s = 29; const r = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    for (let i = 0; i < 60; i++) { const px = r() * CW, py = r() * CH, rad = 70 + r() * 150, gg = x.createRadialGradient(px, py, 4, px, py, rad), k = r() < 0.5 ? 255 : 0; gg.addColorStop(0, `rgba(${k},${k},${k},0.06)`); gg.addColorStop(1, `rgba(${k},${k},${k},0)`); x.fillStyle = gg; x.fillRect(px - rad, py - rad, rad * 2, rad * 2); }
    const im = x.getImageData(0, 0, CW, CH), d = im.data; for (let i = 0; i < d.length; i += 4) { const n = (r() - 0.5) * 14; d[i] += n; d[i + 1] += n; d[i + 2] += n; } x.putImageData(im, 0, 0);
  }
  // ---- picking: pointer → ray (the real camera: the pose room.html was given, the canvas drawn "cover") → the plane of the pane
  _ray(clientX, clientY) {
    const { p, q, fov } = this.o.pose(), cv = this.o.canvas, r = cv.getBoundingClientRect(), A = 16 / 9, B = r.width / r.height;
    let nx = ((clientX - r.left) / r.width) * 2 - 1, ny = -(((clientY - r.top) / r.height) * 2 - 1);
    if (B > A) ny *= A / B; else nx *= B / A; // object-fit: cover crops the long side
    const th = Math.tan((fov * Math.PI) / 360);
    const dir = new THREE.Vector3(nx * th * A, ny * th, -1).normalize().applyQuaternion(q);
    return { o: p.clone(), d: dir };
  }
  /** QA: where a world point lands on screen (the inverse of _ray) */
  toClient(P) {
    const { p, q, fov } = this.o.pose(), cv = this.o.canvas, r = cv.getBoundingClientRect(), A = 16 / 9, B = r.width / r.height, th = Math.tan((fov * Math.PI) / 360);
    const l = new THREE.Vector3(P.x, P.y, P.z).sub(p).applyQuaternion(q.clone().invert()); let nx = l.x / (-l.z) / (th * A), ny = l.y / (-l.z) / th;
    if (B > A) ny /= A / B; else nx /= B / A;
    return { x: r.left + ((nx + 1) / 2) * r.width, y: r.top + ((1 - ny) / 2) * r.height };
  }
  _hit(clientX, clientY) {
    const { o, d } = this._ray(clientX, clientY); const px = this.pane ? this.pane.position.x : 0;
    if (Math.abs(d.z) < 1e-4) return null; const t = (PANE.z - o.z) / d.z; if (t <= 0 || t > 6) return null;
    return { x: o.x + d.x * t - px, y: o.y + d.y * t, dist: t };
  }
  _canvasXY(h) { return [((h.x - (PANE.cx - PANE.w / 2)) / PANE.w) * CW, ((PANE.cy + PANE.h / 2 - h.y) / PANE.h) * CH]; }
  /** the pointer went down: returns true if the epilogue takes it (writing or opening), false if it is a look-drag */
  pointerDown(x, y) {
    if (this.state === "gone" || this.state === "opening-auto") return false;
    const h = this._hit(x, y); if (!h || h.dist > 1.7) return false;
    const inWrite = h.x >= WRITE.x0 && h.x <= WRITE.x1 && h.y >= WRITE.y0 && h.y <= WRITE.y1;
    const inWin = h.x >= GRAB.x0 && h.x <= GRAB.x1 && h.y >= GRAB.y0 && h.y <= GRAB.y1;
    const rail = inWin && !inWrite && ((h.x >= GRAB.rail[0] && h.x <= GRAB.rail[1]) || h.x < WRITE.x0 + 0.0 || h.y > WRITE.y1 || h.y < WRITE.y0);
    if (inWrite && this.open < 0.02) { this.writing = true; this.last = this._canvasXY(h); this._dot(this.last); return true; }
    if (rail || (this.canOpen && inWin && !inWrite) || (this.open > 0.02 && inWin)) { this.settle = null; this.state = "opening"; this.grab = { x: x, o0: this.open }; return true; } // (a sash let go half-way and still closing can be taken again)
    return false;
  }
  pointerMove(x, y) {
    if (this.writing) { const h = this._hit(x, y); if (!h) { this.last = null; return true; } const c = this._canvasXY(h); if (h.x >= WRITE.x0 - 0.02 && h.x <= WRITE.x1 + 0.02 && h.y >= WRITE.y0 - 0.02 && h.y <= WRITE.y1 + 0.02) { if (this.last) this._seg(this.last, c); this.last = c; } else this.last = null; return true; }
    if (this.grab) { this.open = Math.min(1, Math.max(0, this.grab.o0 + (x - this.grab.x) / (0.42 * innerWidth))); this.state = "opening"; return true; }
    return false;
  }
  /** the gesture was interrupted (a second finger, focus lost, the capture lost, a cancel): stop writing, let go of the sash — and it goes BACK; an interruption never opens the window */
  abort() {
    this.writing = false; this.last = null; this._acc = 0;
    if (this.grab) { this.grab = null; if (this.state !== "gone" && this.state !== "opening-auto" && this.open > 0.001) this._close(); else if (this.state === "opening") this.state = "idle"; }
  }
  pointerUp() {
    if (this.writing) { this.writing = false; if (this.last) this._maybeDrip(this.last, 0.9); this.last = null; return true; }
    if (this.grab) { this.grab = null; if (this.open >= OPEN_AT) this._autoOpen(); else this._close(); return true; }
    return false;
  }
  _autoOpen() { this.settle = { to: 1, v: this.settle ? this.settle.v : 0 }; this.state = "opening-auto"; }
  _close() { this.settle = { to: 0, v: this.settle ? this.settle.v : 0 }; this.state = "closing"; }
  /** the cursor asks: is the fogged glass here, and can it be written on? */
  writableAt(x, y) { if (this.state === "gone" || this.state === "opening-auto" || this.open >= 0.02) return false; const h = this._hit(x, y); return !!h && h.dist <= 1.7 && h.x >= WRITE.x0 && h.x <= WRITE.x1 && h.y >= WRITE.y0 && h.y <= WRITE.y1; }
  /** the cursor's warmth on the fog (a client point, or null) */
  setWarm(x, y) {
    if (x === null || x === undefined || this.state === "gone") { if (this.warm) { this.warm = null; this.dirty = true; } return; }
    const h = this._hit(x, y); if (!h) { if (this.warm) { this.warm = null; this.dirty = true; } return; }
    const c = this._canvasXY(h); if (!this.warm || Math.hypot(this.warm[0] - c[0], this.warm[1] - c[1]) > 3) { this.warm = c; this.dirty = true; }
  }
  /** keyboard: open the window (the same as the swipe) */
  openKey() { if (this.state !== "gone" && this.state !== "opening-auto" && this.open < 1) this._autoOpen(); }
  // ---- the finger: a clear trace with a slightly wet rim; a thin drip may run from it
  _dot(c) { this._seg(c, [c[0] + 0.01, c[1]]); }
  // a stroke is kept as two masks — the wet rim (light) and the clear trace (dark) — and composed over the fog, so overlapping segments do not pile up
  _compose() {
    const x = this.cx; x.globalCompositeOperation = "source-over"; x.globalAlpha = 1; x.drawImage(this.base, 0, 0);
    x.save(); x.shadowColor = WIPED; x.shadowBlur = 6; x.shadowOffsetX = 4000; x.drawImage(this.core, -4000, 0); x.restore(); // the wiped trace with a soft (blurred) edge into the fog: only its shadow is drawn, offset off-canvas
    { const t = this.tx; t.globalCompositeOperation = "source-over"; t.globalAlpha = 1; t.clearRect(0, 0, CW, CH); t.drawImage(this.rim, 0, 0); t.globalCompositeOperation = "destination-out"; t.drawImage(this.inn, 0, 0); // the ring: the stroke grown by 2 px, minus the stroke
      const e = this.emx; if (e) { e.globalCompositeOperation = "source-over"; e.fillStyle = "rgb(85,85,85)"; e.fillRect(0, 0, CW, CH); e.globalCompositeOperation = "lighter"; e.drawImage(this.tmp, 0, 0); e.globalCompositeOperation = "source-over"; this.emTex.needsUpdate = true; } }
    if (this.warm) { const [wx, wy] = this.warm, g = x.createRadialGradient(wx, wy, 2, wx, wy, 78); g.addColorStop(0, "rgba(0,0,0,0.2)"); g.addColorStop(1, "rgba(0,0,0,0)"); x.fillStyle = g; x.fillRect(wx - 80, wy - 80, 160, 160); } // the finger's warmth: the veil under the cursor thins a little (the strokes are already clear)
    if (this.tex) this.tex.needsUpdate = true; this.dirty = false;
  }
  _seg(a, b) {
    for (const [c, w, col, soft] of [[this.rx, 34, "#fff", 0], [this.ix, 28, "#000", 0], [this.kx, 28, WIPED, 0]]) { c.lineCap = "round"; c.lineJoin = "round"; c.strokeStyle = col; c.lineWidth = w; if (soft) { c.shadowColor = WIPED; c.shadowBlur = soft; } c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke(); c.shadowBlur = 0; }
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]); this.strokeLen += len; this._acc = (this._acc || 0) + len; if (this._acc > 60) { this._acc = 0; this._maybeDrip(b, 0.28); }
    if (this.strokeLen > 220 && !this.canOpen) { this.canOpen = true; }
    this.dirty = true;
  }
  _maybeDrip(c, p) { if (Math.random() < p && this.drips.length < 14) this.drips.push({ x: c[0] + (Math.random() - 0.5) * 6, y: c[1] + 6, len: 0, max: 40 + Math.random() * 120, v: 10 + Math.random() * 14, w: 2 + Math.random() * 1.4 }); }
  /** per frame. dt s. Returns the room time Tv to draw (the window, the fog and the credits follow it). */
  update(dt) {
    // drips
    if (this.drips.length) {
      const k = this.kx, r = this.rx, ix = this.ix; for (const d of this.drips) { const step = Math.min(d.v * dt, d.max - d.len); if (step <= 0) { d.done = true; continue; }
        k.strokeStyle = WIPED; k.lineWidth = d.w; k.lineCap = "round"; k.beginPath(); k.moveTo(d.x, d.y + d.len); k.lineTo(d.x, d.y + d.len + step); k.stroke();
        r.strokeStyle = "#fff"; r.lineWidth = d.w + 4; ix.strokeStyle = "#000"; ix.lineWidth = d.w; ix.lineCap = "round"; ix.beginPath(); ix.moveTo(d.x, d.y + d.len); ix.lineTo(d.x, d.y + d.len + step); ix.stroke(); r.lineCap = "round"; r.beginPath(); r.moveTo(d.x, d.y + d.len); r.lineTo(d.x, d.y + d.len + step); r.stroke();
        r.fillStyle = "#fff"; r.beginPath(); r.arc(d.x, d.y + d.len + step + d.w, d.w * 1.3, 0, 7); r.fill(); d.len += step; d.v *= 0.995; }
      this.drips = this.drips.filter((d) => !d.done); this.dirty = true;
    }
    if (this.dirty) this._compose();
    if (this.settle) { // critically damped spring toward 0 (back) or 1 (open): closing is quick, opening takes ~2.6 s
      const s = this.settle, w = s.to === 1 ? 2.8 : 8, e0 = this.open - s.to, ex = Math.exp(-w * dt), c = s.v + w * e0;
      this.open = s.to + (e0 + c * dt) * ex; s.v = (s.v - w * c * dt) * ex;
      if (s.to === 1 && 1 - this.open < 0.004) { this.open = 1; this.settle = null; this._opened(); }
      else if (s.to === 0 && this.open < 0.002 && Math.abs(s.v) < 0.01) { this.open = 0; this.settle = null; this.state = "idle"; }
    }
    // the fog goes with the window: the MV clears it between 195.6 and 196.6 s; ours follows how far the sash has moved
    this.mat.opacity = 0.95 * (1 - sstep(0.0, 0.55, this.open));
    this.mesh.visible = this.mat.opacity > 0.004; if (this.mat2) { this.mat2.opacity = this.mat.opacity; this.mesh2.visible = this.mesh.visible; }
    // the morning outside: a function of how far the sash is open (u), nothing else — so half-way and back looks the same going and coming: the outside goes to light, the lace comes in on the air
    const k = sstep(0.1, 0.95, this.open);
    if (this.veil) { this.veil.visible = k > 0.002; this.veilMat.opacity = 0.62 * k; }
    if (this.lace) {
      const calm = this.o.reduced && this.o.reduced(); this.tw += calm ? 0 : dt;
      const sw = Math.sin(this.tw * 0.8) * 0.55 + Math.sin(this.tw * 1.9 + 1.1) * 0.3 + Math.sin(this.tw * 3.3 + 2.0) * 0.15, L = this.lace, b = this.lace0;
      L.scale.x = b.sx * (1 + 1.1 * k); L.position.x = b.x - 0.14 * k; L.position.z = b.z + k * (0.1 + 0.05 * sw); L.rotation.y = 0.16 * k * sw; L.rotation.z = 0.05 * k * sw;
    }
    return T_CLOSED + (T_OPEN - T_CLOSED) * this.open;
  }
  _opened() {
    this.state = "gone"; this.canOpen = false; this.writing = false; this.last = null; this.grab = null; this.settle = null; this.warm = null; // (an old gesture must not draw on a canvas that is gone)
    // thrown away: the writing was only ever this canvas
    for (const c of [this.cv, this.base, this.rim, this.core, this.inn, this.tmp, this.emiCv]) { c.getContext("2d").clearRect(0, 0, c.width, c.height); c.width = 1; c.height = 1; } this.drips.length = 0; this.mesh.visible = false;
    if (this.pane) this.pane.remove(this.mesh); this.mat.dispose(); this.tex.dispose(); this.emTex.dispose(); this.flatTex.dispose(); this.mesh.geometry.dispose();
    this.o.scenes.world.remove(this.mesh2); this.mat2.dispose(); this.tex2.dispose(); this.mesh2.geometry.dispose(); this.cv2.width = 1; this.cv2.height = 1;
    this.o.onOpened();
  }
  /** where the eye is relative to the glass (for the cues) */
  nearGlass(eye, fwd) { return eye.z < -0.15 && fwd.z < -0.2 && eye.x > -1.2 && eye.x < 0.8; }
}
