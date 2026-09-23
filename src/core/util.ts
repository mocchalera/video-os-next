import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export class VosError extends Error {
  code: string;
  hint?: string;
  constructor(code: string, message: string, hint?: string) {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}

export function readJson<T = any>(file: string): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch (e: any) {
    throw new VosError("json_read_failed", `${file}: ${e.message}`);
  }
}

export function readJsonIf<T = any>(file: string, fallback: T): T {
  return fs.existsSync(file) ? readJson<T>(file) : fallback;
}

/** Stable JSON: sorted keys, 2-space indent, trailing newline. Deterministic output matters. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value), null, 2) + "\n";
}

function sortKeys(v: any): any {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const out: Record<string, any> = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
    return out;
  }
  return v;
}

export function writeJson(file: string, value: unknown, stable = true): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = stable ? stableStringify(value) : JSON.stringify(value, null, 2) + "\n";
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

export interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

export function run(cmd: string, args: string[], opts: SpawnSyncOptions = {}): RunResult {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 1 << 28, ...opts });
  if (r.error) throw new VosError("spawn_failed", `${cmd}: ${r.error.message}`);
  return { status: r.status ?? -1, stdout: String(r.stdout ?? ""), stderr: String(r.stderr ?? "") };
}

export function runOk(cmd: string, args: string[], opts: SpawnSyncOptions = {}): RunResult {
  const r = run(cmd, args, opts);
  if (r.status !== 0) {
    const tail = r.stderr.trim().split("\n").slice(-6).join("\n");
    throw new VosError("command_failed", `${cmd} ${args.slice(0, 4).join(" ")} … exited ${r.status}\n${tail}`);
  }
  return r;
}

export function which(bin: string): string | null {
  const r = spawnSync("/usr/bin/which", [bin], { encoding: "utf8" });
  return r.status === 0 ? String(r.stdout).trim() : null;
}

export function slug(s: string): string {
  const base = s
    .normalize("NFKC")
    .replace(/\.[^.]+$/, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/g, "");
  return base || "asset";
}

export function round(n: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
