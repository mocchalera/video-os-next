import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig, saveConfig } from "../core/config.ts";
import { contentId } from "../core/hash.ts";
import { readJson, VosError, writeJson } from "../core/util.ts";

/**
 * Shared library of generated clips: a plain folder, typically inside Google Drive for desktop
 * (e.g. ~/Library/CloudStorage/GoogleDrive-<you>/マイドライブ/vos-ai/library), so every machine, project and agent
 * sees the same takes.
 *
 * Layout: <lib>/<request-id>.mp4 + <request-id>.gen.json. No central index — concurrent writers from several
 * agents/machines would fight over it through Drive sync. The sidecar is written last and records the media's
 * byte size and content id, so a half-synced mp4 is never mistaken for a take.
 * The library path is machine-local config (never committed): VOS_GEN_LIBRARY or config `gen_library`.
 */

export function libraryDir(): string | null {
  const d = process.env.VOS_GEN_LIBRARY ?? loadConfig().gen_library;
  return d ? path.resolve(d) : null;
}

export function initLibrary(dir: string): string {
  const abs = path.resolve(dir);
  fs.mkdirSync(abs, { recursive: true });
  const c = loadConfig();
  c.gen_library = abs;
  saveConfig(c);
  return abs;
}

const entryPaths = (lib: string, id: string) => ({ media: path.join(lib, `${id}.mp4`), sidecar: path.join(lib, `${id}.gen.json`) });

/** Copy a finished take into the library (atomic per file; sidecar last). Idempotent. */
export function publish(id: string, media: string, sidecar: string): string | null {
  const lib = libraryDir();
  if (!lib) return null;
  fs.mkdirSync(lib, { recursive: true });
  const dst = entryPaths(lib, id);
  if (!verified(dst.media, dst.sidecar)) {
    const tmp = `${dst.media}.partial-${process.pid}`;
    fs.copyFileSync(media, tmp);
    fs.renameSync(tmp, dst.media);
    const tmpS = `${dst.sidecar}.partial-${process.pid}`;
    fs.copyFileSync(sidecar, tmpS);
    fs.renameSync(tmpS, dst.sidecar);
  }
  return dst.media;
}

/** Media is usable only if it matches what its sidecar recorded (guards against partial Drive sync). */
function verified(media: string, sidecar: string): boolean {
  if (!fs.existsSync(media) || !fs.existsSync(sidecar)) return false;
  try {
    const g = readJson(sidecar);
    const f = g.file;
    if (!f) return false;
    return fs.statSync(media).size === f.bytes && contentId(media) === f.content_id;
  } catch {
    return false;
  }
}

/** If the library already has this request, copy it to `dest` (and its sidecar) and return true. */
export function fetchFromLibrary(id: string, destMedia: string, destSidecar: string): boolean {
  const lib = libraryDir();
  if (!lib) return false;
  const src = entryPaths(lib, id);
  if (!verified(src.media, src.sidecar)) return false;
  fs.mkdirSync(path.dirname(destMedia), { recursive: true });
  fs.copyFileSync(src.media, destMedia);
  fs.copyFileSync(src.sidecar, destSidecar);
  return true;
}

export interface LibraryEntry {
  id: string;
  prompt: string;
  seconds: number;
  size: string;
  seed: number;
  from: string | null; // "image→video" source, as content id @ seconds
  at: string;
  sec: number | null;
  ready: boolean; // false = still syncing / damaged
}

export function listLibrary(opts: { search?: string; limit?: number } = {}): { dir: string; entries: LibraryEntry[] } {
  const lib = libraryDir();
  if (!lib) throw new VosError("no_library", "no generation library configured", "`vos gen library --init <dir>` (e.g. a folder in Google Drive for desktop)");
  if (!fs.existsSync(lib)) return { dir: lib, entries: [] };
  const words = (opts.search ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const entries: LibraryEntry[] = [];
  for (const f of fs.readdirSync(lib)) {
    if (!f.endsWith(".gen.json")) continue;
    const id = f.slice(0, -".gen.json".length);
    let g: any;
    try {
      g = readJson(path.join(lib, f));
    } catch {
      continue;
    }
    const r = g.request ?? {};
    const text = String(r.prompt ?? "").toLowerCase();
    if (words.length && !words.every((w) => text.includes(w))) continue;
    entries.push({
      id, prompt: r.prompt, seconds: r.seconds, size: `${r.width}x${r.height}`, seed: r.seed,
      from: r.first_frame ? `${String(r.first_frame.asset).slice(0, 12)}@${r.first_frame.at}` : null,
      at: g.at, sec: g.ran?.sec ?? null, ready: fs.existsSync(path.join(lib, `${id}.mp4`)),
    });
  }
  entries.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return { dir: lib, entries: entries.slice(0, opts.limit ?? 50) };
}
