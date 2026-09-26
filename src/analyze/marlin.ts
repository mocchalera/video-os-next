import * as fs from "node:fs";
import * as path from "node:path";
import { MARLIN_WORKER, marlinPython } from "../core/config.ts";
import { sha256 } from "../core/hash.ts";
import { P, requireOnline, resolveAsset, type Project } from "../core/project.ts";
import { readJsonIf, run, stableStringify, VosError, writeJson } from "../core/util.ts";
import { analysisColab, inputOf, oneLinePerInput, PROFILES, runJob } from "../remote/analysis.ts";

export interface MarlinEvent {
  start: number;
  end: number;
  description: string;
}

export interface DescribeRecord {
  format: "vos.describe/1";
  asset: string; // content id
  scene: string;
  events: MarlinEvent[];
  finds: { query: string; start: number; end: number }[];
  provenance: {
    producer: string; // "marlin-local" | "marlin-colab"
    model: string;
    at: string;
    note?: string;
    key?: string; // remote results: hash of input bytes + model revision + worker + settings; same key = reuse
    ran?: RemoteRun;
  };
}

/** Where a remote result actually ran. Not part of the key: two GPUs may differ in the last bits, the inputs did not. */
export interface RemoteRun {
  backend: "colab";
  session: string;
  job: string;
  gpu: string | null;
  dtype: string;
  versions: Record<string, unknown> | null;
  revision: string;
  worker_sha256: string;
  input_sha256: string;
  sec: number | null;
}

export const describePath = (p: Project, id: string) => path.join(P.analysis(p.root, id), "describe.json");

export function readDescribe(p: Project, id: string): DescribeRecord | null {
  return readJsonIf<DescribeRecord | null>(describePath(p, id), null);
}

function worker(args: string[]): any {
  const py = marlinPython();
  if (!py) throw new VosError("marlin_unavailable", "no Python with Marlin deps configured", "set VOS_MARLIN_PYTHON or `vos doctor --write` (needs torch + transformers + a local Marlin-2B snapshot)");
  const r = run(py, [MARLIN_WORKER, ...args], { env: { ...process.env, HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" }, timeout: 20 * 60 * 1000 });
  const line = r.stdout.trim().split("\n").filter((l) => l.startsWith("{")).pop();
  if (!line) throw new VosError("marlin_failed", `Marlin worker produced no result (exit ${r.status}): ${r.stderr.trim().split("\n").slice(-5).join(" | ")}`);
  const j = JSON.parse(line);
  if (!j.ok) throw new VosError("marlin_failed", j.error ?? "unknown Marlin error");
  return j;
}

function num(x: any): number {
  return typeof x === "number" ? x : Number(x);
}

/** Describe several assets with one model load. Returns per-alias record or error. */
export function describeMany(p: Project, aliases: string[]): { alias: string; ok: boolean; error?: string }[] {
  const py = marlinPython();
  if (!py) throw new VosError("marlin_unavailable", "no Python with Marlin deps configured", "expected python/.venv");
  const assets = aliases.map((al) => resolveAsset(p, al)).filter((a) => a.kind === "video");
  const byPath = new Map(assets.map((a) => [requireOnline(a), a]));
  const r = run(py, [MARLIN_WORKER, "caption", ...byPath.keys()], { env: { ...process.env, HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" }, timeout: 6 * 60 * 60 * 1000 });
  const out: { alias: string; ok: boolean; error?: string }[] = [];
  for (const line of r.stdout.split("\n").filter((l) => l.startsWith("{"))) {
    const j = JSON.parse(line);
    const a = byPath.get(j.video);
    if (!a) continue;
    if (!j.ok) { out.push({ alias: a.alias, ok: false, error: j.error }); continue; }
    const res = j.result ?? {};
    const prev = readDescribe(p, a.id);
    writeJson(describePath(p, a.id), {
      format: "vos.describe/1", asset: a.id, scene: String(res.scene ?? res.caption ?? ""),
      events: (res.events ?? []).map((e: any) => ({ start: num(e.start ?? e.start_sec), end: num(e.end ?? e.end_sec), description: String(e.description ?? "") })),
      finds: prev?.finds ?? [], provenance: { producer: "marlin-local", model: j.model, at: new Date().toISOString() },
    } satisfies DescribeRecord);
    out.push({ alias: a.alias, ok: true });
  }
  if (!out.length) throw new VosError("marlin_failed", `Marlin produced no results (exit ${r.status}): ${r.stderr.trim().split("\n").slice(-4).join(" | ")}`);
  return out;
}

const MAX_TOKENS = () => process.env.VOS_MARLIN_MAX_TOKENS ?? "2048";

export interface RemoteDescribeOptions {
  session?: string;
  force?: boolean;
  timeoutSec?: number;
}

export type RemoteDescribeOutcome = { alias: string; ok: boolean; status: "built" | "fresh" | "failed"; error?: string };

/**
 * `vos describe --on colab`: the same Marlin worker, run on the analysis VM, one model load for the batch.
 * Only the videos travel (deduplicated by full SHA-256 on the VM). A result is reused when its key matches:
 * same bytes, model revision, worker and settings. Written in the same vos.describe/1 form as local results.
 */
export function describeRemote(p: Project, aliases: string[], o: RemoteDescribeOptions = {}): RemoteDescribeOutcome[] {
  const prof = PROFILES.marlin;
  const settings = { model: prof.model, revision: prof.revision, max_tokens: MAX_TOKENS() };
  const workerSha = sha256(fs.readFileSync(MARLIN_WORKER));
  const out: RemoteDescribeOutcome[] = [];
  const todo: { alias: string; id: string; key: string; input: ReturnType<typeof inputOf> }[] = [];
  for (const al of aliases) {
    const a = resolveAsset(p, al);
    if (a.kind !== "video") throw new VosError("not_video", `describe needs a video asset; "${a.alias}" is ${a.kind}`);
    const input = inputOf(requireOnline(a));
    const key = sha256(stableStringify({ v: 1, input: input.sha256, worker: workerSha, ...settings })).slice(0, 16);
    const prev = readDescribe(p, a.id);
    if (!o.force && prev?.provenance.key === key) {
      out.push({ alias: a.alias, ok: true, status: "fresh" });
      continue;
    }
    todo.push({ alias: a.alias, id: a.id, key, input });
  }
  if (!todo.length) return out;
  const c = analysisColab(o.session);
  const inputs = [...new Map(todo.map((t) => [t.input.sha256, t.input])).values()];
  const r = runJob(c, "marlin", { kind: "describe", inputs, worker: MARLIN_WORKER, files: ["jsonl"], env: { VOS_MARLIN_MAX_TOKENS: settings.max_tokens }, key: settings }, o.timeoutSec ?? 3600);
  if (r.worker_sha256 !== workerSha) throw new VosError("remote_bad_result", "the Marlin worker changed while the job ran; run again");
  const bySha = new Map(oneLinePerInput(r.files.jsonl, inputs).map((l) => [l.sha256, l]));
  const versions = r.job.versions ?? null;
  for (const t of todo) {
    const l = bySha.get(t.input.sha256)!;
    if (!l.ok) {
      out.push({ alias: t.alias, ok: false, status: "failed", error: String(l.error ?? "unknown Marlin error") });
      continue;
    }
    const res = l.result ?? {};
    const events: MarlinEvent[] = (res.events ?? []).map((e: any) => ({ start: num(e.start ?? e.start_sec), end: num(e.end ?? e.end_sec), description: String(e.description ?? "") }));
    const bad = events.find((e) => !Number.isFinite(e.start) || !Number.isFinite(e.end) || e.end < e.start);
    if (bad) {
      out.push({ alias: t.alias, ok: false, status: "failed", error: `Marlin returned an unusable event span ${bad.start}–${bad.end}` });
      continue;
    }
    const prev = readDescribe(p, t.id);
    writeJson(describePath(p, t.id), {
      format: "vos.describe/1", asset: t.id, scene: String(res.scene ?? res.caption ?? ""), events, finds: prev?.finds ?? [],
      provenance: {
        producer: "marlin-colab", model: prof.model, at: new Date().toISOString(), key: t.key,
        ran: {
          backend: "colab", session: c.session, job: r.id, gpu: (versions?.gpu as string) ?? null,
          dtype: versions?.bf16 === false ? "bfloat16 (emulated: GPU has no bf16)" : "bfloat16", versions, revision: prof.revision,
          worker_sha256: r.worker_sha256, input_sha256: t.input.sha256, sec: r.job.sec ?? null,
        },
      },
    } satisfies DescribeRecord);
    out.push({ alias: t.alias, ok: true, status: "built" });
  }
  return out;
}

export function describe(p: Project, alias: string): DescribeRecord {
  const a = resolveAsset(p, alias);
  if (a.kind !== "video") throw new VosError("not_video", `describe needs a video asset; "${a.alias}" is ${a.kind}`);
  const j = worker(["caption", requireOnline(a)]);
  const res = j.result ?? {};
  const events: MarlinEvent[] = (res.events ?? []).map((e: any) => ({ start: num(e.start ?? e.start_sec), end: num(e.end ?? e.end_sec), description: String(e.description ?? "") }));
  const prev = readDescribe(p, a.id);
  const rec: DescribeRecord = {
    format: "vos.describe/1",
    asset: a.id,
    scene: String(res.scene ?? res.caption ?? ""),
    events,
    finds: prev?.finds ?? [],
    provenance: { producer: "marlin-local", model: j.model, at: new Date().toISOString() },
  };
  writeJson(describePath(p, a.id), rec);
  return rec;
}

export function findInAsset(p: Project, alias: string, query: string): { start: number; end: number } {
  const a = resolveAsset(p, alias);
  const j = worker(["find", requireOnline(a), query]);
  const span = j.result?.span ?? [j.result?.start, j.result?.end];
  const hit = { start: num(span[0]), end: num(span[1]) };
  if (!Number.isFinite(hit.start) || !Number.isFinite(hit.end)) throw new VosError("marlin_failed", `Marlin returned no span for "${query}"`);
  const rec = readDescribe(p, a.id) ?? { format: "vos.describe/1", asset: a.id, scene: "", events: [], finds: [], provenance: { producer: "marlin-local", model: j.model, at: new Date().toISOString() } };
  rec.finds = [...rec.finds.filter((f) => f.query !== query), { query, ...hit }];
  writeJson(describePath(p, a.id), rec);
  return hit;
}

export interface TextHit {
  alias: string;
  start: number;
  end: number;
  text: string;
  score: number;
  source: "event" | "scene" | "find";
}

/** Lexical search over stored descriptions (fast, offline, no model). */
export function searchDescriptions(p: Project, query: string, limit = 10): TextHit[] {
  const STOP = new Set(["the", "and", "for", "with", "that", "this", "from", "into", "onto", "are", "was", "his", "her", "its", "their", "some", "someone", "something", "showing", "shows", "while", "over", "under", "near"]);
  const terms = query.toLowerCase().split(/[\s,、。]+/).filter((t) => t.length > 2 && !STOP.has(t));
  const hits: TextHit[] = [];
  for (const [alias, rec] of Object.entries(p.assets.assets)) {
    const d = readDescribe(p, rec.id);
    if (!d) continue;
    const score = (text: string) => {
      const t = text.toLowerCase();
      return terms.reduce((s, term) => s + (t.includes(term) ? 1 : 0), 0) / Math.max(1, terms.length);
    };
    for (const e of d.events) {
      const s = score(e.description);
      if (s > 0) hits.push({ alias, start: e.start, end: e.end, text: e.description, score: s, source: "event" });
    }
    for (const f of d.finds) if (f.query.toLowerCase() === query.toLowerCase()) hits.push({ alias, start: f.start, end: f.end, text: `find: ${f.query}`, score: 1.5, source: "find" });
    const s = score(d.scene);
    if (s > 0) hits.push({ alias, start: 0, end: rec.duration ?? 0, text: d.scene.slice(0, 160), score: s * 0.8, source: "scene" });
  }
  return hits.sort((a, b) => b.score - a.score || a.alias.localeCompare(b.alias) || a.start - b.start).slice(0, limit);
}

export function analysisCoverage(p: Project): Record<string, { describe: boolean; beats: boolean }> {
  const out: Record<string, { describe: boolean; beats: boolean }> = {};
  for (const [alias, rec] of Object.entries(p.assets.assets)) {
    const dir = P.analysis(p.root, rec.id);
    out[alias] = { describe: fs.existsSync(path.join(dir, "describe.json")), beats: fs.existsSync(path.join(dir, "beats.json")) };
  }
  return out;
}
