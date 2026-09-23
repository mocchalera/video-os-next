import { spawnSync } from "node:child_process";
import { VosError } from "../core/util.ts";

export interface BeatAnalysis {
  format: "vos.beats/1";
  bpm: number;
  offset: number; // seconds of the first beat on the grid (0 <= offset < spb)
  confidence: number; // 0..1, phase-alignment strength
  beats: number[]; // seconds
  downbeats?: number[];
  method: string;
}

const SR = 22050;
const HOP = 256;
const WIN = 1024;

function decode(file: string): Float32Array {
  const r = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-ac", "1", "-ar", String(SR), "-f", "f32le", "-"], { maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new VosError("decode_failed", `ffmpeg could not decode ${file}: ${String(r.stderr).slice(-300)}`);
  const b = r.stdout as Buffer;
  return new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4));
}

function fftMag(frame: Float32Array): Float32Array {
  const n = frame.length;
  const re = Float32Array.from(frame);
  const im = new Float32Array(n);
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
  const mag = new Float32Array(n / 2);
  for (let i = 0; i < n / 2; i++) mag[i] = Math.log1p(Math.hypot(re[i], im[i]));
  return mag;
}

/** Spectral-flux onset envelope, one value per hop. */
export function onsetEnvelope(x: Float32Array): Float32Array {
  const frames = Math.max(0, Math.floor((x.length - WIN) / HOP));
  const env = new Float32Array(frames);
  const hann = new Float32Array(WIN).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / WIN));
  let prev: Float32Array | null = null;
  const buf = new Float32Array(WIN);
  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < WIN; i++) buf[i] = x[f * HOP + i] * hann[i];
    const mag = fftMag(buf);
    if (prev) {
      let s = 0;
      for (let k = 0; k < mag.length; k++) {
        const d = mag[k] - prev[k];
        if (d > 0) s += d;
      }
      env[f] = s;
    }
    prev = mag;
  }
  // remove slow trend
  const out = new Float32Array(frames);
  const w = 16;
  for (let i = 0; i < frames; i++) {
    let m = 0, c = 0;
    for (let j = Math.max(0, i - w); j < Math.min(frames, i + w); j++) { m += env[j]; c++; }
    out[i] = Math.max(0, env[i] - m / c);
  }
  return out;
}

export function analyzeBeats(file: string, opts: { minBpm?: number; maxBpm?: number; hint?: number } = {}): BeatAnalysis {
  const x = decode(file);
  const env = onsetEnvelope(x);
  const fr = SR / HOP; // envelope frames per second
  const minB = opts.minBpm ?? 70, maxB = opts.maxBpm ?? 180;
  // tempo by autocorrelation with a log-normal prior around the hint (or 120)
  const center = opts.hint ?? 120;
  let best = { bpm: center, score: -Infinity };
  for (let bpm10 = minB * 10; bpm10 <= maxB * 10; bpm10++) {
    const bpm = bpm10 / 10;
    const lag = (60 / bpm) * fr;
    const l0 = Math.floor(lag), a = lag - l0;
    let s = 0;
    for (let i = 0; i + l0 + 1 < env.length; i++) s += env[i] * (env[i + l0] * (1 - a) + env[i + l0 + 1] * a);
    const prior = Math.exp(-0.5 * (Math.log2(bpm / center) / 0.6) ** 2);
    const score = s * prior;
    if (score > best.score) best = { bpm, score };
  }
  // refine tempo: the autocorrelation peak is coarse over long files; maximise beat-aligned
  // onset strength over a fine grid (0.01 BPM) with a free phase.
  const phaseScore = (b: number) => {
    const sp = 60 / b;
    let bestV = -Infinity;
    for (let k = 0; k < 64; k++) {
      const off = (k / 64) * sp;
      let s = 0, c = 0;
      for (let t = off; t * fr < env.length - 1; t += sp) { s += env[Math.round(t * fr)]; c++; }
      if (c && s / c > bestV) bestV = s / c;
    }
    return bestV;
  };
  let bpm = best.bpm, bestPS = phaseScore(bpm);
  // ±3% catches neighbouring autocorrelation peaks without reaching half/double tempo
  const lo = best.bpm * 0.97, hi = best.bpm * 1.03;
  for (let b = lo; b <= hi + 1e-9; b += 0.01) {
    const v = phaseScore(b);
    if (v > bestPS + 1e-9) { bestPS = v; bpm = b; }
  }
  bpm = Math.round(bpm * 100) / 100;
  const spb = 60 / bpm;
  // phase: try offsets across one beat; score = mean envelope at beat positions
  const steps = 200;
  let phase = { off: 0, score: -Infinity };
  let total = 0;
  const scores: number[] = [];
  for (let k = 0; k < steps; k++) {
    const off = (k / steps) * spb;
    let s = 0, c = 0;
    for (let t = off; t * fr < env.length - 1; t += spb) { s += env[Math.round(t * fr)]; c++; }
    const v = c ? s / c : 0;
    scores.push(v);
    total += v;
    if (v > phase.score) phase = { off, score: v };
  }
  const mean = total / steps;
  const confidence = Math.max(0, Math.min(1, (phase.score - mean) / (phase.score + 1e-9)));
  // latency compensation: envelope index f is the *start* of its analysis window, so an attack
  // at time T peaks when the window is centred on it, i.e. at index time T - WIN/2.
  let offset = phase.off + WIN / 2 / SR;
  offset = ((offset % spb) + spb) % spb;
  if (offset > spb - 0.015 || offset < 0.004) offset = 0; // within ~1 hop of the grid origin
  const duration = x.length / SR;
  const beats: number[] = [];
  for (let t = offset; t < duration; t += spb) beats.push(Math.round(t * 1000) / 1000);
  return { format: "vos.beats/1", bpm, offset: Math.round(offset * 1000) / 1000, confidence: Math.round(confidence * 100) / 100, beats, method: "spectral-flux autocorr + phase scan (vos v0.1)" };
}
