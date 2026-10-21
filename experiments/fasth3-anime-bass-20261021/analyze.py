"""Measure and prepare previews of completed takes; no provider calls or audio changes."""
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess

HERE = Path(__file__).resolve().parent
OUT = HERE / "outputs"
ROOT = HERE.parent.parent
spec = importlib.util.spec_from_file_location("aircraft_measure", HERE.parent / "fasth3-omni-20261021/analyze.py")
measurement = importlib.util.module_from_spec(spec)
spec.loader.exec_module(measurement)


def main():
    record = json.loads((OUT / "run.json").read_text())
    results = []
    for phase in record["phases"]:
        for clip in phase["clips"]:
            alias = ("fast" if phase["model"] == "fasth3-omni" else "legacy") + "_" + str(clip["seed"])
            media = HERE / "project" / clip["file"]
            assert hashlib.sha256(media.read_bytes()).hexdigest() == clip["verified"]["sha256"]
            assert media.stat().st_size == clip["verified"]["bytes"]
            preview = OUT / (alias + ".mp4")
            if not preview.exists():
                shutil.copy2(media, preview)
            assert preview.read_bytes() == media.read_bytes()
            history = json.loads((OUT / ("history_" + clip["request_id"] + ".json")).read_text())
            matching = []
            for job in history.values():
                nodes = next((x for x in job["prompt"] if isinstance(x, dict)), {})
                prefix = nodes.get("save", {}).get("inputs", {}).get("filename_prefix")
                if prefix == "vosgen/" + clip["request_id"]:
                    assert job["status"]["status_str"] == "success"
                    assert nodes["noise"]["inputs"]["noise_seed"] == clip["seed"]
                    assert nodes["sched"]["inputs"]["steps"] == clip["receipt"]["request"]["steps"]
                    assert nodes["unet"]["inputs"]["unet_name"] == clip["receipt"]["request"]["unet"]
                    if phase["model"] == "fasth3-omni":
                        assert nodes["sampler"]["inputs"]["sampler_name"] == "euler"
                        assert nodes["backend"]["inputs"]["attention"] == "comfy kitchen attention"
                        assert nodes["sparse"]["inputs"]["selection"] == "vsa"
                        assert nodes["sparse"]["inputs"]["selection.keep_percent"] == 10
                        assert nodes["shift"]["inputs"]["shift_video"] == 12
                        assert nodes["shift"]["inputs"]["shift_audio"] == 3
                    matching.append(nodes)
            assert len(matching) == 1, "Missing or duplicate matching successful ComfyUI job"
            report = {"model": phase["model"], "seed": clip["seed"], "alias": alias,
                      "request_id": clip["request_id"], "file": clip["file"],
                      "sha256": clip["verified"]["sha256"], "vm_sec": clip["sec"],
                      "wall_sec": clip["wall_sec"], "history_recipe_verified": True, **measurement.measure(media)}
            assert report["video"]["width"] == 1344 and report["video"]["height"] == 768
            assert report["video"]["avg_frame_rate"] == "24/1" and int(report["video"]["nb_read_frames"]) == 124
            assert report["audio"] is not None
            sheet = OUT / (alias + "-sheet.png")
            if not sheet.exists():
                subprocess.run(["node", str(ROOT / "src/cli.ts"), "look", alias, "--project", str(HERE / "project"),
                                "--at", "0,0.75,1.5,2.25,3,3.75,4.5,5", "--width", "448", "--cols", "4",
                                "--out", str(sheet), "--json"], check=True, capture_output=True, text=True, timeout=60)
            hand = OUT / (alias + "-right-hand.png")
            if not hand.exists():
                subprocess.run(["ffmpeg", "-v", "error", "-y", "-t", "1", "-i", str(media), "-vf",
                                "fps=8,crop=260:260:270:290,scale=390:390,tile=4x2:padding=4:color=0x111111",
                                "-frames:v", "1", str(hand)], check=True, capture_output=True, timeout=30)
            results.append(report)
    (OUT / "measurements.json").write_text(json.dumps(results, indent=2) + "\n")
    if len(results) == 4 and not (OUT / "comparison-silent.mp4").exists():
        # Synchronized review copy. Keep originals and their audio untouched.
        aliases = ["fast_1", "fast_2", "legacy_1", "legacy_2"]
        filters = []
        font = "/System/Library/Fonts/Menlo.ttc"
        for i, alias in enumerate(aliases):
            filters.append(f"[{i}:v]scale=672:384,drawbox=x=0:y=0:w=iw:h=32:color=black@0.7:t=fill,"
                           f"drawtext=fontfile='{font}':text='{alias}':x=12:y=7:fontsize=20:fontcolor=white[v{i}]")
        filters.append("[v0][v1][v2][v3]xstack=inputs=4:layout=0_0|672_0|0_384|672_384:shortest=1[v]")
        inputs = [arg for alias in aliases for arg in ("-i", str(OUT / (alias + ".mp4")))]
        subprocess.run(["ffmpeg", "-v", "error", "-y", *inputs, "-filter_complex", ";".join(filters),
                        "-map", "[v]", "-an", "-c:v", "libx264", "-crf", "18", "-preset", "fast",
                        "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(OUT / "comparison-silent.mp4")],
                       check=True, capture_output=True, timeout=90)
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
