import * as fs from "node:fs";
import * as path from "node:path";
import { parseTime, toFrame, framesToSeconds, type Grid, type TimeContext, type TimeValue } from "./time.ts";
import { P, resolveAsset, type Project, type ResolvedAsset } from "./project.ts";
import { readJson, readJsonIf, VosError } from "./util.ts";

export interface ClipFx {
  opacity?: number;
  filter?: string; // CSS filter, e.g. "blur(4px) grayscale(.5)"
  scale?: number;
}

export interface MediaClip {
  id: string;
  asset: string;
  at: TimeValue;
  dur: TimeValue;
  in?: TimeValue; // source seconds, default 0
  slot?: string; // "<graphicsClipId>/<slotName>"
  fit?: "cover" | "contain";
  fx?: ClipFx;
  fade?: { in?: number; out?: number };
  gain_db?: number; // audio
  audio?: boolean; // for video clips: also play the clip's own audio
  label?: string;
}

export interface GraphicsClip {
  id: string;
  src: string; // project-relative html
  at: TimeValue;
  dur: TimeValue;
  props?: Record<string, unknown>;
  label?: string;
}

export interface Track {
  id: string;
  kind: "video" | "audio" | "graphics";
  clips: any[];
  mute?: boolean;
  /** "overlay" tracks (HUD, grain, transitions) are ignored when analysing cuts */
  role?: "content" | "overlay";
}

export interface Marker {
  at: TimeValue;
  label: string;
  kind?: string; // e.g. "section", "expect-black", "expect-flash", "expect-still"
  dur?: TimeValue;
}

export interface TimelineDoc {
  format: "vos.timeline/1";
  name: string;
  canvas?: { width: number; height: number; fps: number; background?: string };
  duration: TimeValue;
  grid?: Grid | { from: string };
  tracks: Track[];
  markers?: Marker[];
}

// ---------- resolved form: everything in frames, assets resolved ----------

export interface RMedia {
  kind: "video" | "audio" | "image";
  id: string;
  track: string;
  trackIndex: number;
  asset: ResolvedAsset;
  start: number; // frames
  frames: number;
  srcIn: number; // seconds
  slot?: { clip: string; name: string };
  fit: "cover" | "contain";
  fx: ClipFx;
  fade: { in: number; out: number };
  gain: number; // linear
  withAudio: boolean;
  label?: string;
}

export interface RGraphics {
  kind: "graphics";
  id: string;
  track: string;
  trackIndex: number;
  src: string;
  absSrc: string;
  start: number;
  frames: number;
  props: Record<string, unknown>;
  label?: string;
}

export interface RMarker {
  frame: number;
  frames: number;
  label: string;
  kind: string;
}

export interface Resolved {
  name: string;
  canvas: { width: number; height: number; fps: number; background: string };
  frames: number;
  grid?: Grid;
  tracks: { id: string; kind: Track["kind"]; index: number; mute: boolean; role: "content" | "overlay" }[];
  media: RMedia[];
  graphics: RGraphics[];
  markers: RMarker[];
  warnings: string[];
}

export function timelinePath(p: Project, file?: string): string {
  return path.resolve(p.root, file ?? p.file.timeline ?? "timeline.json");
}

export function loadTimeline(file: string): TimelineDoc {
  const doc = readJson<TimelineDoc>(file);
  if (doc.format !== "vos.timeline/1") throw new VosError("bad_timeline", `${file}: "format" must be "vos.timeline/1"`);
  return doc;
}

function need(cond: any, where: string, msg: string, hint?: string): asserts cond {
  if (!cond) throw new VosError("invalid_timeline", `${where}: ${msg}`, hint);
}

export function resolveTimeline(p: Project, doc: TimelineDoc): Resolved {
  const canvas = { background: "#000000", ...p.file.canvas, ...(doc.canvas ?? {}) } as Resolved["canvas"];
  const fps = canvas.fps;
  let grid: Grid | undefined;
  if (doc.grid && "from" in doc.grid) {
    const a = resolveAsset(p, doc.grid.from);
    const b = readJsonIf<any>(path.join(P.analysis(p.root, a.id), "beats.json"), null);
    if (!b) throw new VosError("missing_analysis", `grid.from: no beat analysis for "${a.alias}"`, `run \`vos beats ${a.alias}\``);
    grid = { bpm: b.bpm, offset: b.offset };
  } else grid = doc.grid as Grid | undefined;
  const ctx: TimeContext = { fps, grid };
  const warnings: string[] = [];
  const pos = (v: TimeValue, where: string) => {
    try {
      return toFrame(parseTime(v, ctx, "position"), fps);
    } catch (e: any) {
      throw new VosError(e.code ?? "bad_time", `${where}: ${e.message}`, e.hint);
    }
  };
  const len = (v: TimeValue, where: string) => {
    try {
      return toFrame(parseTime(v, ctx, "length"), fps);
    } catch (e: any) {
      throw new VosError(e.code ?? "bad_time", `${where}: ${e.message}`, e.hint);
    }
  };

  const total = len(doc.duration, "duration");
  need(total > 0, "duration", "must be > 0");
  need(Array.isArray(doc.tracks), "tracks", "must be an array");

  const ids = new Set<string>();
  const out: Resolved = { name: doc.name, canvas, frames: total, grid, tracks: [], media: [], graphics: [], markers: [], warnings };

  doc.tracks.forEach((t, ti) => {
    const tw = `tracks[${ti}](${t.id})`;
    need(t.id && typeof t.id === "string", `tracks[${ti}]`, 'needs a string "id"');
    need(["video", "audio", "graphics"].includes(t.kind), tw, 'kind must be "video" | "audio" | "graphics"');
    out.tracks.push({ id: t.id, kind: t.kind, index: ti, mute: !!t.mute, role: t.role === "overlay" ? "overlay" : "content" });
    (t.clips ?? []).forEach((c: any, ci: number) => {
      const w = `${tw}.clips[${ci}]${c?.id ? `(${c.id})` : ""}`;
      need(c && typeof c.id === "string" && c.id, w, 'needs a unique string "id"');
      need(!ids.has(c.id), w, `duplicate clip id "${c.id}"`);
      ids.add(c.id);
      const start = pos(c.at, `${w}.at`);
      const frames = len(c.dur, `${w}.dur`);
      need(frames > 0, `${w}.dur`, "must be > 0 frames after rounding");
      if (start + frames > total) warnings.push(`${w} ends at frame ${start + frames} after timeline end ${total}; it will be cut`);
      if (t.kind === "graphics") {
        need(typeof c.src === "string", w, 'graphics clip needs "src"');
        const absSrc = path.resolve(p.root, c.src);
        need(fs.existsSync(absSrc), `${w}.src`, `${c.src} does not exist`);
        out.graphics.push({ kind: "graphics", id: c.id, track: t.id, trackIndex: ti, src: c.src, absSrc, start, frames: Math.min(frames, total - start), props: c.props ?? {}, label: c.label });
        return;
      }
      need(typeof c.asset === "string", w, 'needs "asset" (alias or content id)');
      let asset: ResolvedAsset;
      try {
        asset = resolveAsset(p, c.asset);
      } catch (e: any) {
        throw new VosError(e.code, `${w}.asset: ${e.message}`, e.hint);
      }
      const srcIn = c.in === undefined ? 0 : parseTime(c.in, ctx, "length");
      need(srcIn >= 0, `${w}.in`, "must be >= 0");
      if (t.kind === "audio") need(asset.kind !== "image", w, `asset "${asset.alias}" is an image; audio tracks need audio or video assets`);
      if (asset.kind !== "image" && asset.duration != null) {
        const needEnd = srcIn + framesToSeconds(frames, fps);
        need(
          needEnd <= asset.duration + 0.5 / fps,
          w,
          `needs source ${srcIn.toFixed(3)}–${needEnd.toFixed(3)}s but "${asset.alias}" is ${asset.duration.toFixed(3)}s long`,
          `shorten dur or move "in" back by ${(needEnd - asset.duration).toFixed(3)}s`,
        );
      }
      let slot: RMedia["slot"];
      if (c.slot) {
        need(t.kind === "video", w, "slot is only valid on video tracks");
        const [clip, name] = String(c.slot).split("/");
        need(clip && name, `${w}.slot`, 'must be "<graphicsClipId>/<slotName>"');
        slot = { clip, name };
      }
      const kind = t.kind === "audio" ? "audio" : asset.kind === "image" ? "image" : "video";
      if (kind === "video" && asset.fps && cadenceMismatch(asset.fps, fps)) {
        warnings.push(`${w}: "${asset.alias}" is ${round2(asset.fps)} fps on a ${fps} fps canvas — uneven frame repeats (judder); generated footage is 24 fps, so a 24 fps canvas ("canvas": {"fps": 24}) plays it cleanly`);
      }
      const gain_db = typeof c.gain_db === "number" ? c.gain_db : 0;
      const gain = Math.min(1, 10 ** (gain_db / 20));
      if (gain_db > 0) warnings.push(`${w}: gain_db ${gain_db} > 0 is clamped to 0 dB (browser volume max is 1)`);
      out.media.push({
        kind,
        id: c.id,
        track: t.id,
        trackIndex: ti,
        asset,
        start,
        frames: Math.min(frames, total - start),
        srcIn,
        slot,
        fit: c.fit ?? "cover",
        fx: c.fx ?? {},
        fade: { in: c.fade?.in ?? 0, out: c.fade?.out ?? 0 },
        gain,
        withAudio: t.kind === "audio" || !!c.audio,
        label: c.label,
      });
    });
  });

  // slot targets must exist and contain the clip in time
  for (const m of out.media) {
    if (!m.slot) continue;
    const g = out.graphics.find((x) => x.id === m.slot!.clip);
    need(g, `clip ${m.id}.slot`, `graphics clip "${m.slot.clip}" not found`);
    need(m.start >= g.start && m.start + m.frames <= g.start + g.frames, `clip ${m.id}.slot`, `clip time ${m.start}–${m.start + m.frames}f must lie inside graphics clip "${g.id}" ${g.start}–${g.start + g.frames}f`);
    const html = fs.readFileSync(g.absSrc, "utf8");
    need(new RegExp(`data-slot=["']${m.slot.name}["']`).test(html), `clip ${m.id}.slot`, `${g.src} has no element with data-slot="${m.slot.name}"`);
  }

  for (const [i, mk] of (doc.markers ?? []).entries()) {
    out.markers.push({ frame: pos(mk.at, `markers[${i}].at`), frames: mk.dur === undefined ? 0 : len(mk.dur, `markers[${i}].dur`), label: mk.label, kind: mk.kind ?? "note" });
  }
  return out;
}

/**
 * Cut points (frames): where a new full-frame picture or content graphic begins.
 * Clip ends are padding more often than cuts, and overlay tracks are not cuts.
 */
export function cutPoints(r: Resolved): number[] {
  const overlay = new Set(r.tracks.filter((t) => t.role === "overlay").map((t) => t.id));
  const s = new Set<number>();
  for (const m of r.media) if (m.kind !== "audio" && !m.slot && !overlay.has(m.track)) s.add(m.start);
  for (const g of r.graphics) if (!overlay.has(g.track)) s.add(g.start);
  return [...s].filter((f) => f > 0 && f < r.frames).sort((a, b) => a - b);
}

/** A source plays without judder only if the canvas shows each source frame a whole number of times (or skips evenly). */
export function cadenceMismatch(srcFps: number, canvasFps: number): boolean {
  const r = canvasFps / srcFps;
  const near = (x: number) => Math.abs(x - Math.round(x)) < 0.01;
  return !(near(r) || near(1 / r));
}

const round2 = (x: number) => Math.round(x * 100) / 100;
