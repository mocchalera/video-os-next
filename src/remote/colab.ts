import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { REPO } from "../core/config.ts";
import { readJson, run, VosError } from "../core/util.ts";

/**
 * Shared plumbing for guarded Colab sessions (vos gen, vos remote). Every billable second goes through the guard
 * (scripts/colab/vos-colab): a lease that stops the VM when nobody renews it, a hard budget, a deadline, verified
 * release. Nothing here calls `colab new/stop` directly; file transfer uses the colab client's upload/download.
 *
 * A `Colab` handle is one named session plus the words its errors use (so `vos gen` keeps saying `vos gen …`).
 */

export const GUARD = () => process.env.VOS_COLAB_GUARD ?? path.join(REPO, "scripts", "colab", "vos-colab");
export const COLAB = () => process.env.VOS_COLAB_BIN ?? "colab";

export interface Colab {
  session: string;
  /** how the human-facing commands are spelled, e.g. "vos gen" or "vos remote" */
  cli: string;
  /** error code when no session is running */
  notUp: string;
  /** error code when the guard stopped the session while we waited */
  stopped: string;
}

export interface StartOptions {
  gpu: string;
  budgetCu: number;
  maxHours: number;
  leaseMin: number;
}

export function guard(args: string[], timeoutMs = 120_000): any {
  const r = run(GUARD(), args, { timeout: timeoutMs });
  const line = r.stdout.trim().split("\n").filter((l) => l.startsWith("{") || l.startsWith("[")).pop();
  if (r.status !== 0 && !line) throw new VosError("colab_guard", `vos-colab ${args[0]} failed (exit ${r.status})`, r.stderr.slice(-600));
  try {
    return line ? JSON.parse(line) : { ok: r.status === 0 };
  } catch {
    // status prints indented JSON across lines
    return JSON.parse(r.stdout);
  }
}

/**
 * Run a snippet in the session kernel. Retries once after a dropped connection, so every snippet sent must be
 * idempotent: worker loads, bootstraps, and submits that carry a client token the VM deduplicates on.
 */
export function exec(c: Colab, code: string, timeoutSec = 120, attempts = 2): void {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "voscolab-")), "cmd.py");
  fs.writeFileSync(f, code);
  let last = "";
  for (let i = 0; i < attempts; i++) {
    const r = run(GUARD(), ["exec", c.session, "-f", f, "--timeout", String(timeoutSec)], { timeout: (timeoutSec + 60) * 1000 });
    if (r.status === 0 || /"ok": true/.test(r.stdout)) return;
    last = (r.stdout + r.stderr).slice(-800);
  }
  throw new VosError("colab_exec", `remote exec failed after ${attempts} attempts`, last);
}

export function sessionRow(c: Colab): any | null {
  const s = guard(["status", c.session]);
  return (s.sessions ?? []).find((x: any) => x.name === c.session) ?? null;
}

export function running(c: Colab): any | null {
  const s = sessionRow(c);
  return s && s.state === "running" ? s : null;
}

export function requireRunning(c: Colab, hint = `ask the human for a compute budget, then \`${c.cli} up --budget-cu <N>\``): any {
  const s = running(c);
  if (!s) throw new VosError(c.notUp, `no running ${c.session} session`, hint);
  return s;
}

export function wait(c: Colab, remotePath: string, timeoutSec: number, what = remotePath): void {
  const r = run(GUARD(), ["wait", c.session, remotePath, "--timeout", String(timeoutSec), "--every", "15"], { timeout: (timeoutSec + 120) * 1000 });
  if (r.status === 0) return;
  const s = sessionRow(c);
  if (s && s.state !== "running") throw new VosError(c.stopped, `the guard stopped the session (${s.stop_reason}) while waiting for ${what}`, `check \`${c.cli} status\`; start again with a budget from the human`);
  throw new VosError("colab_wait", `timed out after ${timeoutSec}s waiting for ${what}`, `the VM is still leased; \`${c.cli} status\`, or \`${c.cli} down\` to stop paying`);
}

/** Extend the lease before a long local step (a big upload) so the dead-man switch does not fire mid-transfer. */
export function renew(c: Colab): void {
  run(GUARD(), ["renew", c.session], { timeout: 60_000 });
}

export function upload(c: Colab, local: string, remote: string, timeoutMs = 300_000): void {
  const r = run(COLAB(), ["upload", "-s", c.session, local, remote], { timeout: timeoutMs });
  if (r.status !== 0) throw new VosError("colab_upload", `could not upload ${path.basename(local)}`, r.stderr.slice(-400));
}

export function download(c: Colab, remotePath: string, local: string): void {
  fs.mkdirSync(path.dirname(local), { recursive: true });
  const r = run(COLAB(), ["download", "-s", c.session, remotePath, local], { timeout: 600_000 });
  if (r.status !== 0 || !fs.existsSync(local)) throw new VosError("colab_download", `could not download ${remotePath}`, r.stderr.slice(-400));
}

export function remoteJson(c: Colab, remotePath: string): any {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "voscolab-")), path.basename(remotePath));
  download(c, remotePath, tmp);
  return readJson(tmp);
}

/** Start a guarded session. Returns the guard's answer; throws on refusal (orphans, no balance, …). */
export function start(c: Colab, o: StartOptions): any {
  if (!(o.budgetCu > 0)) throw new VosError("usage", `${c.cli} up needs --budget-cu <N>`, "compute units cost money: get the number from the human");
  const s = guard(["start", c.session, "--gpu", o.gpu, "--budget-cu", String(o.budgetCu), "--max-hours", String(o.maxHours), "--lease-min", String(o.leaseMin)], 900_000);
  if (!s.ok) throw new VosError(`${c.cli.split(" ").pop()}_up_failed`, s.error ?? "could not start a guarded session", s.orphans ? "run `scripts/colab/vos-colab reap` after checking them" : undefined);
  return s;
}

export function stop(c: Colab): { ok: boolean; state: string } {
  const s = guard(["stop", c.session], 300_000);
  return { ok: !!s.ok, state: s.state };
}

/** Best effort: never leave a paid VM behind a failed setup (the lease would stop it anyway, later). */
export function stopQuietly(c: Colab): void {
  try {
    guard(["stop", c.session], 300_000);
  } catch {
    /* the lease stops it anyway */
  }
}

/**
 * A Python call snippet carrying one JSON argument. Passed through json.loads, never as a Python literal:
 * JSON's null/true/false are not Python (a `--dense` request, sol_tau null, used to die with NameError on the VM).
 */
export function pyCall(fn: string, arg: unknown): string {
  return `${fn}(__import__("json").loads(${JSON.stringify(JSON.stringify(arg))}))`;
}

/** Inverse of pyCall for fakes and tests: the argument of `fn(...)` in a snippet, or null. */
export function parsePyCall(fn: string, code: string): any | null {
  const m = new RegExp(`^${fn}\\(__import__\\("json"\\)\\.loads\\((.*)\\)\\)\\s*$`, "s").exec(code.trim());
  return m ? JSON.parse(JSON.parse(m[1])) : null;
}
