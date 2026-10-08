import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "../core/hash.ts";
import { round, stableStringify, VosError } from "../core/util.ts";

/**
 * The rubric is data, fixed per version and identified by its hash. A purpose lists the criteria it judges and
 * their weights; every other criterion is `unknown` for that purpose (not judged, not guessed).
 */

export type QuestionType = "noul" | "choice" | "score";
export interface Question {
  type: QuestionType;
  instructions: string;
  criteria?: Record<string, string | null> | string[];
}

export interface Criterion {
  on: "frame" | "transcript";
  question: Question;
  value: "p_yes" | "score_norm" | Record<string, number>;
  abstain?: string[];
  unobserved?: Record<string, string>;
}

export interface Purpose {
  label: string;
  query: string;
  weights: Record<string, number>;
  peak: string;
  bounds: "frames" | "transcript";
}

export interface Rubric {
  format: "vos.judge-rubric/1";
  id: string;
  version: string;
  note?: string;
  thresholds: { low_confidence: number; noul_low_band: [number, number]; low_confidence_weight: number; min_evidence: number };
  criteria: Record<string, Criterion>;
  purposes: Record<string, Purpose>;
}

export const RUBRIC_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "rubric.v1.json");

export interface LoadedRubric {
  rubric: Rubric;
  ref: { id: string; version: string; sha256: string; file: string };
}

export function loadRubric(file = RUBRIC_FILE): LoadedRubric {
  const rubric = JSON.parse(fs.readFileSync(file, "utf8")) as Rubric;
  if (rubric.format !== "vos.judge-rubric/1") throw new VosError("bad_rubric", `${file}: format must be vos.judge-rubric/1`);
  for (const [name, p] of Object.entries(rubric.purposes)) {
    for (const c of Object.keys(p.weights)) if (!rubric.criteria[c]) throw new VosError("bad_rubric", `purpose ${name} weighs unknown criterion ${c}`);
    if (!p.weights[p.peak]) throw new VosError("bad_rubric", `purpose ${name}: peak criterion ${p.peak} must be weighted`);
  }
  for (const [name, c] of Object.entries(rubric.criteria)) {
    const q = c.question;
    if (q.type === "score" && (!Array.isArray(q.criteria) || q.criteria.length < 2 || q.criteria.length > 10)) throw new VosError("bad_rubric", `${name}: a score has 2 to 10 levels`);
    if (q.type === "choice" && (!q.criteria || Array.isArray(q.criteria) || Object.keys(q.criteria).length < 2)) throw new VosError("bad_rubric", `${name}: a choice needs named options`);
  }
  return { rubric, ref: { id: rubric.id, version: rubric.version, sha256: sha256(stableStringify(rubric)), file: path.basename(file) } };
}

export function purposeOf(r: Rubric, name: string): Purpose {
  const p = r.purposes[name];
  if (!p) throw new VosError("unknown_purpose", `unknown purpose "${name}"`, `rubric ${r.id}@${r.version} has: ${Object.keys(r.purposes).join(", ")}`);
  return p;
}

/** The questions to put to one frame (or one transcript) for a purpose, in a stable order. */
export function questionsFor(r: Rubric, purpose: string, on: "frame" | "transcript", only?: string[]): Record<string, Question> {
  const p = purposeOf(r, purpose);
  const out: Record<string, Question> = {};
  for (const name of Object.keys(p.weights).sort()) {
    const c = r.criteria[name];
    if (c.on !== on) continue;
    if (only && !only.includes(name)) continue;
    out[name] = c.question;
  }
  return out;
}

/** A validated d1 answer (see d1.ts). */
export interface Answer {
  type: QuestionType;
  noul?: number;
  choice?: string;
  score?: number;
  confidence?: number;
  probabilities?: Record<string, number>;
}

/**
 * answered       — the model gave a usable answer. This is the model's subjective reading of a frame / text, not an
 *                  observed fact (e.g. "action_peak" is inferred from a single still).
 * low_confidence — answered, but undecided (noul inside the band, or the model's own confidence below the threshold)
 * abstained      — the model chose an explicit "cannot tell" option
 * unobserved     — the thing the criterion asks about is not there (no face, no text, no words in the span)
 * unknown        — the criterion is not part of this purpose's rubric: not judged, not guessed
 */
export type Status = "answered" | "low_confidence" | "abstained" | "unobserved" | "unknown";

export interface CriterionResult {
  status: Status;
  value: number | null; // 0..1, null unless answered / low_confidence
  /** the confidence the model reported (uncalibrated); null when it reports none (noul answers) */
  confidence: number | null;
  /** noul only: |P(yes) − 0.5| × 2, derived here from the probability — not a model-reported confidence */
  p_margin?: number;
  kind?: "model_subjective";
  reason?: string;
  answer?: Answer; // the model's raw (subjective) reading
}

export function interpret(r: Rubric, name: string, a: Answer): CriterionResult {
  const c = r.criteria[name];
  const th = r.thresholds;
  if (a.type === "noul") {
    const p = a.noul!;
    const low = p > th.noul_low_band[0] && p < th.noul_low_band[1];
    const margin = round(Math.abs(p - 0.5) * 2, 4);
    return { status: low ? "low_confidence" : "answered", kind: "model_subjective", value: round(p, 4), confidence: null, p_margin: margin, answer: a, ...(low ? { reason: `P(yes)=${round(p, 3)} is inside the undecided band` } : {}) };
  }
  if (a.type === "score") {
    const levels = (c.question.criteria as string[]).length;
    const v = round(a.score! / (levels - 1), 4);
    const conf = a.confidence ?? null;
    const low = conf !== null && conf < th.low_confidence;
    return { status: low ? "low_confidence" : "answered", kind: "model_subjective", value: v, confidence: conf, answer: a, ...(low ? { reason: `confidence ${conf} < ${th.low_confidence}` } : {}) };
  }
  const pick = a.choice!;
  const conf = a.confidence ?? null;
  if (c.abstain?.includes(pick)) return { status: "abstained", kind: "model_subjective", value: null, confidence: conf, answer: a, reason: `model chose "${pick}"` };
  if (c.unobserved?.[pick]) return { status: "unobserved", kind: "model_subjective", value: null, confidence: conf, answer: a, reason: c.unobserved[pick] };
  const table = c.value as Record<string, number>;
  if (!(pick in table)) throw new VosError("bad_rubric", `${name}: option "${pick}" has no value`);
  // expected value over the valued options (the model's spread is part of the reading)
  const probs = a.probabilities ?? { [pick]: 1 };
  let num = 0, den = 0;
  for (const [k, p] of Object.entries(probs)) if (k in table) { num += table[k] * p; den += p; }
  const v = den > 0 ? round(num / den, 4) : table[pick];
  const low = conf !== null && conf < th.low_confidence;
  return { status: low ? "low_confidence" : "answered", kind: "model_subjective", value: v, confidence: conf, answer: a, ...(low ? { reason: `confidence ${conf} < ${th.low_confidence}` } : {}) };
}

export interface Aggregate {
  score: number | null; // weighted mean over judged criteria, null when there is too little evidence
  evidence: number; // share of the purpose's weight that was actually judged (low confidence counts at its weight)
  decision: "judged" | "undeterminable";
  criteria: Record<string, CriterionResult>; // every criterion of the rubric, unknown when not in the purpose
}

export function aggregate(r: Rubric, purpose: string, results: Record<string, CriterionResult | undefined>): Aggregate {
  const p = purposeOf(r, purpose);
  const out: Record<string, CriterionResult> = {};
  let num = 0, den = 0, used = 0;
  const total = Object.values(p.weights).reduce((a, b) => a + b, 0);
  for (const name of Object.keys(r.criteria).sort()) {
    const w = p.weights[name];
    if (w === undefined) {
      out[name] = { status: "unknown", value: null, confidence: null, reason: `not part of the "${purpose}" rubric` };
      continue;
    }
    const res = results[name] ?? { status: "unobserved" as Status, value: null, confidence: null, reason: "not evaluated" };
    out[name] = res;
    if (res.value === null || (res.status !== "answered" && res.status !== "low_confidence")) continue;
    const ew = res.status === "low_confidence" ? w * r.thresholds.low_confidence_weight : w;
    num += ew * res.value;
    den += ew;
    used += ew;
  }
  const evidence = round(used / total, 4);
  const judged = evidence >= r.thresholds.min_evidence && den > 0;
  return { score: judged ? round(num / den, 4) : null, evidence, decision: judged ? "judged" : "undeterminable", criteria: out };
}
