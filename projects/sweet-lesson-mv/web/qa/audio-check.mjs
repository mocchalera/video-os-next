// The viewer's sounds against the song (BRIEF §2: "a floor's small sound", "at least 15 dB under the song").
//   node web/qa/audio-check.mjs      → numbers + web/review/m2/footsteps-mix.wav (30 s of the song, 1:50–2:20, with steps at 1.1 m/s and the Esc click at 134.38)
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { synthStep, synthEsc, dbToGain, STEP_PEAK_DBFS, STEP_PEAK_QUIET_DBFS, ESC_PEAK_DBFS } from "../walk/sfx.js";
const root = new URL("../../", import.meta.url).pathname, SR = 48000;
const raw = execFileSync("ffmpeg", ["-v", "error", "-i", root + "refs/Sweet Lesson.mp3", "-vn", "-f", "f32le", "-ac", "2", "-ar", String(SR), "-"], { maxBuffer: 1 << 30 });
const song = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4); // interleaved stereo
const db = (x) => 20 * Math.log10(Math.max(x, 1e-12));
let ss = 0, pk = 0; for (let i = 0; i < song.length; i++) { ss += song[i] * song[i]; pk = Math.max(pk, Math.abs(song[i])); }
const songRms = Math.sqrt(ss / song.length), songRmsDb = db(songRms), songPkDb = db(pk);
// the same figure ffmpeg's volumedetect gives (mean_volume −17.9), over the whole file
const stepBufs = [0, 1, 2, 3].map((v) => synthStep(SR, v)), esc = synthEsc(SR);
const stat = (a, gDb) => { const g = dbToGain(gDb); let s = 0, p = 0; for (const x of a) { s += (x * g) ** 2; p = Math.max(p, Math.abs(x * g)); } return { peakDb: db(p), rmsDb: db(Math.sqrt(s / a.length)), ms: (a.length / SR) * 1000 }; };
const rows = stepBufs.map((b, i) => ({ variant: i, ...stat(b, STEP_PEAK_DBFS) }));
const r1 = (x) => Math.round(x * 10) / 10;
const res = {
  song: { mean_volume_rms_dBFS: r1(songRmsDb), peak_dBFS: r1(songPkDb) },
  step_with_song: { peak_dBFS: STEP_PEAK_DBFS, below_song_rms_dB: r1(songRmsDb - STEP_PEAK_DBFS) * -1, below_song_peak_dB: r1(STEP_PEAK_DBFS - songPkDb) * -1, per_variant_rms_dBFS: rows.map((r) => r1(r.rmsDb)), duration_ms: r1(rows[0].ms) },
  step_epilogue_no_song: { peak_dBFS: STEP_PEAK_QUIET_DBFS },
  esc_click: { peak_dBFS: ESC_PEAK_DBFS, below_song_rms_dB: r1(-(ESC_PEAK_DBFS - songRmsDb)), duration_ms: r1((esc.length / SR) * 1000) },
};
res.step_with_song.below_song_rms_dB = r1(STEP_PEAK_DBFS - songRmsDb) * -1; // positive = how far below
res.step_with_song.below_song_peak_dB = r1(STEP_PEAK_DBFS - songPkDb) * -1;
res.esc_click.below_song_rms_dB = r1(ESC_PEAK_DBFS - songRmsDb) * -1;
res.requirement = { "≥15 dB under the song (RMS) for steps": res.step_with_song.below_song_rms_dB >= 15 };
// the mix: 30 s of the song with steps every 0.62 m at 1.1 m/s (1.77 Hz) from 5 s, stopping at 20 s, and the Esc at 134.38
const T0 = 110, LEN = 30, N = LEN * SR, mix = new Float32Array(N * 2);
for (let i = 0; i < N * 2; i++) mix[i] = song[T0 * SR * 2 + i];
const put = (buf, atS, peakDb, pan) => { const g = dbToGain(peakDb), i0 = Math.round(atS * SR); for (let k = 0; k < buf.length && i0 + k < N; k++) { const v = buf[k] * g; mix[(i0 + k) * 2] += v * (1 - Math.max(0, pan)); mix[(i0 + k) * 2 + 1] += v * (1 + Math.min(0, pan)); } };
let n = 0; for (let t = 5; t < 20; t += 0.62 / 1.1) { put(stepBufs[(n * 7 + (n >> 2)) % 4], t, STEP_PEAK_DBFS + Math.sin(n * 12.9898) * 1.2, n % 2 ? 0.12 : -0.12); n++; }
put(esc, 134.38 - T0, ESC_PEAK_DBFS, 0);
// measured on the mix: the energy of what was added, against the song, over the 5–20 s walk
let sa = 0, sb = 0; for (let i = 5 * SR; i < 20 * SR; i++) { const a = song[(T0 * SR + i) * 2], b = mix[i * 2] - a; sa += a * a; sb += b * b; }
res.walking_mix_5_20s = { steps: n, song_rms_dBFS: r1(db(Math.sqrt(sa / (15 * SR)))), added_steps_rms_dBFS: r1(db(Math.sqrt(sb / (15 * SR)))), steps_under_song_dB: r1(db(Math.sqrt(sa / (15 * SR))) - db(Math.sqrt(sb / (15 * SR)))) };
// wav out (16 bit)
const pcm = Buffer.alloc(N * 4); for (let i = 0; i < N * 2; i++) pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(mix[i] * 32767))), i * 2);
const h = Buffer.alloc(44); h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVEfmt ", 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22); h.writeUInt32LE(SR, 24); h.writeUInt32LE(SR * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
fs.mkdirSync(root + "web/review/m2", { recursive: true }); fs.writeFileSync(root + "web/review/m2/footsteps-mix.wav", Buffer.concat([h, pcm]));
fs.writeFileSync(root + "web/review/m2/audio-levels.json", JSON.stringify(res, null, 1)); console.log(JSON.stringify(res, null, 1));
