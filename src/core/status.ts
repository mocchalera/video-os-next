import * as fs from "node:fs";
import * as path from "node:path";
import { analysisCoverage } from "../analyze/marlin.ts";
import { CHANNELS, modelPresent } from "../analyze/embed.ts";
import { latestRender } from "../render/render.ts";
import { sha256File } from "./hash.ts";
import { P, type Project } from "./project.ts";
import { framesToSeconds } from "./time.ts";
import { loadTimeline, resolveTimeline, timelinePath } from "./timeline.ts";
import { readJson } from "./util.ts";

export interface Status {
  project: { name: string; root: string; canvas: Project["file"]["canvas"] };
  assets: { total: number; by_kind: Record<string, number>; offline: string[]; described: number; undescribed_video: string[] };
  search: Record<string, { model: boolean; indexed: number }>;
  timeline: { path: string; ok: boolean; error?: string; hint?: string; duration?: number; clips?: number; graphics?: number; warnings?: string[]; unused_assets?: string[] };
  render: { latest: string | null; stale: boolean | null; inspected: boolean };
  attention: string[]; // the things an editor should know right now
}

export function status(p: Project): Status {
  const assets = Object.entries(p.assets.assets);
  const by_kind: Record<string, number> = {};
  const offline: string[] = [];
  for (const [alias, a] of assets) {
    by_kind[a.kind] = (by_kind[a.kind] ?? 0) + 1;
    const pth = p.paths[a.id];
    if (!pth || !fs.existsSync(pth)) offline.push(alias);
  }
  const cov = analysisCoverage(p);
  const undescribed = assets.filter(([alias, a]) => a.kind === "video" && !cov[alias].describe).map(([alias]) => alias);
  const tlPath = timelinePath(p);
  const st: Status = {
    project: { name: p.file.name, root: p.root, canvas: p.file.canvas },
    assets: { total: assets.length, by_kind, offline, described: Object.values(cov).filter((c) => c.describe).length, undescribed_video: undescribed },
    search: Object.fromEntries(CHANNELS.map((ch) => [ch, { model: modelPresent(ch), indexed: assets.filter(([, a]) => fs.existsSync(path.join(P.analysis(p.root, a.id), `embed.${ch}.json`))).length }])),
    timeline: { path: path.relative(p.root, tlPath), ok: false },
    render: { latest: null, stale: null, inspected: false },
    attention: [],
  };
  const byId = new Map<string, string[]>();
  for (const [alias, a] of assets) byId.set(a.id, [...(byId.get(a.id) ?? []), alias]);
  for (const group of byId.values()) if (group.length > 1) st.attention.push(`identical content under different aliases: ${group.join(" = ")}`);
  for (const [ch, v] of Object.entries(st.search)) if (!v.model) st.attention.push(`search: ${ch} model missing — \`vos models pull ${ch}\``);
  if (offline.length) st.attention.push(`${offline.length} asset(s) offline on this machine: ${offline.slice(0, 6).join(", ")}${offline.length > 6 ? ", …" : ""}`);
  if (fs.existsSync(tlPath)) {
    try {
      const r = resolveTimeline(p, loadTimeline(tlPath));
      const used = new Set(r.media.map((m) => m.asset.alias));
      for (const g of r.graphics) {
        const html = fs.readFileSync(g.absSrc, "utf8");
        for (const m of html.matchAll(/vos:\/\/asset\/([^"'@)\s]+)/g)) used.add(m[1]);
      }
      st.timeline = {
        ...st.timeline,
        ok: true,
        duration: framesToSeconds(r.frames, r.canvas.fps),
        clips: r.media.length,
        graphics: r.graphics.length,
        warnings: r.warnings,
        unused_assets: assets.map(([a]) => a).filter((a) => !used.has(a)),
      };
      if (r.warnings.length) st.attention.push(`${r.warnings.length} timeline warning(s), e.g. ${r.warnings[0]}`);
    } catch (e: any) {
      st.timeline = { ...st.timeline, ok: false, error: e.message, hint: e.hint };
      st.attention.push(`timeline does not resolve: ${e.message}`);
    }
  } else {
    st.attention.push("no timeline.json yet");
  }
  const latest = latestRender(p);
  if (latest) {
    const rc = readJson(latest.replace(/\.mp4$/, ".receipt.json"));
    const changed = Object.entries(rc.inputs?.assets ?? {}).filter(([alias, a]: [string, any]) => p.assets.assets[alias] && p.assets.assets[alias].id !== a.id).map(([alias]) => alias);
    if (changed.length) st.attention.push(`latest render used old content for: ${changed.join(", ")}`);
    const stale = (fs.existsSync(tlPath) ? rc.timeline.sha256 !== sha256File(tlPath) : false) || changed.length > 0;
    st.render = { latest: path.relative(p.root, latest), stale, inspected: fs.existsSync(latest.replace(/\.mp4$/, ".inspect.json")) };
    if (stale) st.attention.push("latest render is stale — re-render before judging it");
    else if (!st.render.inspected) st.attention.push("latest render has not been inspected");
  }
  return st;
}

export { P };
