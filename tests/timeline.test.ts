import { test } from "node:test";
import assert from "node:assert/strict";
import { loadTimeline, resolveTimeline, cutPoints } from "../src/core/timeline.ts";
import { fixtureProject, writeTimeline, baseTimeline } from "./helpers.ts";
import * as path from "node:path";

const p = fixtureProject();
const resolve = (doc: any) => {
  writeTimeline(p, doc);
  return resolveTimeline(p, loadTimeline(path.join(p.root, "timeline.json")));
};

test("resolves to frames with assets, slots and gain", () => {
  const r = resolve(baseTimeline());
  assert.equal(r.frames, 120);
  const a = r.media.find((m) => m.id === "a")!;
  assert.equal(a.start, 0);
  assert.equal(a.frames, 60);
  assert.equal(a.srcIn, 0.5);
  const w = r.media.find((m) => m.id === "w")!;
  assert.deepEqual(w.slot, { clip: "title", name: "win" });
  const music = r.media.find((m) => m.id === "music")!;
  assert.ok(Math.abs(music.gain - 0.501) < 0.001);
  assert.deepEqual(cutPoints(r), [15, 60]);
});

test("source overrun is an error with a concrete fix", () => {
  const d: any = baseTimeline();
  d.tracks[0].clips[0].in = 2; // 2s + 2s = 4s is fine
  d.tracks[0].clips[0].dur = "5b"; // 2 + 2.5 = 4.5 > 4
  assert.throws(() => resolve(d), (e: any) => /is 4\.000s long/.test(e.message) && /move "in" back/.test(e.hint));
});

test("unknown asset lists known aliases", () => {
  const d: any = baseTimeline();
  d.tracks[0].clips[0].asset = "nope";
  assert.throws(() => resolve(d), (e: any) => e.code === "unknown_asset" && /clip/.test(e.hint));
});

test("slot must exist in the graphic and lie inside it in time", () => {
  const d: any = baseTimeline();
  d.tracks[2].clips[0].slot = "title/missing";
  assert.throws(() => resolve(d), /no element with data-slot="missing"/);
  const d2: any = baseTimeline();
  d2.tracks[2].clips[0].at = 0;
  assert.throws(() => resolve(d2), /must lie inside graphics clip/);
});

test("duplicate clip ids are rejected", () => {
  const d: any = baseTimeline();
  d.tracks[0].clips[1].id = "a";
  assert.throws(() => resolve(d), /duplicate clip id/);
});

test("cadence: 24 fps footage on a 30 fps canvas warns; clean ratios do not", async () => {
  const { cadenceMismatch } = await import("../src/core/timeline.ts");
  assert.equal(cadenceMismatch(24, 30), true);
  assert.equal(cadenceMismatch(23.976, 30), true);
  assert.equal(cadenceMismatch(24, 24), false);
  assert.equal(cadenceMismatch(30, 60), false);
  assert.equal(cadenceMismatch(60, 30), false);
  assert.equal(cadenceMismatch(29.97, 30), false);
});
