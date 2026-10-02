// On-screen text of the web version (M2). Nothing but small grey monospace: the context number, a thin time line that appears on a tap,
// the closed captions, and the epilogue's one-line cues. No buttons, no panels, no tooltips (BRIEF §3).
// Wording is the brief's and the director's (2026-10-01) — nothing is added without asking.

const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;
/** piecewise-smooth table [[t, v], …] — the same function room.html's `tab` is (so the number here is the number on the monitor) */
export function tab(pairs, T) {
  if (!pairs || !pairs.length) return 0;
  if (T <= pairs[0][0]) return pairs[0][1];
  for (let i = 0; i + 1 < pairs.length; i++) { const [a, va] = pairs[i], [b, vb] = pairs[i + 1]; if (T < b) return lerp(va, vb, sstep(a, b, T)); }
  return pairs[pairs.length - 1][1];
}

// song sections (shots.md): Intro / Verse 1 / Hook / Verse 2 / Break / Verse 3 / Hook / Bridge / Outro
export const SECTIONS = [
  { t: 0, name: "Intro" }, { t: 8.6, name: "Verse 1" }, { t: 38.3, name: "Hook" }, { t: 58.4, name: "Verse 2" }, { t: 91.1, name: "Break" },
  { t: 103.4, name: "Verse 3" }, { t: 132.7, name: "Hook" }, { t: 152.9, name: "Bridge" }, { t: 176.3, name: "Outro" },
];
export const SONG_END = 214.8;

// the clock on the wall (room.html drawClock): 5:00 + the song's seconds as minutes, then from 97 s it is the night and runs to 7:12 in the morning
export function roomClock(T, BLINKS = [105.9, 107.8, 110.6, 113.7, 116.4, 122.7, 125.1]) {
  let hr = 5 + (T / 60 + 0.2) / 60, min = T / 60 + 0.2;
  if (T > 97) {
    const steps = [[97, 19.3], [103.4, 21.1], ...BLINKS.map((b, i) => [b, 21.8 + i * 0.72]), [127.7, 26.6], [139, 29.5], [152.6, 30.4], [176.3, 31.2]];
    let hv = 19.3, tb = 97; for (const [tt, v] of steps) if (T >= tt) { hv = v; tb = tt; }
    hv += (T - tb) / 180; hr = hv; min = (hv % 1) * 60;
  }
  const h = Math.floor(hr) % 24, m = Math.floor(((hr % 1) * 60) % 60);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")}`;
}

function parseSrt(txt) {
  const out = [];
  for (const blk of txt.replace(/\r/g, "").split(/\n\n+/)) {
    const L = blk.split("\n"); const m = /(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)/.exec(L[1] || "");
    if (m) out.push({ a: +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000, b: +m[5] * 3600 + +m[6] * 60 + +m[7] + +m[8] / 1000, text: L.slice(2).join("\n") });
  }
  return out;
}

export class UI {
  /** @param {{ctx: number[][], seek: (T:number)=>void, duration: number}} o */
  constructor(o) {
    this.o = o; this.ctxTab = o.ctx; this.visible = false; this.hideAt = 0; this.cc = "off"; this.caps = { ja: [], en: [] }; this.lastCtx = null; this.lastCap = null;
    const css = document.createElement("style");
    css.textContent = `
#ctx,#tl,#cc,#cues,#log,#fade{font:11px/1.5 "Room Mono","Room Sans","Hiragino Sans","Hiragino Kaku Gothic ProN","Yu Gothic","Noto Sans JP",ui-monospace,monospace;color:#7d7d7d;letter-spacing:.03em}
#ctx{position:absolute;left:calc(16px + env(safe-area-inset-left));bottom:calc(10px + env(safe-area-inset-bottom));z-index:4;pointer-events:none}
#tl{position:absolute;left:calc(16px + env(safe-area-inset-left));right:calc(16px + env(safe-area-inset-right));bottom:calc(44px + env(safe-area-inset-bottom));height:44px;z-index:5;opacity:0;pointer-events:none;visibility:hidden;transition:opacity .35s,visibility 0s .35s}
#tl.on{opacity:1;pointer-events:auto;visibility:visible;transition:opacity .35s}
#tl .line{position:absolute;left:0;right:0;bottom:12px;height:1px;background:#4a4a4a}
#tl .prog{position:absolute;left:0;bottom:12px;height:1px;background:#bdbdbd;width:0}
#tl .hit{position:absolute;left:-8px;right:-8px;bottom:0;height:30px;touch-action:none}
#tl .tick{position:absolute;bottom:7px;width:1px;height:11px;background:#4a4a4a}
#tl .name{position:absolute;bottom:-9px;white-space:nowrap;font-size:10px;color:#626262}
#tl .head{position:absolute;bottom:7px;width:1px;height:11px;background:#e6e6e6}
#tl .when{position:absolute;bottom:22px;transform:translateX(-50%);font-size:10px;color:#c4c4c4;white-space:nowrap}
#tl .end{position:absolute;bottom:22px;font-size:10px;color:#626262}
#tl .ccbtn{position:absolute;right:0;bottom:-26px;color:#8a8a8a;padding:2px 0}
#cc{position:absolute;left:50%;bottom:calc(78px + env(safe-area-inset-bottom));transform:translateX(-50%);z-index:3;max-width:72%;text-align:center;color:#e8e8e8;font-size:17px;line-height:1.5;text-shadow:0 0 6px #000,0 0 2px #000;pointer-events:none;white-space:pre-line;opacity:0;transition:opacity .2s;letter-spacing:.04em}
#cc.on{opacity:1}
#cc.ja{font-family:"Room Serif","Hiragino Mincho ProN","Yu Mincho",serif}
#cc.en{font-family:"Room Sans","Hiragino Sans",sans-serif;font-size:15px}
#cues{position:absolute;left:50%;bottom:calc(64px + env(safe-area-inset-bottom));max-width:94vw;transform:translateX(-50%);z-index:4;text-align:center;font-size:clamp(14px,1.25vw,18px);color:#cfcfcf;opacity:0;transition:opacity 1.4s;white-space:nowrap;text-shadow:0 0 6px #000,0 0 3px #000;letter-spacing:.05em}
#cues.on{opacity:1}
#cues:not(.on) .act{pointer-events:none}
#cues .act{pointer-events:auto;color:#e2e2e2;margin:0 16px;border-bottom:1px solid #6a6a6a;padding:2px 0}
#fade{position:absolute;inset:0;background:#000;z-index:3;opacity:0;pointer-events:none;transition:opacity 2.4s ease}
#log{position:fixed;inset:0;z-index:9;background:#050505;color:#b5b5b5;padding:56px 7vw 40px;overflow:auto;display:none;font-size:13px;line-height:1.7;-webkit-user-select:text;user-select:text}
#log.on{display:block}
#log .x{position:fixed;right:22px;top:16px;color:#8a8a8a;font-size:18px}
#log .row{display:grid;grid-template-columns:7.5em 8em 1fr;gap:0 1em;margin:0 0 .35em}
#log .row .t{color:#5f5f5f}#log .row .w{color:#7d8794}#log .row.human .w,#log .row.human .m{color:#e9d6b2}
#log .row .m{white-space:pre-wrap;overflow-wrap:anywhere}
@media (max-width:640px){#log .row{grid-template-columns:5em 1fr}#log .row .w{display:none}}
@media (orientation:portrait){#cc{max-width:90%;font-size:15px}#cues{white-space:normal;width:92vw}#tl .name{font-size:9px}}
@media (prefers-reduced-motion:reduce){#cues,#tl,#cc,#fade,#gate button{transition:none !important}}
`;
    document.head.appendChild(css);
    const mk = (id, cls = "") => { const e = document.createElement("div"); e.id = id; if (cls) e.className = cls; (id === "log" ? document.body : document.getElementById("room-view")).appendChild(e); return e; };
    this.elCtx = mk("ctx"); this.elCap = mk("cc"); this.elCues = mk("cues"); this.elFade = mk("fade");
    this.elTl = mk("tl"); this.elTl.innerHTML = `<div class="line"></div><div class="prog"></div><div class="head"></div><div class="when"></div><span class="end" style="left:0">5:00</span><span class="end" style="right:0">7:12</span><div class="ccbtn" role="button" tabindex="0" data-cur="block" aria-label="closed captions">CC</div><div class="hit" data-cur="bar"></div>`;
    for (const s of SECTIONS) { const t = document.createElement("div"); t.className = "tick"; t.style.left = (s.t / SONG_END) * 100 + "%"; const n = document.createElement("div"); n.className = "name"; n.textContent = s.name; n.style.left = (s.t / SONG_END) * 100 + "%"; n.style.transform = "translateX(3px)"; this.elTl.append(t, n); }
    this.prog = this.elTl.querySelector(".prog"); this.head = this.elTl.querySelector(".head"); this.when = this.elTl.querySelector(".when"); this.ccbtn = this.elTl.querySelector(".ccbtn");
    this.endL = this.elTl.querySelectorAll(".end")[0]; this.endR = this.elTl.querySelectorAll(".end")[1];
    const hit = this.elTl.querySelector(".hit"); let drag = false;
    const at = (e) => { const r = this.elTl.getBoundingClientRect(); return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * SONG_END; };
    hit.addEventListener("pointerdown", (e) => { drag = true; hit.setPointerCapture(e.pointerId); this.o.seek(at(e)); this.touch(); e.stopPropagation(); });
    hit.addEventListener("pointermove", (e) => { if (drag) { this.o.seek(at(e)); this.touch(); } });
    hit.addEventListener("pointerup", () => { drag = false; }); hit.addEventListener("pointercancel", () => { drag = false; });
    this.ccbtn.addEventListener("pointerdown", (e) => { e.stopPropagation(); this.cycleCC(); this.touch(); });
    this.ccbtn.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); this.cycleCC(); this.touch(); } });
    this.elLog = mk("log"); this.elLog.setAttribute("role", "dialog"); this.elLog.setAttribute("aria-label", "log");
    this.cueDone = new Set();
  }
  async loadCaptions() {
    for (const k of ["ja", "en"]) { try { const r = await fetch(`/_src/out/sweet-lesson.${k}.srt`); if (r.ok) this.caps[k] = parseSrt(await r.text()); } catch (e) { /* captions are optional */ } }
  }
  get blocksLook() { return this.visible; }
  // ---- time line
  show() { this.visible = true; this.elTl.classList.add("on"); this.touch(); }
  hide() { this.visible = false; this.elTl.classList.remove("on"); }
  toggle() { this.visible ? this.hide() : this.show(); }
  touch() { this.hideAt = performance.now() + 7000; }
  cycleCC() { this.cc = this.cc === "off" ? "ja" : this.cc === "ja" ? "en" : "off"; this.lastCap = null; this.ccbtn.textContent = this.cc === "off" ? "CC" : "CC " + this.cc; this.ccbtn.style.color = this.cc === "off" ? "#8a8a8a" : "#d4d4d4"; }
  /** per frame: T = the song clock (null in the epilogue); ctxT = the time the monitor's context number is read at */
  frame(T, ctxT, hint) {
    const c = Math.round(tab(this.ctxTab, ctxT)); if (c !== this.lastCtx) { this.lastCtx = c; this.elCtx.textContent = `context ${c}%`; }
    if (T === null) { if (this.visible) this.hide(); this._caption(null); return; }
    if (this.visible) {
      if (performance.now() > this.hideAt) this.hide();
      const u = Math.min(1, T / SONG_END), pct = u * 100 + "%"; this.prog.style.width = pct; this.head.style.left = pct; this.when.style.left = pct; this.when.textContent = roomClock(T);
      this.endL.style.opacity = u < 0.07 ? 0 : 1; this.endR.style.opacity = u > 0.93 ? 0 : 1;
    }
    this._caption(T);
  }
  _caption(T) {
    let text = "";
    if (this.cc !== "off" && T !== null) { const L = this.caps[this.cc]; for (let i = 0; i < L.length; i++) if (T >= L[i].a && T < L[i].b) { text = L[i].text; break; } }
    const key = this.cc + "|" + text; if (key === this.lastCap) return; this.lastCap = key;
    this.elCap.className = this.cc === "off" ? "" : this.cc; this.elCap.textContent = text; this.elCap.classList.toggle("on", !!text);
  }
  // ---- the one-line cues (hint, epilogue)
  cue(html, on = true) { this.elCues.innerHTML = html; this.elCues.classList.toggle("on", on); }
  cueClear() { this.elCues.classList.remove("on"); }
  fade(to, ms) { this.elFade.style.transitionDuration = (ms || 2400) + "ms"; this.elFade.style.opacity = String(to); }
  // ---- the log as plain text (accessibility)
  openLog(events) {
    const L = this.elLog; L.innerHTML = ""; const x = document.createElement("div"); x.className = "x"; x.textContent = "×"; x.setAttribute("role", "button"); x.dataset.cur = "block"; x.setAttribute("aria-label", "close"); x.tabIndex = 0;
    x.addEventListener("pointerdown", () => this.closeLog()); x.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") this.closeLog(); }); L.appendChild(x);
    for (const e of events) { const r = document.createElement("div"); r.className = "row" + (e.who === "human" ? " human" : ""); const t = document.createElement("span"); t.className = "t"; t.textContent = e.jst || ""; const w = document.createElement("span"); w.className = "w"; w.textContent = e.who || ""; const m = document.createElement("span"); m.className = "m"; m.textContent = (e.text || "").replace(/\s+$/g, ""); r.append(t, w, m); L.appendChild(r); }
    // a modal: everything behind it is inert (no focus, no clicks, no keys), Tab stays inside, and closing gives the focus back to what opened it
    this.opener = document.activeElement; this.inerted = [];
    for (const el of Array.from(document.body.children)) { if (el === L || el.id === "cur" || el.tagName === "SCRIPT" || el.tagName === "STYLE" || el.hasAttribute("inert")) continue; el.setAttribute("inert", ""); this.inerted.push(el); }
    L.setAttribute("aria-modal", "true"); L.onkeydown = (e) => { if (e.code === "Tab") { e.preventDefault(); x.focus(); } };
    L.classList.add("on"); L.scrollTop = 0; x.focus(); this.logOpen = true;
  }
  closeLog() {
    if (!this.logOpen) return; this.elLog.classList.remove("on"); this.logOpen = false;
    for (const el of this.inerted || []) el.removeAttribute("inert"); this.inerted = [];
    const o = this.opener; this.opener = null; try { if (o && o.isConnected && o.focus) o.focus({ preventScroll: true }); else if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); } catch { /* ok */ }
  }
}
