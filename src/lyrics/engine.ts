import * as fs from "node:fs";

/**
 * Run a lyric-motion graphic (examples/graphics/lyric-motion.html: JIZURA + the vos adapter) in Node, without a
 * browser: the planner is exact (it does not measure glyphs), drawing goes to a recording stub canvas. Used by
 * `vos lyrics plan` (read the cut plan without rendering) and by the tests (plan rules + smoke-render every part).
 */

export interface LyricMotion {
  J: any;
  plan: any;
  project: any;
  /** the lyric rows the adapter built: lineItem[plan line] = index of the source item (-1 for a break) */
  LY: { text: string; overrides: Record<string, any>; lineItem: number[] };
  /** draw local time t (seconds) on the stub canvas; throws on Math.random / Date.now use */
  frame(t: number): void;
  stats: { text: number };
  /** console.warn / console.error lines the engine produced (JIZURA reports a failing part that way) */
  warnings: string[];
}

/** pixel buffers are shared per size: their content never matters here, and the engine asks for frame-sized ones
 *  (texture plates) often enough to exhaust memory if each were a fresh allocation */
const PIXELS = new Map<number, Uint8ClampedArray>();
function pixels(n: number): Uint8ClampedArray {
  let d = PIXELS.get(n);
  if (!d) { d = new Uint8ClampedArray(n); for (let i = 3; i < n; i += 4 * 7) d[i] = 255; if (PIXELS.size > 64) PIXELS.clear(); PIXELS.set(n, d); }
  return d;
}

/** a DOMMatrix-shaped identity (layouts chain rotate / translate / inverse / transformPoint on getTransform()) */
function matrix(): any {
  const m: any = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0, m11: 1, m12: 0, m21: 0, m22: 1, m41: 0, m42: 0, is2D: true, isIdentity: true };
  for (const k of ["rotate", "translate", "scale", "multiply", "inverse", "skewX", "skewY", "rotateSelf", "translateSelf", "scaleSelf", "multiplySelf", "invertSelf", "preMultiplySelf", "flipX", "flipY"]) m[k] = () => m;
  m.transformPoint = (pt: any = {}) => ({ x: pt.x ?? 0, y: pt.y ?? 0, z: 0, w: 1 });
  return m;
}

function stubCanvas(stats: { text: number }) {
  const cv: any = { width: 300, height: 150 };
  // methods live on a prototype, like CanvasRenderingContext2D (JIZURA's post effects call proto.drawImage.call(…))
  const proto: Record<string, unknown> = {};
  for (const m of ["fillRect", "clearRect", "strokeRect", "drawImage", "fillText", "strokeText", "save", "restore", "beginPath", "closePath", "moveTo", "lineTo", "arc", "rect", "fill", "stroke", "clip", "translate", "rotate", "scale", "setTransform", "transform", "putImageData"])
    proto[m] = () => { if (m === "fillText" || m === "strokeText") stats.text++; };
  const state: Record<string, unknown> = Object.assign(Object.create(proto), { canvas: cv, font: "10px x", globalAlpha: 1 });
  const ctx = new Proxy(state, {
    getPrototypeOf: () => proto,
    get(t, k: string) {
      if (k in t) return t[k];
      if (k === "measureText") return (s: string) => ({ width: [...String(s)].reduce((w, c) => w + (/[ -~]/.test(c) ? 0.55 : 1), 0) * (parseFloat(String(t.font).split(" ")[1]) || 10), actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 });
      if (k === "getImageData" || k === "createImageData") return (...a: number[]) => {
        const w = Math.max(1, (k === "getImageData" ? a[2] : a[0]) | 0), h = Math.max(1, (k === "getImageData" ? a[3] : a[1]) | 0);
        return { width: w, height: h, data: pixels(w * h * 4) };
      };
      if (k === "getLineDash") return () => [];
      if (k === "getTransform") return () => matrix();
      if (k.startsWith("create")) return () => ({ addColorStop() {}, setTransform() {} });
      if (k === "isPointInPath" || k === "isPointInStroke") return () => false;
      return (...a: unknown[]) => { if (k === "fillText" || k === "strokeText") stats.text++; };
    },
    set(t, k: string, v) { t[k] = v; return true; },
  });
  cv.getContext = () => ctx;
  return cv;
}

function guarded<T>(fn: () => T): T {
  const rnd = Math.random, now = Date.now;
  Math.random = () => { throw new Error("Math.random called (graphics must be deterministic)"); };
  Date.now = () => { throw new Error("Date.now called (graphics must be deterministic)"); };
  try { return fn(); } finally { Math.random = rnd; Date.now = now; }
}

export function loadLyricMotion(htmlPath: string, props: Record<string, unknown>, cfg: { width: number; height: number; fps?: number; duration?: number; grid?: unknown; clipDur?: number; clipStart?: number } = { width: 1920, height: 1080 }): LyricMotion {
  const html = fs.readFileSync(htmlPath, "utf8");
  const m = html.match(/<script>([\s\S]*)<\/script>/);
  if (!m) throw new Error(`${htmlPath}: no <script>`);
  let js = m[1];
  const at = js.lastIndexOf("});");
  js = js.slice(0, at) + "globalThis.__lyricMotion = { J, planNow, project, LY };\n" + js.slice(at);
  const stats = { text: 0 }, warnings: string[] = [];
  let onFrame: ((t: number) => void) | null = null;
  const g = globalThis as any;
  const env = { window: { __VOS_CFG__: { fps: 24, duration: 600, ...cfg } }, document: { fonts: { status: "loaded" }, createElement: () => stubCanvas(stats), head: null } };
  // the engine reads window / document at load and while drawing: install them only for the duration of a call
  const within = <T>(fn: () => T): T => {
    const saved = { window: g.window, document: g.document, Path2D: g.Path2D, DOMMatrix: g.DOMMatrix, warn: console.warn, error: console.error };
    g.window = env.window; g.document = env.document;
    g.Path2D ??= class { constructor() { return new Proxy({}, { get: () => () => {} }); } };
    g.DOMMatrix ??= class { constructor() { return matrix(); } };
    console.warn = console.error = (...a: unknown[]) => { warnings.push(a.map(String).join(" ")); };
    try { return guarded(fn); } finally {
      g.window = saved.window; g.document = saved.document; g.Path2D = saved.Path2D; g.DOMMatrix = saved.DOMMatrix; console.warn = saved.warn; console.error = saved.error;
    }
  };
  const vos = { graphic: (fn: any) => fn({ q: (s: string) => (s === ".lm-cv" ? stubCanvas(stats) : { innerHTML: "" }), props, dur: cfg.clipDur, start: cfg.clipStart ?? 0, onFrame: (h: any) => { onFrame = h; } }) };
  const lm = within(() => { new Function("vos", js)(vos); const r = g.__lyricMotion; delete g.__lyricMotion; return r; });
  const plan = within(() => lm.planNow());
  return { J: lm.J, plan, project: lm.project, LY: lm.LY, stats, warnings, frame: (t: number) => within(() => onFrame!(t)) };
}
