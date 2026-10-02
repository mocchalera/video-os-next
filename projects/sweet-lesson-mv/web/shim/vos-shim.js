/* Sweet Lesson web — vos runtime shim (M0).
 *
 * Runs graphics/room.html *in place* (fetched from /_src/room.html, never copied) with a small stand-in for the
 * vos runtime: vos.graphic(ctx => …) with ctx = { three, q, qa, props, fps, onFrame, … }, the same surface as
 * src/runtime/vos-runtime.js + vos-three.js. Differences from the real runtime, all on purpose:
 *   - time comes from the audio element's position (not gsap / seek),
 *   - the WebGL canvas is sized by a resolution tier and shown with object-fit: cover,
 *   - vos://asset/<alias> in the markup is rewritten to the project's static files,
 *   - props: the clip's props from timeline.json, with {"$data": "data/x.json"} resolved by fetch.
 * room.html is run unmodified by this file; its few WEB hooks (window.__roomWebRes, window.__roomDbg.web) are additive and
 * inert unless set from here.
 */
(function () {
  "use strict";
  const SRC = "/_src/";
  const log = (...a) => console.log("[shim]", ...a);

  async function json(url) { const r = await fetch(url); if (!r.ok) throw new Error(url + " " + r.status); return r.json(); }

  /** resolve {"$data": "data/x.json"} anywhere inside props */
  async function resolveProps(v) {
    if (Array.isArray(v)) return Promise.all(v.map(resolveProps));
    if (v && typeof v === "object") {
      if (typeof v.$data === "string") return json(SRC + v.$data);
      const out = {};
      await Promise.all(Object.keys(v).map(async (k) => { out[k] = await resolveProps(v[k]); }));
      return out;
    }
    return v;
  }

  /** @param {{res?:number, dprCap?:number, aa?:boolean, pdb?:boolean, host:HTMLElement}} opt */
  async function load(opt) {
    const t0 = performance.now();
    const marks = (window.__shimMarks = { start: 0 });
    const mark = (k) => { marks[k] = Math.round(performance.now() - t0); };

    const [timeline, assets, roomText] = await Promise.all([json(SRC + "timeline.json"), json(SRC + "assets.json"), fetch(SRC + "room.html").then((r) => r.text())]);
    mark("fetched");
    const clip = timeline.tracks.flatMap((t) => t.clips || []).find((c) => c.src === "graphics/room.html");
    const props = await resolveProps(clip.props || {});
    mark("props");
    const cfg = { fps: timeline.canvas.fps, width: timeline.canvas.width, height: timeline.canvas.height, duration: clip.dur };

    // --- split room.html: <style>, markup, the one <script>
    const doc = new DOMParser().parseFromString("<body>" + roomText + "</body>", "text/html");
    let script = "";
    for (const s of Array.from(doc.querySelectorAll("script"))) { script += s.textContent; s.remove(); }
    let css = "";
    for (const s of Array.from(doc.querySelectorAll("style"))) { css += s.textContent; s.remove(); }
    // vos://asset/<alias> → static file (only the markup uses it)
    const assetUrl = (alias) => {
      const a = assets.assets[alias];
      if (!a) throw new Error("unknown asset " + alias);
      if (a.kind === "image" && alias.startsWith("tex_")) return opt.tex === 512 ? "/assets/tex-512/" + a.filename : SRC + "refs/tex/" + a.filename; // the phone tiers use the 512² set (¼ of the GPU memory and of the transfer)
      return SRC + "refs/audio/" + a.filename;
    };
    for (const el of Array.from(doc.querySelectorAll("[src]"))) {
      const m = /^vos:\/\/asset\/([^@]+)/.exec(el.getAttribute("src") || "");
      if (m) el.setAttribute("src", assetUrl(m[1]));
    }
    // optional resolution tier: room.html reads window.__roomWebRes (an additive hook; unset = 1920×1080 as in the vos render)
    let W = 1920, H = 1080;
    if (opt.q) window.__roomWebQ = opt.q; else delete window.__roomWebQ; // MSAA / shadow-map / data-centre scale (room.html reads it; unset = as the vos render)
    if (opt.res && opt.res !== 1080) { H = opt.res; W = Math.round((opt.res * 16) / 9); window.__roomWebRes = opt.res; } else delete window.__roomWebRes;

    const styleEl = document.createElement("style"); styleEl.textContent = css; document.head.appendChild(styleEl);
    const root = document.createElement("section");
    root.style.cssText = "position:absolute;inset:0;overflow:hidden";
    while (doc.body.firstChild) root.appendChild(doc.body.firstChild);
    opt.host.appendChild(root);

    // --- the runtime surface room.html sees
    const frameHandlers = [];
    let api3 = null;
    const ctx = {
      root, props, dur: cfg.duration, start: 0, fps: cfg.fps, spb: 60 / timeline.grid.bpm,
      b: (n) => (n * 60) / timeline.grid.bpm,
      q: (s) => root.querySelector(s),
      qa: (s) => Array.prototype.slice.call(root.querySelectorAll(s)),
      onFrame: (h) => frameHandlers.push(h),
      three(o) {
        o = o || {};
        const host = o.el || root;
        const canvas = document.createElement("canvas");
        canvas.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;display:block;object-fit:cover";
        host.appendChild(canvas);
        const renderer = new THREE.WebGLRenderer({ canvas, antialias: !!opt.aa, alpha: !!o.alpha, preserveDrawingBuffer: !!opt.pdb, powerPreference: "high-performance" });
        renderer.setPixelRatio(1);
        // output size = the tier (final composite pass only; the post chain's own targets follow room.html's W/H)
        renderer.setSize(W, H, false);
        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(o.fov || 45, W / H, o.near || 0.1, o.far || 1000);
        api3 = { THREE, renderer, scene, camera, canvas, update: null };
        return api3;
      },
    };
    const vos = { graphic: (fn) => fn(ctx) };
    mark("parsed");
    // run room.html's script with `vos` shadowed (no global leakage)
    new Function("vos", script + "\n//# sourceURL=graphics/room.html")(vos);
    mark("scriptRan");

    // fonts + photo textures: wait for them before the first frame (the real pipeline has them already)
    const imgReady = (i) => (i.complete ? 0 : new Promise((r) => { i.addEventListener("load", r, { once: true }); i.addEventListener("error", r, { once: true }); }));
    await Promise.all(Array.from(root.querySelectorAll(".room-tex img")).map(imgReady));
    mark("textures");
    await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 3000))]);
    mark("assets");

    const { renderer, canvas } = api3;
    const gl = renderer.getContext();
    return {
      cfg, props, root, canvas, renderer, gl, marks, W, H,
      get dbg() { return window.__roomDbg; },
      /** draw the room at song time t (this is the whole "frame") */
      update(t) { api3.update(t); api3.renderer.render(api3.scene, api3.camera); }, // as vos-three.js: update(t), then the output scene
    };
  }

  window.SweetShim = { load };
})();
