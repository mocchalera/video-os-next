import * as fs from "node:fs";
import * as path from "node:path";
import { compile, compileDigest, type CompileOptions } from "../compile/hyperframes.ts";
import { hyperframesBin } from "../core/config.ts";
import { sha256File } from "../core/hash.ts";
import { ffmpegVersion, probe } from "../core/media.ts";
import { P, type Project } from "../core/project.ts";
import { run, runOk, VosError, writeJson } from "../core/util.ts";

export interface RenderOptions extends CompileOptions {
  draft?: boolean;
  output?: string;
  quiet?: boolean;
}

export interface Receipt {
  format: "vos.receipt/1";
  output: string;
  output_sha256: string;
  output_duration: number;
  timeline: { path: string; sha256: string; frames: number; fps: number };
  compile_digest: string;
  inputs: unknown;
  settings: { quality: string; fps: number; graphics_only: boolean; format: string };
  tools: { hyperframes: string; ffmpeg: string; node: string };
  created_at: string; // informational only; excluded from any digest
}

function hfVersion(bin: string): string {
  try {
    return run(bin, ["--version"]).stdout.trim().split("\n").pop() ?? "unknown";
  } catch {
    return "unknown";
  }
}

export function lintBuild(buildDir: string): { errors: string[]; warnings: string[] } {
  const bin = hyperframesBin();
  if (!bin) throw new VosError("no_hyperframes", "HyperFrames CLI not found", "set VOS_HYPERFRAMES_BIN or run `vos doctor --write`");
  const r = run(bin, ["lint", buildDir, "--json"], { cwd: buildDir });
  try {
    const j = JSON.parse(r.stdout.slice(r.stdout.indexOf("{")));
    const f: any[] = j.findings ?? [];
    return {
      errors: f.filter((x) => x.severity === "error").map((x) => `${x.code}: ${x.message}`),
      warnings: f.filter((x) => x.severity === "warning").map((x) => `${x.code}: ${x.message}`),
    };
  } catch {
    return { errors: r.status === 0 ? [] : [r.stderr.trim() || r.stdout.trim()], warnings: [] };
  }
}

export function render(p: Project, opts: RenderOptions = {}): { output: string; receipt: Receipt; receiptPath: string; lintWarnings: string[] } {
  const bin = hyperframesBin();
  if (!bin) throw new VosError("no_hyperframes", "HyperFrames CLI not found", "set VOS_HYPERFRAMES_BIN or run `vos doctor --write`");
  const c = compile(p, opts);
  const lint = lintBuild(c.buildDir);
  // "composition_file_too_large" etc. are authoring advice for hand-written pages, not for generated ones.
  const blocking = lint.errors;
  if (blocking.length) throw new VosError("lint_failed", `HyperFrames lint rejected the compiled page:\n- ${blocking.join("\n- ")}`, "fix the timeline/graphics; the compiled page is generated");

  const fps = c.resolved.canvas.fps;
  const format = opts.graphicsOnly ? "mov" : "mp4";
  const digest = compileDigest(c).slice(0, 10);
  const outDir = P.out(p.root);
  fs.mkdirSync(outDir, { recursive: true });
  const output = path.resolve(opts.output ?? path.join(outDir, `${c.resolved.name}${opts.graphicsOnly ? ".overlay" : ""}${opts.draft ? ".draft" : ""}.${digest}.${format}`));
  const quality = opts.draft ? "draft" : "high";
  const args = ["render", c.buildDir, "-q", quality, "-f", String(fps), "-o", output];
  if (opts.graphicsOnly) args.push("--format", "mov");
  if (!opts.draft) args.push("--video-frame-format", "png");
  const r = run(bin, args, { cwd: c.buildDir, stdio: opts.quiet ? "pipe" : ["ignore", "inherit", "inherit"] });
  if (r.status !== 0 || !fs.existsSync(output)) {
    throw new VosError("render_failed", `HyperFrames render failed (exit ${r.status})${r.stderr ? ":\n" + r.stderr.trim().split("\n").slice(-8).join("\n") : ""}`);
  }
  const pr = probe(output);
  const receipt: Receipt = {
    format: "vos.receipt/1",
    output: path.relative(p.root, output),
    output_sha256: sha256File(output),
    output_duration: pr.duration ?? 0,
    timeline: { path: c.inputs.timeline.path, sha256: c.inputs.timeline.sha256, frames: c.resolved.frames, fps },
    compile_digest: compileDigest(c),
    inputs: c.inputs,
    settings: { quality, fps, graphics_only: !!opts.graphicsOnly, format },
    tools: { hyperframes: hfVersion(bin), ffmpeg: ffmpegVersion(), node: process.version },
    created_at: new Date().toISOString(),
  };
  const receiptPath = output.replace(/\.(mp4|mov)$/, ".receipt.json");
  writeJson(receiptPath, receipt);
  return { output, receipt, receiptPath, lintWarnings: lint.warnings };
}

export function latestRender(p: Project, kind: "mp4" | "mov" = "mp4"): string | null {
  const dir = P.out(p.root);
  if (!fs.existsSync(dir)) return null;
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(`.${kind}`) && fs.existsSync(path.join(dir, f.replace(/\.(mp4|mov)$/, ".receipt.json"))))
    .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return files.length ? path.join(dir, files[0].f) : null;
}

export { runOk };
