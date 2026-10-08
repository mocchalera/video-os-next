import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { REPO } from "../core/config.ts";
import { sha256, sha256File } from "../core/hash.ts";
import { requireOnline, resolveAsset, type Project } from "../core/project.ts";
import { round, stableStringify, VosError, writeJson } from "../core/util.ts";
import { checkDisk, D1_PIN, decide, RUNNER_PIN, type CallRecord, type Endpoint } from "./d1.ts";
import { checkPoolFresh, type Candidate, type Pool } from "./pool.ts";
import { extractFrame, frameTable, framesIn, snap, toolVersions, type FrameTable } from "./pts.ts";
import { aggregate, interpret, loadRubric, purposeOf, questionsFor, type Aggregate, type CriterionResult, type Question, type Rubric } from "./rubric.ts";

/**
 * Two runners over one frozen pool.
 *   baseline — the existing search only: rank = fused search score of the candidate (0 when the search did not
 *              surface it); in/out = the artifact's own span snapped to real frames.
 *   d1       — rubric questions on representative frames (one pass per frame, all questions at once), then the
 *              highest-scoring candidates are looked at densely on real frame times to place in/out.
 * Every frame cited is an extracted image whose decoder PTS was checked; every answer keeps its probabilities.
 */

export interface FrameRef {
  source: string;
  index: number;
  t: number; // media seconds of the real frame
  observed_t: number; // what the decoder delivered when the image was extracted
  file: string; // relative to the run directory
  sha256: string;
}

export interface Bounds {
  in: number | null;
  out: number | null;
  basis: "artifact_span" | "frames" | "transcript" | "none";
  /** where the true boundary can lie given the frames looked at (estimate, not an observation). null on a side
   *  that is `open`: the run reached the edge of what was looked at, so the cut may lie anywhere beyond it */
  in_range?: [number | null, number];
  out_range?: [number, number | null];
  open?: ("in" | "out")[]; // the good run touched the edge of what was looked at
  note?: string;
}

export interface Judged {
  candidate: string;
  source: string;
  origins: string[];
  rank: number;
  score: number | null;
  decision: "judged" | "undeterminable" | "abstained";
  reason?: string;
  confidence: number | null;
  evidence?: number;
  criteria?: Record<string, CriterionResult>;
  frames?: { ref: FrameRef; criteria: Record<string, CriterionResult>; frame_score: number | null }[];
  refine?: { frames: { ref: FrameRef; value: number | null; status: string }[]; peak: FrameRef | null; vmax: number | null; threshold: number | null; status: string };
  bounds: Bounds;
}

export interface RunResult {
  format: "vos.judge-result/1";
  runner: "baseline" | "d1";
  created_at: string;
  pool: { digest: string; purpose: string; query: string; seed: number; candidates: number; rubric_sha256: string };
  manifest: Record<string, unknown>;
  ranked: Judged[];
  resources: Record<string, unknown>;
}

/** Which code made a result: commit, tree, and — when the checkout is not clean — what differs (hashed). */
export function vosRevision() {
  const git = (...args: string[]) => spawnSync("git", ["-C", REPO, ...args], { encoding: "utf8", maxBuffer: 1 << 28 }).stdout ?? "";
  const head = git("rev-parse", "HEAD").trim() || null;
  const tree = git("rev-parse", "HEAD^{tree}").trim() || null;
  const status = git("status", "--porcelain").split("\n").filter(Boolean);
  const judgeDirty = git("status", "--porcelain", "--", "src/judge", "src/cli.ts").trim();
  const diff = status.length ? git("diff", "HEAD", "--binary") : "";
  const judgeFiles = fs.readdirSync(path.join(REPO, "src", "judge")).filter((f) => /\.(ts|json)$/.test(f)).sort();
  const code = sha256(judgeFiles.map((f) => f + ":" + sha256File(path.join(REPO, "src", "judge", f))).join("\n"));
  return {
    git_head: head, git_tree: tree, worktree_clean: status.length === 0, dirty_entries: status.slice(0, 50), dirty_diff_sha256: status.length ? sha256(diff) : null,
    judge_code_dirty: judgeDirty.length > 0, judge_code_sha256: code,
  };
}

const poolRef = (pool: Pool) => ({ digest: pool.digest, purpose: pool.purpose, query: pool.query, seed: pool.seed, candidates: pool.candidates.length, rubric_sha256: pool.rubric.sha256 });

const ORIGIN_ORDER = ["search", "event", "asr", "coverage"];
const originRank = (c: { origins: string[] }) => Math.min(...c.origins.map((o) => ORIGIN_ORDER.indexOf(o)));

function spanOf(c: Candidate): Bounds {
  if (!c.start.frame || !c.end.frame) return { in: null, out: null, basis: "none", note: `span not on trusted frames (${c.start.flag ?? c.end.flag})` };
  return { in: c.start.frame.t, out: Math.max(c.end.frame.next_t, c.start.frame.next_t), basis: "artifact_span", note: "the artifact's span snapped to the frames on screen; its accuracy is not measured" };
}

// ---------------- baseline ----------------

export function runBaseline(p: Project, pool: Pool): RunResult {
  checkPoolFresh(p, pool);
  const t0 = performance.now();
  const scored = pool.candidates.map((c) => {
    // the search's own evidence for this span: its own fused score, or the best overlapping search candidate
    let s = c.search?.score ?? 0;
    for (const o of pool.candidates) {
      if (o.source !== c.source || !o.search || o === c) continue;
      const ov = Math.min(o.end.claimed, c.end.claimed) - Math.max(o.start.claimed, c.start.claimed);
      if (ov > 0) s = Math.max(s, o.search.score);
    }
    return { c, s };
  });
  scored.sort((a, b) => b.s - a.s || originRank(a.c) - originRank(b.c) || a.c.source.localeCompare(b.c.source) || a.c.start.claimed - b.c.start.claimed);
  // without any search channel every score is 0 and the order is only origin / source / time: say so
  const degenerate = pool.search.channels_used.length === 0 || pool.search.hits === 0;
  const ranked: Judged[] = scored.map(({ c, s }, i) => ({
    candidate: c.id, source: c.source, origins: c.origins, rank: i + 1, score: round(s, 4), decision: s > 0 ? "judged" : "undeterminable",
    ...(s > 0 ? {} : { reason: "the existing search did not surface this span" }), confidence: null, bounds: spanOf(c),
  }));
  return {
    format: "vos.judge-result/1", runner: "baseline", created_at: new Date().toISOString(),
    pool: poolRef(pool),
    manifest: {
      vos: vosRevision(), search: pool.search, tools: toolVersions(), degenerate,
      note: degenerate
        ? "DEGENERATE: no search channel / no hits — every score is 0, the order is origin, source, time only (not a ranking)"
        : "existing fused search (channels as listed + lexical, RRF) only; no model is run at scoring time",
    },
    ranked, resources: { wall_ms: round(performance.now() - t0, 1), node_max_rss_kib: process.resourceUsage().maxRSS },
  };
}

// ---------------- d1 ----------------

export interface D1Options {
  outDir: string; // the run directory (frames are written under it)
  refineTop?: number;
  refinePad?: number;
  refineMaxFrames?: number;
  width?: number;
  minFreeBytes?: number;
  log?: (s: string) => void;
}

interface Ctx {
  p: Project;
  pool: Pool;
  rubric: Rubric;
  ep: Endpoint;
  o: Required<Omit<D1Options, "log">> & { log: (s: string) => void };
  tables: Map<string, { table: FrameTable; file: string }>;
  calls: number[];
  callLog: string; // calls.jsonl in the run directory
  callRecords: CallRecord[];
  cache: Map<string, Record<string, CriterionResult>>;
  extracted: number;
  tokens: number;
}

/** Every model call, as it happened: latency, HTTP status, request / raw reply hashes, the usage the server reported. */
function logCall(ctx: Ctx, call: CallRecord, what: Record<string, unknown>) {
  ctx.calls.push(call.ms);
  ctx.callRecords.push(call);
  fs.appendFileSync(ctx.callLog, JSON.stringify({ n: ctx.callRecords.length, ...what, ...call }) + "\n");
}

async function judgeFrame(ctx: Ctx, source: string, index: number, questions: Record<string, Question>): Promise<{ ref: FrameRef; criteria: Record<string, CriterionResult> }> {
  const { table, file } = ctx.tables.get(source)!;
  const frameDir = path.join(ctx.o.outDir, "frames", ctx.pool.sources.find((s) => s.alias === source)!.content_id);
  if (ctx.extracted % 25 === 0) checkDisk(ctx.o.outDir, ctx.o.minFreeBytes);
  const fr = extractFrame(file, table, index, frameDir, ctx.o.width);
  ctx.extracted++;
  const ref: FrameRef = { source, index, t: fr.t, observed_t: fr.observed_t, file: path.relative(ctx.o.outDir, fr.file), sha256: fr.sha256 };
  const key = `${fr.sha256}:${sha256(stableStringify(questions))}`;
  const hit = ctx.cache.get(key);
  if (hit) return { ref, criteria: hit };
  const d = await decide(ctx.ep.url, null, questions, [fs.readFileSync(fr.file)]);
  logCall(ctx, d.call, { on: "frame", source, index, t: fr.t, frame_sha256: fr.sha256, questions: Object.keys(questions) });
  if (Number.isFinite(d.input_tokens)) ctx.tokens += d.input_tokens;
  const criteria: Record<string, CriterionResult> = {};
  for (const [name, a] of Object.entries(d.answers)) criteria[name] = interpret(ctx.rubric, name, a);
  ctx.cache.set(key, criteria);
  return { ref, criteria };
}

function transcriptText(pool: Pool, c: Candidate): string | null {
  const src = pool.sources.find((s) => s.alias === c.source)!;
  const segs = src.transcript_segments.filter((s) => Math.min(s.end, c.end.claimed) - Math.max(s.start, c.start.claimed) > 0);
  const text = segs.map((s) => s.text).join(" ").trim();
  return text ? text.slice(0, 1500) : null;
}

async function stage1(ctx: Ctx, c: Candidate): Promise<Judged> {
  const purpose = purposeOf(ctx.rubric, ctx.pool.purpose);
  const base: Omit<Judged, "rank" | "score" | "decision" | "confidence"> = { candidate: c.id, source: c.source, origins: c.origins, bounds: spanOf(c) };
  if (!c.start.frame || !c.end.frame) {
    return { ...base, rank: 0, score: null, decision: "abstained", confidence: null, reason: `span is not on trusted frames (${c.start.flag ?? c.end.flag}); timestamps cannot be tied to real frames` };
  }
  const { table } = ctx.tables.get(c.source)!;
  const s = c.start.frame.t, e = Math.max(c.end.frame.next_t, c.start.frame.next_t);
  const span = e - s;
  const picks = span <= 3 ? [s + span / 2] : [s + span * 0.2, s + span * 0.5, s + span * 0.8];
  const idx = [...new Set(picks.map((t) => snap(table, Math.min(t, table.last_frame_end - 1e-6)).index))];
  const fq = questionsFor(ctx.rubric, ctx.pool.purpose, "frame");
  const frames: NonNullable<Judged["frames"]> = [];
  for (const i of idx) {
    const r = await judgeFrame(ctx, c.source, i, fq);
    frames.push({ ...r, frame_score: aggregate(ctx.rubric, ctx.pool.purpose, r.criteria).score });
  }
  // the candidate is read at its best representative frame (one consistent frame for every visual criterion)
  const best = frames.reduce((a, b) => ((b.frame_score ?? -1) > (a.frame_score ?? -1) ? b : a));
  const results: Record<string, CriterionResult | undefined> = { ...best.criteria };
  const tq = questionsFor(ctx.rubric, ctx.pool.purpose, "transcript");
  if (Object.keys(tq).length) {
    const text = transcriptText(ctx.pool, c);
    if (!text) for (const n of Object.keys(tq)) results[n] = { status: "unobserved", value: null, confidence: null, reason: "no transcript text in this span" };
    else {
      const d = await decide(ctx.ep.url, text, tq);
      logCall(ctx, d.call, { on: "transcript", source: c.source, candidate: c.id, text_sha256: sha256(text), questions: Object.keys(tq) });
      if (Number.isFinite(d.input_tokens)) ctx.tokens += d.input_tokens;
      for (const [n, a] of Object.entries(d.answers)) results[n] = interpret(ctx.rubric, n, a);
    }
  }
  const agg: Aggregate = aggregate(ctx.rubric, ctx.pool.purpose, results);
  // model-reported (uncalibrated) confidences only; the p_margin derived for noul answers is not mixed in
  const confs = Object.entries(agg.criteria).filter(([n, r]) => purpose.weights[n] && r.confidence !== null && r.status !== "unknown").map(([n, r]) => [purpose.weights[n], r.confidence!] as const);
  const conf = confs.length ? round(confs.reduce((a, [w, x]) => a + w * x, 0) / confs.reduce((a, [w]) => a + w, 0), 4) : null;
  return { ...base, rank: 0, score: agg.score, decision: agg.decision, confidence: conf, evidence: agg.evidence, criteria: agg.criteria, frames, ...(agg.decision === "undeterminable" ? { reason: `only ${agg.evidence} of the rubric weight could be judged` } : {}) };
}

/** Dense look around a promising candidate: where does the peak criterion hold? */
async function refine(ctx: Ctx, c: Candidate, j: Judged): Promise<void> {
  const purpose = purposeOf(ctx.rubric, ctx.pool.purpose);
  const { table } = ctx.tables.get(c.source)!;
  if (purpose.bounds === "transcript") {
    const src = ctx.pool.sources.find((s) => s.alias === c.source)!;
    const segs = src.transcript_segments.filter((s) => Math.min(s.end, c.end.claimed) - Math.max(s.start, c.start.claimed) > 0);
    if (!segs.length) {
      j.bounds = { ...j.bounds, note: `${j.bounds.note ?? ""}; no transcript words in span, kept the artifact span`.replace(/^; /, "") };
      return;
    }
    const a = snap(table, segs[0].start), b = snap(table, segs[segs.length - 1].end);
    if (a.flag === "past_trusted" || b.flag === "past_trusted") return;
    j.bounds = { in: a.t, out: b.next_t, basis: "transcript", note: "ASR segment bounds (faster-whisper times; their accuracy is not measured) snapped to the frames on screen" };
    return;
  }
  const s0 = j.bounds.in ?? c.start.claimed, e0 = j.bounds.out ?? c.end.claimed;
  const lo = Math.max(table.t[0], s0 - ctx.o.refinePad), hi = Math.min(table.last_frame_end, e0 + ctx.o.refinePad);
  const step = Math.max(0.2, (hi - lo) / ctx.o.refineMaxFrames);
  const snaps = framesIn(table, lo, hi, step, ctx.o.refineMaxFrames).filter((x) => !x.flag);
  const q = questionsFor(ctx.rubric, ctx.pool.purpose, "frame", [purpose.peak]);
  const seen: { ref: FrameRef; value: number | null; status: string }[] = [];
  for (const sn of snaps) {
    const r = await judgeFrame(ctx, c.source, sn.index, q);
    const cr = r.criteria[purpose.peak];
    seen.push({ ref: r.ref, value: cr.status === "answered" || cr.status === "low_confidence" ? cr.value : null, status: cr.status });
  }
  const vals = seen.map((x) => x.value ?? -1);
  const vmax = Math.max(...vals);
  if (vmax < 0.3) {
    j.refine = { frames: seen, peak: null, vmax: vmax < 0 ? null : vmax, threshold: null, status: "no_peak" };
    return;
  }
  const pk = vals.indexOf(vmax);
  const thr = round(vmax * 0.7, 4);
  let a = pk, b = pk;
  while (a > 0 && vals[a - 1] >= thr) a--;
  while (b < vals.length - 1 && vals[b + 1] >= thr) b++;
  const first = seen[a].ref, last = seen[b].ref;
  const lastEnd = snap(table, last.t).next_t;
  const open: ("in" | "out")[] = [];
  if (a === 0) open.push("in");
  if (b === seen.length - 1) open.push("out");
  // closed side: the cut lies between the last frame below the threshold and the first one above it (both real
  // frames that were looked at); open side: nothing beyond the window was looked at → unbounded (null)
  const inLo = a > 0 ? round(snap(table, seen[a - 1].ref.t).next_t, 6) : null;
  const outHi = b < seen.length - 1 ? round(Math.max(lastEnd, seen[b + 1].ref.t), 6) : null;
  j.refine = { frames: seen, peak: seen[pk].ref, vmax, threshold: thr, status: open.length === 2 ? "uninformative" : "ok" };
  j.bounds = {
    in: first.t, out: lastEnd, basis: "frames",
    in_range: [inLo, first.t], out_range: [lastEnd, outHi],
    ...(open.length ? { open } : {}),
    note: `frames ${first.index}–${last.index} hold ${purpose.peak} ≥ ${thr} (peak ${vmax} at ${seen[pk].ref.t}s); ` +
      (open.length === 2
        ? "every frame looked at is above the threshold: in/out are only the edges of the window looked at, not a found cut"
        : `a closed side's cut lies inside its range (frames between samples were not looked at)${open.length ? `; the ${open[0]} side reached the window edge, so its range is unbounded (null)` : ""}`),
  };
}

export async function runD1(p: Project, pool: Pool, ep: Endpoint, o: D1Options): Promise<RunResult> {
  checkPoolFresh(p, pool);
  const { rubric, ref } = loadRubric();
  if (ref.sha256 !== pool.rubric.sha256) throw new VosError("rubric_changed", `the rubric (${ref.sha256.slice(0, 12)}) is not the one the pool was built with (${pool.rubric.sha256.slice(0, 12)})`);
  const opts = { refineTop: 12, refinePad: 1, refineMaxFrames: 16, width: 448, minFreeBytes: 512 * 2 ** 20, log: () => {}, ...o } as Ctx["o"];
  checkDisk(opts.outDir, opts.minFreeBytes);
  const tables = new Map<string, { table: FrameTable; file: string }>();
  for (const s of pool.sources) {
    const a = resolveAsset(p, s.alias);
    const file = requireOnline(a);
    const table = frameTable(file, a.id, path.join(opts.outDir, "cache"));
    if (table.digest !== s.frames.digest) throw new VosError("stale_pool", `${s.alias}: frame table differs from the pool's (${table.digest.slice(0, 12)} ≠ ${s.frames.digest.slice(0, 12)})`);
    tables.set(s.alias, { table, file });
  }
  const callLog = path.join(opts.outDir, "calls.jsonl");
  fs.writeFileSync(callLog, "");
  const ctx: Ctx = { p, pool, rubric, ep, o: opts, tables, calls: [], callLog, callRecords: [], cache: new Map(), extracted: 0, tokens: 0 };
  const t0 = performance.now();
  const judged: Judged[] = [];
  for (const [i, c] of pool.candidates.entries()) {
    judged.push(await stage1(ctx, c));
    if ((i + 1) % 20 === 0) opts.log(`d1 stage 1: ${i + 1}/${pool.candidates.length}`);
  }
  const t1 = performance.now();
  const order = (a: Judged, b: Judged) => (b.score ?? -1) - (a.score ?? -1) || (b.confidence ?? 0) - (a.confidence ?? 0) || originRank(a) - originRank(b) || a.source.localeCompare(b.source) || a.candidate.localeCompare(b.candidate);
  judged.sort(order);
  const top = judged.filter((j) => j.decision === "judged").slice(0, opts.refineTop);
  for (const j of top) await refine(ctx, pool.candidates.find((c) => c.id === j.candidate)!, j);
  const t2 = performance.now();
  judged.forEach((j, i) => (j.rank = i + 1));
  const ms = [...ctx.calls].sort((a, b) => a - b);
  const pct = (q: number) => (ms.length ? ms[Math.min(ms.length - 1, Math.floor(q * ms.length))] : null);
  const runner = (ep as any).runner;
  const model = (ep as any).model ?? { attached_model_file: (ep as any).model_file };
  const recs = ctx.callRecords;
  const usage = {
    calls: recs.length,
    usage_present: recs.filter((r) => r.usage.present).length,
    output_tokens_absent: recs.filter((r) => r.usage.output_tokens === "absent").length,
    output_tokens_zero: recs.filter((r) => r.usage.output_tokens === 0).length,
    output_tokens_nonzero: recs.filter((r) => typeof r.usage.output_tokens === "number" && r.usage.output_tokens !== 0).length, // always 0: such a reply stops the run
  };
  return {
    format: "vos.judge-result/1", runner: "d1", created_at: new Date().toISOString(),
    pool: poolRef(pool),
    manifest: {
      vos: vosRevision(), rubric: ref, tools: toolVersions(),
      provenance: { complete: ep.provenance_gaps.length === 0, gaps: ep.provenance_gaps },
      model: { repo: D1_PIN.repo, revision: D1_PIN.revision, base: D1_PIN.base, license: D1_PIN.license, files: model.model ? { model: model.model, mmproj: model.mmproj } : model },
      runner: { pin: RUNNER_PIN, observed: runner ? { version_line: runner.version_line, build: runner.build, commit: runner.commit, binary_sha256: runner.sha256, pinned: runner.pinned } : null },
      endpoint: {
        mode: ep.mode, exposure: ep.exposure, transport: ep.url.startsWith("unix:") ? "unix_socket" : "tcp_loopback", model_id: path.basename(ep.model_id), modalities: ep.modalities,
        ...((ep as any).args ? { args: (ep as any).args } : {}), ...((ep as any).env_removed ? { env_removed: (ep as any).env_removed } : {}),
      },
      confidence_note: "confidence values are the model's own, uncalibrated; noul answers carry a derived p_margin instead",
      calls_log: "calls.jsonl",
      params: { refine_top: opts.refineTop, refine_pad: opts.refinePad, refine_max_frames: opts.refineMaxFrames, width: opts.width },
    },
    ranked: judged,
    resources: {
      wall_ms: { stage1: round(t1 - t0, 1), refine: round(t2 - t1, 1), total: round(t2 - t0, 1) },
      d1_calls: ms.length, d1_latency_ms: { p50: pct(0.5), p95: pct(0.95), max: ms.length ? ms[ms.length - 1] : null },
      input_tokens: ctx.tokens, usage, frames_extracted: ctx.extracted, decisions_cached: ctx.cache.size,
      endpoint_max_rss_kib: ep.maxRssKiB(), node_max_rss_kib: process.resourceUsage().maxRSS,
    },
  };
}

export function writeResult(dir: string, r: RunResult): string {
  const f = path.join(dir, `${r.runner}.json`);
  writeJson(f, r, false);
  return f;
}
