// QA: where do the GPU bytes go? Patches WebGL2 before three.js loads (walk.html?glmem=1) and keeps a ledger of what is allocated and still alive:
// textures (storage/upload × mip chain), renderbuffers (× samples), buffers. window.__glmem.report() → { totalMB, byKind, top[] } grouped by (kind, w×h, format, samples).
// An estimate of what the driver is asked to hold (no padding, no compression, no driver copies) — good for ranking, not for an exact figure.
(function () {
  const GL = window.WebGL2RenderingContext; if (!GL) return;
  const P = GL.prototype, C = GL; // constants live on the prototype
  const bpp = (f) => ({ [C.RGBA8]: 4, [C.RGBA16F]: 8, [C.RGBA32F]: 16, [C.RGB8]: 3, [C.RG8]: 2, [C.R8]: 1, [C.RG16F]: 4, [C.R16F]: 2, [C.R32F]: 4, [C.RG32F]: 8, [C.DEPTH_COMPONENT24]: 4, [C.DEPTH_COMPONENT16]: 2, [C.DEPTH_COMPONENT32F]: 4, [C.DEPTH24_STENCIL8]: 4, [C.DEPTH32F_STENCIL8]: 8, [C.SRGB8_ALPHA8]: 4, [C.RGBA]: 4, [C.RGB]: 3, [C.R11F_G11F_B10F]: 4, [C.RGB16F]: 6, [C.RGB10_A2]: 4, [C.RGBA4]: 2, [C.RGB565]: 2, [C.RGB5_A1]: 2 }[f] || 4);
  const name = (f) => { for (const k in C) if (C[k] === f && /^(RGBA|RGB|RG|R|DEPTH|SRGB)/.test(k)) return k; return "0x" + (f || 0).toString(16); };
  const live = new Map(); // object → { kind, w, h, d, fmt, samples, bytes }
  const bound = {}, unitTex = {}; let unit = 0; const key = (t) => (t === C.TEXTURE_2D ? "2d" : t === C.TEXTURE_CUBE_MAP || (t >= C.TEXTURE_CUBE_MAP_POSITIVE_X && t <= C.TEXTURE_CUBE_MAP_NEGATIVE_Z) ? "cube" : t === C.TEXTURE_3D ? "3d" : t === C.TEXTURE_2D_ARRAY ? "2darray" : "?");
  const cur = (t) => bound[key(t) + "@" + unit];
  const wrap = (n, f) => { const o = P[n]; if (o) P[n] = function () { try { f.apply(this, arguments); } catch (e) { /* the ledger must never break the page */ } return o.apply(this, arguments); }; };
  const setTex = (t, patch) => { const tex = cur(t); if (!tex) return; const r = live.get(tex) || { kind: "texture", w: 0, h: 0, d: 1, fmt: 0, samples: 1, bytes: 0, levels: {} }; Object.assign(r, patch.r || {}); if (patch.level !== undefined) r.levels[patch.level + ":" + (patch.face || 0)] = patch.bytes; let b = 0; for (const k in r.levels) b += r.levels[k]; if (r.mips && !r.storage) b *= 4 / 3; /* storage (texStorage*) is immutable: every level is already in the sum */ r.bytes = b; live.set(tex, r); };
  wrap("activeTexture", (u) => { unit = u - C.TEXTURE0; });
  wrap("bindTexture", (t, tex) => { bound[key(t) + "@" + unit] = tex; });
  wrap("texStorage2D", (t, levels, f, w, h) => { let b = 0; for (let l = 0; l < levels; l++) b += Math.max(1, w >> l) * Math.max(1, h >> l) * bpp(f); setTex(t, { r: { w, h, fmt: f, mips: false, storage: true }, level: "s", bytes: b * (key(t) === "cube" ? 6 : 1) }); });
  wrap("texStorage3D", (t, levels, f, w, h, d) => { let b = 0; for (let l = 0; l < levels; l++) b += Math.max(1, w >> l) * Math.max(1, h >> l) * (t === C.TEXTURE_3D ? Math.max(1, d >> l) : d) * bpp(f); setTex(t, { r: { w, h, d, fmt: f, mips: false, storage: true }, level: "s", bytes: b }); });
  P.texImage2D = (function (o) { return function (t, level, f, a, b, c, d, e, g) { try { let w, h; if (arguments.length >= 9) { w = a; h = b; } else { const src = e !== undefined ? e : d; w = src && (src.videoWidth || src.naturalWidth || src.width) || 0; h = src && (src.videoHeight || src.naturalHeight || src.height) || 0; } setTex(t, { r: level === 0 ? { w, h, fmt: f } : {}, level, face: t, bytes: w * h * bpp(f) }); } catch (e2) { } return o.apply(this, arguments); }; })(P.texImage2D.__orig || P.texImage2D);
  wrap("texImage3D", (t, level, f, w, h, d) => { setTex(t, { r: level === 0 ? { w, h, d, fmt: f } : {}, level, bytes: w * h * d * bpp(f) }); });
  wrap("generateMipmap", (t) => { const tex = cur(t); const r = live.get(tex); if (r) { r.mips = true; setTex(t, {}); } });
  wrap("renderbufferStorage", function (t, f, w, h) { const rb = this.__rb; if (rb) live.set(rb, { kind: "renderbuffer", w, h, fmt: f, samples: 1, bytes: w * h * bpp(f) }); });
  wrap("renderbufferStorageMultisample", function (t, s, f, w, h) { const rb = this.__rb; if (rb) live.set(rb, { kind: "renderbuffer", w, h, fmt: f, samples: s, bytes: w * h * bpp(f) * Math.max(1, s) }); });
  const bindRb = P.bindRenderbuffer; P.bindRenderbuffer = function (t, rb) { this.__rb = rb; return bindRb.apply(this, arguments); };
  const curBuf = {}; wrap("bindBuffer", (t, b) => { curBuf[t] = b; });
  wrap("bufferData", (t, a, usage) => { const b = curBuf[t]; if (!b) return; const bytes = typeof a === "number" ? a : (a && a.byteLength) || 0; live.set(b, { kind: "buffer", w: 0, h: 0, fmt: 0, samples: 1, bytes }); });
  for (const [n, fn] of [["deleteTexture", 0], ["deleteRenderbuffer", 0], ["deleteBuffer", 0]]) wrap(n, (o) => { live.delete(o); });
  window.__glmem = {
    live,
    report(top = 22) {
      const g = new Map(); let total = 0; const byKind = {};
      for (const r of live.values()) { total += r.bytes; byKind[r.kind] = (byKind[r.kind] || 0) + r.bytes; const k = `${r.kind} ${r.w}×${r.h}${r.d > 1 ? "×" + r.d : ""} ${name(r.fmt)}${r.samples > 1 ? " ×" + r.samples + "MSAA" : ""}${r.mips ? " +mips" : ""}`; const e = g.get(k) || { what: k, n: 0, MB: 0 }; e.n++; e.MB += r.bytes / 1048576; g.set(k, e); }
      const mb = (x) => Math.round((x / 1048576) * 10) / 10;
      return { totalMB: mb(total), byKindMB: Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, mb(v)])), objects: live.size, top: [...g.values()].sort((a, b) => b.MB - a.MB).slice(0, top).map((e) => ({ ...e, MB: Math.round(e.MB * 10) / 10 })) };
    },
  };
})();
