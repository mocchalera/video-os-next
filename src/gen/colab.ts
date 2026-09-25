import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { REPO } from "../core/config.ts";
import { sha256 } from "../core/hash.ts";
import { ingest, saveAssets, type IngestResult, type Project } from "../core/project.ts";
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
}

export interface ClipOptions {
  prompt: string;
  seconds?: number;
  size?: string; // key of SIZES or "WxH"
  seed?: number;
  steps?: number;
  dense?: boolean; // disable sparse attention (exactness over speed)
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

export function buildRequest(o: ClipOptions): GenRequest {
  if (!o.prompt?.trim()) throw new VosError("usage", "vos gen clip needs --prompt");
  const seconds = o.seconds ?? 5;
  if (!(seconds > 0 && seconds <= 15)) throw new VosError("usage", "--seconds must be in (0, 15]", "the model's trained range is ~5-15 s");
  const [width, height] = parseSize(o.size);
  const body = {
    model: H3.model, prompt: o.prompt.trim(), seconds, width, height, seed: o.seed ?? 1, steps: o.steps ?? H3.steps,
    lora: H3.lora, sol_tau: o.dense ? null : H3.sol_tau, unet: H3.unet, text_encoder: H3.text_encoder,
    video_vae: H3.video_vae, audio_vae: H3.audio_vae, comfy_rev: H3.comfy_rev, weights_rev: H3.weights_rev,
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

function waitRemote(remotePath: string, timeoutSec: number): void {
  const r = run(GUARD(), ["wait", SESSION, remotePath, "--timeout", String(timeoutSec), "--every", "15"], { timeout: (timeoutSec + 120) * 1000 });
  if (r.status !== 0) throw new VosError("colab_wait", `timed out waiting for ${remotePath}`, "the lease keeps the VM alive only while vos is waiting; `vos gen status` shows it");
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
  return { balance: g.balance, rate_cu_h: g.rate_cu_h, orphans: g.orphans, session: s, boot };
}

export function down() {
  const s = guard(["stop", SESSION], 300_000);
  return { ok: !!s.ok, state: s.state };
}

export interface ClipResult extends IngestResult {
  cached: boolean;
  request_id: string;
  file: string;
  sec?: number;
}

export function clip(p: Project, o: ClipOptions & { as?: string; note?: string; replace?: boolean; timeoutSec?: number }): ClipResult {
  const req = buildRequest(o);
  const { media, sidecar } = genPaths(p, req.id);
  const alias = o.as;
  const note = o.note ?? `generated (${req.model}): ${req.prompt.slice(0, 80)}${req.prompt.length > 80 ? "…" : ""}`;
  if (fs.existsSync(media) && fs.existsSync(sidecar)) {
    const r = ingest(p, media, alias, note, !!o.replace);
    saveAssets(p);
    return { ...r, cached: true, request_id: req.id, file: path.relative(p.root, media) };
  }
  const sess = requireSession();
  const boot = waitBoot();
  guardExec(`submit(${JSON.stringify({ ...req, timeout: o.timeoutSec ?? 1800 })})`);
  waitRemote(`${REMOTE}/jobs/${req.id}.done`, (o.timeoutSec ?? 1800) + 60);
  const job = remoteJson(`${REMOTE}/jobs/${req.id}.json`);
  if (job.state !== "ok") throw new VosError("gen_failed", `generation failed on the VM`, String(job.error ?? "").slice(-600) + "\n" + String(job.log_tail ?? "").slice(-400));
  download(job.output, media);
  const rate = Number(status().rate_cu_h) || null;
  writeJson(sidecar, {
    format: "vos.gen/1",
    request: req,
    ran: { gpu: job.gpu, torch: job.torch, flags: job.flags, comfy_rev: job.comfy_rev, weights_rev: job.weights_rev,
      boot_torch: boot.torch, sec: job.sec, s_per_it: job.s_per_it, est_cu: rate ? Math.round((job.sec * rate) / 36) / 100 : null },
    at: new Date().toISOString(),
    session: { name: SESSION, endpoint: sess.endpoint },
  });
  const r = ingest(p, media, alias, note, !!o.replace);
  saveAssets(p);
  return { ...r, cached: false, request_id: req.id, file: path.relative(p.root, media), sec: job.sec };
}
