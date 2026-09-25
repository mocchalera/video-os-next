/* vos 3D helper — loaded (after three.js) only on pages whose graphics use three(). Deterministic: the scene is
   drawn once per timeline frame after update(t); never use THREE.Clock or requestAnimationFrame. */
(function () {
  window.__vosThree = function (opts, root, meta, cfg, frameHandlers) {
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
  };
})();
