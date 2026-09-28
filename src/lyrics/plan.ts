import * as fs from "node:fs";
import * as path from "node:path";
import { bindProps } from "../compile/hyperframes.ts";
import type { Project } from "../core/project.ts";
import { framesToSeconds } from "../core/time.ts";
import { loadTimeline, resolveTimeline, timelinePath } from "../core/timeline.ts";
import { VosError } from "../core/util.ts";
import { loadLyricMotion } from "./engine.ts";

/**
 * `vos lyrics plan` — the cut plan of every lyric-motion clip in the timeline, without rendering: which lyric is on
 * screen when (timeline seconds), with which layout / motion / treatment / background / camera / transition, where
 * the キメ are, plus the markers the screen effects need (flashes, black frames) so `vos inspect` knows they are meant.
 */

const FLASHY = new Set(["flash", "invert", "bloomFlash", "bandInvert", "mirrorFlash", "strobe", "whiteFrame", "negativeRing", "snapshot", "filmBurn", "hrSubliminal"]);
const BLACK = new Set(["blackFrame", "crtOff", "hrSignalLoss"]);
export const MARKER_TAG = "lyric-motion";

export interface LyricPlanCut {
  index: number; line: number; text: string; t0: number; t1: number;
  layout: string; enter: string; hold: string; exit: string; treat: string; bg: string; cam: string;
  trans?: string; morph?: boolean; kime?: boolean; recap?: boolean; locked?: boolean; decor: string[];
}
export interface LyricPlan {
  clip: string; src: string; start: number; style: string; seed: number;
  cuts: LyricPlanCut[];
  markers: { at: number; dur: number; label: string; kind: string }[];
  lines: { index: number; text: string; t0: number; t1: number; cuts: number }[];
  warnings: string[];
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;

export function isLyricMotion(src: string): boolean {
  return /lyric-motion[^/]*\.html$/.test(src);
}

export function lyricPlans(p: Project, o: { timeline?: string; clip?: string } = {}): LyricPlan[] {
  const doc = loadTimeline(timelinePath(p, o.timeline));
  const r = resolveTimeline(p, doc);
  const fps = r.canvas.fps;
  const clips = r.graphics.filter((g) => isLyricMotion(g.src) && (!o.clip || g.id === o.clip));
  if (!clips.length) throw new VosError("no_lyric_clip", o.clip ? `no lyric-motion clip "${o.clip}" in the timeline` : "no lyric-motion graphics clip in the timeline", "add a graphics clip with src graphics/lyric-motion.html (copy it from examples/graphics/)");
  const duration = framesToSeconds(r.frames, fps);
  return clips.map((g) => {
    const props = bindProps(p, g.props, { timeline: { path: "", sha256: "" }, graphics: {}, design: {}, assets: {} }, `clip ${g.id}.props`);
    const m = loadLyricMotion(g.absSrc, props, { width: r.canvas.width, height: r.canvas.height, fps, duration, grid: r.grid ?? null, clipDur: framesToSeconds(g.frames, fps), clipStart: framesToSeconds(g.start, fps) });
    const start = framesToSeconds(g.start, fps), off = start + (Number(props.offset) || 0);
    const plan = m.plan;
    // ロック: a locked line replays its stored cuts while its text still splits the same way (see lock.ts)
    const overrides = m.project.overrides || {};
    const lockHeld = new Map<number, boolean>();
    for (const [k, ov] of Object.entries<any>(overrides)) {
      if (!ov || !ov.lock || !Array.isArray(ov.lockedCuts)) continue;
      const mine = plan.cuts.filter((c: any) => c.line === Number(k) && c.utext != null);
      lockHeld.set(Number(k), mine.length === ov.lockedCuts.length && mine.every((c: any, i: number) => c.utext === ov.lockedCuts[i].utext && c.layout === ov.lockedCuts[i].layout));
    }
    const cuts: LyricPlanCut[] = plan.cuts.filter((c: any) => c.layout !== "title").map((c: any) => ({
      index: c.index, line: c.line, text: c.text, t0: r3(off + c.start), t1: r3(off + c.end),
      layout: c.layout, enter: c.enter, hold: c.hold, exit: c.exit, treat: c.treat, bg: c.bg, cam: c.cam,
      ...(c.trans ? { trans: c.trans } : {}), ...(c.morph ? { morph: true } : {}), ...(c.kime ? { kime: true } : {}), ...(c.recap ? { recap: true } : {}), ...(lockHeld.get(c.line) ? { locked: true } : {}),
      decor: (c.decor || []).map((d: any) => d.id),
    }));
    const markers: LyricPlan["markers"] = [];
    for (const e of plan.events || []) {
      const kind = FLASHY.has(e.type) ? "expect-flash" : BLACK.has(e.type) ? "expect-black" : null;
      if (!kind) continue;
      const at = r3(off + e.t - 0.05), dur = r3(Math.max(0.2, (e.dur || 0.1) + 0.15));
      const prev = markers[markers.length - 1];
      if (prev && prev.kind === kind && at <= prev.at + prev.dur) { prev.dur = r3(Math.max(prev.dur, at + dur - prev.at)); continue; }
      markers.push({ at, dur, kind, label: `${MARKER_TAG}: ${e.type}` });
    }
    const lines = (plan.lines || []).filter((l: any) => !l.interlude).map((l: any) => ({
      index: l.index, text: l.text, t0: r3(off + l.start), t1: r3(off + (l.visEnd ?? l.end)), cuts: cuts.filter((c) => c.line === l.index).length,
    }));
    const warnings = [...new Set(m.warnings)];
    for (const [li, held] of lockHeld) if (!held) warnings.push(`line L${li} is locked but no longer splits into the cuts it was locked with (its text or timing changed): it is replanned — run \`vos lyrics lock --lines ${li}\` to keep the new look`);
    const end = off + plan.duration;
    if (end > start + framesToSeconds(g.frames, fps) + 0.05) warnings.push(`the lyrics run to ${r3(end)} s but the clip ends at ${r3(start + framesToSeconds(g.frames, fps))} s`);
    return { clip: g.id, src: g.src, start, style: m.project.style, seed: m.project.seed, cuts, markers, lines, warnings };
  });
}

/** replace this tool's markers (label "lyric-motion: …") in the timeline file with fresh ones; other markers stay */
export function writeMarkers(p: Project, plans: LyricPlan[], timeline?: string): { file: string; count: number } {
  const file = timelinePath(p, timeline);
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  const keep = (doc.markers || []).filter((m: any) => !String(m.label || "").startsWith(MARKER_TAG + ":"));
  const add = plans.flatMap((pl) => pl.markers);
  doc.markers = [...keep, ...add].sort((a: any, b: any) => (typeof a.at === "number" && typeof b.at === "number" ? a.at - b.at : 0));
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
  return { file: path.relative(p.root, file), count: add.length };
}
