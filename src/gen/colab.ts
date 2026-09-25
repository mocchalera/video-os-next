import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { REPO } from "../core/config.ts";
import { contentId, sha256 } from "../core/hash.ts";
import { ingest, P, requireOnline, resolveAsset, saveAssets, type IngestResult, type Project } from "../core/project.ts";
import { fetchFromLibrary, libraryDir, publish } from "./library.ts";
import { readJson, run, stableStringify, VosError, writeJson } from "../core/util.ts";

/**
 * vos gen — footage generation on a rented Colab GPU (MiniMax-H3 via ComfyUI).
 *
 * Every billable second goes through the guard (scripts/colab/vos-colab): a lease that stops the VM when nobody
 * renews it, a hard budget, a deadline, verified release. vos never talks to `colab new/stop` directly.
 * Generated media is ordinary footage: a file under <project>/generated/, a portable `.gen.json` provenance
 * sidecar next to it, and an `ingest` into assets.json. Same request → same file, no GPU.
 */

export const SESSION = "vos-gen";
const REMOTE = "/content/vosgen";
const GUARD = () => process.env.VOS_COLAB_GUARD ?? path.join(REPO, "scripts", "colab", "vos-colab");
const COLAB = () => process.env.VOS_COLAB_BIN ?? "colab";
const VM_WORKER = path.join(REPO, "python", "colab_gen_vm.py");

/** Measured defaults (scripts/colab/spike/RESULTS.md). Changing any of these changes the request id. */
export const H3 = {
  model: "minimax-h3",
  unet: "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
  text_encoder: "qwen3vl_32b_minimax_h3_int8_convrot.safetensors",
  video_vae: "minimax_h3_video_vae_fp16.safetensors",
  audio_vae: "minimax_h3_audio_vae_fp32.safetensors",
  lora: "minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors",
  steps: 6,
  sol_tau: 1.3,
  comfy_rev: "1568e6cf",
  weights_rev: "1c41cfca8ebba91d0af792a05c5761fb2c3a7975",
} as const;

export const SIZES: Record<string, [number, number]> = {
  "768p": [1344, 768], // official 768p, ~81 s per 5 s clip on A100-40GB
  draft: [864, 480], // ~12 s per 2 s clip
  "768p-portrait": [768, 1344],
  "480p-portrait": [480, 864],
};

export interface GenRequest {
  id: string;
  model: string;
  prompt: string;
  seconds: number;
  width: number;
  height: number;
  seed: number;
  steps: number;
  lora: string;
  sol_tau: number | null;
  unet: string;
  text_encoder: string;
  video_vae: string;
  audio_vae: string;
  comfy_rev: string;
  weights_rev: string;
  first_frame?: FrameRef; // image→video: absent for text→video (keeps t2v ids unchanged)
  last_frame?: FrameRef;
}

/** A frame of a project asset, by content id — portable and stable across machines. */
export interface FrameRef {
  asset: string; // content id
  at: number; // seconds into the asset (0 for stills)
}

export interface ClipOptions {
  prompt: string;
  seconds?: number;
  size?: string; // key of SIZES or "WxH"
  seed?: number;
  steps?: number;
  dense?: boolean; // disable sparse attention (exactness over speed)
  firstFrame?: FrameRef;
  lastFrame?: FrameRef;
}

export function parseSize(s: string | undefined): [number, number] {
  const key = s ?? "768p";
  if (SIZES[key]) return SIZES[key];
  const m = /^(\d+)x(\d+)$/.exec(key);
  if (!m) throw new VosError("usage", `unknown size "${key}"`, `use one of ${Object.keys(SIZES).join(", ")} or WxH`);
  const [w, h] = [Number(m[1]), Number(m[2])];
  if (w % 32 || h % 32) throw new VosError("usage", `size ${key} must be multiples of 32`);
  return [w, h];
}

/** 24 fps snapped up to the model's 17k+5 grid (same formula as the VM worker and the stock template). */
export function framesFor(seconds: number): number {
  const n = Math.max(5, Math.round(seconds * 24));
  return n + ((5 - (n % 17)) % 17 + 17) % 17;
}

const ALIGN_RE = /^(For the target video, at 0\.00 seconds|How the reference pictures align with the target video)/;

/**
 * The official H3 prompt format (MiniMax-H3 skills/h3-prompt-writing, base modes) opens image-anchored prompts with
 * an alignment line, then a blank line, then the fields. vos writes that line itself from --from/--to, using the real
 * last-frame time, so agents cannot get the mode or the timing wrong. A prompt that already has one is left alone.
 */
export function withAlignment(prompt: string, seconds: number, first: boolean, last: boolean): string {
  if ((!first && !last) || ALIGN_RE.test(prompt)) return prompt;
  const shots = [...prompt.matchAll(/\[Shot (\d+)\]/g)].map((m) => Number(m[1]));
  const lastShot = shots.length ? Math.max(...shots) : 1;
  const end = ((framesFor(seconds) - 1) / 24).toFixed(2);
  let line: string;
  if (first && last) {
    line = `How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot ${lastShot}) aligns with the ${end}-second mark of the target video.`;
  } else if (first) {
    line = "For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.";
  } else {
    line = `How the reference pictures align with the target video — <Picture 1> (from [Shot ${lastShot}]) aligns with the ${end}-second mark of the target video.`;
  }
  return `${line}\n\n${prompt}`;
}

/** Advice, not errors: the model accepts free text, but follows the official three-field format far better. */
export function promptWarnings(prompt: string, seconds: number): string[] {
  const w: string[] = [];
  for (const f of ["integrated_multimodal_description:", "overall_soundscape:", "non_diegetic_music:"]) {
    if (!prompt.includes(f)) w.push(`prompt has no "${f}" field — see skills/h3-prompt/SKILL.md`);
  }
  if (w.length === 3) return ["prompt is free text; H3 follows the official fields (integrated_multimodal_description / overall_soundscape / non_diegetic_music) much better — see skills/h3-prompt/SKILL.md"];
  const times = [...prompt.matchAll(/At (\d{2}):(\d{2}\.\d{3})/g)].map((m) => Number(m[1]) * 60 + Number(m[2]));
  const late = times.filter((t) => t >= seconds);
  if (late.length) w.push(`shot cut at ${late[0].toFixed(3)}s is beyond the ${seconds}s clip`);
  if (prompt.length > 7000) w.push(`prompt is ${prompt.length} characters; keep it under ~7000`);
  return w;
}

export function buildRequest(o: ClipOptions): GenRequest {
  if (!o.prompt?.trim()) throw new VosError("usage", "vos gen clip needs --prompt");
  const seconds = o.seconds ?? 5;
  if (!(seconds > 0 && seconds <= 15)) throw new VosError("usage", "--seconds must be in (0, 15]", "the model's trained range is ~5-15 s");
  const [width, height] = parseSize(o.size);
  const body = {
    model: H3.model, prompt: withAlignment(o.prompt.trim(), seconds, !!o.firstFrame, !!o.lastFrame), seconds, width, height, seed: o.seed ?? 1, steps: o.steps ?? H3.steps,
    lora: H3.lora, sol_tau: o.dense ? null : H3.sol_tau, unet: H3.unet, text_encoder: H3.text_encoder,
    video_vae: H3.video_vae, audio_vae: H3.audio_vae, comfy_rev: H3.comfy_rev, weights_rev: H3.weights_rev,
    ...(o.firstFrame ? { first_frame: o.firstFrame } : {}),
    ...(o.lastFrame ? { last_frame: o.lastFrame } : {}),
  };
  return { id: sha256(stableStringify(body)).slice(0, 16), ...body };
}

export const genPaths = (p: Project, id: string) => ({
  media: path.join(p.root, "generated", `${id}.mp4`),
  sidecar: path.join(p.root, "generated", `${id}.gen.json`),
});

// ------------------------------------------------------------------ guard / colab plumbing

function guard(args: string[], timeoutMs = 120_000): any {
  const r = run(GUARD(), args, { timeout: timeoutMs });
  const line = r.stdout.trim().split("\n").filter((l) => l.startsWith("{") || l.startsWith("[")).pop();
  if (r.status !== 0 && !line) throw new VosError("colab_guard", `vos-colab ${args[0]} failed (exit ${r.status})`, r.stderr.slice(-600));
  try {
    return line ? JSON.parse(line) : { ok: r.status === 0 };
  } catch {
    // status prints indented JSON across lines
    return JSON.parse(r.stdout);
  }
}

function guardExec(code: string, timeoutSec = 120): void {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "vosgen-")), "cmd.py");
  fs.writeFileSync(f, code);
  const r = run(GUARD(), ["exec", SESSION, "-f", f, "--timeout", String(timeoutSec)], { timeout: (timeoutSec + 60) * 1000 });
  if (r.status !== 0 && !/"ok": true/.test(r.stdout)) {
    throw new VosError("colab_exec", `remote exec failed (exit ${r.status})`, (r.stdout + r.stderr).slice(-800));
  }
}

function waitRemote(remotePath: string, timeoutSec: number, what = remotePath): void {
  const r = run(GUARD(), ["wait", SESSION, remotePath, "--timeout", String(timeoutSec), "--every", "15"], { timeout: (timeoutSec + 120) * 1000 });
  if (r.status === 0) return;
  const s = (guard(["status", SESSION]).sessions ?? []).find((x: any) => x.name === SESSION);
  if (s && s.state !== "running") throw new VosError("gen_stopped", `the guard stopped the session (${s.stop_reason}) while waiting for ${what}`, "check `vos gen status`; start again with a budget from the human");
  throw new VosError("colab_wait", `timed out after ${timeoutSec}s waiting for ${what}`, "the VM is still leased; `vos gen status`, or `vos gen down` to stop paying");
}

function download(remotePath: string, local: string): void {
  fs.mkdirSync(path.dirname(local), { recursive: true });
  const r = run(COLAB(), ["download", "-s", SESSION, remotePath, local], { timeout: 600_000 });
  if (r.status !== 0 || !fs.existsSync(local)) throw new VosError("colab_download", `could not download ${remotePath}`, r.stderr.slice(-400));
}

function remoteJson(remotePath: string): any {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "vosgen-")), path.basename(remotePath));
  download(remotePath, tmp);
  return readJson(tmp);
}

function session(): any | null {
  const s = guard(["status", SESSION]);
  return (s.sessions ?? []).find((x: any) => x.name === SESSION && x.state === "running") ?? null;
}

function requireSession(): any {
  const s = session();
  if (!s) throw new VosError("gen_not_up", "no running generation session", "ask the human for a compute budget, then `vos gen up --budget-cu <N>`");
  return s;
}

// ------------------------------------------------------------------ commands

export interface UpOptions {
  budgetCu: number;
  maxHours?: number;
  leaseMin?: number;
  gpu?: string;
  wait?: boolean;
}

export function up(o: UpOptions) {
  if (!(o.budgetCu > 0)) throw new VosError("usage", "vos gen up needs --budget-cu <N>", "compute units cost money: get the number from the human");
  if (session()) return { ok: true, session: SESSION, status: "already_up" };
  const s = guard(["start", SESSION, "--gpu", o.gpu ?? "A100", "--budget-cu", String(o.budgetCu),
    "--max-hours", String(o.maxHours ?? 2), "--lease-min", String(o.leaseMin ?? 20)], 900_000);
  if (!s.ok) throw new VosError("gen_up_failed", s.error ?? "could not start a guarded session", s.orphans ? "run `scripts/colab/vos-colab reap` after checking them" : undefined);
  guardExec(fs.readFileSync(VM_WORKER, "utf8"));
  guardExec("bootstrap()");
  const res: any = { ok: true, session: SESSION, endpoint: s.endpoint, budget_cu: o.budgetCu, bootstrap: "started" };
  if (o.wait) res.boot = waitBoot();
  return res;
}

function waitBoot(timeoutSec = 1500): any {
  waitRemote(`${REMOTE}/boot.done`, timeoutSec);
  const boot = remoteJson(`${REMOTE}/boot.json`);
  if (boot.state !== "ready") throw new VosError("gen_boot_failed", "VM bootstrap failed", String(boot.error ?? "").slice(-800));
  return boot;
}

export function status() {
  const g = guard(["status", SESSION]);
  const s = (g.sessions ?? []).find((x: any) => x.name === SESSION) ?? null;
  let boot: any = null;
  if (s?.state === "running") {
    try {
      boot = remoteJson(`${REMOTE}/boot.json`);
    } catch {
      boot = { state: "starting" };
    }
  }
  return { balance: g.balance, rate_cu_h: g.rate_cu_h, orphans: g.orphans, session: s, boot, library: libraryDir() };
}

export function down() {
  const s = guard(["stop", SESSION], 300_000);
  return { ok: !!s.ok, state: s.state };
}

export interface ClipResult extends IngestResult {
  cached: false | "project" | "library";
  request_id: string;
  file: string;
  sec?: number;
  library?: string | null; // where the take was published (null = no library configured)
  warnings?: string[];
}

export interface ClipCall extends Omit<ClipOptions, "firstFrame" | "lastFrame"> {
  from?: string; // "<alias>[@sec]" — image→video start frame
  to?: string; // "<alias>[@sec]" — end frame
  as?: string;
  note?: string;
  replace?: boolean;
  timeoutSec?: number;
}

/** "<alias>[@sec]" → the asset, its frame time, and a stable FrameRef. */
export function resolveFrame(p: Project, spec: string): { ref: FrameRef; alias: string; file: string; kind: string; width?: number; height?: number } {
  const m = /^(.+?)(?:@([\d.]+)s?)?$/.exec(spec);
  if (!m) throw new VosError("usage", `bad frame reference "${spec}"`, "use <alias>@<seconds>, e.g. hero@2.5");
  const a = resolveAsset(p, m[1]);
  if (a.kind !== "video" && a.kind !== "image") throw new VosError("usage", `"${a.alias}" is ${a.kind}; image→video needs a video or image asset`);
  const at = a.kind === "image" ? 0 : Number(m[2] ?? 0);
  if (a.duration != null && a.kind === "video" && !(at >= 0 && at < a.duration)) {
    throw new VosError("usage", `${a.alias}@${at} is outside the asset (0–${a.duration}s)`);
  }
  return { ref: { asset: a.id, at }, alias: a.alias, file: requireOnline(a), kind: a.kind, width: a.width, height: a.height };
}

/** Extract one frame, scaled + centre-cropped to exactly the generation size (no guessing by the model node). */
export function extractFrame(file: string, at: number, width: number, height: number, out: string): string {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const r = run("ffmpeg", ["-v", "error", "-y", "-ss", String(at), "-i", file, "-frames:v", "1",
    "-vf", `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`, out]);
  if (r.status !== 0 || !fs.existsSync(out)) throw new VosError("frame_extract_failed", `could not extract a frame at ${at}s`, r.stderr.slice(-300));
  return out;
}

function upload(local: string, remote: string): void {
  const r = run(COLAB(), ["upload", "-s", SESSION, local, remote], { timeout: 300_000 });
  if (r.status !== 0) throw new VosError("colab_upload", `could not upload ${path.basename(local)}`, r.stderr.slice(-400));
}

export function clip(p: Project, o: ClipCall): ClipResult {
  const first = o.from ? resolveFrame(p, o.from) : null;
  const last = o.to ? resolveFrame(p, o.to) : null;
  // image→video with no explicit size: follow the source's orientation
  const size = o.size ?? (first && first.width && first.height && first.height > first.width ? "768p-portrait" : undefined);
  const req = buildRequest({ ...o, size, firstFrame: first?.ref, lastFrame: last?.ref });
  const { media, sidecar } = genPaths(p, req.id);
  const alias = o.as;
  const note = o.note ?? `generated (${req.model}${first ? `, from ${first.alias}@${first.ref.at}` : ""}): ${req.prompt.slice(0, 80)}${req.prompt.length > 80 ? "…" : ""}`;
  const done = (cached: ClipResult["cached"], extra: Partial<ClipResult> = {}): ClipResult => {
    const r = ingest(p, media, alias, note, !!o.replace);
    saveAssets(p);
    const warnings = promptWarnings(o.prompt, req.seconds);
    return { ...r, cached, request_id: req.id, file: path.relative(p.root, media), ...(warnings.length ? { warnings } : {}), ...extra };
  };
  if (fs.existsSync(media) && fs.existsSync(sidecar)) return done("project");
  if (fetchFromLibrary(req.id, media, sidecar)) return done("library");

  const sess = requireSession();
  const boot = waitBoot();
  const remoteReq: any = { ...req, timeout: o.timeoutSec ?? 1800 };
  const frames: Record<string, { sha256: string }> = {};
  for (const [key, f] of [["first", first], ["last", last]] as const) {
    if (!f) continue;
    const png = extractFrame(f.file, f.ref.at, req.width, req.height, path.join(P.cache(p.root), "gen", `${req.id}_${key}.png`));
    const name = `vosgen_${req.id}_${key}.png`;
    upload(png, `/content/ComfyUI/input/${name}`);
    remoteReq[`${key}_image`] = name;
    frames[key] = { sha256: sha256(fs.readFileSync(png)) };
  }
  guardExec(`submit(${JSON.stringify(remoteReq)})`);
  // a job the VM never picks up must fail fast, not burn the budget (live e2e, 2026-09-25)
  waitRemote(`${REMOTE}/jobs/${req.id}.started`, 180, "the VM to start the job");
  waitRemote(`${REMOTE}/jobs/${req.id}.done`, (o.timeoutSec ?? 1800) + 60, "the generation to finish");
  const job = remoteJson(`${REMOTE}/jobs/${req.id}.json`);
  if (job.state !== "ok") throw new VosError("gen_failed", `generation failed on the VM`, String(job.error ?? "").slice(-600) + "\n" + String(job.log_tail ?? "").slice(-400));
  download(job.output, media);
  const rate = Number(status().rate_cu_h) || null;
  writeJson(sidecar, {
    format: "vos.gen/1",
    request: req,
    ...(Object.keys(frames).length ? { frames } : {}),
    file: { bytes: fs.statSync(media).size, content_id: contentId(media) },
    ran: { gpu: job.gpu, torch: job.torch, flags: job.flags, comfy_rev: job.comfy_rev, weights_rev: job.weights_rev,
      boot_torch: boot.torch, sec: job.sec, s_per_it: job.s_per_it, est_cu: rate ? Math.round((job.sec * rate) / 36) / 100 : null },
    at: new Date().toISOString(),
    session: { name: SESSION, endpoint: sess.endpoint },
  });
  let library: string | null = null;
  try {
    library = publish(req.id, media, sidecar);
  } catch (e: any) {
    library = null; // the take is safe in the project; a Drive hiccup must not lose it
    process.stderr.write(`vos: could not publish to the library: ${e.message}\n`);
  }
  return done(false, { sec: job.sec, library });
}

/** Copy a library take into this project and ingest it (no GPU). */
export function pull(p: Project, id: string, o: { as?: string; note?: string; replace?: boolean }): ClipResult {
  const { media, sidecar } = genPaths(p, id);
  if (!fs.existsSync(media) && !fetchFromLibrary(id, media, sidecar)) {
    throw new VosError("not_in_library", `no ready take ${id} in the library`, "`vos gen library` lists takes; a take still syncing is not ready yet");
  }
  const g = readJson(sidecar);
  const r = ingest(p, media, o.as, o.note ?? `generated (${g.request?.model}): ${String(g.request?.prompt ?? "").slice(0, 80)}`, !!o.replace);
  saveAssets(p);
  return { ...r, cached: "library", request_id: id, file: path.relative(p.root, media) };
}
