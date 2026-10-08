import * as fs from "node:fs";
import * as path from "node:path";
import { find, type FindResult } from "../analyze/embed.ts";
import { describePath, readDescribe } from "../analyze/marlin.ts";
import { readTranscript, transcriptPath } from "../analyze/transcribe.ts";
import { sha256, sha256File } from "../core/hash.ts";
import { P, requireOnline, resolveAsset, type Project } from "../core/project.ts";
import { readJsonIf, round, stableStringify, VosError, writeJson } from "../core/util.ts";
import { frameTable, snap, type FrameTable, type Snap } from "./pts.ts";
import { loadRubric, purposeOf } from "./rubric.ts";

/**
 * The candidate pool: one frozen list both runners judge. Built only from what the project already knows
 * (Marlin events, ASR segments, the existing fused search) plus seeded coverage windows that no artifact
 * proposed (to see what the artifacts miss). Read-only towards the project: `find` reads indexes; the
 * per-clip Marlin find (which writes describe.json) is never used. Artifact hashes are taken before and after,
 * and the runners refuse a pool whose artifacts changed since.
 */

export type Origin = "event" | "asr" | "search" | "coverage";

export interface PoolSource {
  alias: string;
  content_id: string; // vos content id (size + first/last 4 MiB; a short identity, not a full hash)
  sha256: string; // full-file SHA-256
  size: number;
  filename_sha256: string; // the name is not stored (it can carry personal data); its hash is
  frames: Omit<FrameTable, "t"> & { frame_count: number };
  artifacts: Record<string, string | null>; // artifact file → sha256 (null = absent)
  transcript_segments: { start: number; end: number; text: string }[];
}

export interface Bound {
  claimed: number; // the artifact's own time (media seconds as the artifact states it)
  frame: { index: number; t: number; next_t: number } | null; // the real frame on screen at that time
  flag?: Snap["flag"];
}

export interface Candidate {
  id: string;
  source: string; // alias
  origins: Origin[];
  start: Bound;
  end: Bound;
  text?: string; // event description / transcript text / search text
  search?: { score: number; channels: Record<string, number> }; // fused rank score of the existing search
  coverage?: { stratum: number; overlaps_artifact_candidate: boolean };
}

export interface Pool {
  format: "vos.judge-pool/1";
  created_at: string;
  purpose: string;
  query: string;
  seed: number;
  rubric: { id: string; version: string; sha256: string };
  params: { coverage_window: number; coverage_per_30s: number; coverage_max: number; search_limit: number; merge_iou: number };
  sources: PoolSource[];
  search: { channels_used: string[]; channels_unavailable: FindResult["channels_unavailable"]; hits: number };
  candidates: Candidate[];
  artifacts_before: string; // digest of every source's artifact hashes before the search ran
  artifacts_after: string; // … and after; equal, or the pool is refused
  digest: string; // sha256 of the candidate list
}

/** Full-file SHA-256, remembered per content id + size + mtime. */
function fullSha(file: string, contentId: string, cacheDir: string): string {
  const st = fs.statSync(file);
  const stamp = path.join(cacheDir, "sha256", `${contentId}.json`);
  const s = readJsonIf<{ size: number; mtime_ms: number; sha256: string } | null>(stamp, null);
  if (s && s.size === st.size && s.mtime_ms === st.mtimeMs) return s.sha256;
  const h = sha256File(file);
  writeJson(stamp, { size: st.size, mtime_ms: st.mtimeMs, sha256: h });
  return h;
}

const ARTIFACTS = ["describe.json", "transcript.json", "embed.text.json", "embed.text.f32", "embed.visual.json", "embed.visual.f32", "embed.audio.json", "embed.audio.f32"];

export function artifactHashes(p: Project, contentId: string): Record<string, string | null> {
  const dir = P.analysis(p.root, contentId);
  const out: Record<string, string | null> = {};
  for (const f of ARTIFACTS) out[f] = fs.existsSync(path.join(dir, f)) ? sha256File(path.join(dir, f)) : null;
  return out;
}

/** Seeded PRNG (mulberry32): coverage windows are reproducible from (seed, content id). */
function rng(seedText: string): () => number {
  let a = parseInt(sha256(seedText).slice(0, 8), 16) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const iou = (a: [number, number], b: [number, number]) => {
  const inter = Math.max(0, Math.min(a[1], b[1]) - Math.max(a[0], b[0]));
  const uni = Math.max(a[1], b[1]) - Math.min(a[0], b[0]);
  return uni > 0 ? inter / uni : a[0] === b[0] ? 1 : 0;
};

function bound(table: FrameTable, t: number): Bound {
  const s = snap(table, t);
  const bad = s.flag === "past_trusted";
  return { claimed: round(t, 3), frame: bad ? null : { index: s.index, t: s.t, next_t: s.next_t }, ...(s.flag ? { flag: s.flag } : {}) };
}

export interface PoolOptions {
  aliases?: string[];
  purpose: string;
  query?: string;
  seed?: number;
  coverageWindow?: number;
  coveragePer30s?: number;
  coverageMax?: number;
  searchLimit?: number;
  cacheDir?: string;
  /** injected for tests; defaults to the project's fused search */
  search?: (p: Project, query: string, limit: number) => FindResult;
}

export function buildPool(p: Project, o: PoolOptions): Pool {
  const { rubric, ref } = loadRubric();
  const purpose = purposeOf(rubric, o.purpose);
  const query = o.query ?? purpose.query;
  const seed = o.seed ?? 1;
  const params = { coverage_window: o.coverageWindow ?? 2, coverage_per_30s: o.coveragePer30s ?? 1, coverage_max: o.coverageMax ?? 6, search_limit: o.searchLimit ?? 300, merge_iou: 0.8 };
  const cacheDir = o.cacheDir ?? path.join(P.cache(p.root), "judge");
  const aliases = o.aliases?.length ? o.aliases : Object.entries(p.assets.assets).filter(([, a]) => a.kind === "video").map(([al]) => al);
  if (!aliases.length) throw new VosError("usage", "no video assets to judge");

  const sources: PoolSource[] = [];
  const tables = new Map<string, FrameTable>();
  for (const al of aliases) {
    const a = resolveAsset(p, al);
    if (a.kind !== "video") throw new VosError("not_video", `"${a.alias}" is ${a.kind}; the pool takes video assets`);
    const file = requireOnline(a);
    const table = frameTable(file, a.id, cacheDir);
    tables.set(a.alias, table);
    const { t: _t, ...frames } = table;
    const tr = readTranscript(p, a.id);
    sources.push({
      alias: a.alias, content_id: a.id, sha256: fullSha(file, a.id, cacheDir), size: a.size, filename_sha256: sha256(a.filename),
      frames: { ...frames, frame_count: table.t.length }, artifacts: artifactHashes(p, a.id),
      transcript_segments: (tr?.segments ?? []).map((s) => ({ start: s.start, end: s.end, text: s.text })),
    });
  }
  const before = sha256(stableStringify(sources.map((s) => [s.content_id, s.artifacts])));

  // the existing search, exactly as `vos find` would answer it (read-only)
  const search = (o.search ?? ((pp, q, limit) => find(pp, q, { limit, perChannel: limit })))(p, query, params.search_limit);
  const inPool = new Set(aliases.map((al) => resolveAsset(p, al).alias));

  type Raw = Omit<Candidate, "id" | "start" | "end"> & { s: number; e: number };
  const raws: Raw[] = [];
  for (const src of sources) {
    const d = readDescribe(p, src.content_id);
    for (const ev of d?.events ?? []) raws.push({ source: src.alias, origins: ["event"], s: ev.start, e: ev.end, text: ev.description });
    for (const sg of src.transcript_segments) raws.push({ source: src.alias, origins: ["asr"], s: sg.start, e: sg.end, text: sg.text });
  }
  for (const h of search.hits) {
    if (!inPool.has(h.alias)) continue;
    raws.push({ source: h.alias, origins: ["search"], s: h.start, e: h.end, text: h.text, search: { score: h.score, channels: h.channels as Record<string, number> } });
  }
  // merge near-identical spans of one source (keep every origin and the best search evidence)
  const merged: Raw[] = [];
  for (const r of raws.sort((a, b) => a.source.localeCompare(b.source) || a.s - b.s || a.e - b.e)) {
    const m = merged.find((x) => x.source === r.source && iou([x.s, x.e], [r.s, r.e]) >= params.merge_iou);
    if (!m) {
      merged.push({ ...r, origins: [...r.origins] });
      continue;
    }
    for (const og of r.origins) if (!m.origins.includes(og)) m.origins.push(og);
    if (r.search && (!m.search || r.search.score > m.search.score)) m.search = r.search;
    if (r.text && !m.text) m.text = r.text;
  }
  // coverage windows: stratified, seeded; audit units the artifacts did not have to propose
  for (const src of sources) {
    const table = tables.get(src.alias)!;
    const dur = table.last_frame_end;
    const w = Math.min(params.coverage_window, dur);
    const n = Math.max(1, Math.min(params.coverage_max, Math.ceil((dur / 30) * params.coverage_per_30s)));
    const rand = rng(`${seed}:${src.content_id}`);
    for (let k = 0; k < n; k++) {
      const lo = (dur * k) / n, hi = Math.max(lo, (dur * (k + 1)) / n - w);
      const s = round(lo + (hi - lo) * rand(), 3);
      const e = round(Math.min(dur, s + w), 3);
      const overlaps = merged.some((m) => m.source === src.alias && Math.min(m.e, e) - Math.max(m.s, s) > 0);
      merged.push({ source: src.alias, origins: ["coverage"], s, e, coverage: { stratum: k, overlaps_artifact_candidate: overlaps } });
    }
  }
  const candidates: Candidate[] = merged
    .sort((a, b) => a.source.localeCompare(b.source) || a.s - b.s || a.e - b.e || a.origins.join().localeCompare(b.origins.join()))
    .map((r, i) => {
      const table = tables.get(r.source)!;
      const { s, e, ...rest } = r;
      return { id: `c${String(i).padStart(4, "0")}`, ...rest, start: bound(table, s), end: bound(table, Math.max(s, e)) };
    });

  const afterSources = sources.map((s) => [s.content_id, artifactHashes(p, s.content_id)]);
  const after = sha256(stableStringify(afterSources));
  if (after !== before) throw new VosError("artifacts_changed", "describe / transcript / index files changed while the pool was being built", "another process is writing the analysis; build the pool again when it is done");
  return {
    format: "vos.judge-pool/1", created_at: new Date().toISOString(), purpose: o.purpose, query, seed, rubric: { id: ref.id, version: ref.version, sha256: ref.sha256 }, params,
    sources, search: { channels_used: search.channels_used, channels_unavailable: search.channels_unavailable, hits: search.hits.length },
    candidates, artifacts_before: before, artifacts_after: after, digest: sha256(stableStringify(candidates)),
  };
}

/** Refuse a pool whose sources or artifacts are no longer what it was built from. */
export function checkPoolFresh(p: Project, pool: Pool): void {
  if (sha256(stableStringify(pool.candidates)) !== pool.digest) throw new VosError("stale_pool", "pool.json was edited after it was built (candidate digest differs)");
  for (const s of pool.sources) {
    const now = artifactHashes(p, s.content_id);
    if (stableStringify(now) !== stableStringify(s.artifacts)) throw new VosError("stale_pool", `the analysis of ${s.alias} changed since the pool was built`, "build a new pool; both runners must judge the same frozen inputs");
    const a = resolveAsset(p, s.alias);
    if (a.id !== s.content_id) throw new VosError("stale_pool", `${s.alias} now points to other content`);
  }
}

export const poolArtifactFiles = (p: Project, id: string) => ({ describe: describePath(p, id), transcript: transcriptPath(p, id) });
