"""vos transcribe worker: speech → segments + word timings with faster-whisper, offline only (cached models).

    python asr_worker.py --file in.wav --out transcript.json [--model small] [--lang ja] [--vocab "紙の船, 路地"]

Prints one JSON line {"ok": true, ...} or {"ok": false, "error": ...}. Never downloads a model: a missing model is
reported, not fetched (HF_HUB_OFFLINE=1), so network use stays a human decision.
"""
import argparse
import json
import os
import sys
import time

os.environ.setdefault("HF_HUB_OFFLINE", "1")

ap = argparse.ArgumentParser()
ap.add_argument("--file", required=True)
ap.add_argument("--out", required=True)
ap.add_argument("--model", default="small")
ap.add_argument("--lang", default=None)
ap.add_argument("--vocab", default="")
ap.add_argument("--device", default="cpu")
ap.add_argument("--compute", default="int8")
# singing: Silero VAD (tuned for speech) drops sung vocals over music; the song is transcribed without it
ap.add_argument("--no-vad", action="store_true")
a = ap.parse_args()

try:
    import faster_whisper
    from faster_whisper import WhisperModel

    t0 = time.time()
    model = WhisperModel(a.model, device=a.device, compute_type=a.compute)
    segs, info = model.transcribe(
        a.file, language=a.lang or None, word_timestamps=True, vad_filter=not a.no_vad, beam_size=5,
        # vocabulary bias: proper nouns / terms of this piece (e.g. 紙の船 so it is not heard as 髪の船)
        initial_prompt=a.vocab or None, hotwords=a.vocab or None, condition_on_previous_text=False)
    out = []
    for s in segs:
        out.append({
            "start": round(s.start, 3), "end": round(s.end, 3), "text": s.text.strip(),
            "words": [{"start": round(w.start, 3), "end": round(w.end, 3), "word": w.word, "p": round(w.probability, 3)}
                      for w in (s.words or [])],
        })
    rec = {"language": info.language, "language_probability": round(info.language_probability, 3),
           "duration": round(info.duration, 3), "segments": out,
           "engine": f"faster-whisper {faster_whisper.__version__}", "model": a.model, "sec": round(time.time() - t0, 1)}
    with open(a.out, "w") as f:
        json.dump(rec, f, ensure_ascii=False)
    print(json.dumps({"ok": True, "segments": len(out), "language": info.language, "sec": rec["sec"]}))
except Exception as e:  # noqa: BLE001
    msg = f"{type(e).__name__}: {e}"
    if "offline" in msg.lower() or "LocalEntryNotFound" in msg or "not found" in msg.lower():
        msg += " — the model is not cached on this machine; downloading it is a network step for the human to approve"
    print(json.dumps({"ok": False, "error": msg}))
    sys.exit(1)
