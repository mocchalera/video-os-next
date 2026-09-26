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
 * on its own. Analysis commands (`vos describe --on colab`, `vos index --on colab`, `vos find --on colab`) call
 * `runJob`; results come back verified and are written by the same code that writes local results, with provenance
 * that says where they ran.
 */

export const DEFAULT_SESSION = "vos-analysis";
export const REMOTE_ROOT = "/content/vosana";
const VM_WORKER = path.join(REPO, "python", "colab_analysis_vm.py");

/** What a profile needs on the VM. Pinned: changing any of these changes the cache keys of its results. */
export const PROFILES = {
  // gated on Hugging Face: the VM needs the human's token to download it (live 401, 2026-09-27)
  marlin: { model: "NemoStation/Marlin-2B", revision: "fd111fca4fc7897876fb0d7e9df22ca5ac8ab965", gpu: "L4", gated: true },
  // the visual search channel (src/analyze/embed.ts): same model and revision as the local snapshot
  visual: { model: "Qwen/Qwen3-VL-Embedding-2B", revision: "9f2f7e710d6d81056aa5c0a4f04764fec6bb7bda", gpu: "L4", gated: false },
} as const;
export type Profile = keyof typeof PROFILES;

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

function needToken(profiles: Profile[]): string | null {
  const gated = profiles.filter((p) => PROFILES[p].gated);
  if (!gated.length) return null;
  const f = hfTokenFile();
  if (!f) {
    throw new VosError("hf_token_missing", `${gated.map((p) => PROFILES[p].model).join(", ")} is gated on Hugging Face; the VM needs a token to download it`,
      "put a read-only Hugging Face token (with access to that repo) in ~/.config/vos/hf_token (chmod 600) or point VOS_HF_TOKEN_FILE at one; no VM was started");
  }
  return f;
}

export function analysisColab(session?: string): Colab {
  return { session: session || DEFAULT_SESSION, cli: "vos remote", notUp: "remote_not_up", stopped: "remote_stopped" };
}

export interface RemoteUpOptions {
  budgetCu: number;
  profile?: string; // "marlin", "visual" or "marlin,visual"
  gpu?: string;
  maxHours?: number;
  leaseMin?: number;
  wait?: boolean;
  session?: string;
}

export function profilesOf(spec?: string): Profile[] {
  const names = String(spec ?? "marlin").split(",").map((x) => x.trim()).filter(Boolean);
  for (const n of names) if (!(n in PROFILES)) throw new VosError("usage", `unknown profile ${n}`, `use ${Object.keys(PROFILES).join(" | ")} (comma-separated for several)`);
  return [...new Set(names)] as Profile[];
}

const wireProfiles = (ps: Profile[]) => ps.map((name) => ({ name, model: PROFILES[name].model, revision: PROFILES[name].revision }));

/** Load the worker and start its bootstrap; a gated model's token file travels by upload, never in the snippet. */
function bootstrapOn(c: Colab, profiles: Profile[], tokenFile: string | null): void {
  rc.exec(c, fs.readFileSync(VM_WORKER, "utf8"));
  if (tokenFile) rc.upload(c, tokenFile, REMOTE_TOKEN, 60_000);
  rc.exec(c, rc.pyCall("analysis_bootstrap", { profiles: wireProfiles(profiles), ...(tokenFile ? { token_file: REMOTE_TOKEN } : {}) }));
}

function readBoot(c: Colab): any | null {
  try {
    return rc.remoteJson(c, `${REMOTE_ROOT}/boot.json`);
  } catch {
    return null; // still booting, or never started
  }
}

const covers = (boot: any, ps: Profile[]) => ps.every((p) => boot?.profiles?.[p]?.revision === PROFILES[p].revision);

export function up(o: RemoteUpOptions) {
  const c = analysisColab(o.session);
  const want = profilesOf(o.profile);
  if (!(o.budgetCu > 0)) throw new VosError("usage", "vos remote up needs --budget-cu <N>", "compute units cost money: get the number from the human");
  if (rc.running(c)) {
    // A running session is extended in place: a failed bootstrap is retried, a missing profile is added (the
    // worker reload keeps its queue). A healthy session that already covers the request is left alone.
    const boot = readBoot(c);
    if (!boot || (boot.state === "ready" && covers(boot, want))) return { ok: true, session: c.session, status: "already_up" };
    const kept = boot.state === "ready" ? (Object.keys(boot.profiles ?? {}).filter((p) => p in PROFILES) as Profile[]) : [];
    const all = [...new Set([...kept, ...want])];
    bootstrapOn(c, all, needToken(all.filter((p) => !covers(boot, [p]))));
    const res: any = { ok: true, session: c.session, status: boot.state === "error" ? "rebooting" : "extending", profiles: all, bootstrap: "started",
      ...(boot.state === "error" ? { previous_error: String(boot.error ?? "").slice(-300) } : {}) };
    if (o.wait) res.boot = waitBoot(c, want);
    return res;
  }
  const tokenFile = needToken(want); // before any VM exists: a missing token must cost nothing
  const s = rc.start(c, { gpu: o.gpu ?? PROFILES[want[0]].gpu, budgetCu: o.budgetCu, maxHours: o.maxHours ?? 2, leaseMin: o.leaseMin ?? 20 });
  try {
    bootstrapOn(c, want, tokenFile);
    rc.wait(c, `${REMOTE_ROOT}/boot.started`, 90, "the bootstrap to start");
    const res: any = { ok: true, session: c.session, endpoint: s.endpoint, budget_cu: o.budgetCu, profiles: want, bootstrap: "started" };
    if (o.wait) res.boot = waitBoot(c, want);
    return res;
  } catch (e) {
    rc.stopQuietly(c); // never leave a paid VM behind a failed `up`
    throw e;
  }
}

export function waitBoot(c: Colab, profiles: Profile | Profile[], timeoutSec = 1500): any {
  const ps = Array.isArray(profiles) ? profiles : [profiles];
  rc.wait(c, `${REMOTE_ROOT}/boot.started`, 90, "the bootstrap to start (was `vos remote up` interrupted?)");
  rc.wait(c, `${REMOTE_ROOT}/boot.done`, timeoutSec, "the bootstrap to finish");
  const boot = rc.remoteJson(c, `${REMOTE_ROOT}/boot.json`);
  if (boot.state !== "ready") throw new VosError("remote_boot_failed", "VM bootstrap failed", String(boot.error ?? "").slice(-800));
  const missing = ps.filter((p) => !covers(boot, [p]));
  if (missing.length) {
    const have = Object.entries(boot.profiles ?? {}).map(([k, v]: [string, any]) => `${k}@${String(v.revision).slice(0, 8)}`).join(", ") || "nothing";
    throw new VosError("remote_wrong_profile", `the ${c.session} session is set up for ${have}, not ${missing.join(", ")}`, `\`vos remote up --profile ${missing.join(",")} --budget-cu <N>\` adds it to the running session`);
  }
  return boot;
}

export function status(session?: string) {
  const c = analysisColab(session);
  const g = rc.guard(["status", c.session]);
  const s = (g.sessions ?? []).find((x: any) => x.name === c.session) ?? null;
  let boot: any = null;
  if (s?.state === "running") boot = readBoot(c) ?? { state: "starting" };
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
  kind: "describe" | "embed";
  inputs: RemoteInput[];
  worker: string; // local path of the repo worker the VM runs
  files: string[]; // result files the job must publish (e.g. "jsonl", "f32")
  env?: Record<string, string>;
  extra?: Record<string, unknown>; // kind-specific request fields (channel, items)
  key: unknown; // everything that determines the result; the job id is its hash
}

export interface JobResult {
  id: string;
  job: any; // the VM's report: versions, gpu, sec, …
  files: Record<string, Buffer>; // verified against the report's SHA-256 and size
  worker_sha256: string;
  transfer: { uploaded: number; bytes: number; reused: number };
}

/**
 * Run one job and bring back verified results: the report names this job, and every result file it lists matches
 * its checksum and size. Kind-specific checks (one answer per input, row counts) belong to the caller.
 */
export function runJob(c: Colab, profile: Profile, spec: JobSpec, timeoutSec = 3600): JobResult {
  rc.requireRunning(c, `ask the human for a compute budget, then \`vos remote up --profile ${profile} --budget-cu <N>\``);
  waitBoot(c, profile);
  const worker = inputOf(spec.worker);
  const transfer = ensureInputs(c, [worker, ...spec.inputs]);
  const id = sha256(JSON.stringify({ kind: spec.kind, key: spec.key, worker: worker.sha256, inputs: spec.inputs.map((x) => x.sha256).sort(), extra: spec.extra ?? null })).slice(0, 16);
  rc.exec(c, rc.pyCall("analysis_submit", {
    id, token: randomUUID(), kind: spec.kind, inputs: spec.inputs.map(wire), worker: wire(worker), env: spec.env ?? {}, timeout: timeoutSec, ...(spec.extra ?? {}),
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vosana-"));
  const files: Record<string, Buffer> = {};
  for (const name of spec.files) {
    const f = job.files?.[name];
    if (!f) throw new VosError("remote_bad_result", `the job published no ${name} result`);
    const tmp = path.join(dir, `${id}.${name}`);
    rc.download(c, f.path, tmp);
    const body = fs.readFileSync(tmp);
    if (body.length !== f.bytes || sha256(body) !== f.sha256) {
      throw new VosError("remote_bad_result", `the downloaded ${name} result does not match its checksum`, "run the command again (the job's files stay on the VM until the session ends)");
    }
    files[name] = body;
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return { id, job, files, worker_sha256: worker.sha256, transfer };
}

/** describe-style results: exactly one JSON line per input, each for an input that was sent. */
export function oneLinePerInput(body: Buffer, inputs: RemoteInput[]): any[] {
  const want = new Set(inputs.map((x) => x.sha256));
  const lines = body.toString("utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const got = new Set<string>();
  for (const l of lines) {
    if (!want.has(l.sha256) || got.has(l.sha256)) throw new VosError("remote_bad_result", `the result carries an answer for an input that was not sent (${String(l.sha256).slice(0, 12)})`);
    got.add(l.sha256);
  }
  if (got.size !== want.size) throw new VosError("remote_bad_result", `the result answers ${got.size} of ${want.size} input(s)`);
  return lines;
}

/** float32 rows: exactly n rows of dim, all finite. */
export function rowsOf(body: Buffer, n: number, dim: number): Float32Array[] {
  if (!(dim > 0) || body.length !== n * dim * 4) throw new VosError("remote_bad_result", `expected ${n}×${dim} float32 values, got ${body.length} bytes`);
  const all = new Float32Array(body.buffer.slice(body.byteOffset, body.byteOffset + body.length));
  for (let i = 0; i < all.length; i++) if (!Number.isFinite(all[i])) throw new VosError("remote_bad_result", "the embedding contains a non-finite value");
  const rows: Float32Array[] = [];
  for (let i = 0; i < n; i++) rows.push(all.slice(i * dim, (i + 1) * dim));
  return rows;
}
