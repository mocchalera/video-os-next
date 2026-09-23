import { runOk, VosError } from "./util.ts";

export type AssetKind = "video" | "audio" | "image";

export interface Probe {
  kind: AssetKind;
  duration: number | null; // seconds (null for stills)
  width?: number;
  height?: number;
  fps?: number;
  has_audio: boolean;
  codec?: string;
}

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i;

export function probe(file: string): Probe {
  const r = runOk("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", file]);
  const j = JSON.parse(r.stdout);
  const streams: any[] = j.streams ?? [];
  const v = streams.find((s) => s.codec_type === "video");
  const a = streams.find((s) => s.codec_type === "audio");
  const dur = Number(j.format?.duration);
  if (v && (IMAGE_EXT.test(file) || v.codec_name === "png" || v.codec_name === "mjpeg" && !Number.isFinite(dur))) {
    return { kind: "image", duration: null, width: v.width, height: v.height, has_audio: false, codec: v.codec_name };
  }
  if (v) {
    const [n, d] = String(v.avg_frame_rate || v.r_frame_rate || "0/1").split("/").map(Number);
    return {
      kind: "video",
      duration: Number.isFinite(dur) ? dur : null,
      width: v.width,
      height: v.height,
      fps: d ? Math.round((n / d) * 1000) / 1000 : undefined,
      has_audio: !!a,
      codec: v.codec_name,
    };
  }
  if (a) return { kind: "audio", duration: Number.isFinite(dur) ? dur : null, has_audio: true, codec: a.codec_name };
  throw new VosError("unsupported_media", `${file}: no audio or video stream`);
}

export function ffmpegVersion(): string {
  try {
    return runOk("ffmpeg", ["-version"]).stdout.split("\n")[0].replace(/^ffmpeg version\s+/, "").split(" ")[0];
  } catch {
    return "unavailable";
  }
}
