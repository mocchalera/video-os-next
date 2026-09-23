import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { analyzeBeats } from "../src/analyze/beats.ts";

/** Write a mono 16-bit wav of decaying clicks at a known tempo and phase. */
function clickTrack(bpm: number, offset: number, seconds: number): string {
  const sr = 22050, n = Math.floor(sr * seconds);
  const pcm = new Int16Array(n);
  for (let t = offset; t < seconds; t += 60 / bpm) {
    const s = Math.round(t * sr);
    for (let i = 0; i < 1500 && s + i < n; i++) pcm[s + i] += Math.round(12000 * Math.exp(-i / 180) * Math.sin(i * 0.9));
  }
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
  Buffer.from(pcm.buffer).copy(buf, 44);
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "vos-beats-")), "click.wav");
  fs.writeFileSync(f, buf);
  return f;
}

for (const [bpm, offset] of [[120, 0], [96, 0.21], [138, 0.1]] as const) {
  test(`recovers ${bpm} BPM @ ${offset}s`, () => {
    const r = analyzeBeats(clickTrack(bpm, offset, 30));
    assert.ok(Math.abs(r.bpm - bpm) <= 0.05, `bpm ${r.bpm}`);
    const spb = 60 / bpm;
    const d = Math.abs(((r.offset - offset + spb / 2) % spb + spb) % spb - spb / 2);
    assert.ok(d <= 0.015, `offset ${r.offset} vs ${offset}`);
    assert.ok(r.confidence > 0.5);
  });
}
