/* vos runtime — injected into every compiled page. Deterministic: no clocks, no randomness. */
(function () {
  var cfg = window.__VOS_CFG__;
  var master = gsap.timeline({ paused: true });
  var frameHandlers = [];
  var spb = cfg.grid ? 60 / cfg.grid.bpm : 0.5;

  function mount(meta, fn) {
    var root = document.querySelector('section.vos-g[data-clip="' + meta.id + '"]');
    if (!root) throw new Error("vos: graphics root not found for clip " + meta.id);
    gsap.set(root, { visibility: "hidden" });
    master.set(root, { visibility: "visible" }, meta.start);
    master.set(root, { visibility: "hidden" }, meta.start + meta.dur);
    var tl = gsap.timeline();
    var ctx = {
      tl: tl,
      root: root,
      props: meta.props || {},
      dur: meta.dur,
      fps: cfg.fps,
      spb: spb,
      b: function (n) { return n * spb; },
      q: function (s) { return root.querySelector(s); },
      qa: function (s) { return Array.prototype.slice.call(root.querySelectorAll(s)); },
      slot: function (name) { return root.querySelector('[data-slot="' + name + '"]'); },
      /** clips the timeline placed in a slot: [{id, alias, start (local s), dur, in (source s)}] */
      slotClips: function (name) { return (meta.slots && meta.slots[name]) || []; },
      /** source time of the clip showing in a slot at local time t (null if none) */
      sourceTime: function (name, t) {
        var cs = (meta.slots && meta.slots[name]) || [];
        for (var i = 0; i < cs.length; i++) if (t >= cs[i].start && t < cs[i].start + cs[i].dur) return { alias: cs[i].alias, t: cs[i].in + (t - cs[i].start) };
        return null;
      },
      onFrame: function (h) { frameHandlers.push({ h: h, start: meta.start, dur: meta.dur }); },
      /**
       * three.js scene bound to the timeline: returns { THREE, renderer, scene, camera, canvas }. Set `.update = t => …`
       * to move things from local time t; vos renders one frame per timeline frame. No clocks: never use THREE.Clock
       * or requestAnimationFrame — the same t must always draw the same picture.
       */
      three: function (opts) {
        if (!window.THREE) throw new Error("vos: three.js is not loaded on this page");
        opts = opts || {};
        var host = opts.el || root;
        var canvas = document.createElement("canvas");
        canvas.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;display:block";
        host.appendChild(canvas);
        var w = opts.width || cfg.width, h = opts.height || cfg.height;
        var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: !!opts.alpha, preserveDrawingBuffer: true });
        renderer.setPixelRatio(1);
        renderer.setSize(w, h, false);
        var scene = new THREE.Scene();
        var camera = new THREE.PerspectiveCamera(opts.fov || 45, w / h, opts.near || 0.1, opts.far || 1000);
        var api = { THREE: THREE, renderer: renderer, scene: scene, camera: camera, canvas: canvas, update: null };
        frameHandlers.push({ h: function (t) { if (api.update) api.update(t); renderer.render(scene, camera); }, start: meta.start, dur: meta.dur });
        return api;
      },
    };
    fn(ctx);
    master.add(tl, meta.start);
  }

  function render() {
    var t = master.time();
    for (var i = 0; i < frameHandlers.length; i++) {
      var f = frameHandlers[i];
      if (t >= f.start - 1e-6 && t < f.start + f.dur) f.h(t - f.start);
    }
  }

  window.VOS = {
    master: master,
    mount: mount,
    finalize: function () {
      master.set({}, {}, cfg.duration);
      master.eventCallback("onUpdate", render);
      window.__timelines = window.__timelines || {};
      window.__timelines["main"] = master;
      master.seek(0);
      render();
    },
  };
})();
