import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildRequest, clip, down, FASTH3, genPaths, up } from "../src/gen/colab.ts";
import { loadProject } from "../src/core/project.ts";
import { fixtureProject } from "./helpers.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FAKE = path.join(ROOT, "tests/fixtures/fake-colab.mjs");
process.env.VOS_COLAB_GUARD = FAKE;
process.env.VOS_COLAB_BIN = FAKE;
process.env.VOS_GEN_LIBRARY = "";

const ref = { asset: "a", at: 0 };
const request = () => buildRequest({ model: FASTH3.model, prompt: "same scene", refs: [ref] });
const state = (vm: string) => JSON.parse(fs.readFileSync(path.join(vm, "state.json"), "utf8"));
function fixture() {
  const p = fixtureProject();
  const vm = fs.mkdtempSync(path.join(os.tmpdir(), "vos-fasth3-"));
  process.env.FAKE_VM = vm;
  process.env.FAKE_CLIP = path.join(p.root, "media/clip.mp4");
  delete process.env.FAKE_GEN_BAD_PROVENANCE;
  return { p, vm };
}

test("legacy request IDs remain identical to the pre-FastH3 implementation", () => {
  assert.equal(buildRequest({ prompt: "baseline" }).id, "541aa64d1eeef45a");
  assert.equal(buildRequest({ prompt: "baseline", model: "minimax-h3" }).id, "541aa64d1eeef45a");
  assert.equal(buildRequest({ prompt: "baseline", refs: [ref] }).id, "00159547332d5671");
  assert.equal(buildRequest({ prompt: "baseline", firstFrame: { asset: "a", at: 1 } }).id, "695b35b1ed2ece88");
  assert.equal(buildRequest({ prompt: "baseline", control: { asset: "b", strength: 1, end: 0.8 } }).id, "b48a3b794317050f");
});

test("FastH3 requests isolate the model, pins and sampling recipe in the cache key", () => {
  const a = request();
  assert.equal(a.id, request().id);
  assert.notEqual(a.id, buildRequest({ prompt: a.prompt, refs: [ref] }).id);
  assert.notEqual(a.id, buildRequest({ model: FASTH3.model, prompt: a.prompt, refs: [{ ...ref, at: 1 }] }).id);
  assert.equal(a.mode, "ref2va");
  for (const [key, value] of Object.entries(FASTH3)) assert.equal((a as any)[key], value);
  assert.equal(a.lora, "");
  assert.equal(a.sol_tau, null);
});

test("FastH3 refuses unsupported modes and overrides instead of changing their meaning", () => {
  const opts = { model: FASTH3.model, prompt: "x", refs: [ref] };
  for (const extra of [{ firstFrame: ref }, { lastFrame: ref }, { guides: [{ ...ref, to: 0 }] },
    { audioGuides: [{ asset: "sound", at: 0, dur: 5, to: 0 }] },
    { control: { asset: "ctl", strength: 1, end: 1 } }, { dense: true }, { steps: 4 }, { steps: NaN },
    { quality: "full" as const }, { quality: "turbo" as const }]) {
    assert.throws(() => buildRequest({ ...opts, ...extra }), (e: any) => e.code === "usage");
  }
  assert.throws(() => buildRequest({ ...opts, refs: [] }), /reference images/);
  assert.throws(() => buildRequest({ ...opts, refs: Array(10).fill(ref) }), /reference images/);
  assert.throws(() => buildRequest({ ...opts, model: "typo" }), /unknown generation model/);
  assert.equal(buildRequest({ ...opts, steps: 8 }).id, buildRequest(opts).id);
});

test("fake Colab: opt-in bootstrap, CLI routing, provenance, cache and session isolation", (t) => {
  const { p, vm } = fixture();
  t.after(() => down());
  assert.throws(() => up({ model: FASTH3.model, budgetCu: NaN }), /--budget-cu/);
  assert.throws(() => up({ model: "typo", budgetCu: 3 }), /unknown generation model/);
  assert.throws(() => up({ model: FASTH3.model, budgetCu: 3, light: true }), /--light/);
  const boot = JSON.parse(execFileSync(process.execPath, ["--no-warnings", "src/cli.ts", "gen", "up",
    "--model", FASTH3.model, "--budget-cu", "3", "--wait", "--json"], { cwd: ROOT }).toString());
  assert.equal(boot.boot.model, FASTH3.model);
  assert.equal(boot.boot.comfy_rev, FASTH3.comfy_rev);
  const r = JSON.parse(execFileSync(process.execPath, ["--no-warnings", "src/cli.ts", "gen", "clip",
    "--project", p.root, "--model", FASTH3.model, "--refs", "still,clip@1", "--prompt", "same scene",
    "--size", "draft", "--as", "fast", "--json"], { cwd: ROOT }).toString());
  assert.equal(r.cached, false);
  const receipt = JSON.parse(fs.readFileSync(genPaths(p, r.request_id).sidecar, "utf8"));
  assert.equal(receipt.ran.model, FASTH3.model);
  assert.equal(receipt.ran.weights_repo, FASTH3.weights_repo);
  assert.equal(receipt.ran.weights_rev, FASTH3.weights_rev);
  assert.equal(receipt.request.sampler, "euler");
  assert.ok(receipt.frames.ref0.sha256 && receipt.frames.ref1.sha256);
  assert.equal(state(vm).last.ref_images.length, 2);
  assert.ok(!JSON.stringify(receipt).includes(p.root));
  down();
  const cached = clip(loadProject(p.root), { model: FASTH3.model, refs: "still,clip@1", prompt: "same scene", size: "draft", as: "fast" });
  assert.equal(cached.cached, "project", "cache reuse needs no running GPU");
  assert.equal(state(vm).submitted, 1);
  up({ model: FASTH3.model, budgetCu: 3 });
  const uploads = state(vm).uploads.length;
  assert.throws(() => clip(p, { prompt: "legacy", refs: "still" }), (e: any) => e.code === "gen_model_mismatch");
  assert.throws(() => up({ budgetCu: 3 }), (e: any) => e.code === "gen_model_mismatch");
  assert.equal(state(vm).uploads.length, uploads, "mismatches fail before transfer or generation");
  down();
  up({ budgetCu: 3 });
  assert.throws(() => clip(p, { model: FASTH3.model, prompt: "x", refs: "still" }), (e: any) => e.code === "gen_model_mismatch");
});

test("FastH3 rejects stale boots and mismatched result provenance before ingest", (t) => {
  const { p, vm } = fixture();
  t.after(() => { delete process.env.FAKE_GEN_BAD_PROVENANCE; down(); });
  up({ model: FASTH3.model, budgetCu: 3 });
  const file = path.join(vm, "content/vosgen/boot.json");
  const boot = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, JSON.stringify({ ...boot, weights_rev: "stale" }));
  const opts = { model: FASTH3.model, refs: "still", prompt: "x", as: "bad" };
  assert.throws(() => clip(p, opts), (e: any) => e.code === "gen_model_mismatch");
  assert.equal(state(vm).uploads, undefined);
  fs.writeFileSync(file, JSON.stringify(boot));
  process.env.FAKE_GEN_BAD_PROVENANCE = "1";
  assert.throws(() => clip(p, opts), (e: any) => e.code === "gen_provenance_mismatch");
  assert.equal(loadProject(p.root).assets.assets.bad, undefined);
  assert.ok(!fs.existsSync(genPaths(p, state(vm).last.id).media));
});
