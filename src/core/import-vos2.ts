import * as fs from "node:fs";
import * as path from "node:path";
import { describePath, type DescribeRecord } from "../analyze/marlin.ts";
import { contentId } from "./hash.ts";
import type { Project } from "./project.ts";
import { readJson, writeJson } from "./util.ts";

/**
 * Attach Marlin analysis produced by video-os-v2 (03_analysis/marlin_events.json) to assets
 * already ingested here. Matching is by content id of the source file, never by name.
 */
export function importVos2Analysis(p: Project, vos2ProjectDir: string): { imported: string[]; skipped: { source: string; reason: string }[] } {
  const f = path.join(vos2ProjectDir, "03_analysis", "marlin_events.json");
  if (!fs.existsSync(f)) return { imported: [], skipped: [{ source: f, reason: "no marlin_events.json" }] };
  const j = readJson(f);
  const byId = new Map(Object.entries(p.assets.assets).map(([alias, a]) => [a.id, alias]));
  const imported: string[] = [];
  const skipped: { source: string; reason: string }[] = [];
  for (const it of j.items ?? []) {
    const src = it.source_path;
    if (!src || !fs.existsSync(src)) {
      skipped.push({ source: src, reason: "source file not reachable" });
      continue;
    }
    const id = contentId(src);
    const alias = byId.get(id);
    if (!alias) {
      skipped.push({ source: src, reason: "source not ingested in this project (vos ingest it first)" });
      continue;
    }
    const rec: DescribeRecord = {
      format: "vos.describe/1",
      asset: id,
      scene: String(it.scene ?? ""),
      events: (it.events ?? []).map((e: any) => ({ start: e.start_us / 1e6, end: e.end_us / 1e6, description: String(e.description) })),
      finds: (it.find_results ?? []).filter((x: any) => x.format_ok !== false).map((x: any) => ({ query: x.query, start: x.span_start_us / 1e6, end: x.span_end_us / 1e6 })),
      provenance: { producer: "import:video-os-v2", model: j.model?.model_alias ?? "unknown", at: j.created_at ?? "unknown", note: path.relative(process.cwd(), f) },
    };
    writeJson(describePath(p, id), rec);
    imported.push(alias);
  }
  return { imported, skipped };
}
