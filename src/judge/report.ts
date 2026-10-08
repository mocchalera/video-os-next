import * as fs from "node:fs";
import * as path from "node:path";
import { round, VosError } from "../core/util.ts";
import type { Pool } from "./pool.ts";
import type { Judged, RunResult } from "./score.ts";

/**
 * Comparison of the two runners on one pool. Two kinds of numbers, never mixed:
 *   model_proxy — computed from the runs themselves (agreement, what reached the top, abstentions, bound shifts,
 *                 resources). They describe the runners, not the truth.
 *   human       — adoption, misses, in/out error, search / fix time. Only from a labels file a person filled in;
 *                 without one every value is null with "not_measured". Never estimated.
 */

export interface LabelItem {
  candidate: string;
  adopt: boolean | null; // would a person use this span for the purpose
  in?: number | null; // the person's in/out (media seconds)
  out?: number | null;
  note?: string;
}

export interface Labels {
  format: "vos.judge-labels/1";
  pool_digest: string;
  labeler: string | null;
  items: LabelItem[];
  /** measured by the person, per runner: seconds spent finding usable spans, and fixing in/out */
  time?: { baseline?: { search_sec: number | null; fix_sec: number | null }; d1?: { search_sec: number | null; fix_sec: number | null } };
}

const NM = { value: null, status: "not_measured" as const, reason: "no human labels for this pool" };

/** What a person would be shown as "this runner's top k": judged candidates only (undeterminable / abstained ones
 *  are not proposals, so they never fill a gap in the list). */
function proposals(r: RunResult, k: number): Judged[] {
  return r.ranked.filter((j) => j.decision === "judged").slice(0, k);
}

/** Labels are checked before any number is computed from them. */
export function validateLabels(pool: Pool, labels: Labels): void {
  const bad = (why: string): never => {
    throw new VosError("bad_labels", `labels rejected: ${why}`);
  };
  if (labels.format !== "vos.judge-labels/1") bad(`format ${labels.format}`);
  if (labels.pool_digest !== pool.digest) throw new VosError("labels_mismatch", "the labels were made for another pool");
  if (!Array.isArray(labels.items)) bad("items is not a list");
  const ids = new Set(pool.candidates.map((c) => c.id));
  const seen = new Set<string>();
  const numOrNull = (x: unknown) => x === undefined || x === null || (typeof x === "number" && Number.isFinite(x) && x >= 0);
  for (const it of labels.items) {
    if (!ids.has(it.candidate)) bad(`unknown candidate ${it.candidate}`);
    if (seen.has(it.candidate)) bad(`candidate ${it.candidate} labeled twice`);
    seen.add(it.candidate);
    if (!(it.adopt === null || typeof it.adopt === "boolean")) bad(`${it.candidate}: adopt must be true, false or null`);
    if (!numOrNull(it.in) || !numOrNull(it.out)) bad(`${it.candidate}: in/out must be seconds ≥ 0 or null`);
    if (typeof it.in === "number" && typeof it.out === "number" && it.out <= it.in) bad(`${it.candidate}: out ≤ in`);
  }
  for (const [r, t] of Object.entries(labels.time ?? {})) {
    if (!t) continue;
    if (!numOrNull((t as any).search_sec) || !numOrNull((t as any).fix_sec)) bad(`time.${r}: seconds ≥ 0 or null`);
  }
}

/** Spearman correlation over candidates both runners ranked. */
function spearman(a: RunResult, b: RunResult): number | null {
  const ra = new Map(a.ranked.map((j) => [j.candidate, j.rank]));
  const pairs = b.ranked.filter((j) => ra.has(j.candidate)).map((j) => [ra.get(j.candidate)!, j.rank] as const);
  const n = pairs.length;
  if (n < 3) return null;
  const d2 = pairs.reduce((s, [x, y]) => s + (x - y) ** 2, 0);
  return round(1 - (6 * d2) / (n * (n * n - 1)), 4);
}

/** Audit sample for people: seeded picks outside both top-k lists, so misses can be measured, not assumed. */
export function auditSample(pool: Pool, runs: RunResult[], k: number, n: number): string[] {
  const inTop = new Set(runs.flatMap((r) => proposals(r, k).map((j) => j.candidate)));
  const rest = pool.candidates.filter((c) => !inTop.has(c.id));
  let a = pool.seed * 2654435761 >>> 0;
  const out: string[] = [];
  const pool2 = [...rest];
  while (out.length < n && pool2.length) {
    a = (a * 1664525 + 1013904223) >>> 0;
    out.push(pool2.splice(a % pool2.length, 1)[0].id);
  }
  return out.sort();
}

export function labelsTemplate(pool: Pool, runs: RunResult[], k = 10, audit = 10): Labels & { instructions: string; order: Record<string, string> } {
  const ids = new Set<string>();
  for (const r of runs) for (const j of proposals(r, k)) ids.add(j.candidate);
  const aud = auditSample(pool, runs, k, audit);
  for (const id of aud) ids.add(id);
  const sorted = [...ids].sort();
  return {
    format: "vos.judge-labels/1", pool_digest: pool.digest, labeler: null,
    instructions: "For each candidate: adopt true/false (would you use this span for the purpose), and your own in/out in media seconds if adopted. Look at the frames, not the ranks. Measure time per runner in seconds. Leave null what you did not judge.",
    order: Object.fromEntries(sorted.map((id) => [id, aud.includes(id) ? "audit (outside both top-k)" : "top-k"])),
    items: sorted.map((candidate) => ({ candidate, adopt: null, in: null, out: null })),
    time: { baseline: { search_sec: null, fix_sec: null }, d1: { search_sec: null, fix_sec: null } },
  };
}

function humanMetrics(pool: Pool, runs: RunResult[], labels: Labels | null, k: number) {
  if (!labels) return Object.fromEntries(runs.map((r) => [r.runner, { adoption_at_k: NM, miss_rate: NM, in_abs_err_sec: NM, out_abs_err_sec: NM, search_sec: NM, fix_sec: NM }]));
  validateLabels(pool, labels);
  const lab = new Map(labels.items.filter((i) => i.adopt !== null).map((i) => [i.candidate, i]));
  const adopted = [...lab.values()].filter((i) => i.adopt);
  const out: Record<string, unknown> = {};
  for (const r of runs) {
    const top = proposals(r, k);
    const judged = top.filter((j) => lab.has(j.candidate));
    const yes = judged.filter((j) => lab.get(j.candidate)!.adopt);
    const topIds = new Set(top.map((j) => j.candidate));
    const errs = (side: "in" | "out") => {
      const e = yes.map((j) => {
        const h = lab.get(j.candidate)![side];
        const m = j.bounds[side];
        return h === null || h === undefined || m === null ? null : Math.abs(h - m);
      }).filter((x): x is number => x !== null);
      return e.length ? { value: round(e.reduce((a, b) => a + b, 0) / e.length, 3), n: e.length, status: "measured" } : { ...NM, reason: "no adopted candidate with a human in/out" };
    };
    const t = (labels.time as any)?.[r.runner];
    const measured = (x: unknown) => (typeof x === "number" ? { value: x, status: "measured" } : { ...NM, reason: "time not recorded" });
    out[r.runner] = {
      adoption_at_k: judged.length ? { value: round(yes.length / judged.length, 4), n: judged.length, proposals_in_top_k: top.length, unlabeled_in_top_k: top.length - judged.length, status: "measured" } : { ...NM, reason: "no labeled candidate among this runner's judged top-k" },
      miss_rate: adopted.length ? { value: round(adopted.filter((i) => !topIds.has(i.candidate)).length / adopted.length, 4), n: adopted.length, status: "measured", note: "share of human-adopted spans among the LABELED ones (top-k ∪ audit picks) outside this runner's top-k; misses outside the labeled set and outside the pool are not measured" } : { ...NM, reason: "no adopted spans" },
      in_abs_err_sec: errs("in"), out_abs_err_sec: errs("out"),
      search_sec: measured(t?.search_sec),
      fix_sec: measured(t?.fix_sec),
    };
  }
  return out;
}

function dirBytes(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    n += e.isDirectory() ? dirBytes(f) : fs.statSync(f).size;
  }
  return n;
}

export function compare(pool: Pool, runs: RunResult[], o: { k?: number; labels?: Labels | null; runDir?: string; modelBytes?: number | null } = {}) {
  const k = o.k ?? 10;
  const by = Object.fromEntries(runs.map((r) => [r.runner, r]));
  for (const r of runs) {
    if (r.pool.digest !== pool.digest) throw new VosError("pool_mismatch", `${r.runner} result was made on another pool`);
    if (r.pool.purpose !== pool.purpose || r.pool.query !== pool.query || r.pool.rubric_sha256 !== pool.rubric.sha256) throw new VosError("pool_mismatch", `${r.runner} result was made for purpose "${r.pool.purpose}" / query "${r.pool.query}" / rubric ${String(r.pool.rubric_sha256).slice(0, 12)}, the pool is "${pool.purpose}" / "${pool.query}" / ${pool.rubric.sha256.slice(0, 12)}`);
  }
  const cov = new Set(pool.candidates.filter((c) => c.origins.includes("coverage")).map((c) => c.id));
  const covOnly = new Set(pool.candidates.filter((c) => c.origins.length === 1 && c.origins[0] === "coverage" && !c.coverage?.overlaps_artifact_candidate).map((c) => c.id));
  const per: Record<string, unknown> = {};
  for (const r of runs) {
    const top = proposals(r, k);
    const statuses: Record<string, number> = {};
    for (const j of r.ranked) for (const cr of Object.values(j.criteria ?? {})) statuses[cr.status] = (statuses[cr.status] ?? 0) + 1;
    const m = r.manifest as any;
    per[r.runner] = {
      candidates: r.ranked.length,
      ...(r.runner === "baseline" ? { degenerate: !!m.degenerate } : {}),
      provenance: r.runner === "d1" ? (m.provenance ?? { complete: false, gaps: ["no provenance recorded"] }) : { complete: true, gaps: [] },
      code: m.vos ? { git_head: m.vos.git_head, worktree_clean: m.vos.worktree_clean, judge_code_dirty: m.vos.judge_code_dirty } : null,
      judged_in_top_k: proposals(r, k).length,
      decisions: r.ranked.reduce((m: Record<string, number>, j) => ((m[j.decision] = (m[j.decision] ?? 0) + 1), m), {}),
      top_k: top.map((j) => ({ rank: j.rank, candidate: j.candidate, source: j.source, origins: j.origins, score: j.score, in: j.bounds.in, out: j.bounds.out, basis: j.bounds.basis })),
      coverage_in_top_k: top.filter((j) => cov.has(j.candidate)).length,
      coverage_only_in_top_k: top.filter((j) => covOnly.has(j.candidate)).map((j) => j.candidate),
      criterion_statuses: statuses,
      resources: r.resources,
    };
  }
  let agreement: Record<string, unknown> = { status: "needs both runners" };
  let bounds: Record<string, unknown> = { status: "needs both runners" };
  if (by.baseline && by.d1) {
    const a = new Set(proposals(by.baseline, k).map((j) => j.candidate));
    const b = proposals(by.d1, k).map((j) => j.candidate);
    agreement = { spearman: spearman(by.baseline, by.d1), top_k_overlap: b.filter((x) => a.has(x)).length, k };
    const base = new Map(by.baseline.ranked.map((j) => [j.candidate, j]));
    const shifts = by.d1.ranked.filter((j) => j.bounds.basis === "frames" || j.bounds.basis === "transcript").map((j) => {
      const bj = base.get(j.candidate)!;
      return { candidate: j.candidate, d_in: bj.bounds.in === null || j.bounds.in === null ? null : round(j.bounds.in - bj.bounds.in, 3), d_out: bj.bounds.out === null || j.bounds.out === null ? null : round(j.bounds.out - bj.bounds.out, 3), in_range: j.bounds.in_range, out_range: j.bounds.out_range, open: j.bounds.open };
    });
    const mean = (xs: (number | null)[]) => {
      const v = xs.filter((x): x is number => x !== null).map(Math.abs);
      return v.length ? round(v.reduce((s, x) => s + x, 0) / v.length, 3) : null;
    };
    bounds = { refined: shifts.length, mean_abs_shift_in: mean(shifts.map((s) => s.d_in)), mean_abs_shift_out: mean(shifts.map((s) => s.d_out)), items: shifts, note: "how far d1 moved in/out from the artifact span; a change, not an error (no ground truth)" };
  }
  const pts = pool.sources.map((s) => ({
    source: s.alias, content_id: s.content_id, vfr: s.frames.vfr.vfr, frames: s.frames.frame_count, decoded: s.frames.decoded_frames, anomalies: s.frames.anomaly_count, trusted: s.frames.trusted,
    time_source: s.frames.time_source ?? null,
    reordered_packets: s.frames.reordered_packets, format_start: s.frames.format_start, last_frame_end_est: s.frames.last_frame_end, format_duration: s.frames.format_duration,
  }));
  // how much of each source the pool can see at all (misses outside every candidate cannot be measured)
  const union = (spans: [number, number][]) => {
    let tot = 0, end = -Infinity;
    for (const [a, b] of spans.sort((x, y) => x[0] - y[0])) {
      if (b <= end) continue;
      tot += b - Math.max(a, end);
      end = b;
    }
    return tot;
  };
  const coverage = pool.sources.map((s) => {
    const cs = pool.candidates.filter((c) => c.source === s.alias);
    const dur = s.frames.last_frame_end;
    const all = union(cs.map((c) => [c.start.claimed, Math.max(c.start.claimed, c.end.claimed)] as [number, number]));
    const win = union(cs.filter((c) => c.origins.includes("coverage")).map((c) => [c.start.claimed, c.end.claimed] as [number, number]));
    return { source: s.alias, duration_est: dur, pool_span_share: dur > 0 ? round(all / dur, 4) : null, coverage_window_share: dur > 0 ? round(win / dur, 4) : null };
  });
  return {
    format: "vos.judge-report/1",
    pool: { digest: pool.digest, purpose: pool.purpose, query: pool.query, seed: pool.seed, candidates: pool.candidates.length, coverage_windows: cov.size, coverage_outside_artifacts: covOnly.size, rubric: pool.rubric, search: pool.search },
    model_proxy: { per_runner: per, agreement, bounds },
    human: humanMetrics(pool, runs, o.labels ?? null, k),
    pts,
    coverage,
    disk: { run_dir_bytes: o.runDir ? dirBytes(o.runDir) : null, model_bytes: o.modelBytes ?? null },
  };
}

export function reportMarkdown(rep: ReturnType<typeof compare>): string {
  const L: string[] = [];
  const pr = rep.model_proxy.per_runner as Record<string, any>;
  L.push(`# vos judge report — ${rep.pool.purpose}`, "");
  L.push(`pool ${rep.pool.digest.slice(0, 12)} · ${rep.pool.candidates} candidates (${rep.pool.coverage_windows} coverage windows, ${rep.pool.coverage_outside_artifacts} outside every artifact span) · rubric ${rep.pool.rubric.id}@${rep.pool.rubric.version} ${rep.pool.rubric.sha256.slice(0, 12)} · query "${rep.pool.query}"`, "");
  L.push("## Model-proxy (describes the runners, not the truth)", "");
  L.push("| runner | judged | undeterminable | abstained | coverage in top-k | wall ms | d1 calls | p50 ms | endpoint max RSS MiB |", "|---|---|---|---|---|---|---|---|---|");
  for (const [name, r] of Object.entries(pr)) {
    const res = r.resources ?? {};
    const wall = typeof res.wall_ms === "object" ? res.wall_ms.total : res.wall_ms;
    L.push(`| ${name} | ${r.decisions.judged ?? 0} | ${r.decisions.undeterminable ?? 0} | ${r.decisions.abstained ?? 0} | ${r.coverage_in_top_k} | ${wall ?? "—"} | ${res.d1_calls ?? "—"} | ${res.d1_latency_ms?.p50 ?? "—"} | ${res.endpoint_max_rss_kib ? round(res.endpoint_max_rss_kib / 1024, 1) : "—"} |`);
  }
  L.push("", `agreement: ${JSON.stringify(rep.model_proxy.agreement)}`, "");
  if (pr.baseline?.degenerate) L.push("⚠ baseline is DEGENERATE: no search channel / no hits, so every score is 0 and its order is origin / source / time only — not a ranking to compare against.", "");
  for (const [name, r] of Object.entries(pr)) if (r.provenance && !r.provenance.complete) L.push(`⚠ ${name}: provenance incomplete — ${r.provenance.gaps.join("; ")}`);
  for (const [name, r] of Object.entries(pr)) if (r.code && (!r.code.worktree_clean || r.code.judge_code_dirty)) L.push(`⚠ ${name}: made from a checkout with uncommitted changes (${r.code.git_head?.slice(0, 12)})`);
  L.push("");
  const b = rep.model_proxy.bounds as any;
  if (b.refined !== undefined) L.push(`bounds: ${b.refined} refined; mean |Δin| ${b.mean_abs_shift_in} s, mean |Δout| ${b.mean_abs_shift_out} s vs the artifact span (a change, not an error)`, "");
  L.push("## Human measures", "");
  for (const [name, h] of Object.entries(rep.human as Record<string, any>)) L.push(`- ${name}: ` + Object.entries(h).map(([k, v]: [string, any]) => `${k} ${v.value === null ? `null (${v.status})` : v.value}`).join(" · "));
  L.push("", "## Pool coverage", "", "| source | share of the source inside any candidate | inside coverage windows |", "|---|---|---|");
  for (const c of rep.coverage) L.push(`| ${c.source} | ${c.pool_span_share} | ${c.coverage_window_share} |`);
  L.push("", "miss_rate (with labels) only counts misses among labeled spans; anything outside the pool cannot be seen.");
  L.push("", "## Frame timing", "", "| source | VFR | frames | anomalies | times from PTS / estimate only | start | last frame end (est.) | container duration |", "|---|---|---|---|---|---|---|---|");
  for (const s of rep.pts) L.push(`| ${s.source} | ${s.vfr} | ${s.frames}/${s.decoded} | ${s.anomalies} (${s.trusted}) | ${s.time_source ? `${s.time_source.pts} / ${s.time_source.best_effort_only}` : "—"} | ${s.format_start} | ${s.last_frame_end_est} | ${s.format_duration} |`);
  return L.join("\n") + "\n";
}
