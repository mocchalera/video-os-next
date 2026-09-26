import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadProject } from "../src/core/project.ts";
import { resolveTimeline, loadTimeline } from "../src/core/timeline.ts";
import { failureCause, passthroughSource, render, renderHeapMb } from "../src/render/render.ts";
import { fixtureProject, writeTimeline, baseTimeline } from "./helpers.ts";

const oneClip = () => ({
  format: "vos.timeline/1",
  name: "pass",
  canvas: { width: 320, height: 180, fps: 30 },
  duration: 4,
  tracks: [
    { id: "V1", kind: "video", clips: [{ id: "pic", asset: "clip", at: 0, dur: 4 }] },
    { id: "A1", kind: "audio", clips: [{ id: "m", asset: "tone", at: 0, dur: 4 }] },
  ],
});

const resolved = (root: string) => {
  const p = loadProject(root);
  return resolveTimeline(p, loadTimeline(path.join(root, "timeline.json")));
};

test("failureCause: the heap-OOM line survives native stack frames and progress bars", () => {
  const log = [
    "[INFO] [Render] Pipeline started {}",
    "  █████░░░░░░  20%  Capturing frames",
    "<--- Last few GCs --->",
    "[1:0x1]   609945 ms: Mark-Compact 4096.4 (4106.0) -> 4096.3 (4109.0) MB, allocation failure; scavenge might not succeed",
    "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory",
    "----- Native stack trace -----",
    ...Array.from({ length: 40 }, (_, i) => ` ${i}: 0x104c21abc node::Something [/usr/local/bin/node]`),
  ].join("\n");
  const c = failureCause(log);
  assert.equal(c.oom, true);
  assert.ok(c.lines.some((l) => l.startsWith("FATAL ERROR")), c.lines.join("\n"));
  assert.ok(!c.lines.some((l) => /0x104c21abc/.test(l)), "no stack frames");
});

test("renderHeapMb: half the RAM, clamped to 4–16 GB; VOS_RENDER_HEAP_MB overrides", () => {
  assert.equal(renderHeapMb({}, 32 * 2 ** 30), 16384);
  assert.equal(renderHeapMb({}, 64 * 2 ** 30), 16384);
  assert.equal(renderHeapMb({}, 4 * 2 ** 30), 4096);
  assert.equal(renderHeapMb({ VOS_RENDER_HEAP_MB: "24000" }, 32 * 2 ** 30), 24000);
});

test("passthrough applies only to one full-frame video at canvas size/fps", () => {
  const p = fixtureProject();
  writeTimeline(p, oneClip());
  const ok = passthroughSource(resolved(p.root));
  assert.equal(ok.ok, true);
  assert.equal(ok.ok && ok.copy, true, "in=0 h264/yuv420p is stream-copied");

  const trimmed = oneClip(); trimmed.tracks[0].clips[0] = { ...trimmed.tracks[0].clips[0], at: 0, dur: 3 } as any;
  trimmed.duration = 3; (trimmed.tracks[1].clips[0] as any).dur = 3; (trimmed.tracks[0].clips[0] as any).in = 0.5;
  writeTimeline(p, trimmed);
  const re = passthroughSource(resolved(p.root));
  assert.equal(re.ok && re.copy, false, "a non-zero in-point is re-encoded");

  const big = oneClip(); big.canvas = { width: 640, height: 360, fps: 30 };
  writeTimeline(p, big);
  assert.match((passthroughSource(resolved(p.root)) as any).reason, /canvas is 640x360/);

  writeTimeline(p, baseTimeline());
  assert.equal(passthroughSource(resolved(p.root)).ok, false, "graphics need the browser");
});

test("render: a single full-frame video is copied frame-exact, mixed, and receipted", () => {
  const p = fixtureProject();
  writeTimeline(p, oneClip());
  const r = render(loadProject(p.root), { quiet: true });
  assert.equal(r.engine, "ffmpeg-passthrough");
  assert.equal(r.receipt.settings.engine, "ffmpeg-passthrough");
  assert.ok(Math.abs(r.receipt.output_duration - 4) < 0.05, String(r.receipt.output_duration));
  assert.ok(r.receipt.audio, "the mix is attached");
  const md5 = (f: string) => execFileSync("ffmpeg", ["-v", "error", "-i", f, "-map", "0:v", "-f", "framemd5", "-"], { encoding: "utf8" })
    .split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.split(",").pop()!.trim());
  assert.deepEqual(md5(r.output), md5(path.join(p.root, "media", "clip.mp4")), "every picture frame is identical to the source");
});

test("render: a HyperFrames crash reports the cause, not the stack trace, and keeps the full log", () => {
  const p = fixtureProject();
  writeTimeline(p, baseTimeline());
  const fake = path.join(p.root, "fake-hf.sh");
  fs.writeFileSync(fake, [
    "#!/bin/bash",
    'if [ "$1" = "lint" ]; then echo \'{"findings":[]}\'; exit 0; fi',
    'if [ "$1" = "--version" ]; then echo 0.0.0; exit 0; fi',
    'echo "progress on stdout"',
    'echo "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory" >&2',
    'for i in $(seq 1 30); do echo " $i: 0xdeadbeef node::Frame" >&2; done',
    'echo "heap=$NODE_OPTIONS" >&2',
    "exit 134",
  ].join("\n"), { mode: 0o755 });
  const prev = process.env.VOS_HYPERFRAMES_BIN;
  process.env.VOS_HYPERFRAMES_BIN = fake;
  try {
    assert.throws(() => render(loadProject(p.root), { quiet: true }), (e: any) => {
      assert.equal(e.code, "render_failed");
      assert.match(e.message, /exit 134/);
      assert.match(e.message, /out of JavaScript heap/);
      assert.match(e.message, /FATAL ERROR/);
      assert.doesNotMatch(e.message, /0xdeadbeef/);
      assert.match(e.hint, /VOS_RENDER_HEAP_MB=/);
      const log = e.hint.match(/full log: (.+)$/)[1];
      assert.match(fs.readFileSync(log, "utf8"), /heap=.*--max-old-space-size=\d+/, "the child gets the raised heap");
      return true;
    });
  } finally {
    if (prev === undefined) delete process.env.VOS_HYPERFRAMES_BIN; else process.env.VOS_HYPERFRAMES_BIN = prev;
  }
});
