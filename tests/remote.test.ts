import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describeRemote, readDescribe, searchDescriptions } from "../src/analyze/marlin.ts";
import { ingest, saveAssets, resolveAsset } from "../src/core/project.ts";
import { sha256File } from "../src/core/hash.ts";
import * as remote from "../src/remote/analysis.ts";
import { parsePyCall, pyCall } from "../src/remote/colab.ts";
import { fixtureProject } from "./helpers.ts";

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-colab.mjs");
fs.chmodSync(FAKE, 0o755);
process.env.VOS_COLAB_GUARD = FAKE;
process.env.VOS_COLAB_BIN = FAKE;
// a dummy token file (the real one is the human's; tests never touch it)
const TOKEN_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "vos-hf-")), "hf_token");
fs.writeFileSync(TOKEN_FILE, "hf_dummy_for_tests\n");
process.env.VOS_HF_TOKEN_FILE = TOKEN_FILE;
const ENV = ["FAKE_EXEC_DROPS", "FAKE_EXEC_DROPS_AFTER", "FAKE_BOOT_FAIL", "FAKE_CORRUPT_UPLOAD", "FAKE_ANALYSIS_ITEM_FAIL", "FAKE_ANALYSIS_STRAY",
  "FAKE_ANALYSIS_BAD_SUM", "FAKE_ANALYSIS_WRONG_ID", "FAKE_ANALYSIS_REV", "FAKE_NEVER_FINISHES", "FAKE_EMBED_NAN", "FAKE_EMBED_SHORT", "FAKE_ANALYSIS_QUEUED"];

function freshVm(): string {
  const vm = fs.mkdtempSync(path.join(os.tmpdir(), "vos-fakeana-"));
  process.env.FAKE_VM = vm;
  for (const k of ENV) delete process.env[k];
  return vm;
}
const fakeState = (vm: string) => JSON.parse(fs.readFileSync(path.join(vm, "state.json"), "utf8"));

/** fixture project + a second video, so batching is visible */
function project() {
  const p = fixtureProject();
  const f = path.join(p.root, "media", "b.mp4");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=160x90:rate=24:duration=2", "-pix_fmt", "yuv420p", f]);
  ingest(p, f, "b");
  saveAssets(p);
  return p;
}

test("pyCall: JSON null/true/false and quotes reach Python through json.loads, and round-trip", () => {
  const arg = { a: null, b: true, c: false, s: `it's "quoted" \\ ${"$"}HOME 日本語\n` };
  const code = pyCall("submit", arg);
  assert.match(code, /^submit\(__import__\("json"\)\.loads\(/);
  assert.deepEqual(parsePyCall("submit", code), arg);
  const py = execFileSync("python3", ["-c", `import json\ndef submit(x): print(json.dumps(x, sort_keys=True))\n${code}`]).toString();
  assert.deepEqual(JSON.parse(py), arg);
});

test("remote up refuses without a budget; describe --on colab without a session says how to start one", () => {
  freshVm();
  const p = project();
  assert.throws(() => remote.up({ budgetCu: 0 }), (e: any) => e.code === "usage" && /budget-cu/.test(e.message) && /money/.test(e.hint));
  assert.throws(() => describeRemote(p, ["clip"]), (e: any) => e.code === "remote_not_up" && /vos remote up --profile marlin --budget-cu/.test(e.hint));
});

test("describe --on colab: one job for the batch, inputs by full hash, results written with where they ran; rerun is free", () => {
  const vm = freshVm();
  const p = project();
  const up = remote.up({ budgetCu: 3 });
  assert.equal(up.session, "vos-analysis");
  assert.equal(fakeState(vm).sessions["vos-analysis"].state, "running");
  assert.equal(fakeState(vm).sessions["vos-gen"], undefined, "never the generation VM");

  const r = describeRemote(p, ["clip", "b"]);
  assert.deepEqual(r.map((x) => [x.alias, x.status]), [["clip", "built"], ["b", "built"]]);
  const st = fakeState(vm);
  assert.equal(Object.keys(st.analysisRuns).length, 1, "one job, one model load");
  assert.equal(st.lastAnalysis.inputs.length, 2);
  const clipSha = sha256File(resolveAsset(p, "clip").path!);
  assert.ok(st.uploads.includes(`/content/vosana/in/${clipSha}.mp4`), "uploaded under its full SHA-256");
  assert.ok(st.renews.length >= 2, "lease renewed before each upload");

  const d = readDescribe(p, resolveAsset(p, "clip").id)!;
  assert.equal(d.format, "vos.describe/1");
  assert.match(d.scene, /^fake scene /);
  assert.equal(d.provenance.producer, "marlin-colab");
  assert.equal(d.provenance.model, "NemoStation/Marlin-2B", "the model id, not a VM path");
  assert.equal(d.provenance.ran?.backend, "colab");
  assert.equal(d.provenance.ran?.gpu, "NVIDIA L4");
  assert.equal(d.provenance.ran?.input_sha256, clipSha);
  assert.equal(d.provenance.ran?.revision, remote.PROFILES.marlin.revision);
  assert.ok(searchDescriptions(p, "fake event").length >= 2, "remote results feed search like local ones");

  const uploads = st.uploads.length;
  const again = describeRemote(p, ["clip", "b"]);
  assert.deepEqual(again.map((x) => x.status), ["fresh", "fresh"]);
  const st2 = fakeState(vm);
  assert.equal(Object.keys(st2.analysisRuns).length, 1, "fresh results cost no remote call");
  assert.equal(st2.uploads.length, uploads);

  // --force runs again, but nothing is uploaded twice: the VM already holds the bytes
  describeRemote(p, ["clip"], { force: true });
  const st3 = fakeState(vm);
  assert.equal(st3.uploads.length, uploads, "dedup by content on the VM");
  assert.equal(Object.keys(st3.analysisRuns).length, 2);
  remote.down();
  assert.equal(fakeState(vm).sessions["vos-analysis"].state, "stopped");
});

test("existing finds survive a remote describe; a failed item is reported per clip and writes nothing", () => {
  freshVm();
  const p = project();
  remote.up({ budgetCu: 3 });
  const id = resolveAsset(p, "clip").id;
  fs.mkdirSync(path.dirname(path.join(p.root, ".vos", "analysis", id, "describe.json")), { recursive: true });
  fs.writeFileSync(path.join(p.root, ".vos", "analysis", id, "describe.json"), JSON.stringify({ format: "vos.describe/1", asset: id, scene: "old", events: [], finds: [{ query: "q", start: 1, end: 2 }], provenance: { producer: "marlin-local", model: "m", at: "x" } }));
  process.env.FAKE_ANALYSIS_ITEM_FAIL = "1"; // the first input fails on the VM
  const r = describeRemote(p, ["b", "clip"]);
  const failed = r.find((x) => !x.ok)!;
  assert.equal(failed.status, "failed");
  assert.match(failed.error!, /decode failed/);
  const ok = r.find((x) => x.ok)!;
  const rec = readDescribe(p, resolveAsset(p, ok.alias).id)!;
  assert.equal(rec.provenance.producer, "marlin-colab");
  if (ok.alias === "clip") assert.deepEqual(rec.finds, [{ query: "q", start: 1, end: 2 }]);
  const other = readDescribe(p, resolveAsset(p, failed.alias).id);
  assert.ok(!other || other.provenance.producer !== "marlin-colab", "the failed clip keeps whatever it had");
  remote.down();
});

test("a connection lost after the VM accepted the job does not run it twice", () => {
  const vm = freshVm();
  const p = project();
  remote.up({ budgetCu: 3 });
  process.env.FAKE_EXEC_DROPS_AFTER = "1";
  const r = describeRemote(p, ["clip"]);
  assert.equal(r[0].status, "built");
  const runs = Object.values(fakeState(vm).analysisRuns) as number[];
  assert.deepEqual(runs, [1]);
  remote.down();
});

test("a corrupted upload fails the job naming the input; the next call uploads it again and succeeds", () => {
  const vm = freshVm();
  const p = project();
  remote.up({ budgetCu: 3 });
  process.env.FAKE_CORRUPT_UPLOAD = "1";
  assert.throws(() => describeRemote(p, ["clip"]), (e: any) => e.code === "remote_job_failed" && /missing or corrupt/.test(e.hint));
  const before = fakeState(vm).uploads.length;
  const r = describeRemote(p, ["clip"]);
  assert.equal(r[0].status, "built");
  assert.ok(fakeState(vm).uploads.length > before, "re-uploaded after the VM dropped the bad copy");
  remote.down();
});

test("results that do not verify are rejected, not written", () => {
  for (const [env, re] of [["FAKE_ANALYSIS_STRAY", /not sent/], ["FAKE_ANALYSIS_BAD_SUM", /checksum/], ["FAKE_ANALYSIS_WRONG_ID", /answered for job/]] as const) {
    freshVm();
    const p = project();
    remote.up({ budgetCu: 3 });
    process.env[env] = "1";
    assert.throws(() => describeRemote(p, ["clip"]), (e: any) => e.code === "remote_bad_result" && re.test(e.message), env);
    assert.equal(readDescribe(p, resolveAsset(p, "clip").id), null, `${env}: nothing written`);
    remote.down();
  }
});

test("a session booted for another model revision is refused; a failed up releases the VM", () => {
  let vm = freshVm();
  const p = project();
  process.env.FAKE_ANALYSIS_REV = "deadbeef";
  remote.up({ budgetCu: 3 });
  assert.throws(() => describeRemote(p, ["clip"]), (e: any) => e.code === "remote_wrong_profile");
  remote.down();
  vm = freshVm();
  process.env.FAKE_EXEC_DROPS = "5";
  assert.throws(() => remote.up({ budgetCu: 3 }), /after 2 attempts/);
  assert.equal(fakeState(vm).sessions["vos-analysis"].state, "stopped", "released right away");
});

test("up on a session whose bootstrap failed retries the bootstrap in place instead of reporting already_up", () => {
  const vm = freshVm();
  process.env.FAKE_BOOT_FAIL = "1";
  remote.up({ budgetCu: 3 });
  assert.throws(() => remote.waitBoot(remote.analysisColab(), "marlin"), (e: any) => e.code === "remote_boot_failed");
  delete process.env.FAKE_BOOT_FAIL;
  const r = remote.up({ budgetCu: 3 });
  assert.equal(r.status, "rebooting");
  assert.equal(fakeState(vm).analysisBoots.length, 2);
  assert.equal(remote.waitBoot(remote.analysisColab(), "marlin").state, "ready");
  assert.equal(remote.up({ budgetCu: 3 }).status, "already_up", "a healthy session is left alone");
  remote.down();
});

test("gated model: no token file refuses before any VM exists; the token travels only by upload", () => {
  let vm = freshVm();
  process.env.VOS_HF_TOKEN_FILE = path.join(os.tmpdir(), "vos-no-such-token");
  try {
    assert.throws(() => remote.up({ budgetCu: 3 }), (e: any) => e.code === "hf_token_missing" && /no VM was started/.test(e.hint));
    assert.ok(!fs.existsSync(path.join(vm, "state.json")) || !fakeState(vm).sessions?.["vos-analysis"], "nothing was started");
  } finally {
    process.env.VOS_HF_TOKEN_FILE = TOKEN_FILE;
  }
  vm = freshVm();
  remote.up({ budgetCu: 3 });
  const st = fakeState(vm);
  const tokenPath = st.analysisBoots[0].token_file;
  assert.match(tokenPath, /^\/content\/vosana\/\.hf_token\.[0-9a-f-]{36}$/, "one file per request");
  assert.ok(st.uploads.includes(tokenPath), "uploaded as a file");
  assert.ok(!JSON.stringify(st).includes("hf_dummy_for_tests"), "the token is in no snippet or call the VM side saw as code");
  remote.down();
});

// ---------------- visual index on the VM ----------------

import { find, indexChannel, readIndex, spaceOf } from "../src/analyze/embed.ts";

test("index --on colab (visual): frames go as one archive per video, rows come back per window with their space", () => {
  const vm = freshVm();
  const p = project();
  remote.up({ budgetCu: 3, profile: "visual" });
  const r = indexChannel(p, ["clip", "b", "still", "tone"], "visual", { on: "colab" });
  assert.deepEqual(r.map((x) => [x.alias, x.status]), [["clip", "built"], ["b", "built"], ["still", "built"], ["tone", "skipped"]]);
  const st = fakeState(vm);
  assert.equal(st.embedItems.length, 1, "one job, one model load");
  const tars = st.uploads.filter((u: string) => u.endsWith(".tar"));
  assert.equal(tars.length, 2, "one archive per video");
  assert.ok(st.uploads.some((u: string) => u.endsWith(".png")), "the still travels as itself");
  const tarFile = path.join(vm, tars[0]);
  const members = execFileSync("tar", ["-tf", tarFile]).toString().trim().split("\n");
  assert.ok(members.every((m) => /^\d{5}\.jpg$/.test(m)), `flat frame names only, no ._ metadata: ${members.slice(0, 3)}`);

  const idx = readIndex(p, resolveAsset(p, "clip").id, "visual")!;
  assert.equal(idx.meta.windows.length, 4, "4 s at 1 frame/s, same windows as a local build");
  assert.equal(idx.rows.length, 4);
  assert.equal(idx.meta.model, "Qwen/Qwen3-VL-Embedding-2B");
  assert.equal(idx.meta.space, spaceOf("visual", "colab"));
  assert.equal((idx.meta.provenance.ran as any).backend, "colab");

  const again = indexChannel(p, ["clip", "b", "still"], "visual", { on: "colab" });
  assert.deepEqual(again.map((x) => x.status), ["fresh", "fresh", "fresh"]);
  assert.equal(fakeState(vm).embedItems.length, 1, "fresh costs no remote call");
  remote.down();
});

test("find --on colab embeds the query on the VM; a local query does not rank against a remote space", () => {
  const vm = freshVm();
  const p = project();
  remote.up({ budgetCu: 3, profile: "visual" });
  indexChannel(p, ["clip", "b"], "visual", { on: "colab" });
  const r = find(p, "a test pattern", { channels: ["visual"], on: "colab" });
  assert.deepEqual(r.channels_used, ["visual"]);
  assert.equal(r.channels_unavailable.length, 0);
  const q = fakeState(vm).embedItems.at(-1);
  assert.deepEqual(q, [{ kind: "text", text: "a test pattern", role: "query" }]);

  process.env.VOS_EMBED_MOCK = "1"; // a local query (mock space) against the colab-built index
  try {
    const l = find(p, "a test pattern", { channels: ["visual"] });
    assert.deepEqual(l.channels_used, ["visual"], "the query itself worked");
    assert.ok(l.channels_unavailable.some((u) => /is in .*, the query in mock/.test(u.reason)), JSON.stringify(l.channels_unavailable));
    assert.equal(l.hits.filter((h) => h.channels.visual !== undefined).length, 0, "no cross-space ranking");
    // and a local rebuild is not fooled into "fresh" by the remote index
    const rebuilt = indexChannel(p, ["clip"], "visual", {});
    assert.equal(rebuilt[0].status, "built");
    assert.equal(readIndex(p, resolveAsset(p, "clip").id, "visual")!.meta.space, "mock");
  } finally {
    delete process.env.VOS_EMBED_MOCK;
  }
  remote.down();
});

test("remote embeddings that do not verify are rejected and nothing is written", () => {
  for (const env of ["FAKE_EMBED_NAN", "FAKE_EMBED_SHORT", "FAKE_ANALYSIS_BAD_SUM"]) {
    freshVm();
    const p = project();
    remote.up({ budgetCu: 3, profile: "visual" });
    process.env[env] = "1";
    assert.throws(() => indexChannel(p, ["clip"], "visual", { on: "colab" }), (e: any) => e.code === "remote_bad_result", env);
    assert.equal(readIndex(p, resolveAsset(p, "clip").id, "visual"), null, `${env}: nothing written`);
    remote.down();
  }
});

test("a session without the visual profile says how to add it; up --profile adds it to the running session", () => {
  const vm = freshVm();
  const p = project();
  remote.up({ budgetCu: 3, profile: "marlin" });
  assert.throws(() => indexChannel(p, ["clip"], "visual", { on: "colab" }), (e: any) => e.code === "remote_wrong_profile" && /--profile visual/.test(e.hint));
  const r = remote.up({ budgetCu: 3, profile: "visual" });
  assert.equal(r.status, "extending");
  assert.deepEqual(r.profiles, ["marlin", "visual"], "keeps what it had");
  const boots = fakeState(vm).analysisBoots;
  assert.deepEqual(boots.at(-1).profiles.map((x: any) => x.name), ["marlin", "visual"]);
  assert.equal(boots.at(-1).token_file, undefined, "marlin is already there: no token sent again");
  assert.equal(indexChannel(p, ["clip"], "visual", { on: "colab" })[0].status, "built");
  assert.equal(remote.up({ budgetCu: 3, profile: "marlin,visual" }).status, "already_up");
  assert.equal(fakeState(vm).sessions["vos-analysis"].budget_cu, 3, "one session, one budget");
  remote.down();
});

test("only the visual channel runs remotely", () => {
  freshVm();
  const p = project();
  remote.up({ budgetCu: 3, profile: "visual" });
  assert.throws(() => indexChannel(p, ["tone"], "audio", { on: "colab", window: 2 }), (e: any) => e.code === "usage");
  remote.down();
});

// ---------------- review fixes ----------------

test("retrying a failed bootstrap sends the token again (the VM deleted the first one)", () => {
  const vm = freshVm();
  process.env.FAKE_BOOT_FAIL = "1";
  remote.up({ budgetCu: 3 }); // marlin: gated
  delete process.env.FAKE_BOOT_FAIL;
  assert.equal(remote.up({ budgetCu: 3 }).status, "rebooting");
  const boots = fakeState(vm).analysisBoots;
  assert.ok(boots.at(-1).token_file, "the errored boot listed marlin, but nothing was downloaded: token sent again");
  assert.notEqual(boots.at(-1).token_file, boots[0].token_file);
  remote.down();
});

test("a session allocated by an interrupted up (no bootstrap yet) is resumed, not reported already_up", () => {
  const vm = freshVm();
  execFileSync(FAKE, ["start", "vos-analysis", "--gpu", "L4", "--budget-cu", "3", "--max-hours", "1", "--lease-min", "20"]);
  const r = remote.up({ budgetCu: 3, profile: "visual" });
  assert.equal(r.status, "resuming");
  assert.equal(fakeState(vm).analysisBoots.length, 1);
  assert.equal(remote.waitBoot(remote.analysisColab(), "visual").state, "ready");
  remote.down();
});

test("a job the VM never starts is cancelled when the caller stops waiting", () => {
  const vm = freshVm();
  const p = project();
  remote.up({ budgetCu: 3, profile: "visual" });
  process.env.FAKE_ANALYSIS_QUEUED = "1";
  assert.throws(() => indexChannel(p, ["clip"], "visual", { on: "colab" }), (e: any) => e.code === "colab_wait" && /start the job/.test(e.message));
  const st = fakeState(vm);
  assert.deepEqual(st.cancels, Object.keys(st.analysisRuns), "the queued job was cancelled");
  remote.down();
});
