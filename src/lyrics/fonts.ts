import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { bindProps } from "../compile/hyperframes.ts";
import { loadConfig, REPO, REPO_PYTHON } from "../core/config.ts";
import type { Project } from "../core/project.ts";
import { loadTimeline, resolveTimeline, timelinePath } from "../core/timeline.ts";
import { run, VosError, which } from "../core/util.ts";
import { loadLyricMotion } from "./engine.ts";
import { isLyricMotion } from "./plan.ts";

/**
 * `vos lyrics fonts` — JIZURA's own typefaces for this project: every face of its catalogue (OFL, google/fonts),
 * subset to the glyphs the lyric-motion clips can draw, written to design/fonts/jizura/ + design/jizura-fonts.css.
 * Then `"fonts": "jizura"` in the clip props. Reports lyric characters a face lacks (they would fall back to a
 * system face). Sources are cached in ~/.cache/vos/fonts; fetching them needs --download (network: ask the human).
 */

const WORKER = path.join(REPO, "python", "jizura_fonts.py");
// characters JIZURA draws besides the lyrics: HUD / labels / counters / symbols used by decor and layouts
const EXTRA = "0123456789:./-_()【】・No.LYRICRECUNTITLEDXYlinebpminterlude—─／" +
  " !\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz" +
  "、。，．「」『』（）〈〉《》〔〕［］｛｝！？＃％＆＊＋－＝／：；＜＞～〜…‥・ー―※→←↑↓◆◇■□●○▲△▼▽★☆♪♡♥✕×÷±°№";

let cachedPy: string | null | undefined;
function fontPython(): string | null {
  if (cachedPy !== undefined) return cachedPy;
  const c = loadConfig() as any;
  for (const py of [process.env.VOS_FONT_PYTHON, c.font_python, REPO_PYTHON, which("python3") ?? undefined].filter(Boolean) as string[]) {
    if (!fs.existsSync(py) && !which(py)) continue;
    if (run(py, ["-c", "import fontTools"], { timeout: 60_000 }).status === 0) return (cachedPy = py);
  }
  return (cachedPy = null);
}

export interface FontsResult { design: string; faces: { family: string; weight: string; file: string; bytes: number }[]; missing: Record<string, string>; glyphs: number; lyricGlyphs: number; written: boolean }

export function lyricFonts(p: Project, o: { timeline?: string; download?: boolean; check?: boolean; text?: string } = {}): FontsResult {
  const r = resolveTimeline(p, loadTimeline(timelinePath(p, o.timeline)));
  const lyric = new Set<string>(), all = new Set<string>(EXTRA);
  const add = (s: unknown) => { for (const c of String(s ?? "")) { lyric.add(c); all.add(c); } };
  if (o.text) add(o.text);
  for (const g of r.graphics.filter((x) => isLyricMotion(x.src))) {
    const props = bindProps(p, g.props, { timeline: { path: "", sha256: "" }, graphics: {}, design: {}, assets: {} }, `clip ${g.id}.props`);
    const m = loadLyricMotion(g.absSrc, props, { width: r.canvas.width, height: r.canvas.height, fps: r.canvas.fps });
    for (const l of m.plan.lines || []) { add(l.text); add(l.note); }
    add(props.title); add(props.artist);
    for (const pool of Object.values<Record<string, string>>({ ja: m.J.POOLS.ja, en: m.J.POOLS.en })) for (const s of Object.values(pool)) for (const c of s) all.add(c);
  }
  if (!lyric.size) throw new VosError("no_lyrics", "no lyric-motion clip with lyrics in the timeline", "add the clip first (or pass --text \"…\")");
  const py = fontPython();
  if (!py) throw new VosError("fonttools_unavailable", "no local Python with fontTools", "pip install fonttools brotli (or set VOS_FONT_PYTHON)");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vos-fonts-"));
  const chars = path.join(tmp, "chars.txt"), lchars = path.join(tmp, "lyric.txt");
  fs.writeFileSync(chars, [...all].join(""));
  fs.writeFileSync(lchars, [...lyric].join(""));
  const design = path.join(p.root, "design");
  const args = [WORKER, "--design", design, "--chars", chars, "--lyric-chars", lchars, ...(o.download ? ["--download"] : []), ...(o.check ? ["--check"] : [])];
  const res = run(py, args, { timeout: 30 * 60 * 1000 });
  fs.rmSync(tmp, { recursive: true, force: true });
  const line = res.stdout.trim().split("\n").filter((l) => l.startsWith("{")).pop();
  const out = line ? JSON.parse(line) : { ok: false, error: res.stderr.slice(-500) };
  if (!out.ok) throw new VosError("fonts_failed", out.error, out.hint);
  return { design: path.relative(p.root, design) || ".", faces: out.faces, missing: out.missing, glyphs: all.size, lyricGlyphs: lyric.size, written: !o.check };
}
