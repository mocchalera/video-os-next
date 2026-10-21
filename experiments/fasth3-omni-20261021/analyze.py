"""Measure generated sources without altering the original videos or audio."""
import argparse
import json
from pathlib import Path
import re
import subprocess

HERE = Path(__file__).resolve().parent
OUT = HERE / "outputs"


def run(args):
    return subprocess.run(args, capture_output=True, text=True, check=True)


def measure(file):
    probe = json.loads(run(["ffprobe", "-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json", str(file)]).stdout)
    video = next(s for s in probe["streams"] if s["codec_type"] == "video")
    audio = next((s for s in probe["streams"] if s["codec_type"] == "audio"), None)
    report = {"video": {k: video.get(k) for k in ("width", "height", "avg_frame_rate", "nb_read_frames", "duration", "codec_name")},
              "audio": {k: audio.get(k) for k in ("sample_rate", "channels", "duration", "codec_name")} if audio else None,
              "duration": probe["format"].get("duration")}
    for label, vf in {"black": "blackdetect=d=0.1:pix_th=0.08", "freeze": "freezedetect=n=0.002:d=0.6"}.items():
        stderr = run(["ffmpeg", "-hide_banner", "-nostats", "-i", str(file), "-vf", vf, "-an", "-f", "null", "-"]).stderr
        report[label + "_events"] = [line for line in stderr.splitlines() if re.search(r"(black|freeze)_(start|end|duration)", line)]
    if audio:
        stderr = run(["ffmpeg", "-hide_banner", "-nostats", "-i", str(file), "-af", "ebur128=peak=true", "-vn", "-f", "null", "-"]).stderr
        summary = stderr.split("Summary:")[-1]
        i = re.search(r"I:\s+(-?[\d.]+) LUFS", summary)
        peak = re.search(r"Peak:\s+(-?[\d.]+) dBFS", summary.split("True peak:")[-1])
        report["loudness"] = {"integrated_lufs": float(i[1]) if i else None, "true_peak_dbfs": float(peak[1]) if peak else None}
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--include-retry", action="store_true", help="Combine the original run and the separately approved FastH3 retry")
    parser.add_argument("--include-recovery", action="store_true", help="Also include the user-directed recovery after GPU verification was fixed")
    parser.add_argument("--include-schema", action="store_true", help="Include the retry after fixing V3 combo schema parsing")
    args = parser.parse_args()
    results = []
    compare = args.include_retry or args.include_recovery or args.include_schema
    sources = ["run.json"] + (["retry-run.json"] if compare else []) + (["recovery-run.json"] if args.include_recovery or args.include_schema else []) + (["schema-run.json"] if args.include_schema else [])
    for source in sources:
        record = json.loads((OUT / source).read_text())
        for phase in record.get("phases", []):
            for clip in phase.get("clips", []):
                file = HERE / "project" / clip["file"]
                result = {"model": phase["model"], "seed": clip["seed"], "file": clip["file"],
                          "request_id": clip["request_id"], "vm_sec": clip["sec"], "wall_sec": clip["wall_sec"],
                          **measure(file)}
                if compare:
                    result["source_run"] = source
                results.append(result)
    target = "measurements-schema.json" if args.include_schema else "measurements-recovery.json" if args.include_recovery else "measurements-comparison.json" if compare else "measurements.json"
    (OUT / target).write_text(json.dumps(results, indent=2) + "\n")
    print(json.dumps(results, indent=2))
