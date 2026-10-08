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
import { assertLoopback, attach, checkDisk, D1_PIN, decide, validateReply, verifyModel, verifyRunner, type Endpoint } from "../src/judge/d1.ts";
import { buildPool, checkPoolFresh } from "../src/judge/pool.ts";
import { extractFrame, frameTable, framesIn, nominalError, snap, trustedTimes, type FrameTable } from "../src/judge/pts.ts";
import { compare, labelsTemplate } from "../src/judge/report.ts";
import { aggregate, interpret, loadRubric, questionsFor, RUBRIC_FILE, type Question } from "../src/judge/rubric.ts";
import { runBaseline, runD1 } from "../src/judge/score.ts";
import { fixtureProject } from "./helpers.ts";

process.env.VOS_EMBED_MOCK = "1"; // deterministic search vectors; no model needed

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "vos-judge-"));
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
  assert.equal(r.times.length, 3);
  assert.equal(r.firstBad, 3);
  assert.deepEqual(r.anomalies.map((a) => a.kind), ["duplicate", "backward", "non_finite"]);
  const table = { t: r.times.map((x) => Math.round(x * 1e6) / 1e6), last_frame_end: 0.099, trusted: "until_first_anomaly" } as unknown as FrameTable;
  assert.equal(snap(table, 0.2).flag, "past_trusted", "times after the anomaly cannot be tied to a frame");
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
  const agg = aggregate(rubric, "screen", { readability: { status: "observed", value: 1, confidence: 0.9 }, sharpness: { status: "observed", value: 1, confidence: 0.9 } });
  assert.equal(agg.criteria.action_peak.status, "unknown");
  assert.equal(agg.criteria.utterance_complete.status, "unknown");
  assert.equal(agg.criteria.composition.status, "unobserved", "in the purpose but not evaluated");
  assert.equal(agg.decision, "judged");
  assert.equal(aggregate(rubric, "screen", { sharpness: { status: "observed", value: 1, confidence: 1 } }).decision, "undeterminable", "too little of the rubric was judged");
});

test("rubric: abstain / unobserved / low confidence are kept apart from a value", () => {
  const { rubric } = loadRubric();
  const ch = (choice: string, probs: Record<string, number>, confidence = 0.8) => ({ type: "choice" as const, choice, confidence, probabilities: probs });
  assert.equal(interpret(rubric, "sharpness", ch("cannot_tell", { sharp: 0.1, slight_blur: 0.1, heavy_blur: 0.1, cannot_tell: 0.7 })).status, "abstained");
  const nf = interpret(rubric, "expression", ch("no_face", { readable: 0.1, hard_to_read: 0.1, no_face: 0.7, cannot_tell: 0.1 }));
  assert.equal(nf.status, "unobserved");
  assert.equal(nf.value, null);
  assert.equal(interpret(rubric, "subject", { type: "noul", noul: 0.5 }).status, "low_confidence");
  const s = interpret(rubric, "action_peak", { type: "score", score: 3, confidence: 0.9, probabilities: { 0: 0, 1: 0, 2: 0, 3: 1 } });
  assert.deepEqual([s.status, s.value], ["observed", 1]);
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
function fakeD1(opts: { status?: number; body?: string; models?: any; log?: any[] } = {}): Promise<{ url: string; close: () => Promise<void> }> {
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
      const seed = createHash("sha256").update(String(reqJ.images?.[0] ?? reqJ.state)).digest();
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
  const ep: Endpoint = { url: fake.url, mode: "attached", model_id: "/x/d1-3B-Q8_0.gguf", modalities: { input: ["text", "image"], output: ["decisions"] }, maxRssKiB: () => null, stop: async () => {} };
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
    assert.ok(j.bounds.in_range![0] <= j.bounds.in! && j.bounds.in! <= j.bounds.in_range![1], "the estimate sits inside its range");
    assert.ok(j.bounds.out_range![0] <= j.bounds.out_range![1]);
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
  const ep: Endpoint = { url: fake.url, mode: "attached", model_id: "/x/m.gguf", modalities: { input: ["text", "image"], output: ["decisions"] }, maxRssKiB: () => null, stop: async () => {} };
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
