import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig } from "../core/config.ts";
import { sha256, sha256File } from "../core/hash.ts";
import { readJsonIf, round, VosError, writeJson } from "../core/util.ts";
import type { Answer, Question } from "./rubric.ts";

/**
 * LiquidAI d1-3B through llama.cpp's `/v1/systemone` (one forward pass, zero output tokens, typed answers).
 * Everything is pinned and checked; anything unexpected stops the run (fail closed, no fallback):
 *   model files missing / wrong size / wrong sha256      → model_missing / model_hash_mismatch
 *   runner older than the d1 support or unrecognised      → runner_unsupported
 *   runner that is not exactly the pinned release        → runner_unpinned (unless explicitly allowed)
 *   endpoint not on this machine (loopback only)          → remote_endpoint_refused
 *   an HTTP redirect from the endpoint (never followed)   → endpoint_redirect_refused
 *   endpoint without decisions / image input / 404 / 501  → endpoint_unsupported
 *   reply that does not answer exactly what was asked     → invalid_reply
 *   too little free space where frames are written        → low_disk
 *
 * Exposure: a spawned llama-server listens on a UNIX socket inside a private (0700) temporary directory, not on a
 * TCP port. Browsers cannot open UNIX sockets, so web pages (CORS, DNS rebinding) cannot reach it, other users
 * cannot connect, and there is no port to race for. No API key is needed for this. Its environment is stripped of
 * LLAMA_* variables (they would silently enable tools, static paths, CORS settings …); only explicit flags apply.
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
function verifyFile(dir: string, want: { name: string; size: number; sha256: string }, rehash = false): VerifiedFile {
  const f = path.join(dir, want.name);
  if (!fs.existsSync(f)) {
    throw new VosError("model_missing", `${want.name} is not in ${dir}`, `official file: ${hfUrl(want.name)} (${want.size} bytes, sha256 ${want.sha256}); fetch with scripts/d1/fetch.sh <dir> after the human approves where it may be stored`);
  }
  const st = fs.statSync(f);
  if (st.size !== want.size) throw new VosError("model_hash_mismatch", `${want.name}: ${st.size} bytes, expected ${want.size}`, "incomplete or different file; re-fetch the pinned revision");
  const stamp = `${f}.vos-verified.json`;
  const s = readJsonIf<{ size: number; mtime_ms: number; sha256: string } | null>(stamp, null);
  if (!rehash && s && s.size === st.size && s.mtime_ms === st.mtimeMs && s.sha256 === want.sha256) return { name: want.name, size: st.size, sha256: s.sha256, verified: "stamp" };
  const h = sha256File(f);
  if (h !== want.sha256) throw new VosError("model_hash_mismatch", `${want.name}: sha256 ${h}, expected ${want.sha256}`, "not the pinned file; re-fetch it from the pinned revision");
  writeJson(stamp, { size: st.size, mtime_ms: st.mtimeMs, sha256: h });
  return { name: want.name, size: st.size, sha256: h, verified: "hashed" };
}

/**
 * `rehash` reads every byte again. Without it a stamp (size + mtime + sha256 written after an earlier full read) is
 * trusted, and the result says so (`verified: "stamp"`) — a stamp can be forged, a full read cannot.
 */
export function verifyModel(dir: string | null, o: { rehash?: boolean } = {}): { dir: string; model: VerifiedFile; mmproj: VerifiedFile } {
  if (!dir) throw new VosError("model_missing", "no d1 model directory configured", "pass --model-dir, or set VOS_D1_MODEL_DIR / config `d1_model_dir` to the folder holding the pinned GGUF files");
  return { dir, model: verifyFile(dir, D1_PIN.files.model, o.rehash), mmproj: verifyFile(dir, D1_PIN.files.mmproj, o.rehash) };
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
  const r = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 30_000, env: runnerEnv().env });
  const text = `${r.stdout}\n${r.stderr}`;
  const m = text.match(/version:\s*(\S+)\s*\(build\s*(\d+),\s*commit\s*([0-9a-f]+)\)/);
  if (!m) throw new VosError("runner_unsupported", `could not read the llama-server version: ${text.trim().slice(0, 200)}`);
  const build = Number(m[2]);
  if (build < RUNNER_PIN.min_build) throw new VosError("runner_unsupported", `llama-server build ${build} predates d1-3B support (needs ≥ ${RUNNER_PIN.min_build})`, `use release ${RUNNER_PIN.tag}`);
  return { bin, version_line: text.match(/version:.*$/m)![0].trim(), build, commit: m[3], sha256: sha256File(bin), pinned: build === Number(RUNNER_PIN.tag.slice(1)) && RUNNER_PIN.commit.startsWith(m[3]) };
}

// ---------------- where the model listens ----------------

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** Frames never leave this machine: only a loopback http endpoint is accepted. */
export function assertLoopback(endpoint: string): URL {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    throw new VosError("usage", `not a URL: ${endpoint}`);
  }
  if (u.protocol !== "http:" || !LOOPBACK.has(u.hostname)) {
    throw new VosError("remote_endpoint_refused", `${endpoint} is not a loopback http endpoint`, "d1 runs on this machine only (127.0.0.1 / ::1 or unix:/path.sock); frames are never uploaded");
  }
  return u;
}

export type Address = { kind: "unix"; socketPath: string; text: string } | { kind: "tcp"; host: string; port: number; text: string };

/** `unix:/abs/path.sock` (a socket owned by this user) or a loopback `http://` URL. Anything else is refused. */
export function parseEndpoint(endpoint: string): Address {
  if (endpoint.startsWith("unix:")) {
    const socketPath = endpoint.slice(5);
    if (!path.isAbsolute(socketPath)) throw new VosError("usage", `unix endpoint needs an absolute path: ${endpoint}`);
    return { kind: "unix", socketPath, text: endpoint };
  }
  const u = assertLoopback(endpoint);
  return { kind: "tcp", host: u.hostname.replace(/^\[|\]$/g, ""), port: Number(u.port || 80), text: u.origin };
}

const MAX_REPLY_BYTES = 16 * 2 ** 20;

/**
 * One HTTP exchange with the local endpoint (node:http; no proxy, no redirects — a 3xx is an error, never followed,
 * so a frame cannot be forwarded elsewhere). A timeout is `timeout`, a refused connection `endpoint_unreachable`.
 */
export function httpCall(endpoint: string, method: "GET" | "POST", urlPath: string, body?: string, timeoutMs = 10_000): Promise<{ status: number; text: string }> {
  const a = parseEndpoint(endpoint);
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err: Error | null, v?: { status: number; text: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(v!);
    };
    const req = http.request({
      ...(a.kind === "unix" ? { socketPath: a.socketPath } : { host: a.host, port: a.port }),
      method, path: urlPath, agent: false,
      headers: { Host: "localhost", ...(body !== undefined ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } : {}) },
    });
    const timer = setTimeout(() => {
      req.destroy();
      done(new VosError("timeout", `${a.text}${urlPath}: no answer within ${timeoutMs} ms`));
    }, timeoutMs);
    req.on("response", (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        res.resume();
        req.destroy();
        return done(new VosError("endpoint_redirect_refused", `${a.text}${urlPath} answered ${status} → ${res.headers.location ?? "?"}`, "redirects are never followed: frames stay with the endpoint that was checked"));
      }
      const chunks: Buffer[] = [];
      let n = 0;
      res.on("data", (c: Buffer) => {
        n += c.length;
        if (n > MAX_REPLY_BYTES) {
          req.destroy();
          return done(new VosError("invalid_reply", `${a.text}${urlPath}: reply larger than ${MAX_REPLY_BYTES} bytes`));
        }
        chunks.push(c);
      });
      res.on("end", () => done(null, { status, text: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", (e) => done(new VosError("endpoint_unreachable", `${a.text}${urlPath}: ${e.message}`)));
    });
    req.on("error", (e) => done(new VosError("endpoint_unreachable", `${a.text}${urlPath}: ${e.message}`)));
    req.end(body);
  });
}

async function getJson(endpoint: string, urlPath: string, timeoutMs = 10_000): Promise<{ status: number; body: any }> {
  const r = await httpCall(endpoint, "GET", urlPath, undefined, timeoutMs);
  let body: any = null;
  try {
    body = JSON.parse(r.text);
  } catch {
    body = r.text;
  }
  return { status: r.status, body };
}

export function checkDisk(dir: string, minBytes: number): { free: number } {
  fs.mkdirSync(dir, { recursive: true });
  const s = fs.statfsSync(dir);
  const free = Number(s.bavail) * Number(s.bsize);
  if (free < minBytes) throw new VosError("low_disk", `${dir}: ${Math.round(free / 2 ** 20)} MiB free, need ≥ ${Math.round(minBytes / 2 ** 20)} MiB`, "free space or write the run to another approved folder (--out)");
  return { free };
}

export type Exposure = "unix_socket_private_dir" | "unix_socket" | "tcp_loopback";

export interface Endpoint {
  url: string; // `unix:/…/d1.sock` or `http://127.0.0.1:PORT`
  mode: "spawned" | "attached";
  exposure: Exposure;
  model_id: string;
  modalities: { input: string[]; output: string[] };
  /** what could not be verified about this endpoint; a comparison run refuses a non-empty list unless allowed */
  provenance_gaps: string[];
  runner?: RunnerInfo;
  pid?: number;
  maxRssKiB: () => number | null;
  stop: () => Promise<void>;
}

async function describeEndpoint(endpoint: string): Promise<{ model_id: string; modalities: { input: string[]; output: string[] } }> {
  const m = await getJson(endpoint, "/v1/models");
  const d = m.body?.data?.[0];
  if (m.status !== 200 || !d) throw new VosError("endpoint_unsupported", `${endpoint}/v1/models answered ${m.status} without a model`);
  const output: string[] = d.architecture?.output_modalities ?? [];
  const input: string[] = d.architecture?.input_modalities ?? [];
  if (!output.includes("decisions")) throw new VosError("endpoint_unsupported", `${endpoint} does not serve a native decision model (output_modalities: ${JSON.stringify(output)})`);
  if (!input.includes("image")) throw new VosError("endpoint_unsupported", `${endpoint} has no image input (no multimodal projector loaded?)`);
  return { model_id: String(d.id), modalities: { input, output } };
}

/**
 * Attach to a llama-server already running on this machine; its model file must be the pinned one. What cannot be
 * checked from outside (mmproj, runner build, flags, exposure of a TCP port) is listed in provenance_gaps.
 */
export async function attach(endpoint: string): Promise<Endpoint & { model_file: VerifiedFile }> {
  const a = parseEndpoint(endpoint);
  const gaps = ["attached: mmproj file not verified", "attached: runner build / flags not verified"];
  let exposure: Exposure = "tcp_loopback";
  if (a.kind === "unix") {
    let st: fs.Stats;
    try {
      st = fs.statSync(a.socketPath);
    } catch {
      throw new VosError("endpoint_unreachable", `${a.socketPath} does not exist`);
    }
    if (!st.isSocket()) throw new VosError("usage", `${a.socketPath} is not a socket`);
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) throw new VosError("remote_endpoint_refused", `${a.socketPath} belongs to another user`);
    exposure = "unix_socket";
  } else gaps.push("attached over TCP loopback: reachable from web pages in a browser unless the server restricts CORS / Host");
  const info = await describeEndpoint(a.text);
  // llama-server's model id is the -m path unless --alias hid it; without the path the file cannot be checked
  if (!path.isAbsolute(info.model_id) || !fs.existsSync(info.model_id)) {
    throw new VosError("model_unverified", `the endpoint reports model "${info.model_id}", not a local file that can be checked`, "start llama-server without --alias (so /v1/models shows the -m path), or let vos start it (--model-dir)");
  }
  const vf = verifyFile(path.dirname(info.model_id), { ...D1_PIN.files.model, name: path.basename(info.model_id) });
  if (vf.verified === "stamp") gaps.push("model verified by stamp (size + mtime), not re-read");
  return { url: a.text, mode: "attached", exposure, ...info, provenance_gaps: gaps, model_file: vf, maxRssKiB: () => null, stop: async () => {} };
}

/** LLAMA_* variables configure llama-server (tools, static paths, CORS, API keys …); the child never inherits them. */
export function runnerEnv(env: NodeJS.ProcessEnv = process.env): { env: NodeJS.ProcessEnv; removed: string[] } {
  const out: NodeJS.ProcessEnv = {};
  const removed: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (/^LLAMA_/i.test(k)) removed.push(k);
    else out[k] = v;
  }
  return { env: out, removed: removed.sort() };
}

/** Flags that close what llama-server opens by default (web UI, /slots, credentialed CORS for any origin). */
export function runnerArgs(model: string, mmproj: string, socketPath: string): string[] {
  return [
    "-m", model, "--mmproj", mmproj,
    "--host", socketPath, // a path ending in .sock: llama-server binds a UNIX socket instead of a TCP port
    "--offline", "--no-webui", "--no-slots", "--no-cors-credentials", "--cors-origins", "http://vos-judge.invalid",
    "-np", "1", "-c", "8192",
  ];
}

export interface StartOptions {
  server: string | null;
  modelDir: string | null;
  logFile?: string;
  pidFile?: string; // written while the server runs, removed when it stops (lets a supervisor check for leftovers)
  readyTimeoutMs?: number;
  rehash?: boolean; // re-read the model files (default true)
  allowUnpinned?: boolean;
  socketDir?: string; // for tests; default: a fresh 0700 directory under the OS temp dir
}

/**
 * Start the pinned llama-server on a private UNIX socket (offline, no web UI, no /slots), wait until it serves
 * decisions. The child is stopped on stop(), and also when this process gets SIGINT / SIGTERM / SIGHUP or exits.
 */
export async function startServer(o: StartOptions): Promise<Endpoint & { model: ReturnType<typeof verifyModel>; env_removed: string[]; args: string[] }> {
  const runner = verifyRunner(o.server);
  if (!runner.pinned && !o.allowUnpinned) throw new VosError("runner_unpinned", `llama-server build ${runner.build} (${runner.commit}) is not the pinned ${RUNNER_PIN.tag} (${RUNNER_PIN.commit.slice(0, 9)})`, "use the pinned release, or pass --allow-incomplete-provenance (the run is then marked)");
  const model = verifyModel(o.modelDir, { rehash: o.rehash ?? true });
  const gaps: string[] = [];
  if (!runner.pinned) gaps.push(`runner build ${runner.build} is not the pinned ${RUNNER_PIN.tag}`);
  if (model.model.verified === "stamp" || model.mmproj.verified === "stamp") gaps.push("model verified by stamp (size + mtime), not re-read");

  const sockDir = o.socketDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "vos-d1-"));
  fs.chmodSync(sockDir, 0o700);
  const socketPath = path.join(sockDir, "d1.sock");
  if (Buffer.byteLength(socketPath) > 100) throw new VosError("usage", `socket path too long for a UNIX socket (${socketPath.length} bytes): ${socketPath}`);
  fs.rmSync(socketPath, { force: true });
  const args = runnerArgs(path.join(model.dir, model.model.name), path.join(model.dir, model.mmproj.name), socketPath);
  const { env, removed } = runnerEnv();
  const log = o.logFile ? fs.openSync(o.logFile, "a") : "ignore";
  const child: ChildProcess = spawn(runner.bin, args, { stdio: ["ignore", log, log], env });
  let exited: number | null = null;
  const exitedP = new Promise<void>((res) => child.on("exit", (code, sig) => ((exited = code ?? (sig ? 128 : -1)), res())));
  if (o.pidFile && child.pid) writeJson(o.pidFile, { pid: child.pid, bin: runner.bin, socket: socketPath, started_at: new Date().toISOString() }, false);

  // ---- cleanup that also runs when this process is told to stop ----
  let cleaned = false;
  const cleanupFiles = () => {
    if (o.pidFile) fs.rmSync(o.pidFile, { force: true });
    fs.rmSync(socketPath, { force: true });
    if (!o.socketDir) fs.rmSync(sockDir, { recursive: true, force: true });
  };
  const killNow = () => {
    if (exited === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
    cleanupFiles();
  };
  const onExit = () => killNow();
  const onSignal = (sig: NodeJS.Signals) => {
    void (async () => {
      await stop();
      process.exit(128 + (os.constants.signals[sig] ?? 15));
    })();
  };
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const s of signals) process.on(s, onSignal);
  process.on("exit", onExit);

  let maxRss = 0;
  const sample = () => {
    if (!child.pid || exited !== null) return;
    const r = spawnSync("ps", ["-o", "rss=", "-p", String(child.pid)], { encoding: "utf8" });
    const kib = Number(String(r.stdout).trim());
    if (Number.isFinite(kib) && kib > maxRss) maxRss = kib;
  };
  const timer = setInterval(sample, 500);
  const stop = async () => {
    if (cleaned) return;
    cleaned = true;
    clearInterval(timer);
    sample();
    for (const s of signals) process.off(s, onSignal);
    process.off("exit", onExit);
    if (exited === null) {
      child.kill("SIGTERM");
      const t = setTimeout(() => exited === null && child.kill("SIGKILL"), 10_000);
      await exitedP;
      clearTimeout(t);
    }
    if (typeof log === "number") fs.closeSync(log);
    cleanupFiles();
  };

  const url = `unix:${socketPath}`;
  const deadline = Date.now() + (o.readyTimeoutMs ?? 300_000);
  for (;;) {
    if (exited !== null) {
      await stop();
      throw new VosError("runner_failed", `llama-server exited (${exited}) before it was ready`, o.logFile ? `see ${o.logFile}` : undefined);
    }
    if (fs.existsSync(socketPath)) {
      try {
        const h = await getJson(url, "/health", 2000);
        if (h.status === 200) break;
      } catch {
        /* not ready yet */
      }
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
  return { url, mode: "spawned", exposure: "unix_socket_private_dir", ...info, provenance_gaps: gaps, runner, pid: child.pid, model, env_removed: removed, args: args.map((x) => (path.isAbsolute(x) ? path.basename(x) : x)), maxRssKiB: () => (maxRss ? maxRss : null), stop };
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

export interface CallRecord {
  ms: number;
  status: number;
  request_sha256: string;
  reply_sha256: string; // sha256 of the raw reply text
  usage: { present: boolean; input_tokens: number | null; output_tokens: number | null | "absent" };
}

export async function decide(url: string, state: unknown, questions: Record<string, Question>, images: Buffer[] = [], timeoutMs = 120_000): Promise<Decision & { call: CallRecord }> {
  const payload = JSON.stringify({ state: state ?? null, questions, ...(images.length ? { images: images.map((b) => `data:image/jpeg;base64,${b.toString("base64")}`) } : {}) });
  const t0 = performance.now();
  const r = await httpCall(url, "POST", "/v1/systemone", payload, timeoutMs);
  const ms = round(performance.now() - t0, 2);
  const text = r.text;
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
  const u = body.usage;
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null);
  const call: CallRecord = {
    ms, status: r.status, request_sha256: sha256(payload), reply_sha256: sha256(text),
    usage: { present: !!u && typeof u === "object", input_tokens: num(u?.input_tokens), output_tokens: u && "output_tokens" in u ? num(u.output_tokens) : "absent" },
  };
  return { answers: v.answers, input_tokens: v.input_tokens, ms, call };
}
