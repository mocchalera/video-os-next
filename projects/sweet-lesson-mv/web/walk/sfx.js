// The viewer's own small sounds (M2): footsteps on the wooden floor of the room, and the click of Esc.
// Synthesised here (no recordings, no licence question, no network), the way tools/sfx.py made the MV's foley.
// The synth is plain arrays so tools (qa/audio-check.mjs) can render it in Node and measure it against the song.
//
// Levels are relative to the song: Sweet Lesson.mp3 has mean_volume −17.9 dBFS (RMS), −15.9 LUFS integrated, peak −4.1 dBFS.
// "At least 15 dB under the song": a step's PEAK is −36 dBFS (≥ 18 dB under the song's RMS, 32 dB under its peak).
export const SONG_RMS_DBFS = -17.9;
export const STEP_PEAK_DBFS = -36;     // with the song
export const STEP_PEAK_QUIET_DBFS = -28; // the epilogue has no song to sit under
export const ESC_PEAK_DBFS = -34;

const rnd = (seed) => { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };

/** one step on old boards: a low body thump, two knocking modes of the floor, a short heel tick. Peak-normalised to 1. */
export function synthStep(sr, variant = 0) {
  const r = rnd(1000 + variant * 77), n = Math.floor(sr * 0.22), out = new Float32Array(n);
  const f0 = 68 + r() * 22, m1 = 150 + r() * 50, m2 = 330 + r() * 120, tickF = 1400 + r() * 900;
  let lp = 0; // one-pole low-pass state for the tick's noise
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    let v = 0.9 * Math.sin(2 * Math.PI * f0 * t * (1 - 0.18 * t)) * Math.exp(-t / 0.040);          // thump
    v += 0.35 * Math.sin(2 * Math.PI * m1 * t) * Math.exp(-t / 0.055) + 0.2 * Math.sin(2 * Math.PI * m2 * t + 0.6) * Math.exp(-t / 0.035); // boards
    const white = r() * 2 - 1; lp += (white - lp) * 0.35;
    v += 0.22 * (white - lp) * Math.sin(2 * Math.PI * tickF * t) * Math.exp(-t / 0.006);          // heel tick (high-passed noise burst)
    v *= Math.min(1, t / 0.0015);                                                                  // no click at the start
    out[i] = v;
  }
  let pk = 0; for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(out[i])); for (let i = 0; i < n; i++) out[i] /= pk || 1;
  return out;
}

/** the Esc key: a short plastic tick with a small body. Peak-normalised to 1. */
export function synthEsc(sr) {
  const r = rnd(4242), n = Math.floor(sr * 0.12), out = new Float32Array(n);
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr, white = r() * 2 - 1; lp += (white - lp) * 0.5;
    let v = 0.8 * (white - lp) * Math.exp(-t / 0.0025) + 0.6 * Math.sin(2 * Math.PI * 3900 * t) * Math.exp(-t / 0.006) + 0.5 * Math.sin(2 * Math.PI * 240 * t) * Math.exp(-t / 0.02);
    out[i] = v * Math.min(1, t / 0.0004);
  }
  let pk = 0; for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(out[i])); for (let i = 0; i < n; i++) out[i] /= pk || 1;
  return out;
}

export const dbToGain = (db) => Math.pow(10, db / 20);

/** browser engine: created on the first tap (the entrance's "enter"), muted with the song */
export class Sfx {
  constructor() { this.ctx = null; this.steps = []; this.esc = null; this.muted = false; this.volume = 1; this.quiet = false; this.k = 0; }
  init() {
    if (this.ctx) return;
    const C = window.AudioContext || window.webkitAudioContext; if (!C) return;
    this.ctx = new C(); const sr = this.ctx.sampleRate;
    this.master = this.ctx.createGain(); this.master.connect(this.ctx.destination); this.master.gain.value = this.muted ? 0 : this.volume;
    const mk = (a) => { const b = this.ctx.createBuffer(1, a.length, sr); b.copyToChannel(a, 0); return b; };
    this.steps = [0, 1, 2, 3].map((v) => mk(synthStep(sr, v))); this.esc = mk(synthEsc(sr));
    // iOS: the context is only allowed to sound after something has been started inside a tap — this is that tap (the entrance's "enter")
    try { this.ctx.resume(); const b = this.ctx.createBuffer(1, 1, 22050), src = this.ctx.createBufferSource(); src.buffer = b; src.connect(this.ctx.destination); src.start(0); } catch (e) { /* no audio is not fatal */ }
    for (const ev of ["touchend", "pointerdown", "keydown"]) window.addEventListener(ev, () => { if (this.ctx && this.ctx.state === "suspended") this.ctx.resume(); }, { passive: true });
  }
  /** the page went to the background: the clock of the sounds stops with it (nothing already scheduled plays on behind a hidden page) */
  suspend() { try { if (this.ctx && this.ctx.state === "running") this.ctx.suspend(); } catch { /* ok */ } }
  resume() { try { if (this.ctx && this.ctx.state !== "running") this.ctx.resume(); } catch { /* ok */ } }
  setVolume(v) { this.volume = Math.max(0, Math.min(1, v)); if (this.master) this.master.gain.value = this.muted ? 0 : this.volume; }
  setMuted(m) { this.muted = m; if (this.master) this.master.gain.value = m ? 0 : this.volume; }
  _play(buf, peakDb, pan = 0, rate = 1) {
    if (!this.ctx || this.muted) return;
    if (this.ctx.state === "suspended") this.ctx.resume();
    const s = this.ctx.createBufferSource(); s.buffer = buf; s.playbackRate.value = rate;
    const g = this.ctx.createGain(); g.gain.value = dbToGain(peakDb);
    const p = this.ctx.createStereoPanner ? this.ctx.createStereoPanner() : null; if (p) { p.pan.value = pan; s.connect(g).connect(p).connect(this.master); } else s.connect(g).connect(this.master);
    s.start();
  }
  step() { this.k++; this._play(this.steps[(this.k * 7 + (this.k >> 2)) % this.steps.length], this.quiet ? STEP_PEAK_QUIET_DBFS : STEP_PEAK_DBFS + (Math.sin(this.k * 12.9898) * 1.2), (this.k % 2 ? 0.12 : -0.12), 0.94 + 0.12 * (0.5 + 0.5 * Math.sin(this.k * 4.1))); }
  escClick() { this._play(this.esc, ESC_PEAK_DBFS, 0, 1); }
}
