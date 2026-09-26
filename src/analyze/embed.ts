import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pythonBin, REPO } from "../core/config.ts";
import { sha256 } from "../core/hash.ts";
import { P, requireOnline, resolveAsset, type Project } from "../core/project.ts";
import { readJsonIf, round, run, runOk, VosError, writeJson } from "../core/util.ts";
import { readDescribe, searchDescriptions } from "./marlin.ts";
import { analysisColab, inputOf, PROFILES, rowsOf, runJob, type RemoteInput } from "../remote/analysis.ts";

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
  /** embedding space: model + revision + query instruction. A query is only compared with indexes of its space. */
  space?: string;
  provenance: { at: string; ran?: Record<string, unknown> };
}

/** HF snapshot revision of a model on this machine, or null. */
function localRevision(id: string): string | null {
  const ref = path.join(HF_HUB, `models--${id.replace("/", "--")}`, "refs", "main");
  return fs.existsSync(ref) ? fs.readFileSync(ref, "utf8").trim() : null;
}

/** The space an embedding lives in. Only the visual channel runs in two places, so only it carries one. */
export function spaceOf(ch: Channel, where: "local" | "colab"): string | undefined {
  if (ch !== "visual") return undefined;
  if (process.env.VOS_EMBED_MOCK === "1" && where === "local") return "mock";
  const rev = where === "colab" ? PROFILES.visual.revision : (localRevision(MODEL_INFO.visual.id) ?? "unknown");
  return `${MODEL_INFO.visual.id}@${rev.slice(0, 12)}#${sha256("Retrieve images or text relevant to the user's query.").slice(0, 8)}`;
}

/** An index written before spaces were recorded was built here, with this machine's snapshot. */
const indexSpace = (m: IndexMeta) => m.space ?? spaceOf(m.channel, "local");

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
  on?: "local" | "colab"; // colab: visual channel only, on the `vos remote` session
  session?: string;
  timeoutSec?: number;
}

export type IndexOutcome = { alias: string; channel: Channel; status: "built" | "fresh" | "skipped"; windows?: number; reason?: string };

interface Prepared {
  outcome?: IndexOutcome; // already decided (fresh / skipped)
  alias: string;
  id: string;
  sig: string;
  windows: IndexMeta["windows"];
  items: WorkerItem[];
}

function prepare(p: Project, alias: string, ch: Channel, opts: IndexOptions): Prepared {
  const a = resolveAsset(p, alias);
  const skip = (reason: string): Prepared => ({ outcome: { alias: a.alias, channel: ch, status: "skipped", reason }, alias: a.alias, id: a.id, sig: "", windows: [], items: [] });
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
  const sameSpace = !prev || indexSpace(prev) === spaceOf(ch, opts.on ?? "local");
  if (!opts.force && prev && sameSpace && prev.key === key && (prev.model === modelId || prev.model.startsWith(modelId.split(" ")[0])) && fs.existsSync(vecPath(p, a.id, ch))) {
    return { outcome: { alias: a.alias, channel: ch, status: "fresh", windows: prev.windows.length }, alias: a.alias, id: a.id, sig: key, windows: prev.windows, items: [] };
  }
  if (!items.length) return skip("nothing to index");
  return { alias: a.alias, id: a.id, sig: key, windows, items };
}

/** Index many assets on one channel with a single model load. */
export function indexChannel(p: Project, aliases: string[], ch: Channel, opts: IndexOptions = {}): IndexOutcome[] {
  const preps = aliases.map((al) => prepare(p, al, ch, opts));
  const todo = preps.filter((x) => !x.outcome);
  if (todo.length && opts.on === "colab") {
    indexRemote(p, ch, todo, opts);
  } else if (todo.length) {
    const r = embed(ch, todo.flatMap((x) => x.items));
    let k = 0;
    for (const x of todo) {
      const rows = r.rows.slice(k, k + x.items.length);
      k += x.items.length;
      writeIndex(p, { format: "vos.embed/1", channel: ch, asset: x.id, model: r.model, dim: r.dim, key: x.sig, windows: x.windows, space: spaceOf(ch, "local"), provenance: { at: new Date().toISOString() } }, rows);
      x.outcome = { alias: x.alias, channel: ch, status: "built", windows: x.windows.length };
    }
  }
  return preps.map((x) => x.outcome!);
}

// ---------------- remote (vos remote session) ----------------

/**
 * One frames archive per video (built once next to the extracted frames, so its hash is stable and the VM keeps
 * it across runs); a still image goes as itself. Only the pixels the local index would have used travel.
 */
function framesArchive(dir: string): string {
  const tar = `${dir}.tar`;
  if (!fs.existsSync(`${tar}.done`)) {
    const frames = fs.readdirSync(dir).filter((f) => f.endsWith(".jpg")).sort();
    fs.rmSync(tar, { force: true });
    // COPYFILE_DISABLE: no macOS ._ metadata members (the VM refuses anything but flat frame names)
    runOk("tar", ["-cf", tar, "-C", dir, ...frames], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
    fs.writeFileSync(`${tar}.done`, "");
  }
  return tar;
}

type RemoteItem = { kind: "image"; input: string; member?: string } | { kind: "text"; text: string; role: "query" | "passage" };

/** Map local worker items to remote ones: frames → (archive, member), stills → themselves, text → text. */
function remoteItems(items: WorkerItem[]): { inputs: RemoteInput[]; items: RemoteItem[] } {
  const inputs = new Map<string, RemoteInput>();
  const byDir = new Map<string, RemoteInput>();
  const out: RemoteItem[] = [];
  for (const it of items) {
    if (it.kind === "text") {
      out.push({ kind: "text", text: it.text!, role: it.role ?? "query" });
      continue;
    }
    if (it.kind !== "image") throw new VosError("usage", "only the visual channel runs remotely");
    const dir = path.dirname(it.path!);
    if (fs.existsSync(path.join(dir, ".done")) && path.basename(path.dirname(dir)) === "frames") {
      let tar = byDir.get(dir);
      if (!tar) {
        tar = inputOf(framesArchive(dir));
        byDir.set(dir, tar);
        inputs.set(tar.sha256, tar);
      }
      out.push({ kind: "image", input: tar.sha256, member: path.basename(it.path!) });
    } else {
      const img = inputOf(it.path!);
      inputs.set(img.sha256, img);
      out.push({ kind: "image", input: img.sha256 });
    }
  }
  return { inputs: [...inputs.values()], items: out };
}

/** Embed on the VM; rows come back checked (count, size, finite) in item order. */
export function embedRemote(ch: Channel, items: WorkerItem[], o: { session?: string; timeoutSec?: number } = {}) {
  if (ch !== "visual") throw new VosError("usage", `the ${ch} channel runs locally only`, "--on colab applies to the visual channel");
  const { inputs, items: ritems } = remoteItems(items);
  const prof = PROFILES.visual;
  const c = analysisColab(o.session);
  const r = runJob(c, "visual", {
    kind: "embed", inputs, worker: WORKER, files: ["f32"], extra: { channel: ch, items: ritems },
    key: { channel: ch, model: prof.model, revision: prof.revision },
  }, o.timeoutSec ?? 3600);
  const rows = rowsOf(r.files.f32, ritems.length, Number(r.job.dim));
  const ran = { backend: "colab", session: c.session, job: r.id, gpu: r.job.versions?.gpu ?? null, device: r.job.device ?? null, versions: r.job.versions ?? null,
    revision: prof.revision, worker_sha256: r.worker_sha256, sec: r.job.sec ?? null, uploaded_bytes: r.transfer.bytes };
  return { rows, dim: Number(r.job.dim), model: prof.model, space: spaceOf(ch, "colab")!, ran };
}

function indexRemote(p: Project, ch: Channel, todo: Prepared[], opts: IndexOptions): void {
  const r = embedRemote(ch, todo.flatMap((x) => x.items), { session: opts.session, timeoutSec: opts.timeoutSec });
  let k = 0;
  for (const x of todo) {
    const rows = r.rows.slice(k, k + x.items.length);
    k += x.items.length;
    writeIndex(p, { format: "vos.embed/1", channel: ch, asset: x.id, model: r.model, dim: r.dim, key: x.sig, windows: x.windows, space: r.space,
      provenance: { at: new Date().toISOString(), ran: r.ran } }, rows);
    x.outcome = { alias: x.alias, channel: ch, status: "built", windows: x.windows.length };
  }
}

export function indexAsset(p: Project, alias: string, ch: Channel, opts: IndexOptions = {}): IndexOutcome {
  return indexChannel(p, [alias], ch, opts)[0];
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

export function find(p: Project, query: string, opts: { channels?: Channel[]; limit?: number; image?: string; perChannel?: number; on?: "local" | "colab"; session?: string } = {}): FindResult {
  // CLAP embeds *sound*. It joins by default only when the query is about sound; otherwise its
  // lukewarm similarities just add noise to visual queries. Explicit --channels always wins.
  const auditory = /\b(sound|noise|music|song|voice|voices|speech|beat|drum|drums|bell|ring|rain sound|crackl|applause|silence|ambience|ambient)\b|音|声|曲|鳴|響|ＢＧＭ|BGM|拍手|足音|雨音|静寂/i.test(query);
  const want = opts.channels ?? CHANNELS.filter((c) => c !== "audio" || auditory);
  const perChannel = opts.perChannel ?? 40;
  const lists: { name: Channel | "lexical"; hits: RankedHit[] }[] = [];
  const used: Channel[] = [];
  const unavailable: FindResult["channels_unavailable"] = [];
  const allSims = new Map<string, number[]>();

  for (const ch of want) {
    if (opts.image && ch !== "visual") continue;
    const indexed = Object.entries(p.assets.assets).map(([alias, a]) => ({ alias, idx: readIndex(p, a.id, ch) })).filter((x) => x.idx);
    // the query is embedded where the user asked (the VM spares this machine the 8 GB visual model)
    const remoteQuery = opts.on === "colab" && ch === "visual";
    if (!indexed.length) {
      unavailable.push({ channel: ch, reason: remoteQuery || modelPresent(ch) ? "no index yet (run `vos index`)" : `model missing (vos models pull ${ch}, or --on colab)` });
      continue;
    }
    let q: Float32Array;
    const qSpace = spaceOf(ch, remoteQuery ? "colab" : "local");
    try {
      const item: WorkerItem = opts.image ? { kind: "image", path: path.resolve(opts.image) } : { kind: "text", role: "query", text: query };
      q = remoteQuery ? embedRemote(ch, [item], { session: opts.session }).rows[0] : embed(ch, [item]).rows[0];
    } catch (e: any) {
      unavailable.push({ channel: ch, reason: e.message });
      continue;
    }
    const hits: RankedHit[] = [];
    for (const { alias, idx } of indexed) {
      const iSpace = indexSpace(idx!.meta);
      if (qSpace && iSpace !== qSpace) {
        // vectors from different spaces are not comparable: say so rather than rank noise
        unavailable.push({ channel: ch, reason: `index for ${alias} is in ${iSpace}, the query in ${qSpace} (vos index --force${remoteQuery ? " --on colab" : ""}, or find ${remoteQuery ? "without" : "with"} --on colab)` });
        continue;
      }
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
    allSims.set(ch, hits.map((h) => h.sim));
    lists.push({ name: ch, hits: hits.slice(0, perChannel) });
    used.push(ch);
  }
  if (!opts.image) {
    const lex = searchDescriptions(p, query, perChannel).map((h): RankedHit => ({ alias: h.alias, start: h.start, end: h.end, sim: h.score, text: h.text, scope: h.source === "scene" ? "clip" : "moment" }));
    if (lex.length) lists.push({ name: "lexical", hits: lex });
  }

  // Fusion, designed for precision and honesty:
  // 1) per list, only hits that stand out from that list's own distribution count (z >= Z_MIN = 1.5);
  //    a channel that is uniformly lukewarm (e.g. audio for a visual query) contributes nothing.
  // 2) spans are runs of consecutive windows *within one list* (a shot, an event), so a long
  //    text event never swallows a precise one-second visual match.
  // 3) other lists add evidence where they overlap a span: each list at most once (its best rank).
  // 4) clip-level descriptions lift that asset's spans at half weight, or stand alone.
  // 5) overlapping spans of one asset: the higher-scoring one wins (NMS on the shorter length).
  const K = 60, Z_MIN = 1.5;
  type Ev = { list: string; rrf: number; sim: number; h: RankedHit };
  type Span = { alias: string; start: number; end: number; ev: Map<string, Ev>; text?: string; textSim: number };
  const gated: Ev[] = [];
  for (const l of lists) {
    const sims = l.hits.map((h) => h.sim);
    const all = l.name === "lexical" ? sims : (allSims.get(l.name) ?? sims);
    const mu = all.reduce((a, b) => a + b, 0) / Math.max(1, all.length);
    const sd = Math.sqrt(all.reduce((a, b) => a + (b - mu) ** 2, 0) / Math.max(1, all.length)) || 1;
    l.hits.forEach((h, r) => {
      if (l.name !== "lexical" && (h.sim - mu) / sd < Z_MIN) return;
      gated.push({ list: l.name, rrf: 1 / (K + r + 1), sim: h.sim, h });
    });
  }
  const give = (sp: Span, e: Ev, w = 1) => {
    const cur = sp.ev.get(e.list);
    if (!cur || e.rrf * w > cur.rrf) sp.ev.set(e.list, { ...e, rrf: e.rrf * w });
    if (e.h.text && e.h.scope === "moment" && e.sim >= sp.textSim && e.list !== "lexical") { sp.text = e.h.text; sp.textSim = e.sim; }
    if (!sp.text && e.h.text && e.h.scope === "moment") sp.text = e.h.text;
  };
  const spans: Span[] = [];
  const moments = gated.filter((e) => e.h.scope === "moment").sort((a, b) => a.list.localeCompare(b.list) || a.h.alias.localeCompare(b.h.alias) || a.h.start - b.h.start);
  for (const e of moments) {
    const last = spans[spans.length - 1];
    const sliding = e.list === "visual" || e.list === "audio"; // text events are distinct moments; never chain them
    const sameRun = sliding && last && last.alias === e.h.alias && last.ev.get(e.list) !== undefined && last.ev.size === 1 && e.h.start <= last.end + 0.05;
    if (sameRun) {
      last.end = Math.max(last.end, e.h.end);
      give(last, e);
    } else {
      const sp: Span = { alias: e.h.alias, start: e.h.start, end: e.h.end, ev: new Map(), textSim: -Infinity };
      give(sp, e);
      spans.push(sp);
    }
  }
  const seeds = spans.map((sp) => ({ sp, own: [...sp.ev.keys()][0] }));
  for (const { sp, own } of seeds) {
    for (const e of moments) {
      if (e.list === own || e.h.alias !== sp.alias) continue;
      if (e.h.start < sp.end - 0.05 && e.h.end > sp.start + 0.05) give(sp, e);
    }
  }
  for (const e of gated.filter((x) => x.h.scope === "clip")) {
    const own = spans.filter((s) => s.alias === e.h.alias);
    if (own.length) own.forEach((s) => give(s, e, 0.5));
    else {
      const sp: Span = { alias: e.h.alias, start: e.h.start, end: e.h.end, ev: new Map(), text: e.h.text, textSim: e.sim };
      give(sp, e);
      spans.push(sp);
    }
  }
  // an editor needs a place to cut: spans longer than ~12 s are coarse evidence and rank lower
  const precision = (sp: Span) => Math.min(1, 12 / Math.max(0.001, sp.end - sp.start)) ** 0.35;
  const scored = spans.map((s) => ({ s, score: [...s.ev.values()].reduce((a, b) => a + b.rrf, 0) * precision(s) }));
  scored.sort((a, b) => b.score - a.score || a.s.end - a.s.start - (b.s.end - b.s.start) || a.s.alias.localeCompare(b.s.alias) || a.s.start - b.s.start);
  const kept: typeof scored = [];
  for (const c of scored) {
    const clash = kept.some((k) => {
      if (k.s.alias !== c.s.alias) return false;
      const ov = Math.min(k.s.end, c.s.end) - Math.max(k.s.start, c.s.start);
      return ov > 0.5 * Math.min(k.s.end - k.s.start || 1, c.s.end - c.s.start || 1);
    });
    if (!clash) kept.push(c);
  }
  return {
    query: opts.image ? `image:${opts.image}` : query,
    channels_used: used,
    channels_unavailable: unavailable,
    hits: kept.slice(0, opts.limit ?? 10).map(({ s, score }) => ({
      alias: s.alias,
      start: round(s.start),
      end: round(s.end),
      score: round(score * 100, 2),
      channels: Object.fromEntries([...s.ev.entries()].map(([k, v]) => [k, round(v.sim, 3)])),
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
