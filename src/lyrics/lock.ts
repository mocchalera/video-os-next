import * as fs from "node:fs";
import * as path from "node:path";
import { bindProps } from "../compile/hyperframes.ts";
import type { Project } from "../core/project.ts";
import { framesToSeconds } from "../core/time.ts";
import { loadTimeline, resolveTimeline, timelinePath } from "../core/timeline.ts";
import { VosError } from "../core/util.ts";
import { loadLyricMotion } from "./engine.ts";
import { isLyricMotion } from "./plan.ts";

/**
 * `vos lyrics lock` / `unlock` — keep what a line shows while other lines change.
 *
 * JIZURA plans every line from its own seed, but also from what the lines before it used (so layouts and motions do
 * not repeat) and from the part's palette (統一感). Directing one line, changing `enabled` or a text therefore moves
 * the lines after it. A lock stores the line's cuts exactly as planned now (JIZURA's own ロック: J.lineSnapshot —
 * layouts, params, motion, decor, colours, joins, accents) into the lyric data file, and the planner replays them.
 * A lock applies while the line's text still splits into the same cuts; `vos lyrics plan` says when one no longer does.
 */

export interface LockReport {
  clip: string;
  file: string;
  locked: { line: number; text: string; cuts: number }[];
  unlocked: { line: number; text: string }[];
  skipped: { line: number; why: string }[];
}

/** "0,2-5" → [0, 2, 3, 4, 5]; "all" / undefined → null (every line) */
export function parseLineSpec(spec: unknown): number[] | null {
  if (spec == null || spec === true || spec === "all") return null;
  const out = new Set<number>();
  for (const part of String(spec).split(",").map((x) => x.trim()).filter(Boolean)) {
    const m = part.match(/^L?(\d+)(?:\s*-\s*L?(\d+))?$/i);
    if (!m) throw new VosError("usage", `bad line list "${spec}"`, 'use plan line numbers: "3", "0,2-5", "L4" or "all"');
    const a = Number(m[1]), b = m[2] != null ? Number(m[2]) : a;
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) out.add(i);
  }
  return [...out].sort((x, y) => x - y);
}

export function lockLyrics(p: Project, o: { timeline?: string; clip?: string; lines?: unknown; except?: unknown; unlock?: boolean }): LockReport {
  const doc = loadTimeline(timelinePath(p, o.timeline));
  const r = resolveTimeline(p, doc);
  const fps = r.canvas.fps;
  let clips = r.graphics.filter((g) => isLyricMotion(g.src) && (!o.clip || g.id === o.clip));
  if (!clips.length) throw new VosError("no_lyric_clip", o.clip ? `no lyric-motion clip "${o.clip}" in the timeline` : "no lyric-motion graphics clip in the timeline");
  if (clips.length > 1) throw new VosError("usage", `${clips.length} lyric-motion clips (${clips.map((g) => g.id).join(", ")}): say which one`, "vos lyrics lock --clip <id>");
  const g = clips[0];
  const raw = (g.props || {}).lyrics as any;
  if (!raw || typeof raw !== "object" || typeof raw.$data !== "string")
    throw new VosError("lock_needs_data", `clip ${g.id}: the lyrics are not a data file`, 'locks are stored per line in the lyric data: use "lyrics": {"$data": "data/lyrics.json"} (an array of { at, text, … })');
  const file = path.resolve(p.root, raw.$data);
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const items: any[] = Array.isArray(data) ? data : Array.isArray(data?.lines) ? data.lines : null as any;
  if (!items) throw new VosError("lock_needs_data", `${raw.$data}: not an array of lines`, "locks need the array form: [{ \"at\": 1.2, \"text\": \"…\" }, …] (or { \"lines\": [...] })");

  const props = bindProps(p, g.props, { timeline: { path: "", sha256: "" }, graphics: {}, design: {}, assets: {} }, `clip ${g.id}.props`);
  const duration = framesToSeconds(r.frames, fps);
  const m = loadLyricMotion(g.absSrc, props, { width: r.canvas.width, height: r.canvas.height, fps, duration, grid: r.grid ?? null, clipDur: framesToSeconds(g.frames, fps), clipStart: framesToSeconds(g.start, fps) });
  const plan = m.plan, J = m.J, lineItem = m.LY.lineItem;
  const lyricLines = (plan.lines || []).filter((l: any) => !l.interlude).map((l: any) => l.index as number);
  const want = parseLineSpec(o.lines) ?? lyricLines;
  const except = new Set(parseLineSpec(o.except) ?? []);
  const rep: LockReport = { clip: g.id, file: path.relative(p.root, file), locked: [], unlocked: [], skipped: [] };
  // 統一感: a returning line (same words) is drawn from its first occurrence — lock them together, or the repeat of
  // a locked line would be planned afresh (and look different from before)
  const norm = (t: string) => String(t || "").replace(/\s+/g, "");
  const sel = new Set(want.filter((li) => !except.has(li)));
  if (!o.unlock) for (const li of [...sel]) for (const l2 of lyricLines) if (!except.has(l2) && plan.lines[l2] && norm(plan.lines[l2].text) === norm(plan.lines[li]?.text)) sel.add(l2);
  for (const li of [...sel].sort((x, y) => x - y)) {
    const ln = plan.lines[li];
    const idx = lineItem[li];
    if (!ln || ln.interlude || idx == null || idx < 0 || !items[idx]) { rep.skipped.push({ line: li, why: ln?.interlude ? "an instrumental break, not a line" : "no such line in the plan" }); continue; }
    const item = items[idx];
    if (o.unlock) {
      if (item.lock || item.lockedCuts) { delete item.lock; delete item.lockedSeed; delete item.lockedCuts; rep.unlocked.push({ line: li, text: ln.text }); }
      continue;
    }
    const snap = J.lineSnapshot(plan, li);
    if (!snap) { rep.skipped.push({ line: li, why: "the line has no cuts" }); continue; }
    // JIZURA's snapshot leaves out the glyph stagger (a per-cut random pick): keep it too, the adapter restores it
    const mine = plan.cuts.filter((c: any) => c.line === li && c.utext != null);
    snap.forEach((s2: any, i: number) => { if (mine[i] && mine[i].stagger != null) s2.stagger = mine[i].stagger; });
    item.lock = true;
    item.lockedSeed = ln.seed;
    item.lockedCuts = snap;
    rep.locked.push({ line: li, text: ln.text, cuts: snap.length });
  }
  // one line per item, like `vos lyrics time` writes it (the locks make lines long; keep them diffable)
  const body = "[\n" + items.map((it) => "  " + JSON.stringify(it)).join(",\n") + "\n]\n";
  fs.writeFileSync(file, Array.isArray(data) ? body : JSON.stringify({ ...data, lines: items }, null, 1) + "\n");
  return rep;
}
