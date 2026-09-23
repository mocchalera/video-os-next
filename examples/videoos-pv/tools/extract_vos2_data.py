"""Derive data/*.json for the PV graphics from the video-os-v2 project of 回っているよ.
Everything on screen in BUILD / REFINE comes from these files (bound via props {"$data": ...})."""
import hashlib, json, sys, yaml, pathlib
src = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "/Users/mocchalera/Dev/video-os-v2-spec/projects/mawatteiru-yo-20260902")
tl_path = src / "05_timeline/timeline.json"
tl = json.loads(tl_path.read_text())
fps = tl["sequence"]["fps_num"] / tl["sequence"]["fps_den"]
labels = {m["frame"]: m["label"] for m in tl["markers"]}
clips = [
    {"beat": c["beat_id"], "asset": c["asset_id"], "frame": c["timeline_in_frame"], "frames": c["timeline_duration_frames"],
     "label": labels.get(c["timeline_in_frame"], "").split(": ", 1)[-1]}
    for c in tl["tracks"]["video"][0]["clips"]
]
brief = yaml.safe_load((src / "01_intent/creative_brief.yaml").read_text())
cut = {"source": str(tl_path.relative_to(src.parent.parent)), "sha256": hashlib.sha256(tl_path.read_bytes()).hexdigest(),
       "fps": fps, "total_frames": clips[-1]["frame"] + clips[-1]["frames"], "clips": clips,
       "emotion_curve": brief.get("emotion_curve", [])}
review = yaml.safe_load((src / "06_review/review_report.yaml").read_text())
rev = {"status": review["summary_judgment"]["status"], "confidence": review["summary_judgment"]["confidence"],
       "strength": review["strengths"][0]["summary"]}
out = pathlib.Path(__file__).resolve().parent.parent / "data"
out.mkdir(exist_ok=True)
(out / "mawatteiru-cut.json").write_text(json.dumps(cut, ensure_ascii=False, indent=2) + "\n")
(out / "mawatteiru-review.json").write_text(json.dumps(rev, ensure_ascii=False, indent=2) + "\n")
print("ok", len(clips), "clips", cut["sha256"][:12])
