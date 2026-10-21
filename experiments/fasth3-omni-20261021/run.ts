/** One approved comparison. No allocation unless --execute --budget-cu 6 is supplied. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sha256 } from "../../src/core/hash.ts";
import { initProject, loadProject, ingest, saveAssets, resolveAsset } from "../../src/core/project.ts";
import { buildRequest, clip, down, GEN, genPaths, status, up } from "../../src/gen/colab.ts";
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
const record: any = { approved_ask: "ask_218f72ffc7cb", budget_cu: 6, budget_per_session_cu: 3, phases: [], state: "planned" };
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
  if (s.ok !== true || !Number.isFinite(s.balance) || s.rate_cu_h !== 0 || s.orphans?.length ||
      s.sessions?.some((x: any) => x.state !== "stopped") || assignments().length) {
    throw new Error("Existing, orphaned or uncertain Colab activity; no session was changed");
  }
  return s;
}

function hardware() {
  rc.exec(GEN, 'import subprocess\n_write(ROOT + "/hardware.json", {"gpu": subprocess.check_output(["nvidia-smi", "--query-gpu=name,memory.total,driver_version", "--format=csv,noheader,nounits"], text=True).strip()})');
  const h = rc.remoteJson(GEN, "/content/vosgen/hardware.json");
  const rows = h.gpu.split("\n");
  const [name, memory] = rows[0].split(",").map((s: string) => s.trim());
  if (rows.length !== 1 || !name.includes("A100") || Number(memory) < 39000 || Number(memory) > 45000) {
    throw new Error("Not the approved A100 40GB: " + h.gpu);
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
  const input = path.join(ART, "inputs/reference.png");
  const lock = JSON.parse(fs.readFileSync(path.join(HERE, "source-lock.json"), "utf8"));
  if (sha256(fs.readFileSync(input)) !== lock.reference.sha256) throw new Error("Reference SHA-256 mismatch");
  const projectRoot = path.join(ART, "project");
  const p = fs.existsSync(path.join(projectRoot, "vos.project.json")) ? loadProject(projectRoot)
    : initProject(projectRoot, "fasth3-omni-comparison", { width: 1344, height: 768, fps: 24 });
  ingest(p, input, "reference"); saveAssets(p);
  const prompt = fs.readFileSync(path.join(HERE, "prompt.txt"), "utf8");
  const reference = resolveAsset(p, "reference");
  const models = ["minimax-h3", "fasth3-omni"];
  const requests = models.flatMap((model) => [1, 2].map((seed) => buildRequest({ model, prompt, seed,
    seconds: 5, size: "768p", refSize: "match", refs: [{ asset: reference.id, at: 0 }] })));
  write("planned-requests.json", { status: "not_executed", budget_authorized: args.includes("--execute"), requests });
  if (!args.includes("--execute")) { log("4 requests prepared; no GPU or model downloads"); return; }
  if (Number(value("--budget-cu")) !== 6) throw new Error("This run requires the approved --budget-cu 6");
  if (process.env.VOS_COLAB_GUARD || process.env.VOS_COLAB_BIN) throw new Error("Unexpected Colab command override");
  const source = JSON.parse(fs.readFileSync(path.join(OUT, "execution-source.json"), "utf8"));
  for (const [file, hash] of Object.entries(source.files)) {
    if (sha256(fs.readFileSync(path.join(ROOT, file))) !== hash) throw new Error("Execution source changed: " + file);
  }
  if (requests.some((r) => fs.existsSync(genPaths(p, r.id).media))) throw new Error("Existing takes would invalidate fresh-generation timing");
  record.before = idle();
  if (record.before.balance < 6) throw new Error("Insufficient CU balance");
  fs.writeFileSync(path.join(OUT, "execution.started"), JSON.stringify({ ask: record.approved_ask, budget_cu: 6, time: new Date().toISOString() }) + "\n", { flag: "wx" });
  record.source = source;
  record.runner_sha256 = sha256(fs.readFileSync(fileURLToPath(import.meta.url)));
  record.started_at = Date.now(); record.state = "running"; save();
  for (const model of models) {
    const phase: any = { model, state: "starting", clips: [], budget_cu: 3, started_at: Date.now() };
    record.phases.push(phase); save();
    const before = idle(); phase.before = before;
    const prior = ledger()?.created_at;
    let attempted = false;
    try {
      log(`Starting ${model}: A100, 3 CU, 30-minute deadline`);
      attempted = true;
      phase.up = up({ model, budgetCu: 3, maxHours: 0.5, leaseMin: 10, gpu: "A100" });
      if (phase.up.status === "already_up") throw new Error("Another caller started a session; refusing to use it");
      phase.hardware = hardware(); save();
      rc.wait(GEN, "/content/vosgen/boot.done", 1200, "the comparison bootstrap");
      phase.boot = rc.remoteJson(GEN, "/content/vosgen/boot.json");
      if (phase.boot.state !== "ready") throw new Error("Bootstrap failed: " + phase.boot.error);
      write(`${model}-boot.json`, phase.boot);
      log(`${model} ready; bootstrap ${phase.boot.sec}s; ${phase.hardware.gpu}`); save();
      for (const seed of [1, 2]) {
        const s = status();
        const remaining = 1800 - (Date.now() - phase.started_at) / 1000;
        if (s.session?.state !== "running" || s.session.spent_cu >= 2.4 || remaining < 300) throw new Error("Insufficient session reserve for another take");
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
        phase.release_verified = phase.after?.session?.state === "stopped" && phase.remaining_assignments?.length === 0;
        phase.observed_cu = phase.before.balance - phase.after?.balance;
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
  log(`4 clips generated. All assignments released. Balance difference ${record.observed_cu.toFixed(2)} CU.`);
}

try { main(); }
catch (e) { record.state = "error"; record.error = String(e); record.ended_at = Date.now(); save(); console.error(e); process.exitCode = 1; }
