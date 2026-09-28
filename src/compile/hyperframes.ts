import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256, sha256File } from "../core/hash.ts";
import { P, requireOnline, resolveAsset, type Project } from "../core/project.ts";
import { framesToSeconds } from "../core/time.ts";
import { loadTimeline, resolveTimeline, timelinePath, type Resolved, type RMedia } from "../core/timeline.ts";
import { readJson, runOk, stableStringify, VosError, writeJson } from "../core/util.ts";
import { readTranscript } from "../analyze/transcribe.ts";
import { readDescribe } from "../analyze/marlin.ts";

const RUNTIME_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "runtime");

export interface CompileOptions {
  timeline?: string;
  graphicsOnly?: boolean; // transparent overlay: no media, transparent background
  outDir?: string;
}

export interface CompileResult {
  buildDir: string;
  html: string;
  resolved: Resolved;
  inputs: CompileInputs;
  htmlSha256: string;
}

export interface CompileInputs {
  timeline: { path: string; sha256: string };
  graphics: Record<string, string>; // src -> sha256
  design: Record<string, string>;
  assets: Record<string, { id: string; filename: string; used_by: string[] }>;
}

interface GraphicParts {
  styles: string[];
  markup: string;
  scripts: string[];
}

function splitGraphic(html: string): GraphicParts {
  const styles: string[] = [];
  const scripts: string[] = [];
  let markup = html.replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, (_, css) => {
    styles.push(css);
    return "";
  });
  markup = markup.replace(/<script[^>]*>([\s\S]*?)<\/script>/gi, (_, js) => {
    scripts.push(js);
    return "";
  });
  return { styles, markup: markup.trim(), scripts };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const sec = (frames: number, fps: number) => String(framesToSeconds(frames, fps));

/**
 * Props may bind to real artifacts so on-screen text cannot drift from the data:
 *   {"$describe": "<alias>"}  → Marlin describe record of that asset
 *   {"$transcript": "<alias>"} → transcript (segments + word timings) of that asset
 *   {"$data": "data/x.json"}  → project-relative JSON file
 *   {"$asset": "<alias>"}     → portable asset record
 *   {"$assets": true}         → all asset records by alias
 */
export function bindProps(p: Project, v: any, inputs: CompileInputs, where: string): any {
  if (Array.isArray(v)) return v.map((x, i) => bindProps(p, x, inputs, `${where}[${i}]`));
  if (!v || typeof v !== "object") return v;
  const keys = Object.keys(v);
  if (keys.length === 1 && keys[0] === "$describe") {
    const a = resolveAsset(p, v.$describe);
    const d = readDescribe(p, a.id);
    if (!d) throw new VosError("missing_analysis", `${where}: no description for "${a.alias}"`, `run \`vos describe ${a.alias}\` (or \`vos import vos2\`)`);
    inputs.design[`describe:${a.alias}`] = sha256(JSON.stringify(d));
    return d;
  }
  if (keys.length === 1 && keys[0] === "$transcript") {
    const a = resolveAsset(p, v.$transcript);
    const t = readTranscript(p, a.id);
    if (!t) throw new VosError("missing_analysis", `${where}: no transcript for "${a.alias}"`, `run \`vos transcribe ${a.alias}\``);
    inputs.design[`transcript:${a.alias}`] = sha256(JSON.stringify(t.segments));
    return t;
  }
  if (keys.length === 1 && keys[0] === "$data") {
    const f = path.resolve(p.root, v.$data);
    if (!fs.existsSync(f)) throw new VosError("missing_file", `${where}: ${v.$data} not found`);
    inputs.design[`data:${v.$data}`] = sha256File(f);
    return readJson(f);
  }
  if (keys.length === 1 && keys[0] === "$assets") {
    const o: Record<string, unknown> = {};
    for (const [alias, a] of Object.entries(p.assets.assets)) o[alias] = { alias, id: a.id, filename: a.filename, duration: a.duration, kind: a.kind };
    return o;
  }
  if (keys.length === 1 && keys[0] === "$asset") {
    const a = resolveAsset(p, v.$asset);
    return { alias: a.alias, id: a.id, filename: a.filename, duration: a.duration, width: a.width, height: a.height };
  }
  const o: Record<string, any> = {};
  for (const k of keys) o[k] = bindProps(p, v[k], inputs, `${where}.${k}`);
  return o;
}

export function compile(p: Project, opts: CompileOptions = {}): CompileResult {
  const tlPath = timelinePath(p, opts.timeline);
  const doc = loadTimeline(tlPath);
  const r = resolveTimeline(p, doc);
  const fps = r.canvas.fps;
  const buildDir = opts.outDir ?? P.build(p.root, r.name + (opts.graphicsOnly ? "-overlay" : ""));
  fs.rmSync(buildDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(buildDir, "media", "stills"), { recursive: true });

  const inputs: CompileInputs = {
    timeline: { path: path.relative(p.root, tlPath), sha256: sha256File(tlPath) },
    graphics: {},
    design: {},
    assets: {},
  };
  const useAsset = (alias: string, by: string) => {
    const a = resolveAsset(p, alias);
    const e = (inputs.assets[a.alias] ??= { id: a.id, filename: a.filename, used_by: [] });
    if (!e.used_by.includes(by)) e.used_by.push(by);
    return a;
  };

  // ---- media files (symlinked, named by content id) ----
  const mediaRel = (alias: string, by: string) => {
    const a = useAsset(alias, by);
    const src = requireOnline(a);
    const rel = `media/${a.id}${path.extname(src).toLowerCase()}`;
    const dst = path.join(buildDir, rel);
    if (!fs.existsSync(dst)) fs.symlinkSync(src, dst);
    return rel;
  };

  // ---- vos:// URL resolution inside graphics ----
  const resolveVosUrls = (text: string, by: string): string =>
    text.replace(/vos:\/\/(asset|file)\/([^"')\s]+)/g, (_m, kind: string, rest: string) => {
      if (kind === "file") {
        const abs = path.resolve(p.root, rest);
        if (!fs.existsSync(abs)) throw new VosError("missing_file", `${by}: vos://file/${rest} not found`);
        const rel = `media/files/${sha256(rest).slice(0, 12)}${path.extname(rest)}`;
        fs.mkdirSync(path.join(buildDir, "media", "files"), { recursive: true });
        if (!fs.existsSync(path.join(buildDir, rel))) fs.symlinkSync(abs, path.join(buildDir, rel));
        inputs.design[`file:${rest}`] = sha256File(abs);
        return rel;
      }
      const [alias, at] = rest.split("@");
      if (at === undefined) return mediaRel(alias, by);
      const a = useAsset(alias, `${by}@${at}`);
      const src = requireOnline(a);
      const t = Number(at);
      if (!Number.isFinite(t)) throw new VosError("bad_url", `${by}: bad still time in vos://asset/${rest}`);
      const cacheFile = path.join(P.cache(p.root), "stills", `${a.id}_${t.toFixed(3)}.jpg`);
      if (!fs.existsSync(cacheFile)) {
        fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
        runOk("ffmpeg", ["-v", "error", "-y", "-ss", String(t), "-i", src, "-frames:v", "1", "-q:v", "2", cacheFile]);
      }
      const rel = `media/stills/${a.id}_${t.toFixed(3)}.jpg`;
      fs.copyFileSync(cacheFile, path.join(buildDir, rel));
      return rel;
    });

  // ---- design (global css + fonts) ----
  const designDir = path.join(p.root, "design");
  let designCss = "";
  if (fs.existsSync(designDir)) {
    fs.symlinkSync(designDir, path.join(buildDir, "design"));
    for (const f of fs.readdirSync(designDir).sort()) {
      const abs = path.join(designDir, f);
      if (fs.statSync(abs).isFile()) inputs.design[f] = sha256File(abs);
      if (f.endsWith(".css")) {
        designCss += `/* design/${f} */\n` + fs.readFileSync(abs, "utf8").replace(/url\((['"]?)(?!data:|https?:|\/)([^'")]+)\1\)/g, "url($1design/$2$1)") + "\n";
      }
    }
  }

  // ---- graphics ----
  const graphicsCss = new Map<string, string>();
  const sections = new Map<string, string>(); // clip id -> section html
  const mountScripts: string[] = [];
  let usesThree = false; // three.js (~2 MB) is loaded only into pages whose graphics use it
  const slotMedia = new Map<string, RMedia[]>();
  for (const m of r.media) if (m.slot) (slotMedia.get(m.slot.clip) ?? slotMedia.set(m.slot.clip, []).get(m.slot.clip)!).push(m);

  let trackCounter = 0;
  const mediaTags: { m: RMedia; html: string }[] = [];
  const mediaHtml = (m: RMedia): string => {
    const rel = mediaRel(m.asset.alias, `clip:${m.id}`);
    const start = sec(m.start, fps);
    const dur = sec(m.frames, fps);
    const style: string[] = [];
    if (!m.slot) style.push("position:absolute;inset:0;width:100%;height:100%");
    else style.push("position:absolute;inset:0;width:100%;height:100%");
    style.push(`object-fit:${m.fit}`);
    if (m.fx.filter) style.push(`filter:${m.fx.filter}`);
    if (m.fx.scale) style.push(`transform:scale(${m.fx.scale})`);
    if (m.fx.opacity !== undefined && !m.fade.in) style.push(`opacity:${m.fx.opacity}`);
    const ti = ++trackCounter;
    if (m.kind === "image") {
      return `<img id="m_${m.id}" class="clip vos-media" src="${rel}" data-start="${start}" data-duration="${dur}" data-track-index="${ti}" style="${style.join(";")}">`;
    }
    if (m.kind === "audio") {
      return `<audio id="ma_${m.id}" class="clip" src="${rel}" data-start="${start}" data-duration="${dur}" data-media-start="${m.srcIn}" data-volume="${m.gain}" data-track-index="${ti}"></audio>`;
    }
    const v = `<video id="m_${m.id}" class="clip vos-media" src="${rel}" muted playsinline data-start="${start}" data-duration="${dur}" data-media-start="${m.srcIn}" data-track-index="${ti}" style="${style.join(";")}"></video>`;
    if (m.withAudio && m.asset.has_audio) {
      const ai = ++trackCounter;
      return v + `<audio id="ma_${m.id}" class="clip" src="${rel}" data-start="${start}" data-duration="${dur}" data-media-start="${m.srcIn}" data-volume="${m.gain}" data-track-index="${ai}"></audio>`;
    }
    return v;
  };

  for (const g of r.graphics) {
    const raw = fs.readFileSync(g.absSrc, "utf8");
    if (/\bTHREE\b|\bthree\s*\(/.test(raw)) usesThree = true;
    inputs.graphics[g.src] = sha256(raw);
    const parts = splitGraphic(raw);
    if (!graphicsCss.has(g.src)) graphicsCss.set(g.src, resolveVosUrls(parts.styles.join("\n"), g.src));
    let markup = resolveVosUrls(parts.markup, g.src);
    for (const m of slotMedia.get(g.id) ?? []) {
      const re = new RegExp(`(<[a-zA-Z][^>]*data-slot=["']${m.slot!.name}["'][^>]*>)`);
      if (opts.graphicsOnly) continue; // overlay render leaves slots empty (media lives in the NLE)
      const tag = mediaHtml(m);
      mediaTags.push({ m, html: tag });
      markup = markup.replace(re, `$1${tag}`);
    }
    sections.set(
      g.id,
      `<section class="vos-g" data-clip="${esc(g.id)}" data-src="${esc(g.src)}" style="position:absolute;inset:0;overflow:hidden;visibility:hidden">\n${markup}\n</section>`,
    );
    const slots: Record<string, { id: string; alias: string; start: number; dur: number; in: number }[]> = {};
    for (const m of slotMedia.get(g.id) ?? []) (slots[m.slot!.name] ??= []).push({ id: m.id, alias: m.asset.alias, start: framesToSeconds(m.start - g.start, fps), dur: framesToSeconds(m.frames, fps), in: m.srcIn });
    const meta = JSON.stringify({ id: g.id, start: framesToSeconds(g.start, fps), dur: framesToSeconds(g.frames, fps), props: bindProps(p, g.props, inputs, `clip ${g.id}.props`), slots }).replace(/<\//g, "<\\/");
    for (const js of parts.scripts) {
      mountScripts.push(`<script>/* ${g.id} ← ${g.src} */\n(function(){ var vos = { graphic: function (fn) { VOS.mount(${meta}, fn); } };\n${resolveVosUrls(js, g.src)}\n})();</script>`);
    }
  }

  // ---- layers in track order ----
  const layers: string[] = [];
  for (const t of r.tracks) {
    if (t.mute) continue;
    const items: string[] = [];
    if (t.kind === "graphics") {
      for (const g of r.graphics.filter((x) => x.track === t.id)) items.push(sections.get(g.id)!);
    } else if (!opts.graphicsOnly) {
      for (const m of r.media.filter((x) => x.track === t.id && !x.slot)) {
        const tag = mediaHtml(m);
        mediaTags.push({ m, html: tag });
        items.push(tag);
      }
    }
    if (!items.length) continue;
    layers.push(`<div id="layer-${esc(t.id)}" class="vos-layer" data-vos-track="${esc(t.id)}" style="position:absolute;inset:0;overflow:hidden;isolation:isolate;z-index:${(t.index + 1) * 10}">\n${items.join("\n")}\n</div>`);
  }

  // ---- media fades on the master timeline ----
  const fades: string[] = [];
  for (const { m } of mediaTags) {
    if (m.kind === "audio") continue;
    const s = framesToSeconds(m.start, fps);
    const e = framesToSeconds(m.start + m.frames, fps);
    const target = m.fx.opacity ?? 1;
    if (m.fade.in > 0) fades.push(`VOS.master.fromTo("#m_${m.id}",{opacity:0},{opacity:${target},duration:${m.fade.in},ease:"none",immediateRender:false},${s});`);
    if (m.fade.out > 0) fades.push(`VOS.master.to("#m_${m.id}",{opacity:0,duration:${m.fade.out},ease:"none"},${Math.max(s, e - m.fade.out)});`);
  }

  const cfg = { fps, duration: framesToSeconds(r.frames, fps), grid: r.grid ?? null, name: r.name, width: r.canvas.width, height: r.canvas.height };
  const bg = opts.graphicsOnly ? "transparent" : r.canvas.background;
  const W = r.canvas.width;
  const H = r.canvas.height;
  fs.copyFileSync(path.join(RUNTIME_DIR, "gsap.min.js"), path.join(buildDir, "gsap.min.js"));
  if (usesThree) {
    fs.copyFileSync(path.join(RUNTIME_DIR, "three.js"), path.join(buildDir, "three.js"));
    fs.copyFileSync(path.join(RUNTIME_DIR, "vos-three.js"), path.join(buildDir, "vos-three.js"));
  }
  const runtime = fs.readFileSync(path.join(RUNTIME_DIR, "vos-runtime.js"), "utf8");

  const html = `<!doctype html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=${W}, height=${H}">
<!-- generated by vos compile from ${esc(inputs.timeline.path)} (sha256 ${inputs.timeline.sha256.slice(0, 12)}). Do not edit; edit the timeline and graphics instead. -->
<script src="./gsap.min.js"></script>
${usesThree ? '<script src="./three.js"></script>\n<script src="./vos-three.js"></script>\n' : ""}<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:${W}px;height:${H}px;overflow:hidden;background:${bg}}
#root{position:relative;width:${W}px;height:${H}px;overflow:hidden;background:${bg}}
${designCss}
${[...graphicsCss.entries()].map(([src, css]) => `/* ${src} */\n${css}`).join("\n")}
${opts.graphicsOnly ? "/* overlay render: slots stay transparent so NLE footage shows through */\n[data-slot]{background:transparent!important}" : ""}
</style>
</head>
<body>
<div id="root" data-composition-id="main" data-start="0" data-duration="${cfg.duration}" data-width="${W}" data-height="${H}">
${layers.join("\n")}
</div>
<script>window.__VOS_CFG__ = ${JSON.stringify(cfg)};</script>
<script>${runtime}</script>
${mountScripts.join("\n")}
<script>${fades.join("\n")}
VOS.finalize();</script>
</body>
</html>
`;
  fs.writeFileSync(path.join(buildDir, "index.html"), html);
  fs.writeFileSync(path.join(buildDir, "meta.json"), JSON.stringify({ id: r.name, name: r.name }) + "\n");
  writeJson(path.join(buildDir, "resolved.json"), serializeResolved(r));
  writeJson(path.join(buildDir, "inputs.json"), inputs);
  return { buildDir, html, resolved: r, inputs, htmlSha256: sha256(html) };
}

export function serializeResolved(r: Resolved) {
  return {
    ...r,
    media: r.media.map((m) => ({ ...m, asset: { alias: m.asset.alias, id: m.asset.id, filename: m.asset.filename, duration: m.asset.duration, kind: m.asset.kind } })),
  };
}

export function compileDigest(c: CompileResult): string {
  return sha256(stableStringify({ html: c.htmlSha256, inputs: c.inputs }));
}
