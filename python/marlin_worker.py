#!/usr/bin/env python3
"""Marlin-2B one-shot worker for video-os-next.

Usage:
  python marlin_worker.py caption <video> [<video> …]   (one JSON line per video; model loads once)
  python marlin_worker.py find <video> "<event description>"

Prints one JSON object on stdout. Requires torch + transformers and a local
NemoStation/Marlin-2B snapshot (HF_HUB_OFFLINE=1 is honoured).
"""
import json
import os
import sys


def main() -> int:
    if len(sys.argv) < 3 or sys.argv[1] not in ("caption", "find"):
        print(__doc__, file=sys.stderr)
        return 2
    mode, video = sys.argv[1], sys.argv[2]
    try:
        import torch
        from transformers import AutoModelForCausalLM
    except Exception as exc:  # pragma: no cover
        print(json.dumps({"ok": False, "error": f"missing deps: {exc}"}))
        return 3
    model_id = os.environ.get("VOS_MARLIN_MODEL", "NemoStation/Marlin-2B")
    model = AutoModelForCausalLM.from_pretrained(
        model_id, trust_remote_code=True, dtype=getattr(torch, "bfloat16", None), device_map="auto"
    )
    if mode == "caption":
        for v in sys.argv[2:]:
            try:
                res = model.caption(v, max_new_tokens=int(os.environ.get("VOS_MARLIN_MAX_TOKENS", "2048")))
                if not isinstance(res, dict):
                    res = {"caption": str(res), "events": []}
                print(json.dumps({"ok": True, "model": model_id, "video": v, "result": res}, ensure_ascii=False, default=str), flush=True)
            except Exception as exc:  # keep going; report per video
                print(json.dumps({"ok": False, "video": v, "error": str(exc)}), flush=True)
        return 0
    else:
        query = sys.argv[3] if len(sys.argv) > 3 else "the strongest action moment"
        res = model.find(video, event=query)
        res = {"query": query, **res} if isinstance(res, dict) else {"query": query, "span": res}
    print(json.dumps({"ok": True, "model": model_id, "result": res}, ensure_ascii=False, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
