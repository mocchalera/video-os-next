// The MV's foley (refs/sfx_stem.wav: the invisible hand — the bed, keys, can, bag, door, window), played with the song.
// Compressed to AAC (tools/build-assets.sh: 725 KB for 214.8 s) with +7.5 dB baked in (the MV puts the stem at +8 dB: 8–12 dB under the song; measured here 11.9 dB under).
// It is a second <audio> element slaved to the song's: iOS ignores <audio>.volume, so there is no gain to set — only start/stop/seek/mute, which iOS honours.
// If it cannot load or play (offline, a browser that refuses two media elements) the web version still works: nothing but this sound is lost.
//
// States, kept apart (loaded is not playing):
//   loaded   the file can be played (canplay)
//   sounding the element is actually playing (the "playing" event, not paused, not ended)
//   refused  play() was rejected (iOS before a gesture, a policy): no retry loop — the next tap / key / click clears it and the next frame tries once
const ESC_DUCK = [134.3, 134.58]; // the stem has the Esc click at 134.42; if the viewer pressed earlier, their own click is sounded then and the stem's is muted
export class Foley {
  constructor(music, fps = 24) {
    this.m = music; this.fps = fps; this.a = null; this.loaded = false; this.sounding = false; this.refused = false; this.err = null;
    this.lastCheck = 0; this.needSync = true; this.gen = 0; this.want = false; this.escEarly = () => false;
    for (const ev of ["pointerdown", "keydown", "touchend"]) addEventListener(ev, () => { if (this.refused) { this.refused = false; this.needSync = true; } }, { passive: true, capture: true });
  }
  get ok() { return this.loaded; } // (kept for the QA scripts: "the file is there"). What matters for sound is `sounding`.
  load() {
    const a = new Audio(); a.preload = "none"; a.playsInline = true; a.src = "/assets/foley.m4a";
    a.addEventListener("canplay", () => { this.loaded = true; });
    a.addEventListener("playing", () => { this.sounding = true; this.refused = false; });
    for (const ev of ["pause", "ended", "emptied", "waiting"]) a.addEventListener(ev, () => { this.sounding = false; });
    a.addEventListener("error", () => { this.loaded = false; this.sounding = false; this.err = "load"; });
    this.a = a;
  }
  /** called inside the entrance's tap: an element must be started by a gesture once before a program may start it later (iOS) */
  unlock() {
    const a = this.a; if (!a) return; const g = ++this.gen; a.muted = true; const p = a.play();
    // park it again — but only if nothing has asked for real playback since (a later start must not be stopped by this old promise)
    if (p && p.then) p.then(() => { if (this.gen === g && !this.want) { a.pause(); a.currentTime = 0; } }).catch((e) => { this.err = String(e && e.message || e); });
  }
  /** the page went to the background (the frame loop stops with it, so update() will not pause us) */
  halt() { this.want = false; if (this.a && !this.a.paused) this.a.pause(); this.needSync = true; }
  /** after a seek or a return: the next update() puts the element on the song's clock before anything else */
  dirty() { this.needSync = true; }
  _covers(T) { const s = this.a.seekable; for (let i = 0; i < s.length; i++) if (s.start(i) <= T + 0.02 && s.end(i) >= T) return true; return false; }
  seek(T) { if (this.a && this.loaded && this._covers(T)) { try { this.a.currentTime = T; } catch { /* not seekable yet */ } } this.needSync = true; }
  /** per frame. T = the song's clock; playing = the song is running */
  update(T, playing) {
    const a = this.a; if (!a || !this.loaded) return;
    a.volume = this.m.volume ?? 1; a.muted = this.m.muted || (this.escEarly() && T > ESC_DUCK[0] && T < ESC_DUCK[1]);
    if (!playing) { this.want = false; if (!a.paused) a.pause(); return; }
    if (!this.want) { this.want = true; this.gen++; this.needSync = true; } // a real start: any older unlock() promise no longer owns the element
    if (a.paused) {
      if (this.refused) return; // wait for the next gesture; no per-frame retries
      if (!this._covers(T)) return; // not seekable there yet (it would fall back to 0): stay silent until it is
      try { a.currentTime = T; } catch { /* */ }
      const p = a.play(); if (p && p.catch) p.catch((e) => { this.err = String(e && e.message || e); this.refused = true; this.sounding = false; });
      this.needSync = false; this.lastCheck = performance.now(); return;
    }
    const now = performance.now(); if (!this.needSync && now - this.lastCheck < 250) return; this.lastCheck = now;
    if (a.seeking) return; this.needSync = false;
    if (Math.abs(a.currentTime - T) > 0.9 / this.fps && this._covers(T)) { try { a.currentTime = T; } catch { /* */ } } // less than one frame (41.7 ms at 24 fps)
  }
}
