import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ingest, loadProject, saveAssets } from "../src/core/project.ts";
import { loadTimeline, resolveTimeline } from "../src/core/timeline.ts";
import { duckExpr, mixAudio } from "../src/render/mix.ts";
import { fixtureProject, writeTimeline } from "./helpers.ts";

const ff = (args: string[]) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args]);

/** RMS level (dBFS) of a segment of a wav. */
function rmsOf(wav: string, from: number, dur: number): number {
  try {
    const r = execFileSync("sh", ["-c", `ffmpeg -v info -ss ${from} -t ${dur} -i '${wav}' -af astats=measure_overall=RMS_level:measure_perchannel=0 -f null - 2>&1`]).toString();
    return Number(/RMS level dB:\s*(-?[\d.]+)/.exec(r)?.[1]);
  } catch {
    return NaN;
  }
}
function lufs(wav: string): number {
  const r = execFileSync("sh", ["-c", `ffmpeg -v info -i '${wav}' -af ebur128 -f null - 2>&1`]).toString();
  return Number(/I:\s+(-?[\d.]+) LUFS/.exec(r.split("Summary:").pop() ?? "")?.[1]);
}

function project() {
  const p = fixtureProject();
  const m = path.join(p.root, "media");
  ff(["-f", "lavfi", "-i", "sine=frequency=220:duration=4:sample_rate=48000", "-af", "volume=-20dB", path.join(m, "music.wav")]);
  ff(["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", "4", path.join(m, "silence.wav")]);
  const q = loadProject(p.root);
  ingest(q, path.join(m, "music.wav"), "music");
  ingest(q, path.join(m, "silence.wav"), "voice");
  saveAssets(q);
  return loadProject(p.root);
}

const tl = (extra: any = {}, musicGain = 0) => ({
  format: "vos.timeline/1", name: "mix", canvas: { width: 320, height: 180, fps: 24 }, duration: 4,
  tracks: [
    { id: "M", kind: "audio", clips: [{ id: "m", asset: "music", at: 0, dur: 4, gain_db: musicGain }], ...(extra.duck ? { duck: extra.duck } : {}) },
    { id: "V", kind: "audio", clips: [{ id: "v", asset: "voice", at: 1.5, dur: 1 }] },
  ],
  ...(extra.master ? { master: extra.master } : {}),
});

function mix(p: any, doc: any): string {
  writeTimeline(p, doc);
  const r = resolveTimeline(p, loadTimeline(path.join(p.root, "timeline.json")));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vos-mix-"));
  const out = path.join(dir, "mix.wav");
  mixAudio(r, out, dir);
  return out;
}

test("gain above 0 dB is applied by the vos mixer (the browser could not)", () => {
  const p = project();
  const a = mix(p, tl({ master: { loudness: null } }, 0));
  const b = mix(p, tl({ master: { loudness: null } }, 6));
  assert.ok(Math.abs(rmsOf(b, 0.2, 1) - rmsOf(a, 0.2, 1) - 6) < 0.3, `${rmsOf(a, 0.2, 1)} → ${rmsOf(b, 0.2, 1)}`);
});

test("ducking dips the music by the declared dB while the other track's clip plays, and recovers after", () => {
  const p = project();
  const w = mix(p, tl({ master: { loudness: null }, duck: { by: "V", db: -12, attack: 0.2, release: 0.3 } }));
  const outside = rmsOf(w, 0.2, 0.8);
  const inside = rmsOf(w, 1.7, 0.6);
  const after = rmsOf(w, 3.2, 0.6);
  assert.ok(Math.abs(inside - outside + 12) < 0.5, `inside ${inside} vs outside ${outside}`);
  assert.ok(Math.abs(after - outside) < 0.3, "recovers after release");
});

test("master loudness: normalised to the target LUFS; null leaves the level alone", () => {
  const p = project();
  assert.ok(Math.abs(lufs(mix(p, tl({ master: { loudness: -14 } }))) + 14) < 1);
  assert.ok(lufs(mix(p, tl({ master: { loudness: null } }))) < -20);
});

test("duck expression and validation", () => {
  assert.equal(duckExpr([[1, 2]], -12, 0.25, 0.5), "1-0.749*clip(min((t-0.75)/0.25,(2.5-t)/0.5),0,1)");
  const p = project();
  writeTimeline(p, tl({ duck: { by: "nope" } }));
  assert.throws(() => resolveTimeline(p, loadTimeline(path.join(p.root, "timeline.json"))), /must name another track/);
  writeTimeline(p, { ...tl(), tracks: [{ ...tl().tracks[0], clips: [{ id: "m", asset: "music", at: 0, dur: 4, gain_db: 30 }] }] });
  assert.throws(() => resolveTimeline(p, loadTimeline(path.join(p.root, "timeline.json"))), /<= \+24 dB/);
});
