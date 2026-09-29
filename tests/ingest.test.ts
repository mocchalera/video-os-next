import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { ingest } from "../src/core/project.ts";
import { fixtureProject } from "./helpers.ts";

const tone = (file: string, hz: number) =>
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `sine=frequency=${hz}:duration=1`, file]);

test("--replace without --as rebinds the alias of a file rewritten in place", () => {
  const p = fixtureProject();
  const f = path.join(p.root, "media", "stem.wav");
  tone(f, 220);
  const first = ingest(p, f, "snd");
  tone(f, 330);
  const again = ingest(p, f, undefined, undefined, true);
  assert.equal(again.alias, "snd");
  assert.equal(again.status, "replaced");
  assert.notEqual(again.id, first.id);
  assert.deepEqual(p.assets.assets.snd.replaced, [first.id]);
  assert.equal(Object.keys(p.assets.assets).filter((k) => k.startsWith("stem")).length, 0);
});

test("without --replace a rewritten file still gets a new alias", () => {
  const p = fixtureProject();
  const f = path.join(p.root, "media", "stem.wav");
  tone(f, 220);
  ingest(p, f, "snd");
  tone(f, 330);
  const again = ingest(p, f);
  assert.equal(again.alias, "stem");
  assert.equal(again.status, "added");
});
