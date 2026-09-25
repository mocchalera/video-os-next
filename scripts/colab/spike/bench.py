"""Stage B benchmark harness for the MiniMax-H3 on Colab spike. Runs ON the Colab VM.

Kernel state persists across `colab exec` calls, so this is written as a module of
functions: exec it once, then drive it with small snippets.

    colab exec -s h3 -f scripts/colab/spike/bench.py
    echo 'setup_comfy(); start_server(["--use-sage-attention"])' | colab exec -s h3
    echo 'print(run(WF, {"6.inputs.steps": 8}, label="sage-8step"))' | colab exec -s h3

Every run records wall time, queue→done time, and peak VRAM (nvidia-smi sampling),
and appends to /content/bench/results.jsonl. Nothing here guesses node names: the
API-format workflow is loaded from a file and overridden by "<node>.inputs.<key>" paths.
"""
import json
import os
import subprocess
import threading
import time
import urllib.request
import uuid

COMFY = "/content/ComfyUI"
BENCH = "/content/bench"
URL = "http://127.0.0.1:8188"
os.makedirs(BENCH, exist_ok=True)
_server = None


def sh(cmd: str, check: bool = True) -> str:
    r = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    if check and r.returncode != 0:
        raise RuntimeError(f"{cmd}\n{r.stderr[-2000:]}")
    return r.stdout


def setup_comfy(ref: str = "master", extra_pip: tuple[str, ...] = ()) -> dict:
    t = time.time()
    if not os.path.isdir(COMFY):
        sh(f"git clone -q https://github.com/comfyanonymous/ComfyUI.git {COMFY}")
    sh(f"cd {COMFY} && git fetch -q && git checkout -q {ref}")
    sh(f"cd {COMFY} && pip install -q -r requirements.txt")
    if extra_pip:
        sh("pip install -q " + " ".join(extra_pip))
    return {"comfy_rev": sh(f"cd {COMFY} && git rev-parse --short HEAD").strip(), "sec": round(time.time() - t, 1)}


def fetch(repo: str, path: str, subdir: str) -> dict:
    """Download one weight file from HF straight to the VM's local disk (not Drive)."""
    from huggingface_hub import hf_hub_download

    t = time.time()
    dest = f"{COMFY}/models/{subdir}"
    p = hf_hub_download(repo, path, local_dir=dest)
    name = os.path.basename(path)
    if os.path.dirname(path):  # flatten so ComfyUI sees it by file name
        os.replace(p, f"{dest}/{name}")
    size = os.path.getsize(f"{dest}/{name}")
    dt = time.time() - t
    return {"file": name, "gb": round(size / 1e9, 2), "sec": round(dt, 1), "mb_s": round(size / 1e6 / max(dt, 1e-3), 1)}


def start_server(flags: list[str] | None = None, timeout: int = 600) -> dict:
    global _server
    stop_server()
    args = ["python", "main.py", "--listen", "127.0.0.1", "--port", "8188", *(flags or [])]
    log = open(f"{BENCH}/server.log", "w")
    t = time.time()
    _server = subprocess.Popen(args, cwd=COMFY, stdout=log, stderr=subprocess.STDOUT)
    while time.time() - t < timeout:
        try:
            urllib.request.urlopen(f"{URL}/system_stats", timeout=2)
            return {"flags": flags or [], "boot_sec": round(time.time() - t, 1)}
        except Exception:  # noqa: BLE001
            if _server.poll() is not None:
                raise RuntimeError("server exited:\n" + open(f"{BENCH}/server.log").read()[-3000:])
            time.sleep(1)
    raise TimeoutError("ComfyUI did not come up")


def stop_server() -> None:
    global _server
    if _server and _server.poll() is None:
        _server.terminate()
        _server.wait(30)
    _server = None


def _post(path: str, body: dict) -> dict:
    req = urllib.request.Request(f"{URL}{path}", json.dumps(body).encode(), {"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req))


def _get(path: str) -> dict:
    return json.load(urllib.request.urlopen(f"{URL}{path}"))


def load_workflow(path: str) -> dict:
    with open(path) as f:
        return json.load(f)


def apply(wf: dict, overrides: dict) -> dict:
    wf = json.loads(json.dumps(wf))
    for key, val in overrides.items():
        node, _, rest = key.partition(".")
        cur = wf[node]
        parts = rest.split(".")
        for p in parts[:-1]:
            cur = cur[p]
        cur[parts[-1]] = val
    return wf


class _VramPeak(threading.Thread):
    def __init__(self) -> None:
        super().__init__(daemon=True)
        self.peak, self.done = 0, False

    def run(self) -> None:
        while not self.done:
            out = sh("nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits", check=False)
            try:
                self.peak = max(self.peak, int(out.strip().splitlines()[0]))
            except Exception:  # noqa: BLE001
                pass
            time.sleep(0.5)


def run(wf: dict, overrides: dict | None = None, label: str = "", timeout: int = 3600) -> dict:
    """Queue one prompt, wait for it, return timing + outputs. Appends to results.jsonl."""
    prompt = apply(wf, overrides or {})
    mon = _VramPeak()
    mon.start()
    t0 = time.time()
    pid = _post("/prompt", {"prompt": prompt, "client_id": str(uuid.uuid4())})["prompt_id"]
    while True:
        h = _get(f"/history/{pid}")
        if pid in h and h[pid].get("status", {}).get("completed") is not None:
            break
        if time.time() - t0 > timeout:
            raise TimeoutError(pid)
        time.sleep(1)
    mon.done = True
    entry = h[pid]
    files = [
        f"{COMFY}/output/{o.get('subfolder', '')}/{o['filename']}".replace("//", "/")
        for node in entry.get("outputs", {}).values()
        for kind in node.values()
        if isinstance(kind, list)
        for o in kind
        if isinstance(o, dict) and "filename" in o
    ]
    res = {
        "label": label,
        "overrides": overrides or {},
        "sec": round(time.time() - t0, 1),
        "vram_peak_mb": mon.peak,
        "status": entry.get("status", {}).get("status_str"),
        "outputs": files,
        "ts": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }
    with open(f"{BENCH}/results.jsonl", "a") as f:
        f.write(json.dumps(res) + "\n")
    return res


print("bench harness loaded")
