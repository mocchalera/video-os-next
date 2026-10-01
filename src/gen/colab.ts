import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { REPO } from "../core/config.ts";
import { contentId, sha256 } from "../core/hash.ts";
import { ingest, P, requireOnline, resolveAsset, saveAssets, type IngestResult, type Project } from "../core/project.ts";
import { fetchFromLibrary, libraryDir, publish } from "./library.ts";
import { readJson, run, stableStringify, VosError, writeJson } from "../core/util.ts";
import { loadTimeline, resolveTimeline, timelinePath } from "../core/timeline.ts";
import * as rc from "../remote/colab.ts";
import type { Colab } from "../remote/colab.ts";

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

/** Revision of the ControlNet part of the worker graph; part of the request id of controlled clips only.
 * 2: ControlNet applied after BlockSparseAttention — before it (1) the control hooks were dropped (2026-10-01). */
export const CONTROL_GRAPH = 2;

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
  mode?: "ref2va"; // reference-to-video (characters / styles / keyframes); absent otherwise
  refs?: FrameRef[]; // <Picture 1..n>
  guides?: GuideRef[]; // <Picture n+1..>, pinned to output seconds
  ref_image_size?: "match" | "max";
  control?: ControlRef; // Fun ControlNet (depth/canny/pose video); absent otherwise
  control_graph?: number; // with control only: CONTROL_GRAPH (a graph fix must not reuse takes made by the broken one)
}

export interface ControlRef {
  asset: string; // content id of the control video (e.g. a previz depth pass)
  strength: number;
  end: number; // fraction of the denoising steps the control applies to
}

export interface GuideRef extends FrameRef {
  to: number; // output second the still is pinned to
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
  refs?: FrameRef[];
  guides?: GuideRef[];
  refSize?: "match" | "max";
  quality?: "turbo" | "full"; // reference mode only: 20 full steps (default) vs 4-step turbo LoRA (drafts)
  control?: ControlRef;
}

/** Reference-to-video (stock templates video_minimax_h3_r2v / multiframe_reference). */
export const H3_REF = {
  unet: "minimax_h3_ref2va_pruned_int8_convrot.safetensors",
  lora: "minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors",
  turbo_steps: 4,
  full_steps: 20,
  max_images: 9,
} as const;

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
export function promptWarnings(prompt: string, seconds: number, images = 0): string[] {
  const w: string[] = [];
  if (images > 0) {
    for (const f of ["subject_definitions:", "summary:", "retention_analysis:", "detailed_description:", "overall_soundscape:", "non_diegetic_music:"]) {
      if (!prompt.includes(f)) w.push(`reference prompt has no "${f}" field — see skills/h3-prompt/SKILL.md §7`);
    }
    const used = new Set([...prompt.matchAll(/<Picture (\d+)>/g)].map((m) => Number(m[1])));
    for (const k of used) if (k > images) w.push(`<Picture ${k}> is cited but only ${images} image(s) are attached (refs first, then guides)`);
    for (let k = 1; k <= images; k++) if (!used.has(k)) w.push(`<Picture ${k}> is attached but never cited in the prompt`);
    return w;
  }
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
  const ref = !!(o.refs?.length || o.guides?.length);
  if (ref) {
    if (o.firstFrame || o.lastFrame) throw new VosError("usage", "--from/--to cannot be combined with --refs/--guides", "in reference mode pin the opening frame with a guide at 0: --guides shot@2=0");
    const n = (o.refs?.length ?? 0) + (o.guides?.length ?? 0);
    if (n > H3_REF.max_images) throw new VosError("usage", `${n} reference images; the model takes at most ${H3_REF.max_images}`);
    for (const g of o.guides ?? []) if (!(g.to >= 0 && g.to < seconds)) throw new VosError("usage", `guide pinned at ${g.to}s is outside the ${seconds}s clip`);
    const full = o.quality !== "turbo"; // live A/B: turbo v0.1 shows smears/flare artifacts; full is clean
    const body = {
      model: H3.model, mode: "ref2va" as const, prompt: o.prompt.trim(), seconds, width, height, seed: o.seed ?? 1,
      steps: o.steps ?? (full ? H3_REF.full_steps : H3_REF.turbo_steps), lora: full ? "" : H3_REF.lora,
      sol_tau: o.dense ? null : H3.sol_tau, unet: H3_REF.unet, text_encoder: H3.text_encoder, video_vae: H3.video_vae,
      audio_vae: H3.audio_vae, comfy_rev: H3.comfy_rev, weights_rev: H3.weights_rev,
      refs: o.refs ?? [], guides: o.guides ?? [], ref_image_size: o.refSize ?? "match",
      ...(o.control ? { control: o.control, control_graph: CONTROL_GRAPH } : {}),
    };
    return { id: sha256(stableStringify(body)).slice(0, 16), ...body };
  }
  const body = {
    model: H3.model, prompt: withAlignment(o.prompt.trim(), seconds, !!o.firstFrame, !!o.lastFrame), seconds, width, height, seed: o.seed ?? 1, steps: o.steps ?? H3.steps,
    lora: H3.lora, sol_tau: o.dense ? null : H3.sol_tau, unet: H3.unet, text_encoder: H3.text_encoder,
    video_vae: H3.video_vae, audio_vae: H3.audio_vae, comfy_rev: H3.comfy_rev, weights_rev: H3.weights_rev,
    ...(o.firstFrame ? { first_frame: o.firstFrame } : {}),
    ...(o.lastFrame ? { last_frame: o.lastFrame } : {}),
    ...(o.control ? { control: o.control, control_graph: CONTROL_GRAPH } : {}),
  };
  return { id: sha256(stableStringify(body)).slice(0, 16), ...body };
}

export const genPaths = (p: Project, id: string) => ({
  media: path.join(p.root, "generated", `${id}.mp4`),
  sidecar: path.join(p.root, "generated", `${id}.gen.json`),
});

// ------------------------------------------------------------------ guard / colab plumbing (shared: src/remote/colab.ts)

export const GEN: Colab = { session: SESSION, cli: "vos gen", notUp: "gen_not_up", stopped: "gen_stopped" };
const guard = rc.guard;
const guardExec = (code: string, timeoutSec = 120, attempts = 2) => rc.exec(GEN, code, timeoutSec, attempts);
const waitRemote = (remotePath: string, timeoutSec: number, what = remotePath) => rc.wait(GEN, remotePath, timeoutSec, what);
const download = (remotePath: string, local: string) => rc.download(GEN, remotePath, local);
const remoteJson = (remotePath: string) => rc.remoteJson(GEN, remotePath);
const upload = (local: string, remote: string) => rc.upload(GEN, local, remote);
const session = () => rc.running(GEN);
const requireSession = () => rc.requireRunning(GEN);

// ------------------------------------------------------------------ commands

export interface UpOptions {
  budgetCu: number;
  maxHours?: number;
  leaseMin?: number;
  gpu?: string;
  wait?: boolean;
  light?: boolean; // ComfyUI only, no H3 weights: enough for `vos gen upscale` (e.g. on a cheaper T4)
}

export function up(o: UpOptions) {
  if (!(o.budgetCu > 0)) throw new VosError("usage", "vos gen up needs --budget-cu <N>", "compute units cost money: get the number from the human");
  if (session()) return { ok: true, session: SESSION, status: "already_up" };
  const s = rc.start(GEN, { gpu: o.gpu ?? "A100", budgetCu: o.budgetCu, maxHours: o.maxHours ?? 2, leaseMin: o.leaseMin ?? 20 });
  try {
    guardExec(fs.readFileSync(VM_WORKER, "utf8"));
    guardExec(o.light ? "bootstrap(light=True)" : "bootstrap()");
    waitRemote(`${REMOTE}/boot.started`, 90, "the bootstrap to start");
    const res: any = { ok: true, session: SESSION, endpoint: s.endpoint, budget_cu: o.budgetCu, bootstrap: "started", light: !!o.light };
    if (o.wait) res.boot = waitBoot();
    return res;
  } catch (e) {
    // never leave a paid VM behind a failed `up` (live: a VM idled 20 min to the budget stop, 2026-09-25)
    rc.stopQuietly(GEN);
    throw e;
  }
}

function waitBoot(timeoutSec = 1500): any {
  waitRemote(`${REMOTE}/boot.started`, 90, "the bootstrap to start (was `vos gen up` interrupted?)");
  waitRemote(`${REMOTE}/boot.done`, timeoutSec, "the bootstrap to finish");
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
  return rc.stop(GEN);
}

export interface ClipResult extends IngestResult {
  cached: false | "project" | "library";
  request_id: string;
  file: string;
  sec?: number;
  library?: string | null; // where the take was published (null = no library configured)
  warnings?: string[];
}

export interface ClipCall extends Omit<ClipOptions, "firstFrame" | "lastFrame" | "refs" | "guides" | "control"> {
  from?: string; // "<alias>[@sec]" — image→video start frame
  to?: string; // "<alias>[@sec]" — end frame
  refs?: string; // "a@1,b" — reference images <Picture 1..n>
  guides?: string; // "a@1=0,b@2=3.5" — stills pinned to output seconds, <Picture n+1..>
  controlVideo?: string; // alias of a control video (a previz depth pass, a canny/pose video)
  controlStrength?: number;
  controlEnd?: number;
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

/** Extract one frame, scaled + centre-cropped to exactly the generation size (no guessing by the model node); 0x0 = native. */
export function extractFrame(file: string, at: number, width: number, height: number, out: string): string {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const vf = width && height ? ["-vf", `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`] : [];
  const r = run("ffmpeg", ["-v", "error", "-y", "-ss", String(at), "-i", file, "-frames:v", "1", ...vf, out]);
  if (r.status !== 0 || !fs.existsSync(out)) throw new VosError("frame_extract_failed", `could not extract a frame at ${at}s`, r.stderr.slice(-300));
  return out;
}

/** Queue one job on the VM and wait for it; a job the VM never picks up fails fast instead of burning the budget. */
function runRemote(remoteReq: { id: string; [k: string]: unknown }, timeoutSec: number): any {
  // the token makes a retried exec (dropped connection after the VM accepted it) a no-op instead of a second run
  guardExec(rc.pyCall("submit", { ...remoteReq, timeout: timeoutSec, token: randomUUID() }));
  waitRemote(`${REMOTE}/jobs/${remoteReq.id}.started`, 180, "the VM to start the job");
  waitRemote(`${REMOTE}/jobs/${remoteReq.id}.done`, timeoutSec + 60, "the job to finish");
  const job = remoteJson(`${REMOTE}/jobs/${remoteReq.id}.json`);
  if (job.state !== "ok") throw new VosError("gen_failed", `job failed on the VM`, String(job.error ?? "").slice(-600) + "\n" + String(job.log_tail ?? "").slice(-400));
  return job;
}

const list = (s?: string) => (s ?? "").split(",").map((x) => x.trim()).filter(Boolean);

export function clip(p: Project, o: ClipCall): ClipResult {
  const first = o.from ? resolveFrame(p, o.from) : null;
  const last = o.to ? resolveFrame(p, o.to) : null;
  const refs = list(o.refs).map((x) => resolveFrame(p, x));
  const guides = list(o.guides).map((x) => {
    const m = /^(.+)=([\d.]+)s?$/.exec(x);
    if (!m) throw new VosError("usage", `bad guide "${x}"`, "use <alias>@<source sec>=<output sec>, e.g. layout@2=1.5");
    return { ...resolveFrame(p, m[1]), to: Number(m[2]) };
  });
  const ctl = o.controlVideo ? resolveAsset(p, o.controlVideo) : null;
  if (ctl && ctl.kind !== "video") throw new VosError("usage", `--control needs a video asset; "${ctl.alias}" is ${ctl.kind}`);
  const control = ctl ? { asset: ctl.id, strength: o.controlStrength ?? 1.0, end: o.controlEnd ?? 1.0 } : undefined;
  // image→video with no explicit size: follow the source's orientation
  const lead = first ?? refs[0] ?? null;
  const size = o.size ?? (lead && lead.width && lead.height && lead.height > lead.width ? "768p-portrait" : undefined);
  const req = buildRequest({ ...o, size, firstFrame: first?.ref, lastFrame: last?.ref, refs: refs.map((r) => r.ref),
    guides: guides.map((g) => ({ ...g.ref, to: g.to })), control });
  if (ctl && ctl.duration != null && ctl.duration + 0.05 < req.seconds) {
    process.stderr.write(`vos: control video ${ctl.alias} is ${ctl.duration}s, shorter than the ${req.seconds}s clip — its last frame is held\n`);
  }
  const { media, sidecar } = genPaths(p, req.id);
  const alias = o.as;
  const note = o.note ?? `generated (${req.model}${first ? `, from ${first.alias}@${first.ref.at}` : ""}${refs.length ? `, refs ${refs.map((r) => r.alias).join("+")}` : ""}${guides.length ? `, guides ${guides.map((g) => `${g.alias}→${g.to}s`).join("+")}` : ""}${ctl ? `, control ${ctl.alias}` : ""}): ${req.prompt.slice(0, 80)}${req.prompt.length > 80 ? "…" : ""}`;
  const done = (cached: ClipResult["cached"], extra: Partial<ClipResult> = {}): ClipResult => {
    const r = ingest(p, media, alias, note, !!o.replace);
    saveAssets(p);
    const warnings = promptWarnings(o.prompt, req.seconds, (req.refs?.length ?? 0) + (req.guides?.length ?? 0));
    return { ...r, cached, request_id: req.id, file: path.relative(p.root, media), ...(warnings.length ? { warnings } : {}), ...extra };
  };
  if (fs.existsSync(media) && fs.existsSync(sidecar)) return done("project");
  if (fetchFromLibrary(req.id, media, sidecar)) return done("library");

  const sess = requireSession();
  const boot = waitBoot();
  const remoteReq: any = { ...req };
  const frames: Record<string, { sha256: string }> = {};
  for (const [key, f] of [["first", first], ["last", last]] as const) {
    if (!f) continue;
    const png = extractFrame(f.file, f.ref.at, req.width, req.height, path.join(P.cache(p.root), "gen", `${req.id}_${key}.png`));
    const name = `vosgen_${req.id}_${key}.png`;
    upload(png, `/content/ComfyUI/input/${name}`);
    remoteReq[`${key}_image`] = name;
    frames[key] = { sha256: sha256(fs.readFileSync(png)) };
  }
  // references keep their own framing (the model scales them per ref_image_size); guides are output frames → exact size
  refs.forEach((f, i) => {
    const png = extractFrame(f.file, f.ref.at, 0, 0, path.join(P.cache(p.root), "gen", `${req.id}_ref${i}.png`));
    const name = `vosgen_${req.id}_ref${i}.png`;
    upload(png, `/content/ComfyUI/input/${name}`);
    (remoteReq.ref_images ??= []).push(name);
    frames[`ref${i}`] = { sha256: sha256(fs.readFileSync(png)) };
  });
  guides.forEach((g, i) => {
    const png = extractFrame(g.file, g.ref.at, req.width, req.height, path.join(P.cache(p.root), "gen", `${req.id}_guide${i}.png`));
    const name = `vosgen_${req.id}_guide${i}.png`;
    upload(png, `/content/ComfyUI/input/${name}`);
    (remoteReq.guide_images ??= []).push({ image: name, at: g.to });
    frames[`guide${i}`] = { sha256: sha256(fs.readFileSync(png)) };
  });
  if (ctl) {
    const name = `vosgen_${req.id}_control.mp4`;
    upload(requireOnline(ctl), `/content/ComfyUI/input/${name}`);
    remoteReq.control_video = name;
  }
  const job = runRemote(remoteReq, o.timeoutSec ?? 1800);
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

// ------------------------------------------------------------------ finishing upscale

export const UPSCALERS = ["realesrgan-x2", "realesrgan-x4"] as const;

export interface UpscalePlan {
  alias: string;
  from: string; // source content id
  source_request: string | null; // generation request id, when known
  size: [number, number];
  target: [number, number];
  model: string;
  id: string; // upscale request id
  status: "todo" | "cached" | "skipped";
  reason?: string;
}

/** Smallest even size that covers the canvas at the source aspect (the renderer covers; bigger is waste). */
export function coverSize(w: number, h: number, cw: number, ch: number): [number, number] {
  const f = Math.max(cw / w, ch / h);
  const even = (x: number) => 2 * Math.ceil(x / 2);
  return [even(w * f), even(h * f)];
}

/** content id → provenance sidecar of everything under <project>/generated (the file↔sidecar link is by content). */
function generatedIndex(p: Project): Map<string, any> {
  const dir = path.join(p.root, "generated");
  const idx = new Map<string, any>();
  if (!fs.existsSync(dir)) return idx;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".gen.json")) continue;
    const id = f.slice(0, -".gen.json".length);
    const media = path.join(dir, `${id}.mp4`);
    if (!fs.existsSync(media)) continue;
    const g = readJson(path.join(dir, f));
    idx.set(g.file?.content_id ?? contentId(media), { ...g, __id: id });
  }
  return idx;
}

/** Generated clips the timeline actually uses, and what finishing them would take. Pure planning, no network. */
export function planUpscale(p: Project, o: { model?: string; only?: string[] } = {}): UpscalePlan[] {
  const r = resolveTimeline(p, loadTimeline(timelinePath(p)));
  const byContent = generatedIndex(p);
  const seen = new Set<string>();
  const plans: UpscalePlan[] = [];
  for (const m of r.media) {
    const a = m.asset;
    if (m.kind !== "video" || seen.has(a.alias) || (o.only && !o.only.includes(a.alias))) continue;
    seen.add(a.alias);
    const g = byContent.get(a.id) ?? null;
    if (!g) continue; // not generated footage: not ours to touch
    const size: [number, number] = [a.width ?? 0, a.height ?? 0];
    const base = { alias: a.alias, from: a.id, source_request: g.request?.id ?? g.source?.request_id ?? null, size };
    if (g.format === "vos.gen-upscale/1") {
      plans.push({ ...base, target: size, model: g.upscale?.model, id: g.__id, status: "skipped", reason: "already upscaled" });
      continue;
    }
    const target = coverSize(size[0], size[1], r.canvas.width, r.canvas.height);
    if (target[0] <= size[0] && target[1] <= size[1]) {
      plans.push({ ...base, target: size, model: "-", id: "-", status: "skipped", reason: "already covers the canvas" });
      continue;
    }
    const f = target[0] / size[0];
    const model = o.model ?? (f <= 2 ? "realesrgan-x2" : "realesrgan-x4");
    if (!(UPSCALERS as readonly string[]).includes(model)) throw new VosError("usage", `unknown upscaler ${model}`, `use ${UPSCALERS.join(" | ")}`);
    const id = sha256(stableStringify({ kind: "upscale", v: 1, from: a.id, model, width: target[0], height: target[1], comfy_rev: H3.comfy_rev })).slice(0, 16);
    const cached = fs.existsSync(genPaths(p, id).media);
    plans.push({ ...base, target, model, id, status: cached ? "cached" : "todo" });
  }
  return plans;
}

/**
 * Finishing pass: upscale every generated clip the timeline uses, in one session, then rebind each alias to the
 * upscaled content (`replace`). The timeline is untouched; assets.json keeps the previous content id in `replaced`,
 * and the latest render becomes stale — re-render to see the result.
 */
export function upscale(p: Project, o: { model?: string; only?: string[]; dryRun?: boolean; timeoutSec?: number } = {}) {
  const plans = planUpscale(p, o);
  if (o.dryRun) return { dry_run: true, plans };
  const results: any[] = [];
  for (const pl of plans) {
    if (pl.status === "skipped") {
      results.push(pl);
      continue;
    }
    const { media, sidecar } = genPaths(p, pl.id);
    let cached: ClipResult["cached"] = fs.existsSync(media) && fs.existsSync(sidecar) ? "project" : false;
    if (!cached && fetchFromLibrary(pl.id, media, sidecar)) cached = "library";
    let sec: number | undefined;
    if (!cached) {
      requireSession();
      waitBoot();
      const src = resolveAsset(p, pl.alias);
      const name = `vosgen_${pl.id}_src.mp4`;
      upload(requireOnline(src), `/content/ComfyUI/input/${name}`);
      const job = runRemote({ id: pl.id, kind: "upscale", src_image: name, model: pl.model, width: pl.target[0], height: pl.target[1] }, o.timeoutSec ?? 1800);
      download(job.output, media);
      sec = job.sec;
      writeJson(sidecar, {
        format: "vos.gen-upscale/1",
        source: { content_id: pl.from, request_id: pl.source_request, size: pl.size },
        upscale: { model: pl.model, file: job.upscaler?.file, width: pl.target[0], height: pl.target[1] },
        file: { bytes: fs.statSync(media).size, content_id: contentId(media) },
        ran: { gpu: job.gpu, torch: job.torch, comfy_rev: job.comfy_rev, sec: job.sec },
        at: new Date().toISOString(),
      });
      try {
        publish(pl.id, media, sidecar);
      } catch (e: any) {
        process.stderr.write(`vos: could not publish to the library: ${e.message}\n`);
      }
    }
    const r = ingest(p, media, pl.alias, `upscaled (${pl.model}, ${pl.size.join("x")}→${pl.target.join("x")}) from ${pl.source_request ?? pl.from}`, true);
    results.push({ ...pl, status: "done", cached, sec, ingest: r.status });
  }
  saveAssets(p);
  return { dry_run: false, plans: results };
}
