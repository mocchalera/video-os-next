import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { loadProject } from "../src/core/project.ts";
import { buildRequest, clip, down, genPaths, parseSize, pull, status, up } from "../src/gen/colab.ts";
import { listLibrary } from "../src/gen/library.ts";
import { fixtureProject } from "./helpers.ts";

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-colab.mjs");
fs.chmodSync(FAKE, 0o755);
process.env.VOS_COLAB_GUARD = FAKE;
process.env.VOS_COLAB_BIN = FAKE;
process.env.VOS_GEN_LIBRARY = ""; // never touch the real (Drive) library from tests

function freshVm(): string {
  const vm = fs.mkdtempSync(path.join(os.tmpdir(), "vos-fakevm-"));
  const clipFile = path.join(vm, "fixture.mp4");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=2", "-f", "lavfi", "-i", "sine=duration=2",
    "-shortest", "-pix_fmt", "yuv420p", clipFile]);
  process.env.FAKE_VM = vm;
  process.env.FAKE_CLIP = clipFile;
  delete process.env.FAKE_JOB_FAIL;
  delete process.env.FAKE_BOOT_FAIL;
  delete process.env.FAKE_NEVER_STARTS;
  return vm;
}
const fakeState = (vm: string) => JSON.parse(fs.readFileSync(path.join(vm, "state.json"), "utf8"));

test("request id is stable, content-addressed, and changes with anything that changes the pixels", () => {
  const a = buildRequest({ prompt: "  a cyclist in the rain " });
  assert.equal(a.id, buildRequest({ prompt: "a cyclist in the rain" }).id, "whitespace-trimmed");
  assert.notEqual(a.id, buildRequest({ prompt: "a cyclist in the rain", seed: 2 }).id);
  assert.notEqual(a.id, buildRequest({ prompt: "a cyclist in the rain", dense: true }).id);
  assert.equal(a.sol_tau, 1.3);
  assert.deepEqual([a.width, a.height, a.seconds, a.steps], [1344, 768, 5, 6]);
  assert.deepEqual(parseSize("draft"), [864, 480]);
  assert.deepEqual(parseSize("640x384"), [640, 384]);
  assert.throws(() => parseSize("650x384"), /multiples of 32/);
  assert.throws(() => buildRequest({ prompt: "" }), /--prompt/);
  assert.throws(() => buildRequest({ prompt: "x", seconds: 30 }), /seconds/);
});

test("up refuses without a budget; clip refuses without a session", () => {
  freshVm();
  assert.throws(() => up({ budgetCu: NaN }), /--budget-cu/);
  const p = fixtureProject();
  assert.throws(() => clip(p, { prompt: "x" }), (e: any) => e.code === "gen_not_up" && /budget/.test(e.hint));
});

test("clip: generates on the VM, downloads, writes provenance, ingests; second call is a cache hit with no GPU", () => {
  const vm = freshVm();
  const r0 = up({ budgetCu: 8 });
  assert.equal(r0.bootstrap, "started");
  assert.ok(fakeState(vm).calls.some((c: string) => c.startsWith("start vos-gen --gpu A100 --budget-cu 8")));

  const p = fixtureProject();
  const r = clip(p, { prompt: "a cyclist in the rain", size: "draft", seconds: 2, as: "rain_insert" });
  assert.equal(r.cached, false);
  assert.equal(r.library, null, "no library configured in tests unless asked");
  assert.equal(r.alias, "rain_insert");
  assert.equal(r.status, "added");

  const { media, sidecar } = genPaths(p, r.request_id);
  assert.ok(fs.existsSync(media));
  const gen = JSON.parse(fs.readFileSync(sidecar, "utf8"));
  assert.equal(gen.format, "vos.gen/1");
  assert.equal(gen.request.prompt, "a cyclist in the rain");
  assert.equal(gen.ran.gpu, "NVIDIA A100-SXM4-40GB");
  assert.equal(gen.ran.est_cu, 0.12);
  assert.ok(!JSON.stringify(gen).includes(p.root), "no absolute local paths in the portable sidecar");

  const reloaded = loadProject(p.root);
  const rec = reloaded.assets.assets.rain_insert;
  assert.equal(rec.kind, "video");
  assert.match(rec.note ?? "", /generated \(minimax-h3\): a cyclist/);
  assert.ok(!fs.readFileSync(path.join(p.root, "assets.json"), "utf8").includes(p.root), "assets.json stays portable");

  const again = clip(reloaded, { prompt: "a cyclist in the rain", size: "draft", seconds: 2, as: "rain_insert" });
  assert.equal(again.cached, "project");
  assert.equal(again.status, "unchanged");
  assert.equal(fakeState(vm).submitted, 1, "cache hit must not touch the GPU");
  down();
});

test("a failed job surfaces the VM error and ingests nothing", () => {
  freshVm();
  up({ budgetCu: 8 });
  process.env.FAKE_JOB_FAIL = "1";
  const p = fixtureProject();
  assert.throws(() => clip(p, { prompt: "boom", as: "bad" }), (e: any) => e.code === "gen_failed" && /CUDA OOM/.test(e.hint));
  assert.equal(loadProject(p.root).assets.assets.bad, undefined);
  down();
});

test("a job the VM never starts fails fast instead of waiting out the budget", () => {
  freshVm();
  up({ budgetCu: 8 });
  process.env.FAKE_NEVER_STARTS = "1";
  assert.throws(() => clip(fixtureProject(), { prompt: "stuck" }), (e: any) => e.code === "colab_wait" && /start the job/.test(e.message));
  down();
});

test("a wait that ends because the guard stopped the session says so", () => {
  const vm = freshVm();
  up({ budgetCu: 8 });
  process.env.FAKE_NEVER_STARTS = "1";
  const st = JSON.parse(fs.readFileSync(path.join(vm, "state.json"), "utf8"));
  st.sessions["vos-gen"].state = "running";
  fs.writeFileSync(path.join(vm, "state.json"), JSON.stringify(st));
  // simulate the supervisor stopping on budget right after submit
  const orig = process.env.VOS_COLAB_GUARD;
  const shim = path.join(vm, "guard-stops.mjs");
  fs.writeFileSync(shim, `#!/usr/bin/env node
import { execFileSync } from "node:child_process"; import * as fs from "node:fs";
const a = process.argv.slice(2);
if (a[0] === "wait") { const s = JSON.parse(fs.readFileSync(process.env.FAKE_VM + "/state.json","utf8")); s.sessions["vos-gen"].state = "stopped"; s.sessions["vos-gen"].stop_reason = "budget"; fs.writeFileSync(process.env.FAKE_VM + "/state.json", JSON.stringify(s)); process.exit(1); }
try { process.stdout.write(execFileSync(${JSON.stringify(FAKE)}, a)); } catch (e) { process.stdout.write(e.stdout ?? ""); process.exit(e.status ?? 1); }
`);
  fs.chmodSync(shim, 0o755);
  process.env.VOS_COLAB_GUARD = shim;
  try {
    assert.throws(() => clip(fixtureProject(), { prompt: "x" }), (e: any) => e.code === "gen_stopped" && /budget/.test(e.message));
  } finally {
    process.env.VOS_COLAB_GUARD = orig;
  }
});

test("a failed bootstrap is reported, not retried silently", () => {
  freshVm();
  process.env.FAKE_BOOT_FAIL = "1";
  up({ budgetCu: 8 });
  assert.throws(() => clip(fixtureProject(), { prompt: "x" }), (e: any) => e.code === "gen_boot_failed");
  down();
});

test("status reports balance and the guarded session; down stops it", () => {
  freshVm();
  up({ budgetCu: 5 });
  const s = status();
  assert.equal(s.session.state, "running");
  assert.equal(s.boot.state, "ready");
  assert.equal(down().ok, true);
  assert.equal(status().session.state, "stopped");
});

const probeWH = (f: string) => execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", f]).toString().trim();

test("image→video: the frame is cut at the asked time, cropped to the exact size, uploaded, and part of the request", () => {
  const vm = freshVm();
  up({ budgetCu: 8 });
  const p = fixtureProject();
  const r = clip(p, { prompt: "the pattern comes alive", from: "clip@1.5", seconds: 2, size: "draft", as: "alive" });
  const st = fakeState(vm);
  assert.equal(st.last.first_image, `vosgen_${r.request_id}_first.png`);
  assert.deepEqual(st.last.first_frame, { asset: p.assets.assets.clip.id, at: 1.5 });
  assert.equal(probeWH(path.join(vm, "content/ComfyUI/input", st.last.first_image)), "864,480");
  const g = JSON.parse(fs.readFileSync(genPaths(p, r.request_id).sidecar, "utf8"));
  assert.match(g.frames.first.sha256, /^[0-9a-f]{64}$/);
  assert.match(loadProject(p.root).assets.assets.alive.note ?? "", /from clip@1.5/);
  // text→video requests carry no frame keys, so their ids are unchanged by this feature
  assert.equal("first_frame" in buildRequest({ prompt: "x" }), false);
  assert.notEqual(r.request_id, buildRequest({ prompt: "the pattern comes alive", seconds: 2, size: "draft" }).id);
  assert.throws(() => clip(p, { prompt: "x", from: "clip@99" }), /outside the asset/);
  assert.throws(() => clip(p, { prompt: "x", from: "tone" }), /needs a video or image/);
  down();
});

test("library: a take made in one project is reused by another with no GPU; pull by id; half-synced files are ignored", () => {
  const vm = freshVm();
  const lib = fs.mkdtempSync(path.join(os.tmpdir(), "vos-lib-"));
  process.env.VOS_GEN_LIBRARY = lib;
  try {
    up({ budgetCu: 8 });
    const a = fixtureProject();
    const r = clip(a, { prompt: "shared take", size: "draft", seconds: 2, as: "take" });
    assert.equal(r.library, path.join(lib, `${r.request_id}.mp4`));
    const side = JSON.parse(fs.readFileSync(path.join(lib, `${r.request_id}.gen.json`), "utf8"));
    assert.equal(side.file.bytes, fs.statSync(path.join(lib, `${r.request_id}.mp4`)).size);

    const b = fixtureProject();
    const rb = clip(b, { prompt: "shared take", size: "draft", seconds: 2, as: "same_take" });
    assert.equal(rb.cached, "library");
    assert.equal(fakeState(vm).submitted, 1, "library hit must not touch the GPU");
    assert.equal(loadProject(b.root).assets.assets.same_take.id, loadProject(a.root).assets.assets.take.id);

    const listed = listLibrary({ search: "SHARED" });
    assert.equal(listed.entries.length, 1);
    assert.equal(listed.entries[0].id, r.request_id);
    assert.equal(listLibrary({ search: "nothing like this" }).entries.length, 0);

    const c = fixtureProject();
    assert.equal(pull(c, r.request_id, { as: "pulled" }).alias, "pulled");

    // Drive still syncing: truncated media must not be taken as the take
    fs.truncateSync(path.join(lib, `${r.request_id}.mp4`), 100);
    const d = fixtureProject();
    assert.throws(() => pull(d, r.request_id, {}), /no ready take/);
    const rd = clip(d, { prompt: "shared take", size: "draft", seconds: 2 });
    assert.equal(rd.cached, false, "falls back to generating");
    assert.equal(fakeState(vm).submitted, 2);
    down();
  } finally {
    process.env.VOS_GEN_LIBRARY = "";
  }
});

test("H3 prompt format: alignment line is written by vos from --from/--to, with the real last-frame time", async () => {
  const { withAlignment, promptWarnings, framesFor } = await import("../src/gen/colab.ts");
  assert.equal(framesFor(5), 124);
  assert.equal(framesFor(2), 56);
  const body = "integrated_multimodal_description: [Shot 1] a boat. [Shot 2] At 00:02.500, the camera cuts to a drain.\n\noverall_soundscape: rain.\n\nnon_diegetic_music: N/A";
  assert.equal(withAlignment(body, 5, false, false), body, "text→video untouched");
  assert.match(withAlignment(body, 5, true, false), /^For the target video, at 0\.00 seconds into the target video, <Picture 1> \(from \[Shot 1\]\) is fully referenced\.\n\nintegrated_multimodal_description:/);
  assert.match(withAlignment(body, 5, true, true), /Picture 2 \(from Shot 2\) aligns with the 5\.13-second mark/);
  assert.match(withAlignment(body, 5, false, true), /^How the reference pictures align .*<Picture 1> \(from \[Shot 2\]\) aligns with the 5\.13-second mark/);
  const pre = withAlignment(body, 5, true, false);
  assert.equal(withAlignment(pre, 5, true, false), pre, "an existing alignment line is kept, not doubled");
  assert.deepEqual(promptWarnings(body, 5), []);
  assert.match(promptWarnings("a boat in the rain", 5)[0], /free text/);
  assert.match(promptWarnings(body, 2).join(), /beyond the 2s clip/);
});
