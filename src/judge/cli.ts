import * as fs from "node:fs";
import * as path from "node:path";
import type { Project } from "../core/project.ts";
import { readJson, VosError, writeJson } from "../core/util.ts";
import { attach, D1_PIN, d1Paths, RUNNER_PIN, startServer, verifyModel, verifyRunner, type Endpoint } from "./d1.ts";
import { buildPool, type Pool } from "./pool.ts";
import { compare, labelsTemplate, reportMarkdown, type Labels } from "./report.ts";
import { loadRubric } from "./rubric.ts";
import { runBaseline, runD1, writeResult, type RunResult } from "./score.ts";

export const JUDGE_HELP = `vos judge — rank candidate spans per use and propose in/out, with evidence (d1 PoC)

  vos judge rubric [--purpose action|talk|screen]          the fixed rubric (version + sha256) and its questions
  vos judge doctor [--model-dir d] [--llama-server bin] [--rehash]
                                                           pinned model / runner present and verified? (no network;
                                                           --rehash re-reads the 3.4 GB instead of trusting the stamp)
  vos judge pool --purpose P --out <run-dir> [aliases…] [--query "…"] [--seed 1] [--channels text]
                                                           freeze the candidate pool: Marlin events, ASR segments,
                                                           the existing fused search, seeded coverage windows
                                                           (--channels text,visual loads a ~4 GB model locally)
  vos judge score <run-dir> --runner baseline              rank by the existing search only
  vos judge score <run-dir> --runner d1 [--model-dir d --llama-server bin | --endpoint unix:/path.sock|http://127.0.0.1:PORT]
                                     [--refine-top 12] [--trust-stamp] [--allow-incomplete-provenance]
                                                           rubric on real frames via /v1/systemone. vos starts the pinned
                                                           llama-server on a private UNIX socket (no TCP port), re-reads
                                                           the model files, and stops it on exit / Ctrl-C / SIGTERM.
                                                           An attached endpoint, an unpinned runner or a stamp-only model
                                                           check is refused unless --allow-incomplete-provenance.
  vos judge report <run-dir> [--labels labels.json] [--k 10]
                                                           compare; human measures stay null without labels
                                                           (writes labels.template.json for a person to fill)

  <run-dir> is where pool.json, baseline.json, d1.json, calls.jsonl, frames/ and report.* go (and llama-server.pid
  while the server runs). Put it on storage you may write.
  Fail closed: missing / unverified model, old runner, remote endpoint, redirect, invalid reply, low disk → error, no fallback.`;

function readPool(dir: string): Pool {
  const f = path.join(dir, "pool.json");
  if (!fs.existsSync(f)) throw new VosError("no_pool", `${f} does not exist`, "run `vos judge pool --purpose … --out <run-dir>` first");
  return readJson<Pool>(f);
}

export async function judgeCommand(p: () => Project, a: Record<string, any>, rest: string[], out: (data: unknown, human?: () => void) => void): Promise<void> {
  const sub = rest[0];
  if (!sub || sub === "help") {
    console.log(JUDGE_HELP);
    return;
  }
  if (sub === "rubric") {
    const { rubric, ref } = loadRubric();
    const data = a.purpose ? { ref, purpose: a.purpose, ...rubric.purposes[a.purpose], criteria: Object.fromEntries(Object.keys(rubric.purposes[a.purpose]?.weights ?? {}).map((c) => [c, rubric.criteria[c]])) } : { ref, rubric };
    if (a.purpose && !rubric.purposes[a.purpose]) throw new VosError("unknown_purpose", `unknown purpose ${a.purpose}`, `known: ${Object.keys(rubric.purposes).join(", ")}`);
    out(data, () => {
      console.log(`${ref.id}@${ref.version}  sha256 ${ref.sha256}`);
      for (const [name, pu] of Object.entries(rubric.purposes)) {
        if (a.purpose && a.purpose !== name) continue;
        console.log(`\n${name}  ${pu.label}\n  query: ${pu.query}\n  bounds: ${pu.bounds}, peak: ${pu.peak}`);
        for (const [c, w] of Object.entries(pu.weights)) console.log(`  ${String(w).padEnd(5)} ${c.padEnd(18)} [${rubric.criteria[c].on}] ${rubric.criteria[c].question.instructions}`);
      }
    });
    return;
  }
  if (sub === "doctor") {
    const paths = d1Paths({ modelDir: a["model-dir"], server: a["llama-server"] });
    const res: Record<string, unknown> = { pins: { model: D1_PIN, runner: RUNNER_PIN }, paths };
    for (const [k, f] of [["model", () => verifyModel(paths.modelDir, { rehash: !!a.rehash })], ["runner", () => verifyRunner(paths.server)]] as const) {
      try {
        res[k] = { ok: true, ...(f() as object) };
      } catch (e: any) {
        res[k] = { ok: false, code: e.code, error: e.message, hint: e.hint };
      }
    }
    out(res, () => {
      for (const k of ["model", "runner"]) {
        const r = res[k] as any;
        const how = k === "model" && r.ok ? ` (${r.model.verified === "stamp" || r.mmproj.verified === "stamp" ? "stamp only: size + mtime, not re-read — use --rehash" : "every byte hashed"})` : k === "runner" && r.ok ? ` (${r.pinned ? "pinned" : "NOT the pinned release"})` : "";
        console.log(`${k.padEnd(7)} ${r.ok ? "ok" + how : `${r.code}: ${r.error}`}${r.hint ? `\n        hint: ${r.hint}` : ""}`);
      }
    });
    return;
  }
  if (sub === "pool") {
    if (!a.purpose || !a.out) throw new VosError("usage", "vos judge pool --purpose <action|talk|screen> --out <run-dir> [aliases…]");
    const dir = path.resolve(String(a.out));
    if (fs.existsSync(path.join(dir, "pool.json")) && !a.force) throw new VosError("exists", `${dir}/pool.json exists`, "a pool is frozen; use a new run directory (or --force to replace it)");
    const channels = a.channels ? String(a.channels).split(",").map((x) => x.trim()).filter(Boolean) : undefined;
    for (const c of channels ?? []) if (!["text", "visual", "audio"].includes(c)) throw new VosError("usage", `unknown channel ${c}`, "text, visual, audio");
    const pool = buildPool(p(), { aliases: rest.slice(1), purpose: String(a.purpose), query: a.query, seed: a.seed ? Number(a.seed) : undefined, channels: channels as any });
    writeJson(path.join(dir, "pool.json"), pool, false);
    out({ pool: path.join(dir, "pool.json"), digest: pool.digest, candidates: pool.candidates.length, search: pool.search }, () => {
      console.log(`pool ${pool.digest.slice(0, 12)}: ${pool.candidates.length} candidates over ${pool.sources.length} sources → ${dir}/pool.json`);
      const by: Record<string, number> = {};
      for (const c of pool.candidates) for (const o of c.origins) by[o] = (by[o] ?? 0) + 1;
      console.log(`  origins ${JSON.stringify(by)}  search channels ${pool.search.channels_used.join(",") || "none"}${pool.search.channels_unavailable.length ? `  (unavailable: ${pool.search.channels_unavailable.map((u) => u.channel).join(",")})` : ""}`);
      for (const s of pool.sources.filter((x) => x.frames.trusted !== "all")) console.log(`  ⚠ ${s.alias}: ${s.frames.anomaly_count} frame(s) after a timestamp anomaly are not trusted`);
    });
    return;
  }
  if (sub === "score") {
    const dir = path.resolve(rest[1] ?? "");
    const pool = readPool(dir);
    const runner = String(a.runner ?? "");
    let r: RunResult;
    if (runner === "baseline") r = runBaseline(p(), pool);
    else if (runner === "d1") {
      let ep: Endpoint;
      const allow = !!a["allow-incomplete-provenance"];
      if (a.endpoint) ep = await attach(String(a.endpoint));
      else {
        const paths = d1Paths({ modelDir: a["model-dir"], server: a["llama-server"] });
        ep = await startServer({ server: paths.server, modelDir: paths.modelDir, logFile: path.join(dir, "llama-server.log"), pidFile: path.join(dir, "llama-server.pid"), rehash: !a["trust-stamp"], allowUnpinned: allow });
      }
      if (ep.provenance_gaps.length && !allow) {
        await ep.stop();
        throw new VosError("provenance_incomplete", `refusing a comparison run: ${ep.provenance_gaps.join("; ")}`, "let vos start the pinned server with a full model check, or pass --allow-incomplete-provenance (the result is then marked)");
      }
      try {
        r = await runD1(p(), pool, ep, { outDir: dir, refineTop: a["refine-top"] ? Number(a["refine-top"]) : undefined, log: (s) => !a.json && console.error(s) });
      } finally {
        await ep.stop();
      }
    } else throw new VosError("usage", "--runner baseline | d1");
    const f = writeResult(dir, r);
    out({ result: f, runner: r.runner, top: r.ranked.slice(0, 10).map((j) => ({ rank: j.rank, candidate: j.candidate, source: j.source, score: j.score, in: j.bounds.in, out: j.bounds.out })), resources: r.resources }, () => {
      console.log(`${r.runner}: ${r.ranked.length} candidates ranked → ${f}`);
      for (const j of r.ranked.slice(0, 10)) console.log(`  ${String(j.rank).padStart(3)}  ${(j.score ?? NaN).toFixed(3).padStart(7)}  ${j.source}  ${j.bounds.in ?? "?"}–${j.bounds.out ?? "?"}s  [${j.origins.join("+")}] ${j.decision}${j.reason ? `  (${j.reason})` : ""}`);
    });
    return;
  }
  if (sub === "report") {
    const dir = path.resolve(rest[1] ?? "");
    const pool = readPool(dir);
    const runs = ["baseline", "d1"].map((r) => path.join(dir, `${r}.json`)).filter((f) => fs.existsSync(f)).map((f) => readJson<RunResult>(f));
    if (!runs.length) throw new VosError("no_results", "no runner results in the run directory", "vos judge score <run-dir> --runner baseline | d1");
    const labels = a.labels ? readJson<Labels>(path.resolve(String(a.labels))) : null;
    let modelBytes: number | null = null;
    try {
      const m = verifyModel(d1Paths({ modelDir: a["model-dir"] }).modelDir);
      modelBytes = m.model.size + m.mmproj.size;
    } catch {
      modelBytes = null;
    }
    const k = a.k ? Number(a.k) : 10;
    const rep = compare(pool, runs, { k, labels, runDir: dir, modelBytes });
    writeJson(path.join(dir, "report.json"), rep, false);
    fs.writeFileSync(path.join(dir, "report.md"), reportMarkdown(rep));
    const tpl = path.join(dir, "labels.template.json");
    writeJson(tpl, labelsTemplate(pool, runs, k), false);
    out({ report: path.join(dir, "report.json"), markdown: path.join(dir, "report.md"), labels_template: tpl, ...rep }, () => console.log(reportMarkdown(rep) + `\nlabels template: ${tpl}`));
    return;
  }
  throw new VosError("usage", `vos judge ${sub}?`, "run `vos judge help`");
}
