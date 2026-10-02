// The cursor as a trace (BRIEF §2, v1.1): no OS arrow, no hand — a small thing that says "something is here", in the room's own words.
//   room            a hollow ring, 14 px, 1 px, grey, a little soft. Appears when you move, goes after 2 s of stillness, and while you look around by dragging.
//   something to press   a terminal block cursor (the ▍ of a prompt: a bar 3/8 of a cell wide), blinking slowly at 1 Hz — it is waiting for you.
//   the time line   a 1 px vertical line.
//   the fogged window   a larger soft circle; the fog under it thins a little (the warmth of a finger) — press, and it writes.
// Not on touch screens. It is a DOM element moved with transform only (never in WebGL: no frame-rate cost). The page's own cursor is hidden only
// once this one is alive (html.cur-on), so there is never a state with no cursor at all.
// Room Mono has no ▍ glyph (99 glyphs, no block elements) and no other typeface may come in, so the block is drawn as a box of the same proportions.
const CSS = `
html.cur-on #room-view,html.cur-on #room-view *{cursor:none !important}
#cur{position:fixed;left:0;top:0;width:0;height:0;z-index:60;pointer-events:none;will-change:transform;contain:layout style;transform:translate3d(-100px,-100px,0)}
#cur i{position:absolute;display:block;opacity:0;transition:opacity .22s}
#cur .ring{left:-7px;top:-7px;width:14px;height:14px;box-sizing:border-box;border:1px solid rgba(214,214,214,.55);border-radius:50%;filter:blur(.4px);box-shadow:0 0 3px rgba(190,190,190,.22)}
#cur .blk{left:-1px;top:-8px;width:4px;height:16px;background:#d6d6d6;box-shadow:0 0 4px rgba(214,214,214,.35)}
#cur .bar{left:0;top:-11px;width:1px;height:22px;background:rgba(236,236,236,.92)}
#cur .fog{left:-26px;top:-26px;width:52px;height:52px;border-radius:50%;background:radial-gradient(circle,rgba(255,255,255,.16) 0,rgba(255,255,255,.1) 38%,rgba(46,58,76,.2) 56%,rgba(46,58,76,.08) 66%,rgba(46,58,76,0) 76%);transition:opacity .22s,transform .14s}
#cur.m-ring:not(.off) .ring{opacity:1}
#cur.m-block:not(.off) .blk{opacity:1;animation:curblink 1s ease-in-out infinite}
#cur.m-bar:not(.off) .bar{opacity:1}
#cur.m-fog:not(.off) .fog{opacity:1}
#cur.m-fog.down .fog{transform:scale(.58)}
@keyframes curblink{0%,100%{opacity:1}50%{opacity:.1}}
@media (prefers-reduced-motion:reduce){#cur i{transition:none !important}#cur.m-block:not(.off) .blk{animation:none}}
/* keyboard focus speaks the same way: a grey 1 px line and a prompt's block, no browser ring */
#gate button:focus,#cues .act:focus-visible,#tl .ccbtn:focus-visible,#tl .hit:focus-visible,#log .x:focus-visible{outline:1px solid rgba(190,190,190,.7);outline-offset:4px}
#gate button:focus::before,#cues .act:focus-visible::before,#tl .ccbtn:focus-visible::before,#log .x:focus-visible::before{content:"";display:inline-block;width:4px;height:1.1em;margin:0 .45em -.2em 0;background:#d6d6d6;animation:curblink 1s ease-in-out infinite}
@media (prefers-reduced-motion:reduce){#gate button:focus::before,#cues .act:focus-visible::before,#tl .ccbtn:focus-visible::before,#log .x:focus-visible::before{animation:none}}
`;

export class Cursor {
  /** @param {{ctx:()=>HTMLElement|null, epi:()=>any}} o  ctx: the "context n%" label (click-through, but it is a thing to press); epi: the running epilogue, or null */
  constructor(o) {
    this.o = o; this.alive = false; this.mode = "ring"; this.x = -100; this.y = -100; this.down = false; this.lock = null; this.idle = 0; this.last = { mode: "", warm: false };
    const css = document.createElement("style"); css.textContent = CSS; document.head.appendChild(css);
    const el = this.el = document.createElement("div"); el.id = "cur"; el.className = "m-ring off"; el.setAttribute("aria-hidden", "true");
    el.innerHTML = `<i class="ring"></i><i class="blk"></i><i class="bar"></i><i class="fog"></i>`; document.body.appendChild(el);
    const opt = { passive: true, capture: true };
    addEventListener("pointermove", (e) => this._move(e), opt);
    addEventListener("pointerdown", (e) => this._press(e, true), opt);
    addEventListener("pointerup", (e) => this._press(e, false), opt); addEventListener("pointercancel", (e) => this._press(e, false), opt);
    document.addEventListener("mouseleave", () => this._off(true));
    // a release the page never saw (the button let go in another window, the focus taken away, the capture lost) must not leave "pressed" behind: it would keep the cursor away until the next click
    addEventListener("blur", () => this._release()); document.addEventListener("visibilitychange", () => { if (document.hidden) this._release(); });
    addEventListener("lostpointercapture", () => this._release(), opt); addEventListener("pagehide", () => this._release());
  }
  _live(e) { return e.pointerType === "mouse" || e.pointerType === "pen"; }
  _alive() { if (!this.alive) { this.alive = true; document.documentElement.classList.add("cur-on"); } }
  /** forget any press: not down, no lock, hidden until the next move */
  _release() { this.down = false; this.lock = null; this.el.classList.remove("down"); this._off(true); }
  _off(clearWarm) { this.el.classList.add("off"); clearTimeout(this.idle); if (clearWarm) this._warm(null); }
  _set(mode) { if (mode === this.mode) return; this.mode = mode; this.el.className = `m-${mode}` + (this.el.classList.contains("off") ? " off" : "") + (this.down ? " down" : ""); }
  _warm(p) { const epi = this.o.epi(); if (epi && epi.setWarm) { if (p) epi.setWarm(p.x, p.y); else epi.setWarm(null); } }
  /** which of the four the pointer is over */
  modeAt(x, y, target) {
    const t = target && target.closest ? target.closest("[data-cur],#log") : null;
    if (t) return t.dataset && t.dataset.cur ? t.dataset.cur : "ring"; // the log's plain text: the room's ring (its close button has data-cur)
    const c = this.o.ctx(); if (c && c.textContent) { const r = c.getBoundingClientRect(); if (x >= r.left - 6 && x <= r.right + 6 && y >= r.top - 4 && y <= r.bottom + 4) return "block"; }
    const epi = this.o.epi(); if (epi && epi.writableAt && epi.writableAt(x, y)) return "fog";
    return "ring";
  }
  _move(e) {
    if (!e.target?.closest?.("#room-view")) { this._off(true); return; }
    if (!this._live(e)) { this._off(true); return; } // a finger: nothing to show
    if (this.down && e.pointerType === "mouse" && e.buttons === 0) { this.down = false; this.lock = null; this.el.classList.remove("down"); } // the release was lost: this move says no button is held
    this._alive(); this.x = e.clientX; this.y = e.clientY; this.target = e.target; this.el.style.transform = `translate3d(${this.x}px,${this.y}px,0)`;
    const m = this.lock || this.modeAt(this.x, this.y, e.target); this._set(m);
    if (this.down && m === "ring") return; // looking around: it stays away
    this.el.classList.remove("off");
    this._warm(m === "fog" ? { x: this.x, y: this.y } : null);
    clearTimeout(this.idle); if (m === "ring") this.idle = setTimeout(() => this.el.classList.add("off"), 2000);
  }
  /** a few times a second: the entrance goes away, the camera drifts, the window opens under a resting pointer — so the mode is asked again (room → the ring, which then goes after 2 s) */
  tick(now) {
    if (!this.alive || this.lock || this.el.classList.contains("off") || now - (this._tk || 0) < 200) return; this._tk = now;
    const target = document.elementFromPoint(this.x, this.y) || this.target; if (!target?.closest?.("#room-view")) { this._off(true); return; }
    const m = this.modeAt(this.x, this.y, target); if (m === this.mode) return;
    this._set(m); this._warm(m === "fog" ? { x: this.x, y: this.y } : null);
    clearTimeout(this.idle); if (m === "ring") this.idle = setTimeout(() => this.el.classList.add("off"), 2000);
  }
  _press(e, on) {
    if (!e.target?.closest?.("#room-view")) { this._release(); return; }
    if (!this._live(e)) { if (on) this._off(true); return; }
    this._alive(); this.down = on; this.el.classList.toggle("down", on);
    if (on) { this.lock = this.modeAt(e.clientX, e.clientY, e.target); this._set(this.lock); if (this.lock === "ring") this._off(false); }
    else { this.lock = null; }
  }
}
