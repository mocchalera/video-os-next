import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ingest, initProject, loadProject, saveAssets, type Project } from "../src/core/project.ts";

/** A throwaway project with generated media: a 4s test video, a 4s tone, a still. */
export function fixtureProject(): Project {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vos-test-"));
  initProject(root, "fixture");
  const m = path.join(root, "media");
  fs.mkdirSync(m);
  const ff = (args: string[]) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args]);
  ff(["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=4", "-pix_fmt", "yuv420p", path.join(m, "clip.mp4")]);
  ff(["-f", "lavfi", "-i", "sine=frequency=440:duration=4", path.join(m, "tone.wav")]);
  ff(["-f", "lavfi", "-i", "color=c=orange:s=64x64", "-frames:v", "1", path.join(m, "still.png")]);
  const p = loadProject(root);
  ingest(p, path.join(m, "clip.mp4"), "clip");
  ingest(p, path.join(m, "tone.wav"), "tone");
  ingest(p, path.join(m, "still.png"), "still");
  saveAssets(p);
  fs.writeFileSync(
    path.join(root, "graphics", "title.html"),
    `<style>.t{color:#fff}</style><div class="t">TITLE</div><div class="box" data-slot="win"></div><img src="vos://asset/clip@1.5">
<script>vos.graphic(({ tl, q }) => { tl.from(q(".t"), { opacity: 0, duration: 0.5 }, 0); });</script>`,
  );
  return loadProject(root);
}

export function writeTimeline(p: Project, doc: unknown): void {
  fs.writeFileSync(path.join(p.root, "timeline.json"), JSON.stringify(doc, null, 2));
}

export const baseTimeline = () => ({
  format: "vos.timeline/1",
  name: "fx",
  canvas: { width: 320, height: 180, fps: 30 },
  duration: "8b",
  grid: { bpm: 120, offset: 0 },
  tracks: [
    { id: "V1", kind: "video", clips: [{ id: "a", asset: "clip", at: 0, in: 0.5, dur: "4b" }, { id: "b", asset: "still", at: "4b", dur: "4b" }] },
    { id: "G1", kind: "graphics", clips: [{ id: "title", src: "graphics/title.html", at: "1b", dur: "4b" }] },
    { id: "S1", kind: "video", clips: [{ id: "w", asset: "clip", slot: "title/win", at: "2b", dur: "2b", in: 1 }] },
    { id: "A1", kind: "audio", clips: [{ id: "music", asset: "tone", at: 0, dur: "8b", gain_db: -6 }] },
  ],
  markers: [{ at: "4b", label: "B", kind: "section" }],
});
