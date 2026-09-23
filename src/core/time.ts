import { VosError } from "./util.ts";

/**
 * Time values in the edit document:
 *   number        seconds
 *   "12.5s"       seconds
 *   "360f"        frames at the timeline fps
 *   "16b"         beats on the grid. As a position: grid.offset + 16 * spb. As a length: 16 * spb.
 *   "16b+2f"      sums are allowed ("+" or "-" between terms)
 */
export type TimeValue = number | string;

export interface Grid {
  bpm: number;
  offset: number; // seconds of beat 0
}

export interface TimeContext {
  fps: number;
  grid?: Grid;
}

const TERM = /^([+-]?\d+(?:\.\d+)?)(s|f|b)?$/;

export function parseTime(value: TimeValue, ctx: TimeContext, kind: "position" | "length"): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new VosError("bad_time", `non-finite time ${value}`);
    return value;
  }
  const src = String(value).replace(/\s+/g, "");
  if (!src) throw new VosError("bad_time", "empty time value");
  const terms = src.match(/[+-]?[^+-]+/g) ?? [];
  let total = 0;
  let usedBeatPosition = false;
  for (const raw of terms) {
    const m = TERM.exec(raw);
    if (!m) throw new VosError("bad_time", `cannot parse time "${value}"`, 'use 12.5, "12.5s", "360f" or "16b"');
    const n = Number(m[1]);
    const unit = m[2] ?? "s";
    if (unit === "s") total += n;
    else if (unit === "f") total += n / ctx.fps;
    else {
      if (!ctx.grid) throw new VosError("no_grid", `beat time "${value}" used but timeline has no grid`, 'add "grid": {"bpm":120,"offset":0}');
      const spb = 60 / ctx.grid.bpm;
      total += n * spb;
      if (kind === "position" && !usedBeatPosition) {
        total += ctx.grid.offset;
        usedBeatPosition = true;
      }
    }
  }
  return total;
}

/** Deterministic rounding to frames (round half up, with epsilon for float noise). */
export function toFrame(seconds: number, fps: number): number {
  return Math.floor(seconds * fps + 0.5 + 1e-9);
}

export function framesToSeconds(frames: number, fps: number): number {
  return Math.round((frames / fps) * 1e6) / 1e6;
}

export function formatTc(seconds: number, fps: number): string {
  const f = toFrame(seconds, fps);
  const ff = f % fps;
  const s = Math.floor(f / fps);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}:${pad(ff)}`;
}
