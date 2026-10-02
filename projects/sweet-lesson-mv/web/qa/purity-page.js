// Page-side purity test (needs ?qa=1 so that DBG.web.scenes exists). Defines window.__purity(cfg).
// Reference = what the vos renderer does: update(k/24) for k = 0,1,2,… in order. Test = jump to the same frames in a
// random order (backwards and forwards) after the whole timeline has been run, and compare pixels and scene state.
(function () {
  let PREC = 4; const f4 = (x) => (x === undefined ? "" : Number(x).toFixed(PREC));
  function uni(m) {
    let s = "";
    if (m && m.uniforms) for (const k of Object.keys(m.uniforms).sort()) { const v = m.uniforms[k].value;
      if (typeof v === "number") s += k + "=" + f4(v) + ";";
      else if (v && v.toArray) s += k + "=" + v.toArray().map(f4).join(",") + ";";
      else if (v && v.isTexture) s += k + "=tex:" + v.uuid.slice(0, 5) + ";"; }
    return s;
  }
  function sig(o) {
    let s = o.type + "|" + (o.name || "") + "|" + (o.visible ? 1 : 0) + "|" + [o.position.x, o.position.y, o.position.z].map(f4) + "|" + [o.quaternion.x, o.quaternion.y, o.quaternion.z, o.quaternion.w].map(f4) + "|" + [o.scale.x, o.scale.y, o.scale.z].map(f4);
    if (o.isLight) { s += "|L" + f4(o.intensity) + "," + o.color.getHexString(); if (o.target) s += ",T" + [o.target.position.x, o.target.position.y, o.target.position.z].map(f4); }
    if (o.material) for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      s += "|M" + f4(m.emissiveIntensity) + "," + f4(m.opacity) + "," + (m.color ? m.color.getHexString() : "") + "," + (m.emissiveMap ? m.emissiveMap.uuid.slice(0, 5) : "") + "," + (m.map ? m.map.uuid.slice(0, 5) : "") + "," + (m.visible === false ? "hid" : "") + uni(m);
    }
    if (o.isInstancedMesh) { const a = o.instanceMatrix.array; let h = 0; for (let i = 0; i < a.length; i++) h = (h * 31 + Math.round(a[i] * 1e4)) | 0; s += "|I" + o.count + "," + h; }
    return s;
  }
  let SC = null;
  function snap() { // keyed by Object3D.id; hidden objects (or under a hidden parent) are reduced to "hidden": stale transforms of invisible things don't matter
    const S = SC, out = new Map(), desc = new Map();
    const roots = [S.world, S.wsc, S.dc, S.studio];
    const walk = (o, vis, ri, depth) => { const v = vis && o.visible; out.set(o.id, v ? sig(o) : o.type + "|hidden"); desc.set(o.id, ri + ":#" + o.id + ":" + o.type + ":" + (o.name || "") + (o.geometry ? ":" + o.geometry.type : "") + (o.parent && o.parent.name ? " <" + o.parent.name : "")); for (const c of o.children) walk(c, v, ri, depth + 1); };
    roots.forEach((r, ri) => walk(r, true, ri, 0));
    return { out, desc };
  }
  function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

  window.__purity = async (cfg) => {
    const shim = __m0.shim, gl = shim.gl, W = shim.canvas.width, H = shim.canvas.height, px = new Uint8Array(W * H * 4), tiny = new Uint8Array(4);
    const FPS = cfg.fps || 24; PREC = cfg.prec || 4; SC = shim.dbg.web.scenes; const WEB = shim.dbg.web;
    if (!cfg.web || cfg.refOff) shim.dbg.web = undefined; // baseline: web hooks off (the vos behaviour)
    // refOff: the reference is the vos behaviour (hooks off, frames stepped in order); the test then jumps with the web hooks ON — the web frame must be the MV's frame
    const frames = Array.from(new Set(cfg.Ts.map((t) => Math.round(t * FPS)))).sort((a, b) => a - b);
    const want = new Set(frames), kmax = frames[frames.length - 1];
    const upd = (k) => { shim.update(k / FPS); if (cfg.double) shim.update(k / FPS); };
    __m0.stop(); const t0 = performance.now(), ref = new Map();
    for (let k = 0; k <= kmax; k++) {
      shim.update(k / FPS);
      if (want.has(k)) { gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px); const s = snap(); ref.set(k, { px: px.slice(), st: s.out, desc: s.desc }); }
      else if (k % 48 === 0) gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, tiny);
    }
    const tRef = performance.now() - t0; if (cfg.refOff && cfg.web) shim.dbg.web = WEB;
    const r = rng(cfg.seed || 1), order = frames.slice(); for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    const res = []; let bad = 0;
    for (const k of order) {
      upd(k); gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px); const R = ref.get(k);
      let nd = 0, mx = 0, sum = 0; const where = []; for (let i = 0; i < px.length; i++) { const d = Math.abs(px[i] - R.px[i]); if (d) { nd++; sum += d; if (d > mx) mx = d; if (where.length < 12) where.push([(i >> 2) % W, H - 1 - Math.floor(i / 4 / W), i & 3]); } }
      const s = snap(), sd = []; let sdN = 0;
      const T = k / FPS, CAM = shim.props.cam, WS = CAM.whiteSpan || [1e9, 1e9], wEnter = CAM.white && CAM.white.length ? CAM.white[0].t : 1e9;
      const inWhite = T > wEnter - 1.6 && T < WS[1] + 1.4, inStudio = T >= 97.1 && T < 103.6; // the white rooms / the studio are only drawn (and only updated) then
      for (const [id, v] of R.st) { const dsc = R.desc.get(id); if ((dsc.startsWith("1:") && !inWhite) || (dsc.startsWith("3:") && !inStudio)) continue; const g = s.out.get(id); if (g !== v) { sdN++; if (sd.length < (cfg.maxList || 8)) sd.push({ obj: R.desc.get(id), ref: v, got: g }); } }
      const ok = nd === 0; if (!ok) bad++;
      res.push({ where, T: +(k / FPS).toFixed(3), pixDiffBytes: nd, maxDiff: mx, meanOverDiff: nd ? +(sum / nd).toFixed(2) : 0, stateDiffs: sdN, sample: cfg.verbose ? sd : sd.slice(0, 3) });
    }
    return { frames: frames.length, bad, tRefMs: Math.round(tRef), objects: ref.get(frames[0]).st.size, results: res.sort((a, b) => a.T - b.T) };
  };
  window.__snap = snap;
})();
