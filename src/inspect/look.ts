import * as fs from "node:fs";
import * as path from "node:path";
import { sha256 } from "../core/hash.ts";
import { P, type Project } from "../core/project.ts";
import { formatTc } from "../core/time.ts";
import { runOk, VosError } from "../core/util.ts";

const FONT_CANDIDATES = [
  "/System/Library/Fonts/SFNSMono.ttf",
  "/System/Library/Fonts/Menlo.ttc",
  "/System/Library/Fonts/Supplemental/Arial.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
];
const FONT = FONT_CANDIDATES.find((f) => fs.existsSync(f)) ?? null;

export interface LookOptions {
  times: number[];
  width?: number; // tile width
  columns?: number;
  labels?: string[]; // extra text per time
  out?: string;
  fps?: number; // for timecode labels
  keepFrames?: boolean;
}

export interface LookResult {
  sheet: string;
  frames: { t: number; file?: string; label: string }[];
}

export function evenTimes(duration: number, count: number): number[] {
  const n = Math.max(1, count);
  return Array.from({ length: n }, (_, i) => Math.round(((i + 0.5) * duration * 1000) / n) / 1000);
}

/** Frame sheet: the agent's primary way to *see* a source or a render. */
export function look(p: Project, file: string, opts: LookOptions): LookResult {
  if (!opts.times.length) throw new VosError("no_times", "no times to look at");
  const width = opts.width ?? 480;
  const cols = opts.columns ?? Math.min(4, opts.times.length);
  const key = sha256(JSON.stringify([file, fs.statSync(file).mtimeMs, opts])).slice(0, 12);
  const dir = path.join(P.cache(p.root), "look", key);
  fs.mkdirSync(dir, { recursive: true });
  const frames: LookResult["frames"] = [];
  opts.times.forEach((t, i) => {
    const label = `${formatTc(t, opts.fps ?? 30)}  ${t.toFixed(2)}s${opts.labels?.[i] ? "  " + opts.labels[i] : ""}`;
    const f = path.join(dir, `${String(i).padStart(3, "0")}.jpg`);
    const draw = FONT
      ? `,drawbox=x=0:y=ih-28:w=iw:h=28:color=black@0.72:t=fill,drawtext=fontfile='${FONT}':text='${label.replace(/[':\\]/g, (c) => "\\" + c)}':x=8:y=h-22:fontsize=15:fontcolor=white`
      : "";
    runOk("ffmpeg", ["-v", "error", "-y", "-ss", String(Math.max(0, t)), "-i", file, "-frames:v", "1", "-vf", `scale=${width}:-2${draw}`, "-q:v", "3", f]);
    frames.push({ t, file: opts.keepFrames ? f : undefined, label });
  });
  const rows = Math.ceil(frames.length / cols);
  const sheet = path.resolve(opts.out ?? path.join(dir, "sheet.png"));
  runOk("ffmpeg", ["-v", "error", "-y", "-framerate", "1", "-i", path.join(dir, "%03d.jpg"), "-vf", `tile=${cols}x${rows}:padding=4:color=0x111111`, "-frames:v", "1", sheet]);
  return { sheet, frames };
}
