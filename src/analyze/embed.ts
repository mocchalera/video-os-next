import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pythonBin, REPO } from "../core/config.ts";
import { sha256 } from "../core/hash.ts";
import { P, requireOnline, resolveAsset, type Project } from "../core/project.ts";
import { readJsonIf, round, run, runOk, VosError, writeJson } from "../core/util.ts";
import { readDescribe, searchDescriptions } from "./marlin.ts";

/**
 * Three independent retrieval channels. Vector spaces are never mixed: each channel ranks on
 * its own, and ranks (not scores) are fused. Missing models are reported, never silently skipped.
 */
export type Channel = "text" | "visual" | "audio";
export const CHANNELS: Channel[] = ["text", "visual", "audio"];

export const MODEL_INFO: Record<Channel, { id: string; what: string; approx_size: string }> = {
  text: { id: "multilingual-e5-small (onnx q8)", what: "Marlin descriptions ↔ query text (ja/en)", approx_size: "129 MB" },
  visual: { id: "Qwen/Qwen3-VL-Embedding-2B", what: "sampled frames ↔ query text or image", approx_size: "~4.3 GB" },
  audio: { id: "laion/clap-htsat-fused", what: "audio windows ↔ query text", approx_size: "~0.6 GB" },
};

const WORKER = path.join(REPO, "python", "embed_worker.py");
const HF_HUB = process.env.HF_HUB_CACHE ?? path.join(process.env.HF_HOME ?? path.join(os.homedir(), ".cache", "huggingface"), "hub");

export function modelPresent(ch: Channel): boolean {
  if (process.env.VOS_EMBED_MOCK === "1") return true;
  if (ch === "text") return fs.existsSync(path.join(os.homedir(), ".cache/vos/models/multilingual-e5-small/onnx/model_quantized.onnx"));
  const dir = path.join(HF_HUB, `models--${MODEL_INFO[ch].id.replace("/", "--")}`, "snapshots");
  if (!fs.existsSync(dir)) return false;
  return fs.readdirSync(dir).some((s) => fs.readdirSync(path.join(dir, s)).some((f) => /\.(safetensors|bin)$/.test(f)));
}

export function modelStatus() {
  return CHANNELS.map((ch) => ({ channel: ch, ...MODEL_INFO[ch], present: modelPresent(ch) }));
}

export interface WorkerItem {
  kind: "text" | "image" | "audio";
  text?: string;
  role?: "query" | "passage";
  path?: string;
  start?: number;
  end?: number;
}

export function embed(ch: Channel, items: WorkerItem[]): { rows: Float32Array[]; dim: number; model: string } {
  const py = pythonBin();
  if (!py) throw new VosError("python_unavailable", "no Python environment for model workers", "expected python/.venv (see README) or set VOS_PYTHON");
  if (!modelPresent(ch)) throw new VosError("model_missing", `${ch} channel model ${MODEL_INFO[ch].id} is not on this machine`, `run \`vos models pull ${ch}\` (downloads ${MODEL_INFO[ch].approx_size})`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vos-embed-"));
  const req = path.join(tmp, "req.json");
  const out = path.join(tmp, "out.f32");
  fs.writeFileSync(req, JSON.stringify({ items }));
  const r = run(py, [WORKER, ch, req, out], { env: { ...process.env, HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", TOKENIZERS_PARALLELISM: "false" }, timeout: 60 * 60 * 1000 });
  const line = r.stdout.trim().split("\n").filter((l) => l.startsWith("{")).pop();
  const j = line ? JSON.parse(line) : null;
  if (!j?.ok) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw new VosError(j?.code ?? "embed_failed", `${ch} embedding failed: ${j?.error ?? r.stderr.trim().split("\n").slice(-4).join(" | ")}`);
  }
  const buf = fs.readFileSync(out);
  fs.rmSync(tmp, { recursive: true, force: true });
  const all = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const rows: Float32Array[] = [];
  for (let i = 0; i < j.n; i++) rows.push(all.slice(i * j.dim, (i + 1) * j.dim));
  return { rows, dim: j.dim, model: j.model };
}

// ---------------- per-asset index ----------------

export interface IndexMeta {
  format: "vos.embed/1";
  channel: Channel;
  asset: string;
  model: string;
  dim: number;
  key: string; // what the index was built from; rebuild when it changes
  windows: { start: number; end: number; text?: string; scope?: "clip" | "moment" }[];
  provenance: { at: string };
}

const metaPath = (p: Project, id: string, ch: Channel) => path.join(P.analysis(p.root, id), `embed.${ch}.json`);
const vecPath = (p: Project, id: string, ch: Channel) => path.join(P.analysis(p.root, id), `embed.${ch}.f32`);

export function readIndex(p: Project, id: string, ch: Channel): { meta: IndexMeta; rows: Float32Array[] } | null {
  const meta = readJsonIf<IndexMeta | null>(metaPath(p, id, ch), null);
  if (!meta || !fs.existsSync(vecPath(p, id, ch))) return null;
  const buf = fs.readFileSync(vecPath(p, id, ch));
  const all = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const rows: Float32Array[] = [];
  for (let i = 0; i < meta.windows.length; i++) rows.push(all.slice(i * meta.dim, (i + 1) * meta.dim));
  return { meta, rows };
}

function writeIndex(p: Project, meta: IndexMeta, rows: Float32Array[]): void {
  writeJson(metaPath(p, meta.asset, meta.channel), meta, false);
  const flat = new Float32Array(rows.length * meta.dim);
  rows.forEach((r, i) => flat.set(r, i * meta.dim));
  fs.writeFileSync(vecPath(p, meta.asset, meta.channel), Buffer.from(flat.buffer));
}

export interface IndexOptions {
  step?: number; // visual: seconds between sampled frames
  window?: number; // audio window seconds
  force?: boolean;
}

export type IndexOutcome = { alias: string; channel: Channel; status: "built" | "fresh" | "skipped"; windows?: number; reason?: string };

export function indexAsset(p: Project, alias: string, ch: Channel, opts: IndexOptions = {}): IndexOutcome {
  const a = resolveAsset(p, alias);
  const skip = (reason: string): IndexOutcome => ({ alias: a.alias, channel: ch, status: "skipped", reason });
  let key: string;
  let windows: IndexMeta["windows"] = [];
  let items: WorkerItem[] = [];

  if (ch === "text") {
    const d = readDescribe(p, a.id);
    if (!d) return skip("no description (run `vos describe` first)");
    key = "text2:" + sha256(JSON.stringify(d.events) + d.scene);
    if (d.scene) windows.push({ start: 0, end: a.duration ?? 0, text: d.scene, scope: "clip" });
    for (const e of d.events) windows.push({ start: e.start, end: e.end, text: e.description, scope: "moment" });
    items = windows.map((w) => ({ kind: "text", role: "passage", text: w.text! }));
  } else if (ch === "visual") {
    if (a.kind === "audio") return skip("audio asset");
    const step = opts.step ?? 1;
    key = `visual:${step}`;
    const src = requireOnline(a);
    if (a.kind === "image") {
      windows = [{ start: 0, end: 0 }];
      items = [{ kind: "image", path: src }];
    } else {
      const dir = path.join(P.cache(p.root), "frames", `${a.id}_${step}`);
      if (!fs.existsSync(path.join(dir, ".done"))) {
        fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(dir, { recursive: true });
        runOk("ffmpeg", ["-v", "error", "-i", src, "-vf", `fps=1/${step}:round=near,scale=448:-2`, "-q:v", "3", path.join(dir, "%05d.jpg")]);
        fs.writeFileSync(path.join(dir, ".done"), "");
      }
      const frames = fs.readdirSync(dir).filter((f) => f.endsWith(".jpg")).sort();
      const dur = a.duration ?? frames.length * step;
      frames.forEach((f, i) => {
        const c = i * step;
        if (c > dur) return;
        windows.push({ start: round(Math.max(0, c - step / 2)), end: round(Math.min(dur, c + step / 2)) });
        items.push({ kind: "image", path: path.join(dir, f) });
      });
    }
  } else {
    if (a.kind === "image" || (a.kind === "video" && !a.has_audio)) return skip("no audio stream");
    const win = opts.window ?? 5;
    key = `audio:${win}`;
    const src = requireOnline(a);
    const wav = path.join(P.cache(p.root), "audio", `${a.id}.48k.wav`);
    if (!fs.existsSync(wav)) {
      fs.mkdirSync(path.dirname(wav), { recursive: true });
      runOk("ffmpeg", ["-v", "error", "-y", "-i", src, "-vn", "-ac", "1", "-ar", "48000", wav]);
    }
    const dur = a.duration ?? 0;
    for (let s = 0; s < Math.max(dur - 0.5, 0.01); s += win / 2) {
      const e = Math.min(dur, s + win);
      windows.push({ start: round(s), end: round(e) });
      items.push({ kind: "audio", path: wav, start: s, end: e });
    }
  }
  const prev = readJsonIf<IndexMeta | null>(metaPath(p, a.id, ch), null);
  const modelId = process.env.VOS_EMBED_MOCK === "1" ? "mock" : MODEL_INFO[ch].id;
  if (!opts.force && prev && prev.key === key && (prev.model === modelId || prev.model.startsWith(modelId.split(" ")[0])) && fs.existsSync(vecPath(p, a.id, ch))) {
    return { alias: a.alias, channel: ch, status: "fresh", windows: prev.windows.length };
  }
  if (!items.length) return skip("nothing to index");
  const r = embed(ch, items);
  writeIndex(p, { format: "vos.embed/1", channel: ch, asset: a.id, model: r.model, dim: r.dim, key, windows, provenance: { at: new Date().toISOString() } }, r.rows);
  return { alias: a.alias, channel: ch, status: "built", windows: windows.length };
}

// ---------------- search ----------------

export interface FindHit {
  alias: string;
  start: number;
  end: number;
  score: number; // fused (reciprocal rank), comparable only within one query
  channels: Partial<Record<Channel | "lexical", number>>; // per-channel similarity / lexical score
  text?: string;
}

export interface FindResult {
  query: string;
  channels_used: Channel[];
  channels_unavailable: { channel: Channel; reason: string }[];
  hits: FindHit[];
}

const dot = (a: Float32Array, b: Float32Array) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

type RankedHit = { alias: string; start: number; end: number; sim: number; text?: string; scope: "clip" | "moment" };

export function find(p: Project, query: string, opts: { channels?: Channel[]; limit?: number; image?: string; perChannel?: number } = {}): FindResult {
  const want = opts.channels ?? CHANNELS;
  const perChannel = opts.perChannel ?? 40;
  const lists: { name: Channel | "lexical"; hits: RankedHit[] }[] = [];
  const used: Channel[] = [];
  const unavailable: FindResult["channels_unavailable"] = [];

  for (const ch of want) {
    if (opts.image && ch !== "visual") continue;
    const indexed = Object.entries(p.assets.assets).map(([alias, a]) => ({ alias, idx: readIndex(p, a.id, ch) })).filter((x) => x.idx);
    if (!indexed.length) {
      unavailable.push({ channel: ch, reason: modelPresent(ch) ? "no index yet (run `vos index`)" : `model missing (vos models pull ${ch})` });
      continue;
    }
    let q: Float32Array;
    try {
      q = embed(ch, [opts.image ? { kind: "image", path: path.resolve(opts.image) } : { kind: "text", role: "query", text: query }]).rows[0];
    } catch (e: any) {
      unavailable.push({ channel: ch, reason: e.message });
      continue;
    }
    const hits: RankedHit[] = [];
    for (const { alias, idx } of indexed) {
      if (idx!.meta.dim !== q.length) {
        unavailable.push({ channel: ch, reason: `index for ${alias} has dim ${idx!.meta.dim} ≠ query ${q.length} (rebuild with vos index --force)` });
        continue;
      }
      idx!.rows.forEach((v, i) => {
        const w = idx!.meta.windows[i];
        hits.push({ alias, start: w.start, end: w.end, sim: dot(q, v), text: w.text, scope: w.scope ?? "moment" });
      });
    }
    hits.sort((a, b) => b.sim - a.sim || a.alias.localeCompare(b.alias) || a.start - b.start);
    lists.push({ name: ch, hits: hits.slice(0, perChannel) });
    used.push(ch);
  }
  if (!opts.image) {
    const lex = searchDescriptions(p, query, perChannel).map((h): RankedHit => ({ alias: h.alias, start: h.start, end: h.end, sim: h.score, text: h.text, scope: h.source === "scene" ? "clip" : "moment" }));
    if (lex.length) lists.push({ name: "lexical", hits: lex });
  }

  // 1) spans from moment-level hits (overlapping windows of one asset merge)
  // 2) each list contributes at most its best reciprocal rank to a span (no stacking of windows)
  // 3) clip-level hits (whole-clip descriptions) lift that asset's spans, or stand alone if it has none
  const K = 60;
  type Span = { alias: string; start: number; end: number; best: Map<string, { rrf: number; sim: number }>; text?: string; textSim: number };
  const spans: Span[] = [];
  const credit = (sp: Span, list: string, rrf: number, h: RankedHit) => {
    const cur = sp.best.get(list);
    if (!cur || rrf > cur.rrf) sp.best.set(list, { rrf, sim: h.sim });
    if (h.text && h.scope === "moment" && h.sim >= sp.textSim) { sp.text = h.text; sp.textSim = h.sim; }
  };
  const moments = lists.flatMap((l) => l.hits.map((h, r) => ({ l: l.name, h, rrf: 1 / (K + r + 1) }))).filter((x) => x.h.scope === "moment");
  moments.sort((a, b) => a.h.alias.localeCompare(b.h.alias) || a.h.start - b.h.start || a.h.end - b.h.end);
  for (const m of moments) {
    let sp = spans.find((s) => s.alias === m.h.alias && m.h.start < s.end - 0.05 && m.h.end > s.start + 0.05);
    if (!sp) spans.push((sp = { alias: m.h.alias, start: m.h.start, end: m.h.end, best: new Map(), textSim: -Infinity }));
    sp.start = Math.min(sp.start, m.h.start);
    sp.end = Math.max(sp.end, m.h.end);
    credit(sp, m.l, m.rrf, m.h);
  }
  for (const l of lists) {
    l.hits.forEach((h, r) => {
      if (h.scope !== "clip") return;
      const own = spans.filter((s) => s.alias === h.alias);
      if (own.length) own.forEach((s) => credit(s, `${l.name}`, 1 / (K + r + 1) * 0.5, h)); // half weight: coarser evidence
      else {
        const sp: Span = { alias: h.alias, start: h.start, end: h.end, best: new Map(), text: h.text, textSim: h.sim };
        credit(sp, l.name, 1 / (K + r + 1), h);
        spans.push(sp);
      }
    });
  }
  const scored = spans.map((s) => ({ s, score: [...s.best.values()].reduce((a, b) => a + b.rrf, 0) }));
  scored.sort((a, b) => b.score - a.score || a.s.alias.localeCompare(b.s.alias) || a.s.start - b.s.start);
  return {
    query: opts.image ? `image:${opts.image}` : query,
    channels_used: used,
    channels_unavailable: unavailable,
    hits: scored.slice(0, opts.limit ?? 10).map(({ s, score }) => ({
      alias: s.alias,
      start: round(s.start),
      end: round(s.end),
      score: round(score * 100, 2),
      channels: Object.fromEntries([...s.best.entries()].map(([k, v]) => [k, round(v.sim, 3)])),
      text: s.text,
    })),
  };
}

// ---------------- model download (network; explicit user action only) ----------------

export function pullModel(ch: Channel): string {
  if (ch === "text") throw new VosError("usage", "text model is bundled via ~/.cache/vos/models (see README)");
  const py = pythonBin();
  if (!py) throw new VosError("python_unavailable", "no Python environment");
  const r = run(py, ["-c", `from huggingface_hub import snapshot_download; print(snapshot_download("${MODEL_INFO[ch].id}"))`], {
    env: { ...process.env, HF_HUB_OFFLINE: "0", TRANSFORMERS_OFFLINE: "0" },
    stdio: ["ignore", "pipe", "inherit"],
    timeout: 3 * 60 * 60 * 1000,
  });
  if (r.status !== 0) throw new VosError("download_failed", `could not download ${MODEL_INFO[ch].id}`, "check network access / Hugging Face availability");
  return r.stdout.trim().split("\n").pop() ?? "";
}
