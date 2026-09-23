import * as fs from "node:fs";
import * as path from "node:path";
import { probe } from "../core/media.ts";
import type { Project } from "../core/project.ts";
import { framesToSeconds } from "../core/time.ts";
import type { Resolved, RMedia } from "../core/timeline.ts";

const x = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const url = (abs: string) => "file://localhost" + abs.split("/").map(encodeURIComponent).join("/");

export interface Fcp7Options {
  overlay?: string | null; // transparent graphics render (.mov) placed on the top video track
}

/**
 * FCP7 XML (xmeml v5) — what Premiere Pro imports reliably.
 * Footage lands on its own tracks with real source in/out; graphics come along as one
 * transparent overlay clip, so an editor can re-cut footage under the design.
 */
export function exportFcp7(p: Project, r: Resolved, opts: Fcp7Options = {}): string {
  const fps = r.canvas.fps;
  const rate = `<rate><timebase>${fps}</timebase><ntsc>FALSE</ntsc></rate>`;
  const fileIds = new Map<string, string>();
  const fileXml = (m: { asset: RMedia["asset"] }, absPath: string) => {
    const known = fileIds.get(m.asset.id);
    if (known) return `<file id="${known}"/>`;
    const id = `file-${fileIds.size + 1}`;
    fileIds.set(m.asset.id, id);
    const durF = Math.round((m.asset.duration ?? 10) * fps);
    const hasVideo = m.asset.kind !== "audio";
    return `<file id="${id}"><name>${x(m.asset.filename)}</name><pathurl>${x(url(absPath))}</pathurl>${rate}<duration>${durF}</duration><media>${
      hasVideo ? `<video><samplecharacteristics><width>${m.asset.width ?? r.canvas.width}</width><height>${m.asset.height ?? r.canvas.height}</height></samplecharacteristics></video>` : ""
    }${m.asset.has_audio ? `<audio><channelcount>2</channelcount></audio>` : ""}</media></file>`;
  };

  let clipN = 0;
  const clipitem = (m: RMedia, kind: "video" | "audio") => {
    const abs = m.asset.path ?? m.asset.filename;
    const inF = Math.round(m.srcIn * fps);
    const still = m.asset.kind === "image";
    return `<clipitem id="clipitem-${++clipN}"><name>${x(m.label ?? m.id)}</name><enabled>TRUE</enabled><duration>${Math.round((m.asset.duration ?? framesToSeconds(m.frames, fps)) * fps)}</duration>${rate}<start>${m.start}</start><end>${m.start + m.frames}</end><in>${still ? 0 : inF}</in><out>${still ? m.frames : inF + m.frames}</out>${fileXml(m, abs)}${
      kind === "audio" ? `<sourcetrack><mediatype>audio</mediatype><trackindex>1</trackindex></sourcetrack>` : ""
    }${m.slot ? `<comments><mastercomment1>vos slot ${x(m.slot.clip + "/" + m.slot.name)} (positioned inside graphics in the vos render)</mastercomment1></comments>` : ""}</clipitem>`;
  };

  const vTracks: string[] = [];
  for (const t of r.tracks.filter((t) => t.kind === "video")) {
    const items = r.media.filter((m) => m.track === t.id).map((m) => clipitem(m, "video"));
    if (items.length) vTracks.push(`<track>${items.join("")}</track>`);
  }
  if (opts.overlay && fs.existsSync(opts.overlay)) {
    const pr = probe(opts.overlay);
    const fake: RMedia = {
      kind: "video", id: "vos-graphics-overlay", track: "GFX", trackIndex: 999,
      asset: { alias: "overlay", id: "overlay", kind: "video", filename: path.basename(opts.overlay), duration: pr.duration, width: pr.width, height: pr.height, has_audio: false, size: 0, path: path.resolve(opts.overlay) },
      start: 0, frames: r.frames, srcIn: 0, fit: "cover", fx: {}, fade: { in: 0, out: 0 }, gain: 1, withAudio: false, label: "vos graphics (transparent)",
    };
    vTracks.push(`<track>${clipitem(fake, "video")}</track>`);
  }
  const aTracks: string[] = [];
  for (const t of r.tracks.filter((t) => t.kind === "audio")) {
    const items = r.media.filter((m) => m.track === t.id).map((m) => clipitem(m, "audio"));
    if (items.length) aTracks.push(`<track>${items.join("")}</track>`);
  }
  const markers = r.markers.map((m) => `<marker><name>${x(m.label)}</name><comment>${x(m.kind)}</comment><in>${m.frame}</in><out>-1</out></marker>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="5"><sequence id="sequence-1"><name>${x(r.name)}</name><duration>${r.frames}</duration>${rate}<timecode>${rate}<string>00:00:00:00</string><frame>0</frame><displayformat>NDF</displayformat></timecode>${markers}<media><video><format><samplecharacteristics>${rate}<width>${r.canvas.width}</width><height>${r.canvas.height}</height><pixelaspectratio>square</pixelaspectratio></samplecharacteristics></format>${vTracks.join("")}</video><audio>${aTracks.join("")}</audio></media></sequence></xmeml>
`;
}
