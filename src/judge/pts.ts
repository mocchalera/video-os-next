import * as fs from "node:fs";
import * as path from "node:path";
import { sha256, sha256File } from "../core/hash.ts";
import { readJsonIf, round, run, runOk, VosError, writeJson } from "../core/util.ts";

/**
 * Real frame times. Nothing here assumes `index / fps` or "the n-th 1-second JPEG is at n seconds":
 * every frame time comes from the decoder (`best_effort_timestamp`), and every extracted image is checked
 * against the PTS the decoder actually delivered for it (ffmpeg showinfo with -copyts).
 *
 * Time axis ("media seconds"): t = PTS − format.start_time. This is the axis `ffmpeg -ss`, `vos look` and the
 * timeline's `in` use, so a non-zero container start (e.g. 10.0 s) maps its first frame to t = 0, and audio that
 * starts before the first video frame shows up as a first frame at t > 0 (not silently shifted).
 */

export interface PtsAnomaly {
  decoded_index: number;
  /** non_finite: no time at all; duplicate / backward: the frame time does not move forward; duplicate_pts: the
   *  stream PTS repeats even though the decoder's estimate moved on; ambiguous_previous: the trusted frame before an
   *  anomaly shares its PTS, so which image belongs to that time is not certain (it is dropped as well) */
  kind: "non_finite" | "duplicate" | "backward" | "duplicate_pts" | "ambiguous_previous";
  t: number | null;
  prev_t: number | null;
  pts: number | null; // raw pts_time (container seconds), null = N/A
  pkt_dts: number | null;
}

/** One decoded frame's timestamps as ffprobe reports them (container seconds; null = N/A). */
export interface DecodedTs {
  best_effort: number | null;
  pts: number | null;
  pkt_dts: number | null;
}

export interface FrameTable {
  format: "vos.frames/1";
  source: { content_id: string; size: number; mtime_ms: number };
  format_start: number; // container start_time (s)
  stream_start: number | null; // video stream start_time (s)
  format_duration: number | null; // container duration (s)
  stream_duration: number | null;
  r_frame_rate: string | null; // nominal (codec) rate, never used for times
  avg_frame_rate: string | null;
  has_b_frames: number;
  /** decoded frame times in media seconds, presentation order, strictly increasing (trusted frames only) */
  t: number[];
  /** frames whose packet PTS order differed from decode order (B-frame reorder evidence) */
  reordered_packets: number;
  vfr: { vfr: boolean; min_delta: number; max_delta: number; median_delta: number; distinct_deltas: number };
  /** ESTIMATE of when the last trusted frame stops being shown: its t + the median delta (not a measured time) */
  last_frame_end: number;
  last_frame_end_basis: "last_t+median_delta";
  /** where each trusted frame's time came from: the stream PTS, or only the decoder's best-effort estimate */
  time_source: { pts: number; best_effort_only: number };
  decoded_frames: number; // every frame the decoder returned
  /** timestamps that were missing, repeated or went backwards; frames from the first one on are not in `t` */
  anomalies: PtsAnomaly[];
  anomaly_count: number; // decoded frames left out of `t`
  trusted: "all" | "until_first_anomaly";
  digest: string; // sha256 of the t array (rounded to µs) — what "frame references" are checked against
  probed_with: string;
  tools: ToolVersions;
}

export interface ToolVersions {
  ffprobe: string | null;
  ffmpeg: string | null;
}

let toolCache: ToolVersions | null = null;
/** First version line of ffprobe / ffmpeg (PTS handling depends on them). */
export function toolVersions(): ToolVersions {
  if (toolCache) return toolCache;
  const v = (bin: string) => {
    const r = run(bin, ["-version"], { timeout: 30_000 });
    return r.status === 0 ? r.stdout.split("\n")[0].trim() : null;
  };
  toolCache = { ffprobe: v("ffprobe"), ffmpeg: v("ffmpeg") };
  return toolCache;
}

/** a full decode of a long clip is slow but bounded; past this it is an error, not a hang */
const DECODE_TIMEOUT_MS = 30 * 60 * 1000;

const num = (x: unknown): number | null => {
  const n = Number(x);
  return x === undefined || x === null || x === "N/A" || !Number.isFinite(n) ? null : n;
};

/**
 * Decoded frames come out in presentation order. A frame without a finite time, one that does not move forward
 * (repeated or backwards), or one whose stream PTS repeats, is an anomaly: frames from the first anomaly on are not
 * trusted — never re-sorted, never guessed. If the last trusted frame shares its PTS with the anomalous one, it is
 * dropped too (which of the two images belongs to that time is not certain). A frame whose PTS is N/A but whose
 * best-effort time is finite stays trusted and is counted as `best_effort_only`. Times are media seconds.
 */
export function trustedTimes(decoded: (number | null | DecodedTs)[], formatStart: number): { times: number[]; anomalies: PtsAnomaly[]; firstBad: number; source: { pts: number; best_effort_only: number } } {
  const recs: DecodedTs[] = decoded.map((d) => (d === null || typeof d === "number" ? { best_effort: d, pts: d, pkt_dts: null } : d));
  const times: number[] = [];
  const fromPts: boolean[] = [];
  const anomalies: PtsAnomaly[] = [];
  let firstBad = -1;
  let last: number | null = null;
  let lastPts: number | null = null;
  const fin = (x: number | null) => (x !== null && Number.isFinite(x) ? x : null);
  recs.forEach((r, i) => {
    const be = fin(r.best_effort) ?? fin(r.pts);
    const pts = fin(r.pts);
    const rel = be === null ? null : be - formatStart;
    let kind: PtsAnomaly["kind"] | null = null;
    if (rel === null) kind = "non_finite";
    else if (last !== null && rel === last) kind = "duplicate";
    else if (last !== null && rel < last) kind = "backward";
    else if (pts !== null && lastPts !== null && pts === lastPts) kind = "duplicate_pts";
    const rec = (k: PtsAnomaly["kind"], idx: number, t: number | null, prev: number | null, rr: DecodedTs) => {
      if (anomalies.length < 50) anomalies.push({ decoded_index: idx, kind: k, t: t === null ? null : round(t, 6), prev_t: prev === null ? null : round(prev, 6), pts: fin(rr.pts), pkt_dts: fin(rr.pkt_dts) });
    };
    if (kind) {
      if (firstBad < 0) {
        firstBad = i;
        // the previous trusted frame has the same PTS as this one: its image/time pairing is ambiguous
        if (pts !== null && lastPts !== null && pts === lastPts && times.length) {
          times.pop();
          fromPts.pop();
          rec("ambiguous_previous", i - 1, last, null, recs[i - 1]);
          firstBad = i - 1;
        }
      }
      rec(kind, i, rel, last, r);
    } else if (firstBad < 0) {
      times.push(rel!);
      fromPts.push(pts !== null);
    }
    if (rel !== null) last = rel;
    if (pts !== null) lastPts = pts;
  });
  const n = fromPts.filter(Boolean).length;
  return { times, anomalies, firstBad, source: { pts: n, best_effort_only: fromPts.length - n } };
}

/** Probe streams + decode every video frame's timestamp. Cached by content id + size + mtime. */
export function frameTable(file: string, contentId: string, cacheDir?: string): FrameTable {
  const st = fs.statSync(file);
  const cacheFile = cacheDir ? path.join(cacheDir, "pts", `${contentId}.json`) : null;
  if (cacheFile) {
    const c = readJsonIf<FrameTable | null>(cacheFile, null);
    if (c && c.format === "vos.frames/1" && c.time_source && c.source.size === st.size && c.source.mtime_ms === st.mtimeMs) return c;
  }
  const s = JSON.parse(
    runOk("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "format=start_time,duration:stream=start_time,duration,r_frame_rate,avg_frame_rate,has_b_frames", "-of", "json", file]).stdout,
  );
  const v = s.streams?.[0];
  if (!v) throw new VosError("no_video", `${path.basename(file)}: no video stream`);
  const fr = JSON.parse(
    runOk("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "frame=best_effort_timestamp_time,pts_time,pkt_dts_time", "-of", "json", file], { timeout: DECODE_TIMEOUT_MS }).stdout,
  );
  const formatStart = num(s.format?.start_time) ?? 0;
  const { times: raw, anomalies, firstBad, source } = trustedTimes((fr.frames ?? []).map((f: any): DecodedTs => ({ best_effort: num(f.best_effort_timestamp_time), pts: num(f.pts_time), pkt_dts: num(f.pkt_dts_time) })), formatStart);
  const totalDecoded = (fr.frames ?? []).length;
  if (!raw.length) throw new VosError("no_frames", `${path.basename(file)}: the decoder returned no usable timed video frames`, anomalies.length ? `first anomaly: ${JSON.stringify(anomalies[0])}` : undefined);
  const pk = JSON.parse(runOk("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time", "-of", "json", file], { timeout: DECODE_TIMEOUT_MS }).stdout);
  const pts = (pk.packets ?? []).map((p: any) => num(p.pts_time)).filter((x: number | null): x is number => x !== null);
  let reordered = 0;
  for (let i = 1; i < pts.length; i++) if (pts[i] < pts[i - 1]) reordered++;
  const deltas = raw.slice(1).map((x, i) => x - raw[i]);
  const sorted = [...deltas].sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  const distinct = new Set(deltas.map((d) => Math.round(d * 1e4))).size;
  const minD = sorted[0] ?? 0, maxD = sorted[sorted.length - 1] ?? 0;
  // VFR: any delta more than half a millisecond and 2% away from the median (timebase rounding is far smaller)
  const vfr = deltas.some((d) => Math.abs(d - median) > Math.max(0.0005, 0.02 * median));
  const t = raw.map((x) => round(x, 6));
  const table: FrameTable = {
    format: "vos.frames/1",
    source: { content_id: contentId, size: st.size, mtime_ms: st.mtimeMs },
    format_start: formatStart,
    stream_start: num(v.start_time),
    format_duration: num(s.format?.duration),
    stream_duration: num(v.duration),
    r_frame_rate: v.r_frame_rate ?? null,
    avg_frame_rate: v.avg_frame_rate ?? null,
    has_b_frames: Number(v.has_b_frames ?? 0),
    t,
    reordered_packets: reordered,
    vfr: { vfr, min_delta: round(minD, 6), max_delta: round(maxD, 6), median_delta: round(median, 6), distinct_deltas: distinct },
    last_frame_end: round(t[t.length - 1] + (median || 0), 6),
    last_frame_end_basis: "last_t+median_delta",
    time_source: source,
    decoded_frames: totalDecoded,
    anomalies,
    anomaly_count: totalDecoded - raw.length,
    trusted: firstBad < 0 ? "all" : "until_first_anomaly",
    digest: sha256(JSON.stringify(t)),
    probed_with: "ffprobe frame=best_effort_timestamp_time,pts_time,pkt_dts_time (decoded)",
    tools: toolVersions(),
  };
  if (cacheFile) writeJson(cacheFile, table, false);
  return table;
}

export interface Snap {
  index: number;
  t: number; // the frame's own time (observed from the decoder table)
  next_t: number; // when the next frame replaces it (last frame: last_frame_end)
  requested: number;
  offset: number; // requested − t (≥ 0 unless before the first frame)
  /** before_first_frame: t precedes the first frame; past_end: after the last frame's display; past_trusted: after
   *  the last trusted frame of a stream with timestamp anomalies (the time cannot be tied to a real frame) */
  flag?: "before_first_frame" | "past_end" | "past_trusted";
}

/** The frame on screen at media time `t`: the last frame whose time ≤ t. */
export function snap(table: FrameTable, t: number): Snap {
  const a = table.t;
  let flag: Snap["flag"];
  if (t < a[0]) flag = "before_first_frame";
  else if (t >= table.last_frame_end) flag = table.trusted === "all" ? "past_end" : "past_trusted";
  let lo = 0, hi = a.length - 1;
  if (t <= a[0]) hi = 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (a[mid] <= t + 1e-9) lo = mid;
    else hi = mid - 1;
  }
  const i = lo;
  const next = i + 1 < a.length ? a[i + 1] : table.last_frame_end;
  return { index: i, t: a[i], next_t: next, requested: t, offset: round(t - a[i], 6), ...(flag ? { flag } : {}) };
}

/**
 * Real frames covering [start, end]: every frame in the window when there are few enough, otherwise an even pick
 * in frame order (count = min(max, frames in window, span/step + 1)). Never a time that is not a frame.
 */
export function framesIn(table: FrameTable, start: number, end: number, step: number, max: number): Snap[] {
  const a = snap(table, Math.max(table.t[0], start));
  const e = Math.min(end, table.last_frame_end - 1e-6);
  if (e < a.t) return [a];
  const b = snap(table, e);
  const avail = b.index - a.index + 1;
  const n = Math.max(1, Math.min(max, avail, Math.floor((e - a.t) / Math.max(step, 1e-3)) + 1 >= avail ? avail : Math.floor((e - a.t) / Math.max(step, 1e-3)) + 1));
  const out: Snap[] = [];
  const seen = new Set<number>();
  for (let k = 0; k < n; k++) {
    const i = n === 1 ? a.index : a.index + Math.round(((avail - 1) * k) / (n - 1));
    if (seen.has(i)) continue;
    seen.add(i);
    out.push(snap(table, table.t[i]));
  }
  return out;
}

/** Where a naive "index / nominal fps" reading would put frame i, and how far that is from the truth. */
export function nominalError(table: FrameTable, index: number): number | null {
  const [n, d] = String(table.r_frame_rate ?? "").split("/").map(Number);
  if (!n || !d) return null;
  return round(index / (n / d) - table.t[index], 6);
}

export interface ExtractedFrame {
  index: number;
  t: number; // table time of the frame we asked for
  observed_t: number; // the time the decoder delivered (showinfo, -copyts) minus format_start
  file: string; // absolute path of the JPEG
  sha256: string;
  width: number;
}

/**
 * Extract exactly frame `index` as a JPEG. Seeks to just before its time (ffmpeg drops frames whose PTS is
 * below the seek point), keeps original timestamps (-copyts) and reads back the PTS of the frame the decoder
 * actually delivered. A different frame is an error, never a silent substitute.
 */
export function extractFrame(file: string, table: FrameTable, index: number, outDir: string, width = 448): ExtractedFrame {
  const t = table.t[index];
  const prev = index > 0 ? table.t[index - 1] : null;
  const eps = prev === null ? 0 : Math.min(0.001, (t - prev) / 4);
  const seek = Math.max(0, t - eps);
  fs.mkdirSync(outDir, { recursive: true });
  const name = `${String(Math.round(t * 1e6)).padStart(12, "0")}_f${index}_w${width}.jpg`;
  const out = path.join(outDir, name);
  const meta = `${out}.json`;
  const cached = readJsonIf<ExtractedFrame | null>(meta, null);
  if (cached && fs.existsSync(out) && cached.t === t && sha256File(out) === cached.sha256) return { ...cached, file: out };
  const tmp = `${out}.tmp-${process.pid}.jpg`;
  const r = run("ffmpeg", [
    "-v", "info", "-y", "-copyts", "-ss", seek.toFixed(6), "-i", file, "-frames:v", "1", "-an",
    "-vf", `showinfo,scale=${width}:-2:out_range=full,format=yuvj420p`, "-q:v", "3", tmp,
  ], { timeout: 5 * 60 * 1000 });
  if (r.status !== 0 || !fs.existsSync(tmp)) throw new VosError("frame_extract_failed", `could not extract frame ${index} (t=${t}) of ${path.basename(file)}: ${r.stderr.trim().split("\n").slice(-3).join(" | ")}`);
  const m = r.stderr.match(/n:\s*0\s+pts:\s*-?\d+\s+pts_time:(-?[0-9.e+-]+)/);
  if (!m) {
    fs.rmSync(tmp, { force: true });
    throw new VosError("frame_pts_unknown", `ffmpeg did not report the PTS of the extracted frame (${path.basename(file)} f${index})`);
  }
  const observed = round(Number(m[1]) - table.format_start, 6);
  // the decoder's time base can round; anything beyond a quarter of the neighbouring gap is another frame
  const next = index + 1 < table.t.length ? table.t[index + 1] : table.last_frame_end;
  const tol = Math.max(1e-4, Math.min(t - (prev ?? t - 1), next - t) / 4);
  if (Math.abs(observed - t) > tol) {
    fs.rmSync(tmp, { force: true });
    throw new VosError("pts_mismatch", `${path.basename(file)}: asked for frame ${index} at ${t}s, the decoder delivered ${observed}s`, "the frame table and the decoder disagree; refusing to cite this frame");
  }
  fs.renameSync(tmp, out);
  const rec: ExtractedFrame = { index, t, observed_t: observed, file: out, sha256: sha256File(out), width };
  writeJson(meta, { ...rec, file: name }, false);
  return rec;
}
