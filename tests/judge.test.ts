import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { indexAsset } from "../src/analyze/embed.ts";
import { sha256File } from "../src/core/hash.ts";
import { loadProject, P, type Project } from "../src/core/project.ts";
import { writeJson } from "../src/core/util.ts";
import { assertLoopback, attach, checkDisk, D1_PIN, decide, runnerEnv, startServer, validateReply, verifyModel, verifyRunner, type Endpoint } from "../src/judge/d1.ts";
import { buildPool, checkPoolFresh, poolDigest } from "../src/judge/pool.ts";
import { extractFrame, frameTable, framesIn, nominalError, snap, trustedTimes, type FrameTable } from "../src/judge/pts.ts";
import { compare, labelsTemplate, reportMarkdown as reportMd, validateLabels } from "../src/judge/report.ts";
import { aggregate, interpret, loadRubric, questionsFor, RUBRIC_FILE, type Question } from "../src/judge/rubric.ts";
import { runBaseline, runD1 } from "../src/judge/score.ts";
import { fixtureProject } from "./helpers.ts";

process.env.VOS_EMBED_MOCK = "1"; // deterministic search vectors; no model needed

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "vos-judge-"));
const round3 = (x: number) => Math.round(x * 1000) / 1000;
const ff = (args: string[]) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args]);

// ---------------- frame times ----------------

test("PTS: B-frames + non-zero container start → media time from the decoder, extraction checked against it", () => {
  const d = tmp();
  const f = path.join(d, "bf_off.mp4");
  ff(["-f", "lavfi", "-i", "testsrc2=size=160x90:rate=30:duration=2", "-c:v", "libx264", "-bf", "3", "-g", "15", "-pix_fmt", "yuv420p", "-output_ts_offset", "10", f]);
  const t = frameTable(f, "a_test", d);
  assert.equal(t.format_start, 10);
  assert.equal(t.t.length, 60);
  assert.equal(t.t[0], 0, "first frame is media time 0, not 10");
  assert.ok(t.reordered_packets > 0, "packets arrive out of presentation order (B-frames)");
  assert.equal(t.vfr.vfr, false);
  assert.equal(t.trusted, "all");
  assert.equal(snap(t, 1.0).index, 30);
  assert.equal(snap(t, 1.01).t, 1.0, "the frame on screen at 1.01 s is the one shown at 1.0 s");
  const fr = extractFrame(f, t, 45, path.join(d, "frames"));
  assert.ok(Math.abs(fr.observed_t - 1.5) < 1e-4, `decoder delivered ${fr.observed_t}`);
  assert.equal(fr.sha256, sha256File(fr.file));
  assert.ok(fs.existsSync(path.join(d, "pts", "a_test.json")), "the table is cached");
  assert.deepEqual(frameTable(f, "a_test", d).digest, t.digest);
});

test("PTS: VFR — index / nominal fps is wrong, the table and the extracted frame are right", () => {
  const d = tmp();
  const f = path.join(d, "vfr.mp4");
  // 30 fps for the first second, then every third frame at 10 fps
  ff(["-f", "lavfi", "-i", "testsrc2=size=160x90:rate=30:duration=2", "-vf", "select='lt(t\\,1)+not(mod(n\\,3))',setpts='if(lt(N\\,30)\\,N/30\\,1+(N-30)/10)/TB'", "-fps_mode", "vfr", "-c:v", "libx264", "-bf", "2", "-pix_fmt", "yuv420p", f]);
  const t = frameTable(f, "a_vfr", d);
  assert.equal(t.vfr.vfr, true);
  assert.equal(t.t[35], 1.5);
  assert.ok(Math.abs(nominalError(t, 35)! - (35 / 30 - 1.5)) < 1e-6, "a fps-based reading would be off by a third of a second");
  assert.equal(snap(t, 1.55).t, 1.5);
  assert.equal(snap(t, 1.55).next_t, 1.6);
  const fr = extractFrame(f, t, 35, path.join(d, "frames"));
  assert.ok(Math.abs(fr.observed_t - 1.5) < 1e-4);
  const dense = framesIn(t, 0.9, 1.35, 0.05, 50);
  assert.deepEqual(dense.map((s) => s.t), [0.9, 0.933333, 0.966667, 1, 1.1, 1.2, 1.3], "every real frame in the window, each once");
  assert.deepEqual(framesIn(t, 0.9, 1.35, 0.05, 3).map((s) => s.t), [0.9, 1, 1.3], "an even pick in frame order when capped");
});

test("PTS: video shorter than the container / starting late → flagged, never invented", () => {
  const d = tmp();
  const f = path.join(d, "tail.mp4");
  ff(["-f", "lavfi", "-i", "testsrc2=size=160x90:rate=25:duration=1", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", f]);
  const t = frameTable(f, "a_tail", d);
  assert.ok(t.format_duration! > 1.9);
  assert.ok(Math.abs(t.last_frame_end - 1.0) < 1e-3, `last frame ends at ${t.last_frame_end}`);
  assert.equal(snap(t, 1.5).flag, "past_end");
  assert.equal(snap(t, 1.5).index, 24, "clamped to the last real frame");
  const late = path.join(d, "late.mp4");
  ff(["-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-itsoffset", "0.5", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=25:duration=1", "-map", "0:a", "-map", "1:v", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", late]);
  const t2 = frameTable(late, "a_late", d);
  assert.ok(t2.t[0] >= 0.45, `first frame at ${t2.t[0]}`);
  assert.equal(snap(t2, 0.1).flag, "before_first_frame");
});

test("PTS: repeated / backwards / missing times → trusted only up to the first anomaly", () => {
  const r = trustedTimes([10, 10.033, 10.066, 10.066, 10.05, 10.1, null], 10);
  assert.equal(r.times.length, 2, "the frame before a repeated time is dropped too: which image is at 10.066 is ambiguous");
  assert.equal(r.firstBad, 2);
  assert.deepEqual(r.anomalies.map((a) => a.kind), ["ambiguous_previous", "duplicate", "backward", "non_finite"]);
  const table = { t: r.times.map((x) => Math.round(x * 1e6) / 1e6), last_frame_end: 0.099, trusted: "until_first_anomaly" } as unknown as FrameTable;
  assert.equal(snap(table, 0.2).flag, "past_trusted", "times after the anomaly cannot be tied to a frame");
  // the screen-recording tail: two frames share pts 43.486667, the second's best-effort time goes back to 43.428333
  const sr = trustedTimes([
    { best_effort: 43.42, pts: 43.42, pkt_dts: 43.4 },
    { best_effort: 43.486667, pts: 43.486667, pkt_dts: 43.45 },
    { best_effort: 43.428333, pts: 43.486667, pkt_dts: 43.428333 },
  ], 0);
  assert.deepEqual(sr.times, [43.42], "the frame sharing the repeated pts is not trusted either (which image is 43.4867 is ambiguous)");
  assert.deepEqual(sr.anomalies.map((a) => a.kind), ["ambiguous_previous", "backward"]);
  assert.deepEqual([sr.anomalies[1].pts, sr.anomalies[1].pkt_dts], [43.486667, 43.428333], "pts and pkt_dts are kept with the anomaly");
  // pts repeats while best-effort moves on → anomaly too; a frame with pts N/A but a best-effort time is counted
  const dp = trustedTimes([{ best_effort: 0, pts: 0, pkt_dts: null }, { best_effort: 0.04, pts: null, pkt_dts: null }, { best_effort: 0.08, pts: 0.08, pkt_dts: null }, { best_effort: 0.12, pts: 0.08, pkt_dts: null }], 0);
  assert.deepEqual(dp.anomalies.map((a) => a.kind), ["ambiguous_previous", "duplicate_pts"]);
  assert.deepEqual(dp.times, [0, 0.04]);
  assert.deepEqual(dp.source, { pts: 1, best_effort_only: 1 });
});

test("PTS: a table that disagrees with the decoder is refused, not silently substituted", () => {
  const d = tmp();
  const f = path.join(d, "c.mp4");
  ff(["-f", "lavfi", "-i", "testsrc2=size=160x90:rate=30:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", f]);
  const t = frameTable(f, "a_c", d);
  const forged: FrameTable = { ...t, t: t.t.map((x, i) => (i === 10 ? x + 0.02 : x)) };
  assert.throws(() => extractFrame(f, forged, 10, path.join(d, "frames")), (e: any) => e.code === "pts_mismatch");
});

// ---------------- rubric ----------------

test("rubric: fixed, hashed; purposes judge only their criteria, the rest is unknown", () => {
  const { rubric, ref } = loadRubric();
  assert.equal(ref.sha256, loadRubric().ref.sha256);
  const d = tmp();
  const edited = JSON.parse(fs.readFileSync(RUBRIC_FILE, "utf8"));
  edited.purposes.action.weights.subject = 0.3;
  fs.writeFileSync(path.join(d, "r.json"), JSON.stringify(edited));
  assert.notEqual(loadRubric(path.join(d, "r.json")).ref.sha256, ref.sha256, "any change is a new rubric");
  assert.deepEqual(Object.keys(questionsFor(rubric, "talk", "transcript")), ["utterance_complete"]);
  assert.ok(!("utterance_complete" in questionsFor(rubric, "talk", "frame")));
  const agg = aggregate(rubric, "screen", { readability: { status: "answered", value: 1, confidence: 0.9 }, sharpness: { status: "answered", value: 1, confidence: 0.9 } });
  assert.equal(agg.criteria.action_peak.status, "unknown");
  assert.equal(agg.criteria.utterance_complete.status, "unknown");
  assert.equal(agg.criteria.composition.status, "unobserved", "in the purpose but not evaluated");
  assert.equal(agg.decision, "judged");
  assert.equal(aggregate(rubric, "screen", { sharpness: { status: "answered", value: 1, confidence: 1 } }).decision, "undeterminable", "too little of the rubric was judged");
});

test("rubric: abstain / unobserved / low confidence are kept apart from a value", () => {
  const { rubric } = loadRubric();
  const ch = (choice: string, probs: Record<string, number>, confidence = 0.8) => ({ type: "choice" as const, choice, confidence, probabilities: probs });
  assert.equal(interpret(rubric, "sharpness", ch("cannot_tell", { sharp: 0.1, slight_blur: 0.1, heavy_blur: 0.1, cannot_tell: 0.7 })).status, "abstained");
  const nf = interpret(rubric, "expression", ch("no_face", { readable: 0.1, hard_to_read: 0.1, no_face: 0.7, cannot_tell: 0.1 }));
  assert.equal(nf.status, "unobserved");
  assert.equal(nf.value, null);
  assert.equal(interpret(rubric, "subject", { type: "noul", noul: 0.5 }).status, "low_confidence");
  const n = interpret(rubric, "subject", { type: "noul", noul: 0.9 });
  assert.deepEqual([n.status, n.kind, n.confidence, n.p_margin], ["answered", "model_subjective", null, 0.8], "noul: no model-reported confidence; the margin is derived and kept apart");
  const s = interpret(rubric, "action_peak", { type: "score", score: 3, confidence: 0.9, probabilities: { 0: 0, 1: 0, 2: 0, 3: 1 } });
  assert.deepEqual([s.status, s.value, s.kind], ["answered", 1, "model_subjective"], "a model answer is the model's subjective reading, not an observation");
  assert.equal(interpret(rubric, "action_peak", { type: "score", score: 1.5, confidence: 0.1, probabilities: { 0: 0.25, 1: 0.25, 2: 0.25, 3: 0.25 } }).status, "low_confidence");
});

// ---------------- d1 contract ----------------

const Q: Record<string, Question> = {
  a: { type: "noul", instructions: "x?" },
  b: { type: "choice", instructions: "y?", criteria: { p: "P", q: "Q" } },
  c: { type: "score", instructions: "z?", criteria: ["lo", "mid", "hi"] },
};
const good = () => ({
  answers: {
    a: { type: "noul", noul: 0.9 },
    b: { type: "choice", choice: "q", confidence: 0.4, probabilities: { p: 0.3, q: 0.7 } },
    c: { type: "score", score: 1.2, confidence: 0.5, probabilities: { 0: 0.1, 1: 0.6, 2: 0.3 }, legend: { 0: "lo", 1: "mid", 2: "hi" } },
  },
  usage: { input_tokens: 50, output_tokens: 0 },
});

test("d1 reply: exactly what was asked, well-formed — anything else is invalid_reply", () => {
  assert.equal(validateReply(Q, good()).answers.b.choice, "q");
  const bad = (mut: (g: any) => void) => {
    const g = good();
    mut(g);
    assert.throws(() => validateReply(Q, g), (e: any) => e.code === "invalid_reply", JSON.stringify(g));
  };
  bad((g) => delete g.answers.c);
  bad((g) => (g.answers.extra = { type: "noul", noul: 0.1 }));
  bad((g) => (g.answers.a.noul = 1.4));
  bad((g) => (g.answers.a.type = "choice"));
  bad((g) => (g.answers.b.probabilities = { p: 0.3, q: 0.3 }));
  bad((g) => (g.answers.b.choice = "p"));
  bad((g) => (g.answers.b.probabilities = { p: 0.3, r: 0.7 }));
  bad((g) => (g.answers.c.score = 2.5));
  bad((g) => (g.usage.output_tokens = 3));
  bad((g) => (g.answers = null));
});

test("d1 endpoint: loopback only; disk floor; missing / unpinned model and old runner fail closed", () => {
  assert.equal(assertLoopback("http://127.0.0.1:8080").port, "8080");
  assertLoopback("http://localhost:1");
  assertLoopback("http://[::1]:9");
  for (const u of ["http://192.168.1.10:8080", "https://127.0.0.1:8080", "http://example.com", "http://127.0.0.1.nip.io"]) assert.throws(() => assertLoopback(u), (e: any) => e.code === "remote_endpoint_refused", u);
  assert.throws(() => checkDisk(tmp(), Number.MAX_SAFE_INTEGER), (e: any) => e.code === "low_disk");
  assert.throws(() => verifyModel(null), (e: any) => e.code === "model_missing");
  const d = tmp();
  assert.throws(() => verifyModel(d), (e: any) => e.code === "model_missing" && /resolve\/bb1e436/.test(e.hint));
  fs.writeFileSync(path.join(d, D1_PIN.files.model.name), "not a model");
  assert.throws(() => verifyModel(d), (e: any) => e.code === "model_hash_mismatch");
  const old = path.join(d, "old-server");
  fs.writeFileSync(old, "#!/bin/sh\necho 'version: 0.5.0 (build 11000, commit abcdef1)' >&2\n");
  fs.chmodSync(old, 0o755);
  assert.throws(() => verifyRunner(old), (e: any) => e.code === "runner_unsupported");
  const cur = path.join(d, "cur-server");
  fs.writeFileSync(cur, "#!/bin/sh\necho 'version: 0.6.0-dev (build 11491, commit 9b4ed0ca5)' >&2\n");
  fs.chmodSync(cur, 0o755);
  assert.equal(verifyRunner(cur).pinned, true);
  assert.throws(() => verifyRunner(path.join(d, "nope")), (e: any) => e.code === "runner_missing");
});

/** A stand-in decision server for tests: deterministic, well-formed answers derived from the request. */
function fakeD1(opts: { status?: number; body?: string; models?: any; log?: any[]; flat?: boolean } = {}): Promise<{ url: string; close: () => Promise<void> }> {
  const srv = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (req.method === "GET" && req.url === "/v1/models") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(opts.models ?? { data: [{ id: "/nonexistent/d1-3B-Q8_0.gguf", architecture: { input_modalities: ["text", "image"], output_modalities: ["decisions"] } }] }));
        return;
      }
      if (opts.status) {
        res.writeHead(opts.status);
        res.end(opts.body ?? "");
        return;
      }
      if (opts.body !== undefined) {
        res.writeHead(200);
        res.end(opts.body);
        return;
      }
      const reqJ = JSON.parse(raw);
      opts.log?.push(reqJ);
      const seed = createHash("sha256").update(opts.flat ? "flat" : String(reqJ.images?.[0] ?? reqJ.state)).digest();
      const answers: Record<string, any> = {};
      Object.entries(reqJ.questions as Record<string, Question>).forEach(([name, q], qi) => {
        const r = (k: number) => (seed[(qi * 7 + k) % 32] + 1) / 257;
        if (q.type === "noul") answers[name] = { type: "noul", noul: r(0) };
        else {
          const keys = q.type === "choice" ? Object.keys(q.criteria as object) : (q.criteria as string[]).map((_, i) => String(i));
          const w = keys.map((_, i) => r(i) ** 3);
          const s = w.reduce((a, b) => a + b, 0);
          const probs = Object.fromEntries(keys.map((k, i) => [k, w[i] / s]));
          const best = keys.reduce((a, b) => (probs[b] > probs[a] ? b : a));
          answers[name] = q.type === "choice"
            ? { type: "choice", choice: best, confidence: probs[best], probabilities: probs }
            : { type: "score", score: keys.reduce((a, k) => a + Number(k) * probs[k], 0), confidence: probs[best], probabilities: probs };
        }
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ answers, usage: { input_tokens: 10, output_tokens: 0 } }));
    });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${(srv.address() as any).port}`, close: () => new Promise((r) => srv.close(() => r())) })));
}

test("d1 endpoint: 404 / 501 → endpoint_unsupported, non-JSON → invalid_reply; attach checks the model file", async () => {
  for (const status of [404, 501]) {
    const s = await fakeD1({ status });
    await assert.rejects(decide(s.url, "x", Q), (e: any) => e.code === "endpoint_unsupported");
    await s.close();
  }
  const g = await fakeD1({ body: "<html>" });
  await assert.rejects(decide(g.url, "x", Q), (e: any) => e.code === "invalid_reply");
  await g.close();
  const ok = await fakeD1();
  const d = await decide(ok.url, "hello", Q);
  assert.deepEqual(Object.keys(d.answers).sort(), ["a", "b", "c"]);
  await assert.rejects(attach(ok.url), (e: any) => e.code === "model_unverified", "the reported model file cannot be checked");
  await ok.close();
  const txt = await fakeD1({ models: { data: [{ id: "x", architecture: { input_modalities: ["text"], output_modalities: ["text"] } }] } });
  await assert.rejects(attach(txt.url), (e: any) => e.code === "endpoint_unsupported");
  await txt.close();
  await assert.rejects(attach("http://10.0.0.1:8080"), (e: any) => e.code === "remote_endpoint_refused");
});

// ---------------- pool → runners → report ----------------

function judgeProject(): Project {
  const p0 = fixtureProject();
  const clip = p0.assets.assets.clip;
  writeJson(path.join(P.analysis(p0.root, clip.id), "describe.json"), {
    format: "vos.describe/1", asset: clip.id, scene: "a colourful test pattern",
    events: [{ start: 0.2, end: 1.8, description: "a bright wheel spins quickly" }, { start: 2, end: 3.9, description: "a person looks up at the sky" }],
    finds: [], provenance: { producer: "test", model: "none", at: "2026-01-01" },
  });
  writeJson(path.join(P.analysis(p0.root, clip.id), "transcript.json"), {
    format: "vos.transcript/1", asset: clip.id, language: "ja",
    segments: [{ start: 0.5, end: 1.6, text: "今日はいい天気です。", words: [] }, { start: 2.1, end: 3.0, text: "それで", words: [] }],
    provenance: { engine: "test", model: "none", vocab: "", key: "k", at: "2026-01-01" },
  });
  const p = loadProject(p0.root);
  indexAsset(p, "clip", "text");
  indexAsset(p, "clip", "visual", { step: 1 });
  return loadProject(p0.root);
}

test("pool: events + ASR + existing search + seeded coverage, frozen with artifact hashes; same seed, same pool", () => {
  const p = judgeProject();
  const pool = buildPool(p, { purpose: "action", aliases: ["clip"], seed: 7 });
  const origins = new Set(pool.candidates.flatMap((c) => c.origins));
  for (const o of ["event", "asr", "search", "coverage"]) assert.ok(origins.has(o as any), `has ${o} candidates`);
  assert.equal(pool.artifacts_before, pool.artifacts_after);
  const src = pool.sources[0];
  assert.match(src.sha256, /^[0-9a-f]{64}$/, "full-file SHA-256, apart from the short content id");
  assert.notEqual(src.sha256, src.content_id);
  assert.ok(src.artifacts["describe.json"] && src.artifacts["embed.visual.f32"]);
  assert.equal(src.frames.frame_count, 120);
  for (const c of pool.candidates) assert.ok(c.start.frame && c.end.frame, "every bound sits on a real frame");
  const again = buildPool(p, { purpose: "action", aliases: ["clip"], seed: 7 });
  assert.equal(again.digest, pool.digest);
  assert.notEqual(buildPool(p, { purpose: "action", aliases: ["clip"], seed: 8 }).digest, pool.digest, "coverage windows follow the seed");
  assert.ok(!JSON.stringify(pool).includes(p.root), "no absolute paths in the pool");
  // the analysis changes → both runners refuse the pool
  const desc = path.join(P.analysis(p.root, src.content_id), "describe.json");
  fs.appendFileSync(desc, " ");
  assert.throws(() => checkPoolFresh(p, pool), (e: any) => e.code === "stale_pool");
});

test("runners on one pool: baseline = existing search; d1 = rubric on checked frames + dense in/out; report keeps human measures null", async () => {
  const p = judgeProject();
  const pool = buildPool(p, { purpose: "action", aliases: ["clip"], seed: 3 });
  const base = runBaseline(p, pool);
  assert.equal(base.ranked.length, pool.candidates.length);
  assert.ok(base.ranked[0].score! > 0, "the search surfaced something");
  assert.equal(base.ranked.filter((j) => j.origins.join() === "coverage" && j.score === 0).every((j) => j.decision === "undeterminable"), true);

  const log: any[] = [];
  const fake = await fakeD1({ log });
  const run = tmp();
  const ep: Endpoint = { url: fake.url, mode: "attached", exposure: "tcp_loopback", provenance_gaps: ["test"], model_id: "/x/d1-3B-Q8_0.gguf", modalities: { input: ["text", "image"], output: ["decisions"] }, maxRssKiB: () => null, stop: async () => {} };
  const r = await runD1(p, pool, ep, { outDir: run, refineTop: 3, minFreeBytes: 1 });
  await fake.close();
  assert.equal(r.ranked.length, pool.candidates.length);
  assert.ok(log.every((q) => q.images?.length === 1 && q.images[0].startsWith("data:image/jpeg;base64,")), "frames only, as data URLs, to loopback");
  for (const j of r.ranked) {
    assert.equal(j.criteria!.readability.status, "unknown", "not part of the action rubric");
    assert.equal(j.criteria!.utterance_complete.status, "unknown");
    for (const f of j.frames ?? []) {
      assert.ok(Math.abs(f.ref.observed_t - f.ref.t) < 1e-3);
      assert.equal(sha256File(path.join(run, f.ref.file)), f.ref.sha256);
    }
  }
  const refined = r.ranked.filter((j) => j.refine);
  assert.ok(refined.length >= 1 && refined.length <= 3);
  for (const j of refined.filter((x) => x.bounds.basis === "frames")) {
    const [ilo, ihi] = j.bounds.in_range!, [olo, ohi] = j.bounds.out_range!;
    assert.ok((ilo === null || ilo <= j.bounds.in!) && j.bounds.in! <= ihi, "the estimate sits inside its range");
    assert.ok(ohi === null || olo <= ohi);
    assert.equal(ilo === null, !!j.bounds.open?.includes("in"), "only an open side is unbounded");
    assert.equal(ohi === null, !!j.bounds.open?.includes("out"));
  }
  assert.equal(r.manifest.rubric && (r.manifest.rubric as any).sha256, pool.rubric.sha256);
  assert.ok((r.resources as any).d1_calls > 0);

  const rep = compare(pool, [base, r], { k: 5, runDir: run });
  for (const runner of ["baseline", "d1"]) {
    for (const [k, v] of Object.entries((rep.human as any)[runner])) assert.equal((v as any).value, null, `${runner}.${k} must stay null without labels`);
  }
  assert.ok(typeof (rep.model_proxy.agreement as any).top_k_overlap === "number");
  const tpl = labelsTemplate(pool, [base, r], 2, 4);
  assert.ok(Object.values(tpl.order).includes("audit (outside both top-k)"), "people also see spans neither runner ranked high");
  // with labels, the measures become real
  const adopt = r.ranked[0].candidate;
  const labeled = compare(pool, [base, r], { k: 5, labels: { format: "vos.judge-labels/1", pool_digest: pool.digest, labeler: "test", items: [{ candidate: adopt, adopt: true, in: 1.0, out: 2.0 }] } });
  assert.equal((labeled.human as any).d1.adoption_at_k.value, 1);
  assert.equal((labeled.human as any).d1.miss_rate.value, 0);
  assert.equal((labeled.human as any).d1.search_sec.value, null);
});

test("talk purpose: the transcript is judged as text; a span without words is unobserved, not guessed", async () => {
  const p = judgeProject();
  const pool = buildPool(p, { purpose: "talk", aliases: ["clip"], seed: 1 });
  const log: any[] = [];
  const fake = await fakeD1({ log });
  const ep: Endpoint = { url: fake.url, mode: "attached", exposure: "tcp_loopback", provenance_gaps: ["test"], model_id: "/x/m.gguf", modalities: { input: ["text", "image"], output: ["decisions"] }, maxRssKiB: () => null, stop: async () => {} };
  const r = await runD1(p, pool, ep, { outDir: tmp(), refineTop: 2, minFreeBytes: 1 });
  await fake.close();
  const textCalls = log.filter((q) => !q.images);
  assert.ok(textCalls.length >= 1 && textCalls.every((q) => typeof q.state === "string" && "utterance_complete" in q.questions));
  const silent = r.ranked.find((j) => {
    const c = pool.candidates.find((x) => x.id === j.candidate)!;
    return c.end.claimed < 0.5 || c.start.claimed > 3.0;
  });
  if (silent) assert.equal(silent.criteria!.utterance_complete.status, "unobserved");
  for (const j of r.ranked.filter((x) => x.bounds.basis === "transcript")) assert.ok(j.bounds.in !== null && j.bounds.out! > j.bounds.in!);
});

// ---------------- review fixes: transport, server lifecycle, frozen pool, labels ----------------

test("d1 transport: a redirect is refused and never followed; a timeout is `timeout`", async () => {
  const got: string[] = [];
  const other = http.createServer((req, res) => {
    got.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "x", architecture: { input_modalities: ["image"], output_modalities: ["decisions"] } }], answers: { a: { type: "noul", noul: 0.9 } } }));
  });
  await new Promise<void>((r) => other.listen(0, "127.0.0.1", () => r()));
  const front = http.createServer((req, res) => {
    req.resume();
    res.writeHead(307, { location: `http://127.0.0.1:${(other.address() as any).port}${req.url}` });
    res.end();
  });
  await new Promise<void>((r) => front.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(front.address() as any).port}`;
  await assert.rejects(decide(url, null, { a: { type: "noul", instructions: "q?" } }, [Buffer.from("FRAME")]), (e: any) => e.code === "endpoint_redirect_refused");
  await assert.rejects(attach(url), (e: any) => e.code === "endpoint_redirect_refused");
  assert.deepEqual(got, [], "the redirect target never received the frame (or anything else)");
  const hang = http.createServer(() => {});
  await new Promise<void>((r) => hang.listen(0, "127.0.0.1", () => r()));
  await assert.rejects(decide(`http://127.0.0.1:${(hang.address() as any).port}`, "x", Q, [], 300), (e: any) => e.code === "timeout");
  hang.closeAllConnections();
  for (const s of [front, other, hang]) await new Promise((r) => s.close(r));
});

/** A stand-in llama-server (no model): --version, and an HTTP server on the --host UNIX socket that reports its env. */
function fakeRunner(dir: string, build = 11491): string {
  const f = path.join(dir, `fake-llama-server-${build}.mjs`);
  fs.writeFileSync(f, `#!${process.execPath}
import * as http from "node:http";
import * as fs from "node:fs";
const a = process.argv.slice(2);
if (a.includes("--version")) { console.error("version: 0.6.0-dev (build ${build}, commit 9b4ed0ca5)"); process.exit(0); }
const host = a[a.indexOf("--host") + 1], m = a[a.indexOf("-m") + 1];
const llama = Object.keys(process.env).filter((k) => k.startsWith("LLAMA_"));
http.createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    res.writeHead(200, { "Content-Type": "application/json" });
    if (req.url === "/health") return res.end("{}");
    if (req.url === "/v1/models") return res.end(JSON.stringify({ data: [{ id: m, architecture: { input_modalities: ["text", "image"], output_modalities: ["decisions"] } }] }));
    if (req.url === "/fake/info") return res.end(JSON.stringify({ args: a, llama_env: llama }));
    res.end(JSON.stringify({ answers: { a: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 3, output_tokens: 0 } }));
  });
}).listen(host);
setInterval(() => {}, 1 << 30);
`);
  fs.chmodSync(f, 0o755);
  return f;
}

/** Sparse stand-ins for the pinned GGUF files with a stamp (no real model; rehash would — rightly — reject them). */
function stampedModelDir(): string {
  const d = tmp();
  for (const w of [D1_PIN.files.model, D1_PIN.files.mmproj]) {
    const f = path.join(d, w.name);
    fs.closeSync(fs.openSync(f, "w"));
    fs.truncateSync(f, w.size);
    const st = fs.statSync(f);
    fs.writeFileSync(`${f}.vos-verified.json`, JSON.stringify({ size: st.size, mtime_ms: st.mtimeMs, sha256: w.sha256 }));
  }
  return d;
}

const shortTmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "vj-"));

test("d1 server: private UNIX socket (no TCP port), LLAMA_* env stripped, hardening flags, pid file, stamp is a provenance gap", async () => {
  const d = shortTmp();
  const runner = fakeRunner(d);
  const models = stampedModelDir();
  process.env.LLAMA_ARG_TOOLS = "all";
  process.env.LLAMA_ARG_CORS_ORIGINS = "*";
  const pidFile = path.join(d, "llama-server.pid");
  let ep;
  try {
    assert.ok(runnerEnv().removed.includes("LLAMA_ARG_TOOLS"));
    await assert.rejects(startServer({ server: runner, modelDir: models, rehash: true }), (e: any) => e.code === "model_hash_mismatch", "a full read rejects the stand-ins");
    ep = await startServer({ server: runner, modelDir: models, rehash: false, pidFile, readyTimeoutMs: 20_000 });
  } finally {
    delete process.env.LLAMA_ARG_TOOLS;
    delete process.env.LLAMA_ARG_CORS_ORIGINS;
  }
  try {
    assert.match(ep.url, /^unix:\/.*\.sock$/);
    assert.equal(ep.exposure, "unix_socket_private_dir");
    const sock = ep.url.slice(5);
    assert.ok(fs.statSync(sock).isSocket());
    assert.equal(fs.statSync(path.dirname(sock)).mode & 0o777, 0o700, "only this user can reach the socket");
    assert.ok(ep.provenance_gaps.some((g) => /stamp/.test(g)), "a stamp-only model check is reported as a gap");
    assert.ok(fs.existsSync(pidFile) && JSON.parse(fs.readFileSync(pidFile, "utf8")).pid === ep.pid);
    const info = JSON.parse((await (await import("../src/judge/d1.ts")).httpCall(ep.url, "GET", "/fake/info")).text);
    assert.deepEqual(info.llama_env, [], "no LLAMA_* variable reaches the runner");
    for (const flag of ["--offline", "--no-webui", "--no-slots", "--no-cors-credentials"]) assert.ok(info.args.includes(flag), flag);
    assert.ok(!info.args.includes("--port"));
    const dd = await decide(ep.url, null, { a: { type: "noul", instructions: "q?" } }, [Buffer.from("x")]);
    assert.deepEqual(dd.call.usage, { present: true, input_tokens: 3, output_tokens: 0 });
    assert.match(dd.call.reply_sha256, /^[0-9a-f]{64}$/);
  } finally {
    await ep.stop();
  }
  assert.ok(!fs.existsSync(pidFile), "pid file removed on stop");
  assert.ok(!fs.existsSync(ep.url.slice(5)), "socket removed on stop");
  assert.throws(() => process.kill(ep.pid!, 0), "runner stopped");
  const old = fakeRunner(d, 11490);
  await assert.rejects(startServer({ server: old, modelDir: models, rehash: false }), (e: any) => e.code === "runner_unpinned");
});

test("d1 server: SIGTERM to the vos process also stops the runner (no orphan)", async () => {
  const d = shortTmp();
  const runner = fakeRunner(d);
  const models = stampedModelDir();
  const script = path.join(d, "hold.ts");
  fs.writeFileSync(script, `const { startServer } = await import(${JSON.stringify(path.resolve("src/judge/d1.ts"))});
const ep = await startServer({ server: ${JSON.stringify(runner)}, modelDir: ${JSON.stringify(models)}, rehash: false, pidFile: ${JSON.stringify(path.join(d, "pid.json"))}, readyTimeoutMs: 20000 });
console.log(JSON.stringify({ pid: ep.pid }));
setInterval(() => {}, 1 << 30);
`);
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, ["--no-warnings", script], { stdio: ["ignore", "pipe", "inherit"] });
  const line: string = await new Promise((res, rej) => {
    let b = "";
    child.stdout!.on("data", (c) => {
      b += c;
      if (b.includes("\n")) res(b.split("\n")[0]);
    });
    child.on("exit", (c) => rej(new Error(`exited ${c}`)));
  });
  const runnerPid = JSON.parse(line).pid;
  process.kill(runnerPid, 0);
  child.kill("SIGTERM");
  const code = await new Promise((r) => child.on("exit", (c, sig) => r(c ?? sig)));
  assert.equal(code, 128 + 15);
  let alive = true;
  for (let i = 0; i < 50 && alive; i++) {
    try {
      process.kill(runnerPid, 0);
      await new Promise((r) => setTimeout(r, 100));
    } catch {
      alive = false;
    }
  }
  if (alive) process.kill(runnerPid, "SIGKILL");
  assert.equal(alive, false, "the runner did not outlive vos");
  assert.ok(!fs.existsSync(path.join(d, "pid.json")));
});

test("frozen pool: purpose / query / transcript edits, a replaced pool and mixed-purpose results are refused", async () => {
  const p = judgeProject();
  const pool = buildPool(p, { purpose: "talk", aliases: ["clip"], seed: 1 });
  assert.equal(poolDigest(pool), pool.digest);
  assert.deepEqual(pool.search.channels_requested, ["text"], "the heavy visual channel is not used unless asked for");
  assert.ok(pool.tools.ffprobe && pool.tools.ffmpeg);
  for (const edit of [(x: any) => (x.purpose = "action"), (x: any) => (x.query = "something else"), (x: any) => (x.sources[0].transcript_segments[0].text = "TAMPERED")]) {
    const forged = structuredClone(pool);
    edit(forged);
    assert.throws(() => checkPoolFresh(p, forged), (e: any) => e.code === "stale_pool");
  }
  // a re-signed pool with transcript text that is not in transcript.json is still refused
  const resigned: any = structuredClone(pool);
  resigned.sources[0].transcript_segments[0].text = "TAMPERED";
  resigned.digest = poolDigest(resigned);
  assert.throws(() => checkPoolFresh(p, resigned), (e: any) => e.code === "stale_pool" && /transcript/.test(e.message));
  const other = buildPool(p, { purpose: "action", aliases: ["clip"], seed: 1 });
  assert.notEqual(other.digest, pool.digest, "same candidates, other purpose → other digest");
  const base = runBaseline(p, pool);
  const baseOther = runBaseline(p, other);
  assert.throws(() => compare(pool, [baseOther]), (e: any) => e.code === "pool_mismatch");
  assert.throws(() => compare(pool, [{ ...base, pool: { ...base.pool, purpose: "action" } }]), (e: any) => e.code === "pool_mismatch");
  assert.equal((base.manifest as any).vos.git_tree.length, 40);
  assert.equal(typeof (base.manifest as any).vos.worktree_clean, "boolean");
});

test("d1 run: every call is logged (latency, status, hashes, usage); provenance gaps are carried into the report", async () => {
  const p = judgeProject();
  const pool = buildPool(p, { purpose: "action", aliases: ["clip"], seed: 3 });
  const fake = await fakeD1();
  const run = tmp();
  const ep: Endpoint = { url: fake.url, mode: "attached", exposure: "tcp_loopback", provenance_gaps: ["attached: test"], model_id: "/x/m.gguf", modalities: { input: ["text", "image"], output: ["decisions"] }, maxRssKiB: () => null, stop: async () => {} };
  const r = await runD1(p, pool, ep, { outDir: run, refineTop: 1, minFreeBytes: 1 });
  await fake.close();
  const lines = fs.readFileSync(path.join(run, "calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, (r.resources as any).d1_calls);
  for (const l of lines) {
    assert.ok(l.ms >= 0 && l.status === 200 && /^[0-9a-f]{64}$/.test(l.reply_sha256) && /^[0-9a-f]{64}$/.test(l.request_sha256));
    assert.equal(l.usage.output_tokens, 0);
  }
  assert.equal((r.resources as any).usage.output_tokens_zero, lines.length);
  assert.deepEqual((r.manifest as any).provenance, { complete: false, gaps: ["attached: test"] });
  const rep = compare(pool, [r], { k: 3 });
  assert.equal((rep.model_proxy.per_runner as any).d1.provenance.complete, false);
  assert.ok(rep.coverage[0].pool_span_share! > 0 && rep.coverage[0].coverage_window_share! <= rep.coverage[0].pool_span_share!);
});

test("spans are half-open: an end exactly on a frame time does not take that frame", () => {
  const p = judgeProject();
  const pool = buildPool(p, { purpose: "action", aliases: ["clip"], seed: 1, search: () => ({ query: "q", channels_used: ["text"], channels_unavailable: [], hits: [{ alias: "clip", start: 1, end: 2, score: 1, channels: {} } as any] }) });
  const c = pool.candidates.find((x) => x.origins.includes("search") && x.start.claimed === 1 && x.end.claimed === 2)!;
  assert.ok(c, "the search span is a candidate");
  assert.equal(c.end.frame!.next_t, 2, "the last frame shown is the one before t = 2");
  const base = runBaseline(p, pool);
  assert.equal(base.ranked.find((j) => j.candidate === c.id)!.bounds.out, 2);
});

test("baseline without any search is marked degenerate; labels are validated; 0 s is a measured time", () => {
  const p = judgeProject();
  const pool = buildPool(p, { purpose: "action", aliases: ["clip"], seed: 1, search: () => ({ query: "q", channels_used: [], channels_unavailable: [{ channel: "text", reason: "test" }], hits: [] }) });
  const base = runBaseline(p, pool);
  assert.equal((base.manifest as any).degenerate, true);
  const id = pool.candidates[0].id;
  const L = (items: any[], time?: any) => ({ format: "vos.judge-labels/1" as const, pool_digest: pool.digest, labeler: "t", items, ...(time ? { time } : {}) });
  assert.throws(() => validateLabels(pool, L([{ candidate: "c9999", adopt: true }])), (e: any) => e.code === "bad_labels");
  assert.throws(() => validateLabels(pool, L([{ candidate: id, adopt: "yes" }])), (e: any) => e.code === "bad_labels");
  assert.throws(() => validateLabels(pool, L([{ candidate: id, adopt: true, in: 2, out: 1 }])), (e: any) => e.code === "bad_labels");
  assert.throws(() => validateLabels(pool, { ...L([]), pool_digest: "x" }), (e: any) => e.code === "labels_mismatch");
  const rep = compare(pool, [base], { k: 5, labels: L([{ candidate: id, adopt: false }], { baseline: { search_sec: 0, fix_sec: null } }) });
  assert.deepEqual((rep.human as any).baseline.search_sec, { value: 0, status: "measured" });
  assert.equal((rep.human as any).baseline.fix_sec.value, null);
  assert.equal((rep.model_proxy.per_runner as any).baseline.judged_in_top_k, 0, "undeterminable candidates are not proposals");
});

test("refine: when every frame looked at is above the threshold, in/out are window edges with unbounded ranges, not a found cut", async () => {
  const p = judgeProject();
  const pool = buildPool(p, { purpose: "action", aliases: ["clip"], seed: 3 });
  const fake = await fakeD1({ flat: true }); // the same answer for every frame
  const ep: Endpoint = { url: fake.url, mode: "attached", exposure: "tcp_loopback", provenance_gaps: ["test"], model_id: "/x/m.gguf", modalities: { input: ["text", "image"], output: ["decisions"] }, maxRssKiB: () => null, stop: async () => {} };
  const r = await runD1(p, pool, ep, { outDir: tmp(), refineTop: 1, minFreeBytes: 1 });
  await fake.close();
  const j = r.ranked.find((x) => x.refine)!;
  assert.equal(j.refine!.status, "uninformative");
  assert.deepEqual(j.bounds.open, ["in", "out"]);
  assert.equal(j.bounds.in_range![0], null);
  assert.equal(j.bounds.out_range![1], null);
  assert.match(j.bounds.note!, /not a found cut/);
});

test("window edges are not effects: open / uninformative sides are excluded from shifts and human in/out error, counted, never 0", async () => {
  const p = judgeProject();
  const pool = buildPool(p, { purpose: "action", aliases: ["clip"], seed: 3 });
  const base = runBaseline(p, pool);
  const fake = await fakeD1({ flat: true });
  const ep: Endpoint = { url: fake.url, mode: "attached", exposure: "tcp_loopback", provenance_gaps: ["test"], model_id: "/x/m.gguf", modalities: { input: ["text", "image"], output: ["decisions"] }, maxRssKiB: () => null, stop: async () => {} };
  const d1 = await runD1(p, pool, ep, { outDir: tmp(), refineTop: 1, minFreeBytes: 1 });
  await fake.close();
  const j = d1.ranked.find((x) => x.refine)!;
  assert.equal(j.refine!.status, "uninformative");
  const labels = (items: any[]) => ({ format: "vos.judge-labels/1" as const, pool_digest: pool.digest, labeler: "t", items });
  const L = labels([{ candidate: j.candidate, adopt: true, in: 1.0, out: 2.0 }]);

  // all open / uninformative: nothing measurable on either side — null with the exclusions counted
  const all = compare(pool, [base, d1], { k: 5, labels: L });
  const b = all.model_proxy.bounds as any;
  assert.equal(b.mean_abs_shift_in, null);
  assert.equal(b.mean_abs_shift_out, null);
  assert.deepEqual([b.measured_in, b.excluded_in, b.excluded_in_reasons], [0, 1, { refine_uninformative: 1 }]);
  assert.deepEqual([b.measured_out, b.excluded_out], [0, 1]);
  const h = (all.human as any).d1;
  assert.equal(h.in_abs_err_sec.value, null);
  assert.equal(h.out_abs_err_sec.value, null);
  assert.deepEqual([h.in_abs_err_sec.excluded, h.in_abs_err_sec.status], [1, "not_measured"]);
  assert.equal(h.adoption_at_k.value, 1, "adoption / ranking are judged apart from the bounds");
  assert.match(reportMd(all), /\[edge\]/);
  assert.match(reportMd(all), /mean \|Δin\| null \(0 measured, 1 excluded/);

  // only the in side open: the closed out side keeps its measurement
  const oneSide: typeof d1 = structuredClone(d1);
  const k1 = oneSide.ranked.find((x) => x.candidate === j.candidate)!;
  k1.refine!.status = "ok";
  k1.bounds.open = ["in"];
  k1.bounds.out_range = [k1.bounds.out!, k1.bounds.out! + 0.5];
  const one = compare(pool, [base, oneSide], { k: 5, labels: L });
  const b1 = one.model_proxy.bounds as any;
  assert.deepEqual([b1.mean_abs_shift_in, b1.excluded_in, b1.excluded_in_reasons], [null, 1, { open_in: 1 }]);
  assert.equal(b1.measured_out, 1);
  assert.equal(typeof b1.mean_abs_shift_out, "number");
  const h1 = (one.human as any).d1;
  assert.equal(h1.in_abs_err_sec.value, null);
  assert.deepEqual([h1.out_abs_err_sec.value, h1.out_abs_err_sec.n, h1.out_abs_err_sec.excluded], [round3(Math.abs(2.0 - k1.bounds.out!)), 1, 0]);

  // both sides closed: both measured, nothing excluded
  k1.bounds.open = undefined;
  k1.bounds.in_range = [k1.bounds.in! - 0.5, k1.bounds.in!];
  const closed = compare(pool, [base, oneSide], { k: 5, labels: L });
  const bc = closed.model_proxy.bounds as any;
  assert.deepEqual([bc.measured_in, bc.measured_out, bc.excluded_in, bc.excluded_out], [1, 1, 0, 0]);
  assert.equal((closed.human as any).d1.in_abs_err_sec.value, round3(Math.abs(1.0 - k1.bounds.in!)));
});
