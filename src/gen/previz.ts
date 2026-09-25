import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig, REPO } from "../core/config.ts";
import { sha256 } from "../core/hash.ts";
import { ingest, saveAssets, type IngestResult, type Project } from "../core/project.ts";
import { readJsonIf, run, stableStringify, VosError, which, writeJson } from "../core/util.ts";
import { framesFor, parseSize } from "./colab.ts";

/**
 * vos previz — lay out space and camera in Blender (a bpy scene script, written like code), render it headless as
 * a clay "beauty" pass and a depth pass at exactly the generation size / 24 fps / frame count, and ingest both.
 * The depth pass drives `vos gen clip --control <name>_depth` (MiniMax-H3 Fun ControlNet) so generated shots keep
 * the planned geometry and camera move; the beauty pass is for judging the layout with `vos look`.
 */

const DRIVER = path.join(REPO, "python", "blender_previz.py");

export function blenderBin(): string | null {
  const c = loadConfig() as any;
  const mac = "/Applications/Blender.app/Contents/MacOS/Blender";
  for (const x of [process.env.VOS_BLENDER, c.blender, which("blender") ?? undefined, mac]) if (x && fs.existsSync(x)) return x;
  return null;
}

export interface PrevizResult {
  name: string;
  cached: boolean;
  beauty: IngestResult;
  depth: IngestResult;
  dir: string;
  frames: number;
  size: [number, number];
}

export function renderPreviz(p: Project, scene: string, o: { as?: string; seconds?: number; size?: string; encoding?: string } = {}): PrevizResult {
  const scenePath = path.resolve(scene);
  if (!fs.existsSync(scenePath)) throw new VosError("missing_file", `${scenePath} does not exist`);
  const bl = blenderBin();
  if (!bl) throw new VosError("blender_missing", "Blender not found", "install Blender, or set VOS_BLENDER / config `blender` to its binary");
  const name = o.as ?? path.basename(scenePath).replace(/\.py$/, "");
  const seconds = o.seconds ?? 5;
  const [width, height] = parseSize(o.size);
  const frames = framesFor(seconds);
  const encoding = o.encoding ?? "disparity";
  const dir = path.join(p.root, "previz", name);
  const key = sha256(stableStringify({ scene: sha256(fs.readFileSync(scenePath)), driver: sha256(fs.readFileSync(DRIVER)), width, height, frames, encoding }));
  const media = { beauty: path.join(dir, `${name}.beauty.mp4`), depth: path.join(dir, `${name}.depth.mp4`) };
  const meta = readJsonIf<any>(path.join(dir, "previz.json"), null);
  const cached = !!meta && meta.key === key && fs.existsSync(media.beauty) && fs.existsSync(media.depth);
  if (!cached) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const r = run(bl, ["--factory-startup", "-b", "-P", DRIVER, "--", "--scene", scenePath, "--out", dir, "--width", String(width),
      "--height", String(height), "--frames", String(frames), "--fps", "24", "--depth-encoding", encoding], { timeout: 3_600_000 });
    if (r.status !== 0 || !/previz: done/.test(r.stdout)) {
      const err = (r.stdout + r.stderr).split("\n").filter((l) => /Error|Traceback|previz:|line \d+/.test(l)).slice(-12).join("\n");
      throw new VosError("previz_failed", "Blender could not render the previz scene", err || (r.stdout + r.stderr).slice(-800));
    }
    for (const pass of ["beauty", "depth"] as const) {
      const e = run("ffmpeg", ["-v", "error", "-y", "-framerate", "24", "-i", path.join(dir, pass, "%04d.png"), "-c:v", "libx264", "-crf", "12",
        "-pix_fmt", "yuv420p", media[pass]]);
      if (e.status !== 0) throw new VosError("previz_encode", `could not encode the ${pass} pass`, e.stderr.slice(-300));
      fs.rmSync(path.join(dir, pass), { recursive: true, force: true });
    }
    const info = readJsonIf<any>(path.join(dir, "previz.json"), {});
    writeJson(path.join(dir, "previz.json"), { ...info, key, scene: path.relative(p.root, scenePath).startsWith("..") ? path.basename(scenePath) : path.relative(p.root, scenePath) });
    if (!scenePath.startsWith(p.root)) fs.copyFileSync(scenePath, path.join(dir, path.basename(scenePath))); // keep the scene with its render
  }
  const note = `previz (blender): ${path.basename(scenePath)}`;
  const beauty = ingest(p, media.beauty, name, `${note} — beauty pass`, true);
  const depth = ingest(p, media.depth, `${name}_depth`, `${note} — depth pass (${encoding}, near=white): use with vos gen clip --control`, true);
  saveAssets(p);
  return { name, cached, beauty, depth, dir: path.relative(p.root, dir), frames, size: [width, height] };
}
