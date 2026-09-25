"""vos gen — VM-side worker for MiniMax-H3 on a Colab GPU. Loaded once into the session kernel
(`vos-colab exec vos-gen -f python/colab_gen_vm.py`), then driven by tiny snippets:

    bootstrap()            ComfyUI + torch cu130 + weights, in a background thread → /content/vosgen/boot.{json,done}
    submit({...request})   queue one generation → /content/vosgen/jobs/<id>.{json,done}, video at out/<id>.mp4

Everything here was measured in scripts/colab/spike/RESULTS.md (A100-40GB):
  * torch cu130 turns on comfy-kitchen's CUDA int8 kernels (ComfyUI disables them below CUDA 13): 5.38 → 1.14 s/step
  * turbo 8-step LoRA @ 6 steps; sol-attn tau 1.3 (−25 % at 1344x768 5 s)
  * parallel HF download with HF_XET_HIGH_PERFORMANCE=1: 58 GB in ~3 min
The local side never trusts this file's claims blindly: every job writes what it actually ran (flags, torch, rev).
"""
import concurrent.futures as cf
import json
import os
import queue
import re
import shutil
import subprocess
import threading
import time
import traceback
import urllib.request
import uuid

ROOT = os.environ.get("VOSGEN_ROOT", "/content/vosgen")
COMFY = os.environ.get("VOSGEN_COMFY", "/content/ComfyUI")
URL = "http://127.0.0.1:8188"
COMFY_REV = "1568e6cf"
WEIGHTS_REPO = "Comfy-Org/MiniMax-H3"
WEIGHTS_REV = "1c41cfca8ebba91d0af792a05c5761fb2c3a7975"
WEIGHTS = [
    ("diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors", "diffusion_models"),
    ("text_encoders/qwen3vl_32b_minimax_h3_int8_convrot.safetensors", "text_encoders"),
    ("vae/minimax_h3_video_vae_fp16.safetensors", "vae"),
    ("vae/minimax_h3_audio_vae_fp32.safetensors", "vae"),
    ("loras/minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors", "loras"),
]
# pin all three: an unpinned torchvision stays on Colab's cu128 build and ComfyUI refuses to start
TORCH_CU130 = ("pip install -q 'torch==2.11.0+cu130' 'torchvision==0.26.0+cu130' 'torchaudio==2.11.0+cu130' "
               "--index-url https://download.pytorch.org/whl/cu130")

os.makedirs(f"{ROOT}/jobs", exist_ok=True)
os.makedirs(f"{ROOT}/out", exist_ok=True)
# Survive re-loading this file into the same kernel (e.g. after a fix): keep the live queue, server and boot
# state, otherwise the running worker thread keeps draining the old queue and new jobs are never picked up.
STATE = globals().get("STATE") or {"server": None, "flags": [], "torch": None, "boot": None}
_JOBS = globals().get("_JOBS") or queue.Queue()


def _sh(cmd, check=True):
    r = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    if check and r.returncode != 0:
        raise RuntimeError(f"{cmd}\n{r.stderr[-2000:]}")
    return r.stdout


def _write(path, obj, done=None):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f)
    os.replace(tmp, path)
    if done:
        open(done, "w").close()


# ------------------------------------------------------------------ bootstrap

def _fetch(path, subdir):
    from huggingface_hub import hf_hub_download
    t = time.time()
    dest = f"{COMFY}/models/{subdir}"
    name = os.path.basename(path)
    final = f"{dest}/{name}"
    if not os.path.exists(final):
        p = hf_hub_download(WEIGHTS_REPO, path, revision=WEIGHTS_REV, local_dir=dest)
        os.replace(p, final)
    return {"file": name, "gb": round(os.path.getsize(final) / 1e9, 2), "sec": round(time.time() - t, 1)}


def _torch_info():
    return _sh("python -c 'import torch;print(torch.__version__, torch.version.cuda)'", False).strip()


def _bootstrap():
    rep = {"state": "running", "comfy_rev": COMFY_REV, "weights_rev": WEIGHTS_REV}
    t0 = time.time()
    try:
        os.environ["HF_XET_HIGH_PERFORMANCE"] = "1"
        if not os.path.isdir(COMFY):
            _sh(f"git clone -q https://github.com/comfyanonymous/ComfyUI.git {COMFY}")
        _sh(f"cd {COMFY} && git fetch -q && git checkout -q {COMFY_REV} && pip install -q -r requirements.txt")
        with cf.ThreadPoolExecutor(8) as ex:
            tf = ex.submit(_sh, TORCH_CU130 + " 2>&1 | tail -3", False)
            dl = [ex.submit(_fetch, p, d) for p, d in WEIGHTS]
            rep["weights"] = [f.result() for f in dl]
            rep["torch_pip"] = tf.result()[-500:]
        rep["torch"] = STATE["torch"] = _torch_info()
        # kitchen CUDA kernels need CUDA >= 13; otherwise the Triton backend is the measured next best
        cuda_ok = bool(re.search(r"\s1[3-9]\.", " " + rep["torch"]))
        STATE["flags"] = [] if cuda_ok else ["--enable-triton-backend"]
        rep["server"] = _start_server(STATE["flags"])
        rep["state"] = "ready"
    except Exception:
        rep["state"] = "error"
        rep["error"] = traceback.format_exc()[-2500:]
    rep["sec"] = round(time.time() - t0, 1)
    STATE["boot"] = rep
    _write(f"{ROOT}/boot.json", rep, f"{ROOT}/boot.done")


def bootstrap():
    for f in ("boot.json", "boot.done"):
        if os.path.exists(f"{ROOT}/{f}"):
            os.remove(f"{ROOT}/{f}")
    threading.Thread(target=_bootstrap, daemon=True).start()
    print(json.dumps({"ok": True, "bootstrap": "started"}))


# ------------------------------------------------------------------ ComfyUI

def _start_server(flags, timeout=600):
    srv = STATE["server"]
    if srv and srv.poll() is None:
        srv.terminate()
        srv.wait(30)
    log = open(f"{ROOT}/server.log", "w")
    t = time.time()
    STATE["server"] = subprocess.Popen(["python", "main.py", "--listen", "127.0.0.1", "--port", "8188", *flags],
                                       cwd=COMFY, stdout=log, stderr=subprocess.STDOUT)
    while time.time() - t < timeout:
        try:
            urllib.request.urlopen(f"{URL}/system_stats", timeout=2)
            return {"flags": flags, "boot_sec": round(time.time() - t, 1)}
        except Exception:
            if STATE["server"].poll() is not None:
                raise RuntimeError("ComfyUI exited:\n" + open(f"{ROOT}/server.log").read()[-3000:])
            time.sleep(1)
    raise TimeoutError("ComfyUI did not come up")


def _post(path, body):
    req = urllib.request.Request(f"{URL}{path}", json.dumps(body).encode(), {"Content-Type": "application/json"})
    try:
        return json.load(urllib.request.urlopen(req))
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"ComfyUI rejected the graph: {e.read().decode()[:2000]}") from e


def frames_for(seconds):
    """24 fps snapped up to the model's 17k+5 grid (stock template formula)."""
    n = max(5, round(seconds * 24))
    return n + (5 - n % 17) % 17


def graph(r):
    """API-format T2V(+audio) graph, rebuilt from the stock template `video_minimax_h3_t2v.json`."""
    g = {}

    def node(nid, cls, **inputs):
        g[nid] = {"class_type": cls, "inputs": inputs}
        return [nid, 0]

    model = node("unet", "UNETLoader", unet_name=r["unet"], weight_dtype="default")
    if r.get("lora"):
        model = node("lora", "LoraLoaderModelOnly", model=model, lora_name=r["lora"], strength_model=r.get("lora_strength", 1.0))
    if r.get("sol_tau") is not None:
        # dynamic combo = flat dotted keys; other inputs are the node defaults at COMFY_REV
        model = node("sparse", "BlockSparseAttention", model=model, **{
            "selection": "sol-attn", "selection.tau": r["sol_tau"], "start_percent": 0.2, "end_percent": 1.0,
            "dense_blocks": "", "min_tokens": 12288, "extra_tokens": 256,
            "sink_conditioning": "exact_kv_and_rows", "verbose": False})
    clip = node("clip", "CLIPLoader", clip_name=r["text_encoder"], type="minimax", device="default")
    vvae = node("vvae", "VAELoader", vae_name=r["video_vae"])
    avae = node("avae", "VAELoader", vae_name=r["audio_vae"])
    node("cond", "MiniMaxH3ImageToVideo", clip=clip, vae=vvae, prompt=r["prompt"],
         width=r["width"], height=r["height"], length=frames_for(r["seconds"]))
    guider = node("guider", "BasicGuider", model=model, conditioning=["cond", 0])
    sigmas = node("sched", "BasicScheduler", model=model, scheduler="simple", steps=r["steps"], denoise=1.0)
    noise = node("noise", "RandomNoise", noise_seed=r["seed"])
    samp = node("sampler", "KSamplerSelect", sampler_name=r.get("sampler", "res_multistep"))
    out = node("sample", "SamplerCustomAdvanced", noise=noise, guider=guider, sampler=samp, sigmas=sigmas,
               latent_image=["cond", 1])
    img = node("vdec", "VAEDecode", samples=out, vae=vvae)
    aud = node("adec", "VAEDecodeAudio", samples=out, vae=avae)
    vid = node("video", "CreateVideo", images=img, audio=aud, fps=24)
    node("save", "SaveVideo", video=vid, filename_prefix=f"vosgen/{r['id']}", format="auto", codec="auto")
    return g


def _run_job(r):
    jid = r["id"]
    rep = {"id": jid, "state": "running", "flags": STATE["flags"], "torch": STATE["torch"],
           "comfy_rev": COMFY_REV, "weights_rev": WEIGHTS_REV, "gpu": _sh(
               "nvidia-smi --query-gpu=name --format=csv,noheader", False).strip()}
    t0 = time.time()
    try:
        if not (STATE["boot"] and STATE["boot"]["state"] == "ready"):
            raise RuntimeError("bootstrap not ready")
        log_mark = os.path.getsize(f"{ROOT}/server.log")
        pid = _post("/prompt", {"prompt": graph(r), "client_id": str(uuid.uuid4())})["prompt_id"]
        while True:
            h = json.load(urllib.request.urlopen(f"{URL}/history/{pid}"))
            st = h.get(pid, {}).get("status", {})
            if st.get("completed") is not None or st.get("status_str") == "error":
                break
            if STATE["server"].poll() is not None:
                raise RuntimeError("ComfyUI died during the job")
            if time.time() - t0 > r.get("timeout", 1800):
                raise TimeoutError("generation timed out on the VM")
            time.sleep(1)
        entry = h[pid]
        if entry["status"].get("status_str") != "success":
            raise RuntimeError(json.dumps(entry["status"].get("messages", []))[-2000:])
        files = [o for n in entry["outputs"].values() for k in n.values() if isinstance(k, list)
                 for o in k if isinstance(o, dict) and o.get("filename", "").endswith(".mp4")]
        src = os.path.join(COMFY, "output", files[0].get("subfolder", ""), files[0]["filename"])
        shutil.move(src, f"{ROOT}/out/{jid}.mp4")
        with open(f"{ROOT}/server.log") as f:
            f.seek(log_mark)
            its = re.findall(r"(\d+)/\1 \[[0-9:]+<00:00, +([0-9.]+)s/it", f.read())
        rep.update(state="ok", output=f"{ROOT}/out/{jid}.mp4", s_per_it=float(its[-1][1]) if its else None)
    except Exception:
        rep.update(state="error", error=traceback.format_exc()[-2500:],
                   log_tail=open(f"{ROOT}/server.log").read()[-1500:] if os.path.exists(f"{ROOT}/server.log") else "")
    rep["sec"] = round(time.time() - t0, 1)
    _write(f"{ROOT}/jobs/{jid}.json", rep, f"{ROOT}/jobs/{jid}.done")


def _worker():
    while True:
        r = _JOBS.get()
        open(f"{ROOT}/jobs/{r['id']}.started", "w").close()
        try:
            _run_job(r)
        except Exception:  # never let one job kill the queue
            _write(f"{ROOT}/jobs/{r['id']}.json", {"id": r["id"], "state": "error", "error": traceback.format_exc()[-2000:]},
                   f"{ROOT}/jobs/{r['id']}.done")


# one worker per kernel namespace, kept across re-loads (tracked by object, not by thread name)
if not (globals().get("_WORKER") and _WORKER.is_alive()):
    _WORKER = threading.Thread(target=_worker, name="vosgen-worker", daemon=True)
    _WORKER.start()


def submit(r):
    for ext in ("json", "done", "started"):
        p = f"{ROOT}/jobs/{r['id']}.{ext}"
        if os.path.exists(p):
            os.remove(p)
    _JOBS.put(r)
    print(json.dumps({"ok": True, "queued": r["id"], "depth": _JOBS.qsize()}))


print(json.dumps({"ok": True, "worker": "vosgen", "comfy_rev": COMFY_REV}))
