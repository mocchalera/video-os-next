#!/usr/bin/env python3
"""Embedding worker for video-os-next.

  python embed_worker.py <channel> <request.json> <out.f32>

channel   text   → multilingual-e5-small (ONNX, local)          dim 384
          visual → Qwen/Qwen3-VL-Embedding-2B (sentence-transformers)  dim 2048
          audio  → laion/clap-htsat-fused (transformers)        dim 512
request   {"items": [ {"kind":"text","text":"…","role":"query|passage"}
                    | {"kind":"image","path":"…"}
                    | {"kind":"audio","path":"…wav","start":s,"end":e} ]}
output    row-major float32 little-endian, L2-normalised, one row per item.
stdout    one JSON line: {"ok":true,"dim":D,"n":N,"model":"…","device":"…"}

VOS_EMBED_MOCK=1 produces deterministic hash vectors (dim 64) without loading any model,
so the Node side can be tested anywhere.
"""
import hashlib
import json
import os
import struct
import sys

MODELS = {
    "text": os.environ.get("VOS_TEXT_MODEL", "~/.cache/vos/models/multilingual-e5-small"),
    "visual": os.environ.get("VOS_VISUAL_MODEL", "Qwen/Qwen3-VL-Embedding-2B"),
    "audio": os.environ.get("VOS_AUDIO_MODEL", "laion/clap-htsat-fused"),
}
VISUAL_INSTRUCTION = "Retrieve images or text relevant to the user's query."


def fail(code, msg):
    print(json.dumps({"ok": False, "code": code, "error": msg}))
    sys.exit(3)


def normalise(rows):
    import numpy as np
    a = np.asarray(rows, dtype="float32")
    n = np.linalg.norm(a, axis=1, keepdims=True)
    n[n == 0] = 1
    return a / n


def item_key(it):
    if it["kind"] == "text":
        return f"text:{it.get('role','passage')}:{it['text']}"
    if it["kind"] == "image":
        with open(it["path"], "rb") as f:
            return "image:" + hashlib.sha256(f.read()).hexdigest()
    return f"audio:{it['path']}:{it.get('start',0):.3f}:{it.get('end',0):.3f}"


def mock(items):
    rows = []
    for it in items:
        h = hashlib.sha256(item_key(it).encode()).digest()
        # expand to 64 floats; words shared between texts share components so tests can rank
        v = [((h[i % 32] ^ (i * 29)) % 255) / 127.0 - 1 for i in range(64)]
        if it["kind"] == "text":
            for w in it["text"].lower().split():
                wh = hashlib.sha256(w.encode()).digest()
                for i in range(64):
                    v[i] += (wh[i % 32] / 127.0 - 1) * 2
        rows.append(v)
    return normalise(rows), "mock", "cpu"


def device():
    import torch
    return "mps" if torch.backends.mps.is_available() else ("cuda" if torch.cuda.is_available() else "cpu")


def text_e5(items):
    import numpy as np
    import onnxruntime as ort
    from tokenizers import Tokenizer
    root = os.path.expanduser(MODELS["text"])
    onnx = os.path.join(root, "onnx", "model_quantized.onnx")
    if not os.path.exists(onnx):
        fail("model_missing", f"text model not found at {root}")
    tok = Tokenizer.from_file(os.path.join(root, "tokenizer.json"))
    tok.enable_truncation(max_length=256)
    sess = ort.InferenceSession(onnx, providers=["CPUExecutionProvider"])
    rows = []
    for i in range(0, len(items), 32):
        batch = items[i : i + 32]
        texts = [("query: " if it.get("role") == "query" else "passage: ") + it["text"] for it in batch]
        enc = tok.encode_batch(texts)
        L = max(len(e.ids) for e in enc)
        ids = np.array([e.ids + [1] * (L - len(e.ids)) for e in enc], dtype="int64")
        mask = np.array([[1] * len(e.ids) + [0] * (L - len(e.ids)) for e in enc], dtype="int64")
        out = sess.run(None, {"input_ids": ids, "attention_mask": mask, "token_type_ids": np.zeros_like(ids)})[0]
        pooled = (out * mask[..., None]).sum(1) / mask.sum(1, keepdims=True)
        rows.extend(pooled.tolist())
    return normalise(rows), "multilingual-e5-small (onnx q8)", "cpu"


def visual_qwen(items):
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    import torch
    from sentence_transformers import SentenceTransformer
    dev = device()
    kw = {"device": dev, "trust_remote_code": True}
    if dev == "mps":
        kw["model_kwargs"] = {"torch_dtype": torch.float16}
    try:
        model = SentenceTransformer(MODELS["visual"], **kw)
    except Exception as e:  # noqa: BLE001
        fail("model_missing", f"{MODELS['visual']}: {e}")
    rows = []
    for it in items:  # one at a time: mixed modalities, bounded memory
        payload = it["text"] if it["kind"] == "text" else {"image": it["path"]}
        kwargs = {"convert_to_numpy": True, "normalize_embeddings": False, "show_progress_bar": False}
        if it["kind"] == "text":
            kwargs["prompt"] = VISUAL_INSTRUCTION
        rows.append(model.encode([payload], **kwargs)[0].astype("float32").tolist())
    return normalise(rows), MODELS["visual"], dev


def audio_clap(items):
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    import librosa
    import torch
    from transformers import ClapModel, ClapProcessor
    dev = device()
    try:
        proc = ClapProcessor.from_pretrained(MODELS["audio"])
        model = ClapModel.from_pretrained(MODELS["audio"]).to(dev).eval()
    except Exception as e:  # noqa: BLE001
        fail("model_missing", f"{MODELS['audio']}: {e}")
    rows, cache = [], {}
    with torch.no_grad():
        for it in items:
            if it["kind"] == "text":
                inp = proc(text=[it["text"]], return_tensors="pt", padding=True).to(dev)
                v = model.get_text_features(**inp)
            else:
                if it["path"] not in cache:
                    cache[it["path"]] = librosa.load(it["path"], sr=48000, mono=True)[0]
                y = cache[it["path"]][int(it["start"] * 48000) : int(it["end"] * 48000)]
                inp = proc(audio=[y], sampling_rate=48000, return_tensors="pt").to(dev)
                v = model.get_audio_features(**inp)
            # transformers ≥5 returns a ModelOutput; the projected 512-d embedding is pooler_output
            v = getattr(v, "pooler_output", v)
            rows.append(v[0].float().cpu().numpy().tolist())
    return normalise(rows), MODELS["audio"], dev


def main():
    if len(sys.argv) != 4 or sys.argv[1] not in MODELS:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    channel, req_path, out_path = sys.argv[1:]
    items = json.load(open(req_path))["items"]
    if not items:
        fail("empty", "no items")
    if os.environ.get("VOS_EMBED_MOCK") == "1":
        arr, model, dev = mock(items)
    else:
        arr, model, dev = {"text": text_e5, "visual": visual_qwen, "audio": audio_clap}[channel](items)
    with open(out_path, "wb") as f:
        f.write(arr.astype("<f4").tobytes())
    print(json.dumps({"ok": True, "dim": int(arr.shape[1]), "n": int(arr.shape[0]), "model": model, "device": dev}))


if __name__ == "__main__":
    main()
