import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { writeJson } from "../src/core/util.ts";
import { P, loadProject } from "../src/core/project.ts";
import { find, indexAsset, readIndex } from "../src/analyze/embed.ts";
import { fixtureProject } from "./helpers.ts";

process.env.VOS_EMBED_MOCK = "1"; // deterministic vectors; no model needed

const p0 = fixtureProject();
const clip = p0.assets.assets.clip;
writeJson(path.join(P.analysis(p0.root, clip.id), "describe.json"), {
  format: "vos.describe/1", asset: clip.id, scene: "a colourful test pattern",
  events: [{ start: 0, end: 2, description: "red bicycle wheel spinning" }, { start: 2, end: 4, description: "woman looks up at the sky" }],
  finds: [], provenance: { producer: "test", model: "none", at: "2026-01-01" },
});
const p = loadProject(p0.root);

test("text index: one window per description, rebuilt only when descriptions change", () => {
  assert.equal(indexAsset(p, "clip", "text").status, "built");
  assert.equal(indexAsset(p, "clip", "text").status, "fresh");
  const idx = readIndex(p, clip.id, "text")!;
  assert.equal(idx.meta.windows.length, 3);
  assert.equal(idx.rows[0].length, 64);
});

test("visual index samples frames on the requested step; images get one window", () => {
  const r = indexAsset(p, "clip", "visual", { step: 1 });
  assert.equal(r.status, "built");
  const idx = readIndex(p, clip.id, "visual")!;
  assert.ok(idx.meta.windows.length >= 4 && idx.meta.windows.length <= 5, `${idx.meta.windows.length} windows`);
  assert.equal(idx.meta.windows[1].start, 0.5);
  assert.equal(indexAsset(p, "still", "visual").windows, 1);
  assert.equal(indexAsset(p, "clip", "visual", { step: 2 }).status, "built", "changing the step rebuilds");
});

test("audio index skips silent-less assets and windows the rest", () => {
  assert.equal(indexAsset(p, "still", "audio").status, "skipped");
  const r = indexAsset(p, "tone", "audio");
  assert.equal(r.status, "built");
  assert.equal(r.windows, 2); // 4 s tone, 5 s window, 2.5 s hop
});

test("find fuses channels + lexical, merges overlapping spans, reports what it used", () => {
  const r = find(p, "woman looks up at the sky", { limit: 5 });
  assert.deepEqual([...r.channels_used].sort(), ["audio", "text", "visual"]);
  const top = r.hits[0];
  assert.equal(top.alias, "clip");
  assert.ok(top.channels.text !== undefined && top.channels.lexical !== undefined, JSON.stringify(top));
  assert.ok(top.start <= 2 && top.end >= 4, `top span ${top.start}-${top.end} should cover the matching event`);
  const again = find(p, "woman looks up at the sky", { limit: 5 });
  assert.deepEqual(again, r, "deterministic");
});

test("find restricted to a channel without an index says why", () => {
  const empty = fixtureProject();
  const r = find(empty, "anything", { channels: ["visual"] });
  assert.equal(r.hits.length, 0);
  assert.match(r.channels_unavailable[0].reason, /vos index/);
});
