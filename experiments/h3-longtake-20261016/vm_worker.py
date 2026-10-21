"""Runs only inside this pilot's isolated, guarded Colab VM."""
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import threading
import time
import traceback
import urllib.request
import uuid

PILOT = Path("/content/h3pilot")
os.environ["VOSGEN_ROOT"] = str(PILOT / "runtime")
os.environ["VOSGEN_COMFY"] = "/content/ComfyUI"
exec(compile((PILOT / "base_worker.py").read_text(), str(PILOT / "base_worker.py"), "exec"), globals())
sys.path.insert(0, str(PILOT))
from workflow import build_graph, delivered_frames, FPS

LOCK = json.loads((PILOT / "source-lock.json").read_text())
COMFY_REV = LOCK["comfy"]["rev"]
WEIGHTS = [item for item in WEIGHTS if item[1] != "loras"] + [REF_WEIGHTS[0]]


def pilot_setup():
    t0 = time.time()
    try:
        subprocess.run(["git", "clone", "--quiet", f"https://github.com/{LOCK['comfy']['repo']}.git", COMFY], check=True)
        for key in ("motion", "longtake", "hybrid"):
            info = LOCK[key]
            dest = Path(COMFY) / "custom_nodes" / f"pilot_{key}"
            dest.parent.mkdir(parents=True, exist_ok=True)
            subprocess.run(["git", "clone", "--quiet", f"https://github.com/{info['repo']}.git", str(dest)], check=True)
            subprocess.run(["git", "checkout", "--quiet", info["rev"]], cwd=dest, check=True)
        _bootstrap()
        if STATE["boot"]["state"] != "ready":
            raise RuntimeError(STATE["boot"].get("error"))
        shutil.copy2(PILOT / "character.png", Path(COMFY) / "input" / "character.png")
        info = json.load(urllib.request.urlopen(f"{URL}/object_info", timeout=20))
        prompt = (PILOT / "prompt.txt").read_text()
        graphs = [build_graph(i, prompt) for i in (1, 2, 3)]
        missing = sorted({n["class_type"] for g in graphs for n in g.values()} - set(info))
        if missing:
            raise RuntimeError(f"Missing node classes: {missing}")
        schemas = {name: info[name] for name in {n["class_type"] for n in graphs[0].values()}}
        _write(str(PILOT / "schemas.json"), schemas)
        rep = {"state": "ready", "sec": round(time.time() - t0, 1),
               "comfy_rev": COMFY_REV, "weights_rev": WEIGHTS_REV,
               "torch": STATE["torch"], "flags": STATE["flags"],
               "gpu": _sh("nvidia-smi --query-gpu=name,memory.total --format=csv,noheader", False).strip(),
               "boot": STATE["boot"]}
    except Exception:
        rep = {"state": "error", "error": traceback.format_exc()[-5000:]}
    _write(str(PILOT / "setup.json"), rep, str(PILOT / "setup.done"))


def pilot_segment(index):
    start = time.time()
    receipt = {"segment": index, "state": "running", "comfy_rev": COMFY_REV,
               "weights_rev": WEIGHTS_REV, "sources": LOCK}
    done = str(PILOT / f"segment_{index:02d}.done")
    try:
        graph = build_graph(index, (PILOT / "prompt.txt").read_text())
        _write(str(PILOT / f"graph_{index:02d}.json"), graph)
        pid = _post("/prompt", {"prompt": graph, "client_id": str(uuid.uuid4())})["prompt_id"]
        receipt["prompt_id"] = pid
        while True:
            history = json.load(urllib.request.urlopen(f"{URL}/history/{pid}", timeout=20))
            status = history.get(pid, {}).get("status", {})
            if pid in history and (status.get("completed") or status.get("status_str") == "error"):
                break
            if STATE["server"].poll() is not None:
                raise RuntimeError("ComfyUI stopped")
            if time.time() - start > 1500:
                _post("/interrupt", {})
                raise TimeoutError("Segment exceeded 25 minutes")
            time.sleep(2)
        entry = history[pid]
        _write(str(PILOT / f"history_{index:02d}.json"), entry)
        if entry.get("status", {}).get("status_str") != "success":
            raise RuntimeError(json.dumps(entry.get("status"), ensure_ascii=False)[-6000:])
        outputs = {}
        for label in ("base", "refined"):
            files = [f for values in entry["outputs"][f"save_{label}"].values() if isinstance(values, list)
                     for f in values if isinstance(f, dict) and f.get("type") == "output"
                     and f.get("filename", "").endswith(".mp4")]
            if len(files) != 1:
                raise RuntimeError(f"Unexpected saved videos: {files}")
            f = files[0]
            source = Path(COMFY) / "output" / f.get("subfolder", "") / f["filename"]
            target = PILOT / f"segment_{index:02d}_{label}.mp4"
            shutil.copy2(source, target)
            outputs[label] = {"path": str(target), "bytes": target.stat().st_size,
                              "sha256": hashlib.sha256(target.read_bytes()).hexdigest()}
        latent = Path(COMFY) / "output" / "h3pilot" / "latents" / f"clip_{index:05d}.safetensors"
        if not latent.is_file():
            raise RuntimeError(f"Missing next-segment latent: {latent}")
        receipt.update(state="ok", outputs=outputs, delivered_frames=delivered_frames(index), fps=FPS,
                       latent_bytes=latent.stat().st_size, graph_sha256=hashlib.sha256(json.dumps(graph,sort_keys=True).encode()).hexdigest())
    except Exception:
        receipt.update(state="error", error=traceback.format_exc()[-6500:],
                       log_tail=(Path(ROOT) / "server.log").read_text()[-6500:])
    receipt["sec"] = round(time.time() - start, 1)
    _write(str(PILOT / f"segment_{index:02d}.json"), receipt, done)


def pilot_launch(phase, index=0):
    marker = PILOT / ("setup.started" if phase == "setup" else f"segment_{index:02d}.started")
    if marker.exists():
        print(json.dumps({"ok": True, "duplicate": True, "phase": phase, "index": index}))
        return
    marker.touch()
    target = pilot_setup if phase == "setup" else lambda: pilot_segment(index)
    threading.Thread(target=target, daemon=True, name=f"pilot-{phase}-{index}").start()
    print(json.dumps({"ok": True, "started": phase, "index": index}))
