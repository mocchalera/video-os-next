import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { REPO } from "../core/config.ts";
import { sha256, sha256File } from "../core/hash.ts";
import { VosError } from "../core/util.ts";
import * as rc from "./colab.ts";
import type { Colab } from "./colab.ts";

/**
 * vos remote — analysis jobs on a rented Colab GPU, in their own guarded session (never the `vos gen` VM: its
 * bootstrap swaps torch and installs ComfyUI into the image). Local stays the default; nothing here starts a VM
 * on its own. The analysis commands (`vos describe --on colab`) call `runJob`; results come back verified and are
 * written by the same code that writes local results, with provenance that says where they ran.
 */

export const DEFAULT_SESSION = "vos-analysis";
export const REMOTE_ROOT = "/content/vosana";
const VM_WORKER = path.join(REPO, "python", "colab_analysis_vm.py");

/** What a profile needs on the VM. Pinned: changing any of these changes the cache keys of its results. */
export const PROFILES = {
  // gated on Hugging Face: the VM needs the human's token to download it (live 401, 2026-09-27)
  marlin: { model: "NemoStation/Marlin-2B", revision: "fd111fca4fc7897876fb0d7e9df22ca5ac8ab965", gpu: "L4", gated: true },
} as const;

const REMOTE_TOKEN = `${REMOTE_ROOT}/.hf_token`;

/**
 * The Hugging Face token file for gated models: VOS_HF_TOKEN_FILE, else ~/.config/vos/hf_token. vos never reads
 * the token itself: the file goes to the VM with `colab upload` (so it is in no command line, snippet, or log),
 * the VM reads it for the download and deletes it right after, success or not.
 */
export function hfTokenFile(): string | null {
  const f = process.env.VOS_HF_TOKEN_FILE || path.join(os.homedir(), ".config", "vos", "hf_token");
  return fs.existsSync(f) && fs.statSync(f).size > 0 ? f : null;
}

function needToken(profile: Profile): string | null {
  if (!PROFILES[profile].gated) return null;
  const f = hfTokenFile();
  if (!f) {
    throw new VosError("hf_token_missing", `${PROFILES[profile].model} is gated on Hugging Face; the VM needs a token to download it`,
      "put a read-only Hugging Face token (with access to that repo) in ~/.config/vos/hf_token (chmod 600) or point VOS_HF_TOKEN_FILE at one; no VM was started");
  }
  return f;
}

/** Load the worker and start its bootstrap; a gated model's token file travels by upload, never in the snippet. */
function bootstrapOn(c: Colab, profile: Profile, tokenFile: string | null): void {
  const prof = PROFILES[profile];
  rc.exec(c, fs.readFileSync(VM_WORKER, "utf8"));
  if (tokenFile) rc.upload(c, tokenFile, REMOTE_TOKEN, 60_000);
  rc.exec(c, rc.pyCall("analysis_bootstrap", { profile, model: prof.model, revision: prof.revision, ...(tokenFile ? { token_file: REMOTE_TOKEN } : {}) }));
}
export type Profile = keyof typeof PROFILES;

export function analysisColab(session?: string): Colab {
  return { session: session || DEFAULT_SESSION, cli: "vos remote", notUp: "remote_not_up", stopped: "remote_stopped" };
}

export interface RemoteUpOptions {
  budgetCu: number;
  profile?: Profile;
  gpu?: string;
  maxHours?: number;
  leaseMin?: number;
  wait?: boolean;
  session?: string;
}

function profileOf(name?: string): Profile {
  const p = (name ?? "marlin") as Profile;
  if (!(p in PROFILES)) throw new VosError("usage", `unknown profile ${name}`, `use ${Object.keys(PROFILES).join(" | ")}`);
  return p;
}

export function up(o: RemoteUpOptions) {
  const c = analysisColab(o.session);
  const profile = profileOf(o.profile);
  if (!(o.budgetCu > 0)) throw new VosError("usage", "vos remote up needs --budget-cu <N>", "compute units cost money: get the number from the human");
  const tokenFile = needToken(profile); // before any VM exists: a missing token must cost nothing
  if (rc.running(c)) {
    // a session whose bootstrap failed is retried in place (reloading the worker keeps its queue), not left broken
    let boot: any = null;
    try {
      boot = rc.remoteJson(c, `${REMOTE_ROOT}/boot.json`);
    } catch {
      /* still booting, or never started */
    }
    if (boot?.state !== "error") return { ok: true, session: c.session, status: "already_up" };
    bootstrapOn(c, profile, tokenFile);
    const res: any = { ok: true, session: c.session, status: "rebooting", profile, bootstrap: "started", previous_error: String(boot.error ?? "").slice(-300) };
    if (o.wait) res.boot = waitBoot(c, profile);
    return res;
  }
  const prof = PROFILES[profile];
  const s = rc.start(c, { gpu: o.gpu ?? prof.gpu, budgetCu: o.budgetCu, maxHours: o.maxHours ?? 2, leaseMin: o.leaseMin ?? 20 });
  try {
    bootstrapOn(c, profile, tokenFile);
    rc.wait(c, `${REMOTE_ROOT}/boot.started`, 90, "the bootstrap to start");
    const res: any = { ok: true, session: c.session, endpoint: s.endpoint, budget_cu: o.budgetCu, profile, bootstrap: "started" };
    if (o.wait) res.boot = waitBoot(c, profile);
    return res;
  } catch (e) {
    rc.stopQuietly(c); // never leave a paid VM behind a failed `up`
    throw e;
  }
}

export function waitBoot(c: Colab, profile: Profile, timeoutSec = 1500): any {
  rc.wait(c, `${REMOTE_ROOT}/boot.started`, 90, "the bootstrap to start (was `vos remote up` interrupted?)");
  rc.wait(c, `${REMOTE_ROOT}/boot.done`, timeoutSec, "the bootstrap to finish");
  const boot = rc.remoteJson(c, `${REMOTE_ROOT}/boot.json`);
  if (boot.state !== "ready") throw new VosError("remote_boot_failed", "VM bootstrap failed", String(boot.error ?? "").slice(-800));
  if (boot.profile !== profile || boot.revision !== PROFILES[profile].revision) {
    throw new VosError("remote_wrong_profile", `the ${c.session} session was set up for ${boot.profile}@${String(boot.revision).slice(0, 8)}, not ${profile}`, "`vos remote down`, then `vos remote up --profile " + profile + "`");
  }
  return boot;
}

export function status(session?: string) {
  const c = analysisColab(session);
  const g = rc.guard(["status", c.session]);
  const s = (g.sessions ?? []).find((x: any) => x.name === c.session) ?? null;
  let boot: any = null;
  if (s?.state === "running") {
    try {
      boot = rc.remoteJson(c, `${REMOTE_ROOT}/boot.json`);
    } catch {
      boot = { state: "starting" };
    }
  }
  return { balance: g.balance, rate_cu_h: g.rate_cu_h, orphans: g.orphans, session: s, boot };
}

export function down(session?: string) {
  return rc.stop(analysisColab(session));
}

// ------------------------------------------------------------------ inputs and jobs

/** A file the VM needs, addressed by its full SHA-256 (not contentId, which samples head and tail only). */
export interface RemoteInput {
  sha256: string;
  size: number;
  ext: string;
  local: string;
}

export function inputOf(file: string): RemoteInput {
  const ext = (path.extname(file).slice(1) || "bin").toLowerCase().replace(/[^a-z0-9]/g, "") || "bin";
  return { sha256: sha256File(file), size: fs.statSync(file).size, ext, local: file };
}

const wire = (x: RemoteInput) => ({ sha256: x.sha256, size: x.size, ext: x.ext });

/** Upload what the VM does not already hold (checked there by hash). Returns how many bytes went up. */
export function ensureInputs(c: Colab, inputs: RemoteInput[]): { uploaded: number; bytes: number; reused: number } {
  const uniq = [...new Map(inputs.map((x) => [x.sha256, x])).values()];
  const token = randomUUID();
  rc.exec(c, rc.pyCall("analysis_have", { token, items: uniq.map(wire) }));
  const have = new Set<string>(rc.remoteJson(c, `${REMOTE_ROOT}/have/${token}.json`).present ?? []);
  let uploaded = 0;
  let bytes = 0;
  for (const x of uniq) {
    if (have.has(x.sha256)) continue;
    rc.renew(c); // a long upload must not outlive the lease
    rc.upload(c, x.local, `${REMOTE_ROOT}/in/${x.sha256}.${x.ext}`, Math.max(300_000, (x.size / 1e6) * 2000));
    uploaded++;
    bytes += x.size;
  }
  return { uploaded, bytes, reused: uniq.length - uploaded };
}

export interface JobSpec {
  kind: "describe";
  inputs: RemoteInput[];
  worker: string; // local path of the repo worker the VM runs
  env?: Record<string, string>;
  key: unknown; // everything that determines the result; the job id is its hash
}

export interface JobResult {
  id: string;
  job: any; // the VM's report: versions, gpu, sec, …
  lines: any[]; // one per input, each carrying sha256
  worker_sha256: string;
  transfer: { uploaded: number; bytes: number; reused: number };
}

/**
 * Run one job and bring back a verified result: the report names this job, the result file matches its checksum,
 * and there is exactly one answer per input, each for an input we sent. Anything else is an error, not data.
 */
export function runJob(c: Colab, profile: Profile, spec: JobSpec, timeoutSec = 3600): JobResult {
  rc.requireRunning(c, `ask the human for a compute budget, then \`vos remote up --profile ${profile} --budget-cu <N>\``);
  waitBoot(c, profile);
  const worker = inputOf(spec.worker);
  const transfer = ensureInputs(c, [worker, ...spec.inputs]);
  const id = sha256(JSON.stringify({ kind: spec.kind, key: spec.key, worker: worker.sha256, inputs: spec.inputs.map((x) => x.sha256).sort() })).slice(0, 16);
  rc.exec(c, rc.pyCall("analysis_submit", {
    id, token: randomUUID(), kind: spec.kind, inputs: spec.inputs.map(wire), worker: wire(worker), env: spec.env ?? {}, timeout: timeoutSec,
  }));
  rc.wait(c, `${REMOTE_ROOT}/jobs/${id}.started`, 180, "the VM to start the job");
  try {
    rc.wait(c, `${REMOTE_ROOT}/jobs/${id}.done`, timeoutSec + 60, "the job to finish");
  } catch (e: any) {
    // a local timeout does not stop anything on the VM: kill the job there too (the session keeps its lease)
    if (e.code === "colab_wait") {
      try {
        rc.exec(c, rc.pyCall("analysis_cancel", { id }), 60, 1);
      } catch {
        /* the lease still bounds the cost */
      }
    }
    throw e;
  }
  const job = rc.remoteJson(c, `${REMOTE_ROOT}/jobs/${id}.json`);
  if (job.id !== id) throw new VosError("remote_bad_result", `the VM answered for job ${job.id}, not ${id}`);
  if (job.state !== "ok") {
    throw new VosError("remote_job_failed", `${spec.kind} failed on the VM`, String(job.error ?? "").slice(-800) + (job.stderr_tail ? "\n" + String(job.stderr_tail).slice(-400) : ""));
  }
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "vosana-")), `${id}.jsonl`);
  rc.download(c, `${REMOTE_ROOT}/jobs/${id}.jsonl`, tmp);
  const body = fs.readFileSync(tmp);
  if (sha256(body) !== job.lines_sha256) throw new VosError("remote_bad_result", "the downloaded result does not match its checksum", "run the command again (the job is cached on the VM only until the session ends)");
  const want = new Set(spec.inputs.map((x) => x.sha256));
  const lines = body.toString("utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const got = new Set<string>();
  for (const l of lines) {
    if (!want.has(l.sha256) || got.has(l.sha256)) throw new VosError("remote_bad_result", `the result carries an answer for an input that was not sent (${String(l.sha256).slice(0, 12)})`);
    got.add(l.sha256);
  }
  if (got.size !== want.size) throw new VosError("remote_bad_result", `the result answers ${got.size} of ${want.size} input(s)`);
  return { id, job, lines, worker_sha256: worker.sha256, transfer };
}
