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
      start: meta.start,   // timeline seconds where this clip starts (graphics that follow the timeline grid need it)
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
      /** 3D scene bound to the timeline — defined in vos-three.js, which is loaded only on pages that use it. */
      three: function (opts) {
        if (!window.__vosThree) throw new Error("vos: the 3D helper is not loaded on this page");
        return window.__vosThree(opts || {}, root, meta, cfg, frameHandlers);
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
