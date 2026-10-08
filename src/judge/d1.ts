import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { loadConfig } from "../core/config.ts";
import { sha256File } from "../core/hash.ts";
import { readJsonIf, round, VosError, writeJson } from "../core/util.ts";
import type { Answer, Question } from "./rubric.ts";

/**
 * LiquidAI d1-3B through llama.cpp's `/v1/systemone` (one forward pass, zero output tokens, typed answers).
 * Everything is pinned and checked; anything unexpected stops the run (fail closed, no fallback):
 *   model files missing / wrong size / wrong sha256      → model_missing / model_hash_mismatch
 *   runner older than the d1 support or unrecognised      → runner_unsupported
 *   endpoint not on this machine (loopback only)          → remote_endpoint_refused
 *   endpoint without decisions / image input / 404 / 501  → endpoint_unsupported
 *   reply that does not answer exactly what was asked     → invalid_reply
 *   too little free space where frames are written        → low_disk
 */

export const D1_PIN = {
  repo: "LiquidAI/d1-3B-GGUF",
  revision: "bb1e436ea78eb96a3f1acb6da865f70c2fbeb563",
  base: { repo: "LiquidAI/d1-3B", revision: "051bcc464b01b9f92942b364d9586b0ef5912432" },
  license: { name: "lfm1.0 (LFM Open License v1.0)", sha256: "4d28ca14dedc0b3d0fcc2b3339f0e79931faa33874f3d24f522183a8fc70068c" },
  files: {
    model: { name: "d1-3B-Q8_0.gguf", size: 2874781280, sha256: "2f0942d5a5f64cf69c3356d2be439b71644b1f0eb3a580912a5a0179eeaba77d" },
    mmproj: { name: "mmproj-d1-3B-Q8_0.gguf", size: 583109728, sha256: "2505920ce464b7c54acd8b7b74a931c0c671f06d0c8833760b2fbceeb253e92a" },
  },
} as const;

export const RUNNER_PIN = {
  project: "ggml-org/llama.cpp",
  tag: "b11491",
  commit: "9b4ed0ca572be213f4440a490f341f810f7aa2cf",
  asset: "llama-b11491-bin-macos-arm64.tar.gz",
  asset_sha256: "5dc61b413298db5e5c547c39b40d1148844eca23f247f8741444837a7cc3626d",
  min_build: 11483, // first release containing ggml-org/llama.cpp#30110 "model : add LiquidAI/d1-3B decision model"
} as const;

export const hfUrl = (name: string) => `https://huggingface.co/${D1_PIN.repo}/resolve/${D1_PIN.revision}/${name}`;

export interface D1Paths {
  modelDir: string | null;
  server: string | null;
}

/** Where the pinned files live on this machine: flags > env > machine config. Never a default download. */
export function d1Paths(o: { modelDir?: string; server?: string } = {}): D1Paths {
  const c = loadConfig() as Record<string, any>;
  return {
    modelDir: o.modelDir ?? process.env.VOS_D1_MODEL_DIR ?? c.d1_model_dir ?? null,
    server: o.server ?? process.env.VOS_LLAMA_SERVER ?? c.llama_server ?? null,
  };
}

export interface VerifiedFile {
  name: string;
  size: number;
  sha256: string;
  verified: "hashed" | "stamp";
}

/** sha256 is checked once and remembered in a stamp keyed by size + mtime (a changed file is hashed again). */
function verifyFile(dir: string, want: { name: string; size: number; sha256: string }): VerifiedFile {
  const f = path.join(dir, want.name);
  if (!fs.existsSync(f)) {
    throw new VosError("model_missing", `${want.name} is not in ${dir}`, `official file: ${hfUrl(want.name)} (${want.size} bytes, sha256 ${want.sha256}); fetch with scripts/d1/fetch.sh <dir> after the human approves where it may be stored`);
  }
  const st = fs.statSync(f);
  if (st.size !== want.size) throw new VosError("model_hash_mismatch", `${want.name}: ${st.size} bytes, expected ${want.size}`, "incomplete or different file; re-fetch the pinned revision");
  const stamp = `${f}.vos-verified.json`;
  const s = readJsonIf<{ size: number; mtime_ms: number; sha256: string } | null>(stamp, null);
  if (s && s.size === st.size && s.mtime_ms === st.mtimeMs && s.sha256 === want.sha256) return { name: want.name, size: st.size, sha256: s.sha256, verified: "stamp" };
  const h = sha256File(f);
  if (h !== want.sha256) throw new VosError("model_hash_mismatch", `${want.name}: sha256 ${h}, expected ${want.sha256}`, "not the pinned file; re-fetch it from the pinned revision");
  writeJson(stamp, { size: st.size, mtime_ms: st.mtimeMs, sha256: h });
  return { name: want.name, size: st.size, sha256: h, verified: "hashed" };
}

export function verifyModel(dir: string | null): { dir: string; model: VerifiedFile; mmproj: VerifiedFile } {
  if (!dir) throw new VosError("model_missing", "no d1 model directory configured", "pass --model-dir, or set VOS_D1_MODEL_DIR / config `d1_model_dir` to the folder holding the pinned GGUF files");
  return { dir, model: verifyFile(dir, D1_PIN.files.model), mmproj: verifyFile(dir, D1_PIN.files.mmproj) };
}

export interface RunnerInfo {
  bin: string;
  version_line: string;
  build: number;
  commit: string;
  sha256: string;
  pinned: boolean; // exactly the pinned release
}

export function verifyRunner(bin: string | null): RunnerInfo {
  if (!bin || !fs.existsSync(bin)) throw new VosError("runner_missing", `llama-server not found${bin ? ` at ${bin}` : ""}`, `use the official ${RUNNER_PIN.project} release ${RUNNER_PIN.tag} (${RUNNER_PIN.asset}, sha256 ${RUNNER_PIN.asset_sha256}); set --llama-server / VOS_LLAMA_SERVER`);
  const r = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 30_000 });
  const text = `${r.stdout}\n${r.stderr}`;
  const m = text.match(/version:\s*(\S+)\s*\(build\s*(\d+),\s*commit\s*([0-9a-f]+)\)/);
  if (!m) throw new VosError("runner_unsupported", `could not read the llama-server version: ${text.trim().slice(0, 200)}`);
  const build = Number(m[2]);
  if (build < RUNNER_PIN.min_build) throw new VosError("runner_unsupported", `llama-server build ${build} predates d1-3B support (needs ≥ ${RUNNER_PIN.min_build})`, `use release ${RUNNER_PIN.tag}`);
  return { bin, version_line: text.match(/version:.*$/m)![0].trim(), build, commit: m[3], sha256: sha256File(bin), pinned: build === Number(RUNNER_PIN.tag.slice(1)) && RUNNER_PIN.commit.startsWith(m[3]) };
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** Frames never leave this machine: only a loopback endpoint is accepted. */
export function assertLoopback(endpoint: string): URL {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    throw new VosError("usage", `not a URL: ${endpoint}`);
  }
  if (u.protocol !== "http:" || !LOOPBACK.has(u.hostname)) {
    throw new VosError("remote_endpoint_refused", `${endpoint} is not a loopback http endpoint`, "d1 runs on this machine only (127.0.0.1 / ::1); frames are never uploaded");
  }
  return u;
}

export function checkDisk(dir: string, minBytes: number): { free: number } {
  fs.mkdirSync(dir, { recursive: true });
  const s = fs.statfsSync(dir);
  const free = Number(s.bavail) * Number(s.bsize);
  if (free < minBytes) throw new VosError("low_disk", `${dir}: ${Math.round(free / 2 ** 20)} MiB free, need ≥ ${Math.round(minBytes / 2 ** 20)} MiB`, "free space or write the run to another approved folder (--out)");
  return { free };
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

export interface Endpoint {
  url: string;
  mode: "spawned" | "attached";
  model_id: string;
  modalities: { input: string[]; output: string[] };
  runner?: RunnerInfo;
  pid?: number;
  maxRssKiB: () => number | null;
  stop: () => Promise<void>;
}

async function getJson(url: string, timeoutMs = 10_000): Promise<{ status: number; body: any }> {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  const text = await r.text();
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: r.status, body };
}

async function describeEndpoint(url: string): Promise<{ model_id: string; modalities: { input: string[]; output: string[] } }> {
  let m: { status: number; body: any };
  try {
    m = await getJson(`${url}/v1/models`);
  } catch (e: any) {
    throw new VosError("endpoint_unreachable", `${url}/v1/models: ${e.message}`);
  }
  const d = m.body?.data?.[0];
  if (m.status !== 200 || !d) throw new VosError("endpoint_unsupported", `${url}/v1/models answered ${m.status} without a model`);
  const output: string[] = d.architecture?.output_modalities ?? [];
  const input: string[] = d.architecture?.input_modalities ?? [];
  if (!output.includes("decisions")) throw new VosError("endpoint_unsupported", `${url} does not serve a native decision model (output_modalities: ${JSON.stringify(output)})`);
  if (!input.includes("image")) throw new VosError("endpoint_unsupported", `${url} has no image input (no multimodal projector loaded?)`);
  return { model_id: String(d.id), modalities: { input, output } };
}

/** Attach to a llama-server already running on this machine; its model file must be the pinned one. */
export async function attach(endpoint: string): Promise<Endpoint & { model_file: VerifiedFile }> {
  const u = assertLoopback(endpoint);
  const url = u.origin;
  const info = await describeEndpoint(url);
  // llama-server's model id is the -m path unless --alias hid it; without the path the file cannot be checked
  if (!path.isAbsolute(info.model_id) || !fs.existsSync(info.model_id)) {
    throw new VosError("model_unverified", `the endpoint reports model "${info.model_id}", not a local file that can be checked`, "start llama-server without --alias (so /v1/models shows the -m path), or let vos start it (--model-dir)");
  }
  const vf = verifyFile(path.dirname(info.model_id), { ...D1_PIN.files.model, name: path.basename(info.model_id) } as any);
  return { url, mode: "attached", ...info, model_file: vf, maxRssKiB: () => null, stop: async () => {} };
}

/** Start the pinned llama-server on 127.0.0.1 (offline, no web UI), wait until it serves decisions. */
export async function startServer(o: { server: string | null; modelDir: string | null; logFile?: string; readyTimeoutMs?: number }): Promise<Endpoint & { model: ReturnType<typeof verifyModel> }> {
  const runner = verifyRunner(o.server);
  const model = verifyModel(o.modelDir);
  const port = await freePort();
  const args = [
    "-m", path.join(model.dir, model.model.name), "--mmproj", path.join(model.dir, model.mmproj.name),
    "--host", "127.0.0.1", "--port", String(port), "--offline", "--no-webui", "-np", "1", "-c", "8192",
  ];
  const log = o.logFile ? fs.openSync(o.logFile, "a") : "ignore";
  const child: ChildProcess = spawn(runner.bin, args, { stdio: ["ignore", log, log], env: { ...process.env, LLAMA_ARG_OFFLINE: "1" } });
  let exited: number | null = null;
  child.on("exit", (code) => (exited = code ?? -1));
  let maxRss = 0;
  const sample = () => {
    if (!child.pid || exited !== null) return;
    const r = spawnSync("ps", ["-o", "rss=", "-p", String(child.pid)], { encoding: "utf8" });
    const kib = Number(String(r.stdout).trim());
    if (Number.isFinite(kib) && kib > maxRss) maxRss = kib;
  };
  const timer = setInterval(sample, 500);
  const stop = async () => {
    clearInterval(timer);
    sample();
    if (exited === null) {
      child.kill("SIGTERM");
      await new Promise<void>((res) => {
        const t = setTimeout(() => {
          child.kill("SIGKILL");
          res();
        }, 10_000);
        child.on("exit", () => {
          clearTimeout(t);
          res();
        });
      });
    }
    if (typeof log === "number") fs.closeSync(log);
  };
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + (o.readyTimeoutMs ?? 300_000);
  for (;;) {
    if (exited !== null) {
      await stop();
      throw new VosError("runner_failed", `llama-server exited (${exited}) before it was ready`, o.logFile ? `see ${o.logFile}` : undefined);
    }
    try {
      const h = await getJson(`${url}/health`, 2000);
      if (h.status === 200) break;
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) {
      await stop();
      throw new VosError("runner_failed", "llama-server did not become ready in time");
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  let info;
  try {
    info = await describeEndpoint(url);
  } catch (e) {
    await stop();
    throw e;
  }
  return { url, mode: "spawned", ...info, runner, pid: child.pid, model, maxRssKiB: () => (maxRss ? maxRss : null), stop };
}

// ---------------- one decision ----------------

export interface Decision {
  answers: Record<string, Answer>;
  input_tokens: number;
  ms: number;
}

const near = (a: number, b: number, eps = 2e-3) => Math.abs(a - b) <= eps;
const prob = (x: unknown) => typeof x === "number" && Number.isFinite(x) && x >= -1e-9 && x <= 1 + 1e-9;

/** Check that a reply answers exactly the questions asked, with well-formed probabilities. */
export function validateReply(questions: Record<string, Question>, body: any): { answers: Record<string, Answer>; input_tokens: number } {
  const bad = (why: string): never => {
    throw new VosError("invalid_reply", `d1 reply rejected: ${why}`, "no fallback: the run stops instead of guessing");
  };
  if (!body || typeof body !== "object" || !body.answers || typeof body.answers !== "object") bad("no answers object");
  const asked = Object.keys(questions).sort();
  const got = Object.keys(body.answers).sort();
  if (JSON.stringify(asked) !== JSON.stringify(got)) bad(`answered ${JSON.stringify(got)}, asked ${JSON.stringify(asked)}`);
  if (body.usage && body.usage.output_tokens !== undefined && body.usage.output_tokens !== 0) bad(`output_tokens ${body.usage.output_tokens} ≠ 0 (not a single-pass decision)`);
  const out: Record<string, Answer> = {};
  for (const name of asked) {
    const q = questions[name];
    const a = body.answers[name];
    if (!a || typeof a !== "object") bad(`${name}: not an object`);
    if (a.type !== undefined && a.type !== q.type) bad(`${name}: type ${a.type} ≠ ${q.type}`);
    if (q.type === "noul") {
      if (!prob(a.noul)) bad(`${name}: noul ${a.noul} is not a probability`);
      out[name] = { type: "noul", noul: a.noul };
      continue;
    }
    const keys = q.type === "choice" ? Object.keys(q.criteria as Record<string, unknown>) : (q.criteria as string[]).map((_, i) => String(i));
    const probs = a.probabilities;
    if (!probs || typeof probs !== "object") bad(`${name}: no probabilities`);
    if (JSON.stringify(Object.keys(probs).sort()) !== JSON.stringify([...keys].sort())) bad(`${name}: probabilities for ${JSON.stringify(Object.keys(probs))}, options ${JSON.stringify(keys)}`);
    let sum = 0;
    for (const k of keys) {
      if (!prob(probs[k])) bad(`${name}: P(${k}) = ${probs[k]}`);
      sum += probs[k];
    }
    if (!near(sum, 1)) bad(`${name}: probabilities sum to ${sum}`);
    if (a.confidence !== undefined && !prob(a.confidence)) bad(`${name}: confidence ${a.confidence}`);
    if (q.type === "choice") {
      if (!keys.includes(a.choice)) bad(`${name}: choice "${a.choice}" is not an option`);
      const best = keys.reduce((x, y) => (probs[y] > probs[x] ? y : x));
      if (probs[a.choice] + 1e-9 < probs[best]) bad(`${name}: choice "${a.choice}" is not the most probable option`);
      out[name] = { type: "choice", choice: a.choice, confidence: a.confidence, probabilities: probs };
    } else {
      const expect = keys.reduce((s, k) => s + Number(k) * probs[k], 0);
      if (typeof a.score !== "number" || !Number.isFinite(a.score) || a.score < -1e-6 || a.score > keys.length - 1 + 1e-6) bad(`${name}: score ${a.score} outside 0..${keys.length - 1}`);
      if (!near(a.score, expect, 0.02)) bad(`${name}: score ${a.score} ≠ expected level ${round(expect, 4)}`);
      out[name] = { type: "score", score: a.score, confidence: a.confidence, probabilities: probs };
    }
  }
  return { answers: out, input_tokens: Number(body.usage?.input_tokens ?? NaN) };
}

export async function decide(url: string, state: unknown, questions: Record<string, Question>, images: Buffer[] = [], timeoutMs = 120_000): Promise<Decision> {
  assertLoopback(url);
  const payload = { state: state ?? null, questions, ...(images.length ? { images: images.map((b) => `data:image/jpeg;base64,${b.toString("base64")}`) } : {}) };
  const t0 = performance.now();
  let r: Response;
  try {
    r = await fetch(`${url}/v1/systemone`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(timeoutMs) });
  } catch (e: any) {
    throw new VosError("endpoint_unreachable", `${url}/v1/systemone: ${e.message}`);
  }
  const text = await r.text();
  const ms = round(performance.now() - t0, 2);
  if (r.status === 404 || r.status === 405 || r.status === 501) throw new VosError("endpoint_unsupported", `${url}/v1/systemone answered ${r.status}: ${text.slice(0, 200)}`, "needs a llama.cpp build with d1 support and the multimodal projector loaded");
  if (r.status === 400) throw new VosError("invalid_request", `d1 rejected the request: ${text.slice(0, 300)}`);
  if (r.status !== 200) throw new VosError("endpoint_error", `${url}/v1/systemone answered ${r.status}: ${text.slice(0, 200)}`);
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    throw new VosError("invalid_reply", `d1 reply is not JSON: ${text.slice(0, 120)}`);
  }
  const v = validateReply(questions, body);
  return { answers: v.answers, input_tokens: v.input_tokens, ms };
}
