import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig, REPO, REPO_PYTHON } from "../core/config.ts";
import { sha256 } from "../core/hash.ts";
import { P, requireOnline, resolveAsset, type Project } from "../core/project.ts";
import { readJsonIf, run, stableStringify, VosError, which, writeJson } from "../core/util.ts";

/**
 * vos transcribe — what is said, and exactly when (segments + word timings), from the audio of an asset.
 * Uses faster-whisper from whichever local Python has it (VOS_ASR_PYTHON / config `asr_python` / the repo venv /
 * `python3`), with an already-cached model only. Result: .vos/analysis/<id>/transcript.json (provenance included),
 * bindable in graphics as {"$transcript": alias} for captions, and usable for cutting and ducking.
 */

export interface TranscriptWord { start: number; end: number; word: string; p: number }
export interface TranscriptSegment { start: number; end: number; text: string; words: TranscriptWord[] }
export interface TranscriptRecord {
  format: "vos.transcript/1";
  asset: string;
  language: string;
  segments: TranscriptSegment[];
  provenance: { engine: string; model: string; vocab: string; key: string; at: string };
}

const WORKER = path.join(REPO, "python", "asr_worker.py");
export const transcriptPath = (p: Project, id: string) => path.join(P.analysis(p.root, id), "transcript.json");
export const readTranscript = (p: Project, id: string) => readJsonIf<TranscriptRecord | null>(transcriptPath(p, id), null);

let cachedPy: string | null | undefined;
export function asrPython(): string | null {
  if (cachedPy !== undefined) return cachedPy;
  const c = loadConfig() as any;
  const candidates = [process.env.VOS_ASR_PYTHON, c.asr_python, REPO_PYTHON, which("python3") ?? undefined].filter(Boolean) as string[];
  for (const py of candidates) {
    if (!fs.existsSync(py)) continue;
    const r = run(py, ["-c", "import faster_whisper"], { timeout: 60_000 });
    if (r.status === 0) return (cachedPy = py);
  }
  return (cachedPy = null);
}

export interface TranscribeOptions { model?: string; lang?: string; vocab?: string; force?: boolean }

export function transcribe(p: Project, alias: string, o: TranscribeOptions = {}): { alias: string; status: "built" | "fresh"; record: TranscriptRecord } {
  const a = resolveAsset(p, alias);
  if (!a.has_audio) throw new VosError("no_audio", `"${a.alias}" has no audio stream`);
  const model = o.model ?? "small";
  const vocab = (o.vocab ?? "").trim();
  const key = sha256(stableStringify({ id: a.id, model, lang: o.lang ?? null, vocab, v: 1 })).slice(0, 16);
  const prev = readTranscript(p, a.id);
  if (prev && prev.provenance.key === key && !o.force) return { alias: a.alias, status: "fresh", record: prev };
  const py = asrPython();
  if (!py) throw new VosError("asr_unavailable", "no local Python with faster-whisper", "set VOS_ASR_PYTHON (or config `asr_python`) to an interpreter that can `import faster_whisper`");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vos-asr-"));
  const wav = path.join(tmp, "in.wav");
  const d = run("ffmpeg", ["-v", "error", "-y", "-i", requireOnline(a), "-vn", "-ac", "1", "-ar", "16000", wav]);
  if (d.status !== 0) throw new VosError("decode_failed", `could not decode the audio of ${a.alias}`, d.stderr.slice(-300));
  const out = path.join(tmp, "t.json");
  const args = [WORKER, "--file", wav, "--out", out, "--model", model, ...(o.lang ? ["--lang", o.lang] : []), ...(vocab ? ["--vocab", vocab] : [])];
  const r = run(py, args, { env: { ...process.env, HF_HUB_OFFLINE: "1" }, timeout: 60 * 60 * 1000 });
  const line = r.stdout.trim().split("\n").filter((l) => l.startsWith("{")).pop();
  const res = line ? JSON.parse(line) : { ok: false, error: r.stderr.slice(-500) };
  if (!res.ok) throw new VosError("asr_failed", `transcription failed: ${res.error}`);
  const raw = JSON.parse(fs.readFileSync(out, "utf8"));
  const record: TranscriptRecord = {
    format: "vos.transcript/1", asset: a.id, language: raw.language, segments: raw.segments,
    provenance: { engine: raw.engine, model, vocab, key, at: new Date().toISOString() },
  };
  writeJson(transcriptPath(p, a.id), record, false);
  fs.rmSync(tmp, { recursive: true, force: true });
  return { alias: a.alias, status: "built", record };
}
