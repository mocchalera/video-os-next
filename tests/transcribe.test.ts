import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { asrPython, readTranscript, transcribe } from "../src/analyze/transcribe.ts";
import { compile } from "../src/compile/hyperframes.ts";
import { ingest, loadProject, saveAssets } from "../src/core/project.ts";
import { which } from "../src/core/util.ts";
import { fixtureProject, writeTimeline } from "./helpers.ts";

test("transcribe: Japanese speech → segments + word times, vocabulary bias, cached; bindable as $transcript", async (t) => {
  if (!asrPython() || !which("say")) return t.skip("needs a local faster-whisper and macOS `say`");
  const p = fixtureProject();
  const m = path.join(p.root, "media");
  execFileSync("say", ["-v", "Kyoko", "雨の夜、紙の船がゆっくり流れていきます。", "-o", path.join(m, "n.aiff")]);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", path.join(m, "n.aiff"), path.join(m, "n.wav")]);
  const q = loadProject(p.root);
  ingest(q, path.join(m, "n.wav"), "narr");
  saveAssets(q);
  const r = transcribe(loadProject(p.root), "narr", { vocab: "紙の船" });
  assert.equal(r.status, "built");
  assert.equal(r.record.language, "ja");
  const text = r.record.segments.map((s) => s.text).join("");
  assert.match(text, /紙の船/, text);
  const words = r.record.segments.flatMap((s) => s.words);
  assert.ok(words.length >= 5 && words.every((w, i) => i === 0 || w.start >= words[i - 1].start), "word times ascend");
  assert.equal(transcribe(loadProject(p.root), "narr", { vocab: "紙の船" }).status, "fresh");
  assert.throws(() => transcribe(loadProject(p.root), "still"), /no audio/);

  fs.writeFileSync(path.join(p.root, "graphics", "cap.html"), `<div class="c"></div><script>vos.graphic(({ props }) => {});</script>`);
  writeTimeline(p, { format: "vos.timeline/1", name: "c", canvas: { width: 320, height: 180, fps: 24 }, duration: 3,
    tracks: [{ id: "G", kind: "graphics", clips: [{ id: "cap", src: "graphics/cap.html", at: 0, dur: 3, props: { t: { $transcript: "narr" } } }] }] });
  const c = compile(loadProject(p.root));
  assert.ok(Object.keys(c.inputs.design).some((k) => k === "transcript:narr"), "the transcript is a recorded input of the page");
  assert.match(fs.readFileSync(path.join(c.buildDir, "index.html"), "utf8"), /"vos\.transcript\/1"/);
  assert.ok(readTranscript(loadProject(p.root), loadProject(p.root).assets.assets.narr.id));
});

test("$transcript without a transcript fails with the command to run", () => {
  const p = fixtureProject();
  fs.writeFileSync(path.join(p.root, "graphics", "cap.html"), `<div></div><script>vos.graphic(() => {});</script>`);
  writeTimeline(p, { format: "vos.timeline/1", name: "c", canvas: { width: 320, height: 180, fps: 24 }, duration: 2,
    tracks: [{ id: "G", kind: "graphics", clips: [{ id: "cap", src: "graphics/cap.html", at: 0, dur: 2, props: { t: { $transcript: "tone" } } }] }] });
  assert.throws(() => compile(loadProject(p.root)), (e: any) => e.code === "missing_analysis" && /vos transcribe tone/.test(e.hint));
});
