/** Offline checks of the paid-run boundary; never calls a provider. */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vos-anime-bass-test-"));
  fs.mkdirSync(path.join(root, "inputs"));
  fs.mkdirSync(path.join(root, "outputs"));
  fs.copyFileSync(path.join(here, "inputs/reference.png"), path.join(root, "inputs/reference.png"));
  return root;
}
function run(root: string, args: string[] = []) {
  return spawnSync(process.execPath, [path.join(here, "run.ts"), "--artifacts", root, ...args], {
    encoding: "utf8", timeout: 30_000,
    // An accidental call to the provider boundary must fail locally.
    env: { ...process.env, VOS_COLAB_BIN: "/not-a-colab-command", VOS_COLAB_GUARD: "/not-a-colab-guard" },
  });
}

test("dry-run prepares equal inputs and explicit model recipes without allocation", () => {
  const root = fixture();
  try {
    const r = run(root);
    assert.equal(r.status, 0, r.stderr);
    const plan = JSON.parse(fs.readFileSync(path.join(root, "outputs/planned-requests.json"), "utf8"));
    assert.equal(plan.budget_authorized, false);
    assert.equal(plan.proposed_budget_cu, 6);
    assert.deepEqual(plan.requests.map((r: any) => [r.model, r.seed, r.steps]), [
      ["fasth3-omni", 1, 8], ["fasth3-omni", 2, 8], ["minimax-h3", 1, 20], ["minimax-h3", 2, 20],
    ]);
    assert.equal(new Set(plan.requests.map((r: any) => r.prompt)).size, 1);
    assert.equal(new Set(plan.requests.map((r: any) => JSON.stringify(r.refs))).size, 1);
    assert.ok(plan.requests.every((r: any) => r.width === 1344 && r.height === 768 && r.seconds === 5));
    assert.equal(fs.existsSync(path.join(root, "outputs/execution.started")), false);
    assert.equal(fs.existsSync(path.join(root, "outputs/run.json")), false);
    const one = run(root, ["--one-seed"]);
    assert.equal(one.status, 0, one.stderr);
    const smaller = JSON.parse(fs.readFileSync(path.join(root, "outputs/planned-requests.json"), "utf8"));
    assert.equal(smaller.proposed_budget_cu, 4);
    assert.deepEqual(smaller.requests.map((r: any) => r.seed), [1, 1]);
  } finally { fs.rmSync(root, { recursive: true }); }
});

test("changed reference is refused before planning", () => {
  const root = fixture();
  try {
    fs.appendFileSync(path.join(root, "inputs/reference.png"), "changed");
    const r = run(root);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Reference SHA-256 mismatch/);
    assert.equal(fs.existsSync(path.join(root, "outputs/planned-requests.json")), false);
  } finally { fs.rmSync(root, { recursive: true }); }
});

test("one-shot refusal preserves every existing evidence file", () => {
  const root = fixture();
  try {
    const out = path.join(root, "outputs");
    const files = ["execution.started", "run.json", "planned-requests.json"];
    for (const f of files) fs.writeFileSync(path.join(out, f), `preserve ${f}\n`);
    for (const args of [[], ["--execute", "--budget-cu", "6"]]) {
      const r = run(root, args);
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /Comparison already attempted/);
      for (const f of files) assert.equal(fs.readFileSync(path.join(out, f), "utf8"), `preserve ${f}\n`);
    }
  } finally { fs.rmSync(root, { recursive: true }); }
});
