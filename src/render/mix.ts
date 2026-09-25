import * as fs from "node:fs";
import * as path from "node:path";
import type { Resolved, RMedia } from "../core/timeline.ts";
import { run, VosError } from "../core/util.ts";

/**
 * vos mixer: the final audio of a render is built here with ffmpeg from the resolved timeline, not by the browser.
 * The browser caps volume at 1 (so a quiet generated take could never be lifted), has no ducking and no loudness
 * control. Everything below is derived from the timeline alone, so the same timeline gives the same mix:
 *
 *   per clip   trim → gain_db (unclamped, ≤ +24) → fades → place at its timeline start
 *   per track  sum; if the track declares `duck: { by }`, dip it with a gain envelope built from the *timeline spans*
 *              of the `by` track's audible clips (attack before, release after) — no signal analysis, no surprises
 *   master     sum of tracks → two-pass EBU R128 loudnorm to `master.loudness` LUFS / `master.true_peak` dBTP
 */

export const MIX_RATE = 48000;

export interface MixReport {
  mixer: "vos-ffmpeg/1";
  sources: number;
  tracks: string[];
  ducks: { track: string; by: string; db: number; spans: number }[];
  loudness: { target: number | null; true_peak: number; measured_before: number | null; applied: boolean };
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;

export function audibleSources(r: Resolved): RMedia[] {
  const muted = new Set(r.tracks.filter((t) => t.mute).map((t) => t.id));
  return r.media.filter((m) => m.withAudio && m.asset.has_audio && m.asset.path && !muted.has(m.track) && m.frames > 0);
}

/** Gain envelope for a ducked track: 1 outside the spans, 10^(db/20) inside, linear ramps of attack/release. */
export function duckExpr(spans: [number, number][], db: number, attack: number, release: number): string {
  const g = 10 ** (db / 20);
  const envs = spans.map(([a, b]) =>
    `clip(min((t-${r3(a - attack)})/${r3(attack)},(${r3(b + release)}-t)/${r3(release)}),0,1)`);
  const env = envs.reduce((acc, e) => (acc ? `max(${acc},${e})` : e), "");
  return `1-${r3(1 - g)}*${env}`;
}

export function mixAudio(r: Resolved, outWav: string, tmpDir: string): MixReport | null {
  const fps = r.canvas.fps;
  const total = r.frames / fps;
  const src = audibleSources(r);
  if (!src.length) return null;
  const args: string[] = ["-v", "error", "-y"];
  const chains: string[] = [];
  const byTrack = new Map<string, string[]>();
  src.forEach((m, i) => {
    const dur = m.frames / fps;
    args.push("-ss", String(r3(m.srcIn)), "-t", String(r3(dur)), "-i", m.asset.path!);
    const f = [`aresample=${MIX_RATE}`, "aformat=sample_fmts=fltp:channel_layouts=stereo", `volume=${m.gainDb}dB`];
    if (m.fade.in > 0) f.push(`afade=t=in:st=0:d=${r3(m.fade.in)}`);
    if (m.fade.out > 0) f.push(`afade=t=out:st=${r3(Math.max(0, dur - m.fade.out))}:d=${r3(m.fade.out)}`);
    const ms = Math.round((m.start / fps) * 1000);
    f.push(`adelay=${ms}:all=1`, `apad=whole_dur=${r3(total)}`, `atrim=0:${r3(total)}`);
    chains.push(`[${i}:a]${f.join(",")}[s${i}]`);
    byTrack.set(m.track, [...(byTrack.get(m.track) ?? []), `[s${i}]`]);
  });
  const ducks: MixReport["ducks"] = [];
  const trackOut: string[] = [];
  for (const [tid, ins] of byTrack) {
    const sum = ins.length > 1 ? `${ins.join("")}amix=inputs=${ins.length}:normalize=0:dropout_transition=0` : `${ins[0]}anull`;
    const t = r.tracks.find((x) => x.id === tid);
    let chain = sum;
    if (t?.duck) {
      const spans = src.filter((m) => m.track === t.duck!.by).map((m) => [m.start / fps, (m.start + m.frames) / fps] as [number, number]);
      const db = t.duck.db ?? -12;
      if (spans.length) chain += `,volume='${duckExpr(spans, db, t.duck.attack ?? 0.25, t.duck.release ?? 0.5)}':eval=frame`;
      ducks.push({ track: tid, by: t.duck.by, db, spans: spans.length });
    }
    chains.push(`${chain}[t_${tid}]`);
    trackOut.push(`[t_${tid}]`);
  }
  chains.push(`${trackOut.join("")}amix=inputs=${trackOut.length}:normalize=0:dropout_transition=0,atrim=0:${r3(total)}[mix]`);
  const raw = path.join(tmpDir, "mix.raw.wav");
  const m1 = run("ffmpeg", [...args, "-filter_complex", chains.join(";"), "-map", "[mix]", "-c:a", "pcm_f32le", "-ar", String(MIX_RATE), raw]);
  if (m1.status !== 0) throw new VosError("mix_failed", "ffmpeg could not mix the timeline audio", m1.stderr.slice(-600));

  const target = r.master.loudness;
  const tp = r.master.true_peak;
  let before: number | null = null;
  let applied = false;
  if (target !== null) {
    const meas = run("ffmpeg", ["-v", "info", "-i", raw, "-af", `loudnorm=I=${target}:TP=${tp}:LRA=11:print_format=json`, "-f", "null", "-"]);
    const js = meas.stderr.slice(meas.stderr.lastIndexOf("{"));
    let j: any = null;
    try {
      j = JSON.parse(js.slice(0, js.indexOf("}") + 1));
    } catch {
      j = null;
    }
    const I = j ? Number(j.input_i) : NaN;
    if (j && Number.isFinite(I) && I > -70) {
      before = I;
      const ln = `loudnorm=I=${target}:TP=${tp}:LRA=11:measured_I=${j.input_i}:measured_TP=${j.input_tp}:measured_LRA=${j.input_lra}:measured_thresh=${j.input_thresh}:offset=${j.target_offset}:linear=true`;
      const m2 = run("ffmpeg", ["-v", "error", "-y", "-i", raw, "-af", `${ln},aresample=${MIX_RATE}`, "-c:a", "pcm_s24le", outWav]);
      if (m2.status !== 0) throw new VosError("mix_failed", "ffmpeg loudness normalisation failed", m2.stderr.slice(-600));
      applied = true;
    }
  }
  if (!applied) {
    const c = run("ffmpeg", ["-v", "error", "-y", "-i", raw, "-c:a", "pcm_s24le", outWav]);
    if (c.status !== 0) throw new VosError("mix_failed", "could not write the mix", c.stderr.slice(-300));
  }
  fs.rmSync(raw, { force: true });
  return { mixer: "vos-ffmpeg/1", sources: src.length, tracks: [...byTrack.keys()], ducks,
    loudness: { target, true_peak: tp, measured_before: before, applied } };
}

/** Replace the audio of a rendered video with the vos mix (video stream copied untouched). */
export function muxAudio(video: string, wav: string, out: string, seconds: number): void {
  const r = run("ffmpeg", ["-v", "error", "-y", "-i", video, "-i", wav, "-map", "0:v", "-map", "1:a", "-c:v", "copy",
    "-c:a", "aac", "-b:a", "256k", "-ar", String(MIX_RATE), "-t", String(r3(seconds)), out]);
  if (r.status !== 0 || !fs.existsSync(out)) throw new VosError("mux_failed", "could not attach the mix to the render", r.stderr.slice(-400));
}
