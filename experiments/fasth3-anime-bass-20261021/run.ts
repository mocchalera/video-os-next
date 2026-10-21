/** Anime bass comparison. Dry-run by default; a fresh approved budget is required. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sha256 } from "../../src/core/hash.ts";
import { initProject, loadProject, ingest, saveAssets, resolveAsset } from "../../src/core/project.ts";
import { buildRequest, clip, down, GEN, genPaths, status } from "../../src/gen/colab.ts";
import * as rc from "../../src/remote/colab.ts";

process.env.VOS_GEN_LIBRARY = ""; // experimental takes stay out of the shared library
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const args = process.argv.slice(2);
const value = (flag: string) => args[args.indexOf(flag) + 1];
const ART = args.includes("--artifacts") ? path.resolve(value("--artifacts")) : HERE;
const OUT = path.join(ART, "outputs");
fs.mkdirSync(OUT, { recursive: true });
const write = (file: string, data: unknown) => {
  const target = path.join(OUT, file), tmp = target + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(tmp, target);
};
const log = (message: string) => console.log(new Date().toISOString(), message);
const seeds = args.includes("--one-seed") ? [1] : [1, 2];
const budget = seeds.length === 1 ? 4 : 6;
const cap = budget / 2;
const record: any = { budget_cu: budget, budget_per_session_cu: cap, seeds, phases: [], state: "planned" };
const save = () => write("run.json", record);
const ledgerPath = path.join(process.env.VOS_COLAB_HOME ?? path.join(os.homedir(), ".config/vos/colab"), "vos-gen.json");
const ledger = () => fs.existsSync(ledgerPath) ? JSON.parse(fs.readFileSync(ledgerPath, "utf8")) : null;

function assignments(): string[] {
  const bin = execFileSync("which", ["colab"], { encoding: "utf8", timeout: 10_000 }).trim();
  const python = path.join(path.dirname(fs.realpathSync(bin)), "python");
  return JSON.parse(execFileSync(python, ["-c", "import json; from colab_cli.common import state; print(json.dumps([a.endpoint for a in state.client.list_assignments()]))"],
    { encoding: "utf8", timeout: 90_000 }));
}

function idle() {
  const s = rc.guard(["status"]);
  if (s.ok !== true || !Number.isFinite(s.balance) || s.rate_cu_h !== 0 || !Array.isArray(s.orphans) || s.orphans.length ||
      !Array.isArray(s.sessions) || s.sessions.some((x: any) => x.state !== "stopped") || assignments().length) {
    throw new Error("Existing, orphaned or uncertain Colab activity; no session was changed");
  }
  return s;
}

function hardware(model: string) {
  const probe = fs.readFileSync(path.join(ROOT, "experiments/fasth3-omni-20261021/gpu_probe.py"), "utf8");
  rc.exec(GEN, probe + "\nwrite_probe()\n", 100, 1);
  const h = rc.remoteJson(GEN, "/content/vosgen/hardware.json");
  write(`${model}-hardware.json`, h);
  const devices = h.cuda?.devices;
  if (h.state !== "ready" || devices?.length !== 1 || !devices[0].name.includes("A100") ||
      devices[0].memory_mib < 39000 || devices[0].memory_mib > 45000) {
    throw new Error("GPU proof does not match one A100 40GB: " + JSON.stringify(h));
  }
  return h;
}

function evidence(id: string, localFile: string) {
  const code = `import hashlib\nfp = ROOT + "/out/${id}.mp4"\n_write(ROOT + "/verify_${id}.json", {"sha256": hashlib.sha256(open(fp, "rb").read()).hexdigest(), "bytes": os.path.getsize(fp)})\n_write(ROOT + "/history_${id}.json", json.load(urllib.request.urlopen(URL + "/history")))`;
  rc.exec(GEN, code);
  const v = rc.remoteJson(GEN, `/content/vosgen/verify_${id}.json`);
  if (v.sha256 !== sha256(fs.readFileSync(localFile)) || v.bytes !== fs.statSync(localFile).size) throw new Error("Downloaded media does not match the VM output");
  rc.download(GEN, `/content/vosgen/history_${id}.json`, path.join(OUT, `history_${id}.json`));
  return v;
}

function main() {
  // Refuse before touching any prior execution evidence, even for a dry-run.
  if (fs.existsSync(path.join(OUT, "execution.started"))) throw new Error("Comparison already attempted; preserve its evidence");
  const input = path.join(ART, "inputs/reference.png");
  const lock = JSON.parse(fs.readFileSync(path.join(HERE, "source-lock.json"), "utf8"));
  if (sha256(fs.readFileSync(input)) !== lock.reference.sha256) throw new Error("Reference SHA-256 mismatch");
  const projectRoot = path.join(ART, "project");
  const p = fs.existsSync(path.join(projectRoot, "vos.project.json")) ? loadProject(projectRoot)
    : initProject(projectRoot, "fasth3-anime-bass-comparison", { width: 1344, height: 768, fps: 24 });
  ingest(p, input, "reference"); saveAssets(p);
  const prompt = fs.readFileSync(path.join(HERE, "prompt.txt"), "utf8");
  const reference = resolveAsset(p, "reference");
  const models = ["fasth3-omni", "minimax-h3"];
  const requests = models.flatMap((model) => seeds.map((seed) => buildRequest({ model, prompt, seed,
    seconds: 5, size: "768p", refSize: "match", refs: [{ asset: reference.id, at: 0 }] })));
  for (const r of requests) {
    const pin = r.model === "fasth3-omni" ? lock.fasth3_omni : lock.legacy;
    if (r.comfy_rev !== pin.comfy_rev || r.weights_rev !== pin.weights_rev) throw new Error("Model revision changed");
  }
  write("planned-requests.json", { status: "not_executed", budget_authorized: false, proposed_budget_cu: budget, requests });
  if (!args.includes("--execute")) { log(`${requests.length} requests prepared; no GPU or model downloads`); return; }
  if (Number(value("--budget-cu")) !== budget) throw new Error(`This run requires the approved --budget-cu ${budget}`);
  if (process.env.VOS_COLAB_GUARD || process.env.VOS_COLAB_BIN) throw new Error("Unexpected Colab command override");
  const source = JSON.parse(fs.readFileSync(path.join(OUT, "execution-source.json"), "utf8"));
  if (!/^ask_[a-z0-9]+$/.test(source.approved_ask) || !/^[0-9a-f]{40}$/.test(source.source_commit) ||
      source.budget_cu !== budget || JSON.stringify(source.seeds) !== JSON.stringify(seeds)) throw new Error("Missing fresh approval or source revision");
  const required = ["python/colab_gen_vm.py", "src/gen/colab.ts", "src/remote/colab.ts",
    "experiments/fasth3-omni-20261021/gpu_probe.py", ...["run.ts", "prompt.txt", "source-lock.json"].map((f) => path.relative(ROOT, path.join(HERE, f)))];
  if (!source.files || required.some((f) => typeof source.files[f] !== "string")) throw new Error("Incomplete execution source manifest");
  for (const [file, hash] of Object.entries(source.files)) {
    if (sha256(fs.readFileSync(path.join(ROOT, file))) !== hash) throw new Error("Execution source changed: " + file);
  }
  if (requests.some((r) => fs.existsSync(genPaths(p, r.id).media))) throw new Error("Existing takes would invalidate fresh-generation timing");
  record.before = idle();
  if (record.before.balance < budget) throw new Error("Insufficient CU balance");
  record.approved_ask = source.approved_ask;
  fs.writeFileSync(path.join(OUT, "execution.started"), JSON.stringify({ ask: record.approved_ask, budget_cu: budget, time: new Date().toISOString() }) + "\n", { flag: "wx" });
  record.source = source;
  record.runner_sha256 = sha256(fs.readFileSync(fileURLToPath(import.meta.url)));
  record.started_at = Date.now(); record.state = "running"; save();
  for (const model of models) {
    const phase: any = { model, state: "starting", clips: [], budget_cu: cap, started_at: Date.now() };
    record.phases.push(phase); save();
    const before = idle(); phase.before = before;
    const prior = ledger()?.created_at;
    let attempted = false;
    try {
      log(`Starting ${model}: A100, ${cap} CU, 30-minute deadline`);
      attempted = true;
      phase.up = rc.start(GEN, { budgetCu: cap, maxHours: 0.5, leaseMin: 10, gpu: "A100" });
      if (phase.up.status === "already_up") throw new Error("Another caller started a session; refusing to use it");
      phase.hardware = hardware(model); save();
      rc.exec(GEN, fs.readFileSync(path.join(ROOT, "python/colab_gen_vm.py"), "utf8"));
      rc.exec(GEN, model === "fasth3-omni" ? 'bootstrap(model="fasth3-omni")' : "bootstrap()");
      rc.wait(GEN, "/content/vosgen/boot.done", 1200, "the comparison bootstrap");
      phase.boot = rc.remoteJson(GEN, "/content/vosgen/boot.json");
      write(`${model}-boot.json`, phase.boot);
      if (phase.boot.state !== "ready") throw new Error("Bootstrap failed: " + phase.boot.error);
      log(`${model} ready; bootstrap ${phase.boot.sec}s; ${phase.hardware.cuda.devices[0].name}`); save();
      for (const seed of seeds) {
        const s = status();
        const remaining = 1800 - (Date.now() - phase.started_at) / 1000;
        if (s.session?.state !== "running" || !Number.isFinite(s.session.spent_cu) || s.session.spent_cu >= cap - 0.6 || remaining < 300) throw new Error("Insufficient session reserve for another take");
        const started = Date.now();
        log(`${model} seed ${seed}: generating 124 frames; observed spend ${s.session.spent_cu} CU`);
        const r = clip(loadProject(projectRoot), { model, prompt, refs: "reference", refSize: "match", seconds: 5,
          size: "768p", seed, as: `${model === "minimax-h3" ? "legacy" : "fast"}_${seed}`, timeoutSec: Math.floor(Math.min(900, remaining - 120)) });
        if (r.cached !== false) throw new Error("Unexpected cached take; this is not a fresh benchmark");
        const files = genPaths(p, r.request_id);
        const verified = evidence(r.request_id, files.media);
        const receipt = JSON.parse(fs.readFileSync(files.sidecar, "utf8"));
        phase.clips.push({ seed, ...r, wall_sec: (Date.now() - started) / 1000, verified, receipt });
        save(); log(`${model} seed ${seed} downloaded and hash-verified: ${r.sec}s VM time`);
      }
      phase.state = "generated";
    } catch (e) {
      phase.state = "error"; phase.error = String(e); throw e;
    } finally {
      const l = ledger();
      const owns = attempted && phase.up?.status !== "already_up" && l && l.created_at !== prior && l.created_at >= phase.started_at / 1000 - 1;
      if (owns) {
        phase.ledger_before_stop = l;
        try { execFileSync("colab", ["download", "-s", "vos-gen", "/content/vosgen/server.log", path.join(OUT, `${model}-server.log`)], { timeout: 30_000, stdio: "pipe" }); }
        catch (e) { phase.log_download_error = String(e); }
        log(`Stopping ${model} session`);
        try { phase.stop = down(); } catch (e) { phase.stop_error = String(e); }
        try { phase.after = status(); } catch (e) { phase.stop_status_error = String(e); }
        try { phase.remaining_assignments = assignments(); } catch (e) { phase.assignment_check_error = String(e); }
        phase.release_verified = phase.after?.session?.state === "stopped" && phase.after?.rate_cu_h === 0 &&
          Array.isArray(phase.after?.orphans) && phase.after.orphans.length === 0 && phase.remaining_assignments?.length === 0;
        phase.observed_cu = phase.before.balance - phase.after?.balance;
        const rate = phase.ledger_before_stop?.rate_cu_h;
        phase.rate_time_estimate_cu = Number.isFinite(rate) ? rate * (Date.now() / 1000 - l.created_at) / 3600 : null;
      } else {
        phase.release_verified = !attempted || (l?.state === "stopped" && l?.created_at !== prior);
      }
      phase.ended_at = Date.now(); save();
      if (!phase.release_verified) throw new Error("VM release not verified; no further phase may start");
    }
  }
  record.after = idle();
  record.observed_cu = record.before.balance - record.after.balance;
  record.state = "generated"; record.ended_at = Date.now(); save();
  log(`${requests.length} clips generated. All assignments released. Balance difference ${record.observed_cu.toFixed(2)} CU.`);
}

try { main(); }
catch (e) {
  if (record.started_at) {
    record.state = "error"; record.error = String(e); record.ended_at = Date.now(); save();
  }
  console.error(e); process.exitCode = 1;
}
