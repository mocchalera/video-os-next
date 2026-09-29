import * as fs from "node:fs";
import * as path from "node:path";
import { contentId } from "./hash.ts";
import { probe, type AssetKind } from "./media.ts";
import { readJson, readJsonIf, slug, VosError, writeJson } from "./util.ts";

export interface ProjectFile {
  format: "vos.project/1";
  name: string;
  canvas: { width: number; height: number; fps: number; background?: string };
  timeline?: string; // default "timeline.json"
}

/** Portable asset record (committed). No absolute paths here. */
export interface AssetRecord {
  id: string; // content id
  kind: AssetKind;
  filename: string;
  duration: number | null;
  width?: number;
  height?: number;
  fps?: number;
  has_audio: boolean;
  size: number;
  note?: string;
  replaced?: string[]; // earlier content ids this alias pointed to (newest last)
}

export interface AssetsFile {
  format: "vos.assets/1";
  assets: Record<string, AssetRecord>; // alias -> record
}

export interface Project {
  root: string;
  file: ProjectFile;
  assets: AssetsFile;
  paths: Record<string, string>; // id -> absolute path (machine-local)
}

export const P = {
  project: (root: string) => path.join(root, "vos.project.json"),
  assets: (root: string) => path.join(root, "assets.json"),
  local: (root: string) => path.join(root, ".vos"),
  paths: (root: string) => path.join(root, ".vos", "paths.json"),
  analysis: (root: string, id: string) => path.join(root, ".vos", "analysis", id),
  build: (root: string, name: string) => path.join(root, ".vos", "build", name),
  cache: (root: string) => path.join(root, ".vos", "cache"),
  out: (root: string) => path.join(root, "out"),
};

export function findProjectRoot(start = process.cwd()): string {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(P.project(dir))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new VosError("no_project", `no vos.project.json found from ${start}`, "run `vos init` or pass --project <dir>");
    dir = parent;
  }
}

export function loadProject(root?: string): Project {
  const r = root ? path.resolve(root) : findProjectRoot();
  const file = readJson<ProjectFile>(P.project(r));
  if (file.format !== "vos.project/1") throw new VosError("bad_project", `${P.project(r)}: format must be vos.project/1`);
  const assets = readJsonIf<AssetsFile>(P.assets(r), { format: "vos.assets/1", assets: {} });
  const paths = readJsonIf<Record<string, string>>(P.paths(r), {});
  return { root: r, file, assets, paths };
}

export function initProject(root: string, name: string, canvas = { width: 1920, height: 1080, fps: 30 }): Project {
  fs.mkdirSync(root, { recursive: true });
  if (fs.existsSync(P.project(root))) throw new VosError("exists", `${P.project(root)} already exists`);
  const file: ProjectFile = { format: "vos.project/1", name, canvas, timeline: "timeline.json" };
  writeJson(P.project(root), file);
  writeJson(P.assets(root), { format: "vos.assets/1", assets: {} });
  fs.mkdirSync(path.join(root, "graphics"), { recursive: true });
  fs.mkdirSync(path.join(root, "design"), { recursive: true });
  fs.writeFileSync(path.join(root, ".gitignore"), ".vos/\nout/\n");
  if (!fs.existsSync(path.join(root, "brief.md"))) {
    fs.writeFileSync(path.join(root, "brief.md"), `# ${name}\n\n## Intent\n\n## Audience\n\n## Must have\n\n## Must avoid\n`);
  }
  return loadProject(root);
}

export function saveAssets(p: Project): void {
  writeJson(P.assets(p.root), p.assets);
  writeJson(P.paths(p.root), p.paths);
}

export interface IngestResult {
  alias: string;
  id: string;
  status: "added" | "relinked" | "unchanged" | "replaced";
  duplicate_of?: string; // another alias with identical content
}

export function ingest(p: Project, file: string, alias?: string, note?: string, replace = false): IngestResult {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) throw new VosError("missing_file", `${abs} does not exist`);
  const id = contentId(abs);
  // A file rewritten in place (a regenerated stem, a re-exported still): --replace without --as rebinds the alias
  // that already points at this path, instead of adding a second alias beside it.
  if (replace && !alias) alias = Object.entries(p.assets.assets).find(([, a]) => p.paths[a.id] === abs)?.[0];
  const existingAlias = Object.entries(p.assets.assets).find(([, a]) => a.id === id)?.[0];
  if (existingAlias && (!alias || alias === existingAlias)) {
    const status = p.paths[id] === abs ? "unchanged" : "relinked";
    p.paths[id] = abs;
    return { alias: existingAlias, id, status };
  }
  let name = alias ?? slug(path.basename(abs));
  if (!alias) {
    let i = 2;
    const base = name;
    while (p.assets.assets[name] && p.assets.assets[name].id !== id) name = `${base}_${i++}`;
  } else if (p.assets.assets[name] && p.assets.assets[name].id !== id && !replace) {
    throw new VosError("alias_taken", `alias "${name}" already points to ${p.assets.assets[name].id}`, "pass --replace to rebind the alias to the new content (renders using the old content become stale)");
  }
  const prev = p.assets.assets[name];
  const pr = probe(abs);
  p.assets.assets[name] = {
    id,
    kind: pr.kind,
    filename: path.basename(abs),
    duration: pr.duration,
    width: pr.width,
    height: pr.height,
    fps: pr.fps,
    has_audio: pr.has_audio,
    size: fs.statSync(abs).size,
    ...(note ?? prev?.note ? { note: note ?? prev?.note } : {}),
    ...(prev && prev.id !== id ? { replaced: [...(prev.replaced ?? []), prev.id] } : {}),
  };
  p.paths[id] = abs;
  return { alias: name, id, status: prev && prev.id !== id ? "replaced" : "added", ...(existingAlias ? { duplicate_of: existingAlias } : {}) };
}

export interface ResolvedAsset extends AssetRecord {
  alias: string;
  path: string | null; // null = offline / unknown on this machine
}

export function resolveAsset(p: Project, ref: string): ResolvedAsset {
  let alias = ref;
  let rec = p.assets.assets[ref];
  if (!rec) {
    const hit = Object.entries(p.assets.assets).find(([, a]) => a.id === ref);
    if (hit) [alias, rec] = hit;
  }
  if (!rec) {
    const known = Object.keys(p.assets.assets).slice(0, 12).join(", ");
    throw new VosError("unknown_asset", `unknown asset "${ref}"`, `known aliases: ${known}${Object.keys(p.assets.assets).length > 12 ? ", …" : ""}`);
  }
  const pth = p.paths[rec.id];
  return { ...rec, alias, path: pth && fs.existsSync(pth) ? pth : null };
}

export function requireOnline(a: ResolvedAsset): string {
  if (!a.path) throw new VosError("asset_offline", `asset "${a.alias}" (${a.filename}) is not available on this machine`, "re-run `vos ingest <file> --as " + a.alias + "`");
  return a.path;
}
