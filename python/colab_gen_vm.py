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
# Matches src/gen/colab.ts FASTH3. Keep the legacy ComfyUI pin isolated in its own session.
FASTH3 = {
    "model": "fasth3-omni", "weights_repo": "FastVideo/FastH3-Omni-Comfy",
    "weights_rev": "82eff2a6eee6c962846879f4bab52610a4df24d3",
    "comfy_rev": "b1a247c9cf9dbfda4b2c0a0c1d50950667eeaa0c",
    "unet": "fasth3_omniref_8step_pruned_int8_convrot.safetensors",
    "text_encoder": WEIGHTS[1][0].split("/")[-1], "video_vae": WEIGHTS[2][0].split("/")[-1],
    "audio_vae": WEIGHTS[3][0].split("/")[-1], "steps": 8, "lora": "", "sol_tau": None,
    "sampler": "euler", "shift_video": 12, "shift_audio": 3, "attention": "vsa", "vsa_keep_percent": 10,
    "attention_backend": "comfy kitchen attention", "graph_revision": "fasth3-omni-v1",
}
FASTH3_WEIGHTS = [("diffusion_models/" + FASTH3["unet"], "diffusion_models"), *WEIGHTS[1:4]]
FASTH3_DOWNLOAD_BACKOFF = (30, 60, 120)
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

def _fetch(path, subdir, repo=WEIGHTS_REPO, revision=WEIGHTS_REV):
    from huggingface_hub import hf_hub_download
    t = time.time()
    dest = f"{COMFY}/models/{subdir}"
    name = os.path.basename(path)
    final = f"{dest}/{name}"
    # For the new profile resolve every component at its pin, including shared filenames.
    attempts = 0
    if repo != WEIGHTS_REPO or not os.path.exists(final):
        while True:
            attempts += 1
            try:
                p = hf_hub_download(repo, path, revision=revision, local_dir=dest)
                break
            except RuntimeError as exc:
                # Xet's Rust transfer error bypasses huggingface_hub's HTTP rate-limit retries.
                # Retry only the observed 429 failure, on the same pinned file, with a bounded wait.
                if repo != FASTH3["weights_repo"] or "429 Too Many Requests" not in str(exc) or attempts > len(FASTH3_DOWNLOAD_BACKOFF):
                    raise
                time.sleep(FASTH3_DOWNLOAD_BACKOFF[attempts - 1])
        os.replace(p, final)
    return {"file": name, "gb": round(os.path.getsize(final) / 1e9, 2), "sec": round(time.time() - t, 1),
            **({"download_attempts": attempts} if repo == FASTH3["weights_repo"] else {})}


def _torch_info():
    return _sh("python -c 'import torch;print(torch.__version__, torch.version.cuda)'", False).strip()


def _bootstrap(light=False, model="minimax-h3"):
    """light=True: ComfyUI only (no H3 weights, no torch swap) — enough for upscaling or checking node schemas."""
    fast = model == FASTH3["model"]
    rev = FASTH3["comfy_rev"] if fast else COMFY_REV
    repo = FASTH3["weights_repo"] if fast else WEIGHTS_REPO
    weights_rev = FASTH3["weights_rev"] if fast else WEIGHTS_REV
    rep = {"state": "running", "model": model, "comfy_rev": rev, "weights_repo": repo,
           "weights_rev": weights_rev, "light": light}
    t0 = time.time()
    try:
        os.environ["HF_XET_HIGH_PERFORMANCE"] = "0" if fast else "1"
        if fast:
            os.environ["HF_XET_NUM_CONCURRENT_RANGE_GETS"] = "4"
            os.environ["HF_XET_FIXED_DOWNLOAD_CONCURRENCY"] = "4"
            rep["download_policy"] = {"parallel_files": 2, "xet_high_performance": False,
                                      "requested_xet_concurrency": 4, "retry_429_wait_seconds": list(FASTH3_DOWNLOAD_BACKOFF)}
        if not os.path.isdir(COMFY):
            _sh(f"git clone -q https://github.com/comfyanonymous/ComfyUI.git {COMFY}")
        _sh(f"cd {COMFY} && git fetch -q && git checkout -q {rev} && pip install -q -r requirements.txt")
        if not light:
            with cf.ThreadPoolExecutor(2 if fast else 8) as ex:
                tf = ex.submit(_sh, TORCH_CU130 + " 2>&1 | tail -3", False)
                dl = [ex.submit(_fetch, p, d, repo, weights_rev) for p, d in (FASTH3_WEIGHTS if fast else WEIGHTS)]
                rep["weights"] = [f.result() for f in dl]
                rep["torch_pip"] = tf.result()[-500:]
        rep["torch"] = STATE["torch"] = _torch_info()
        # kitchen CUDA kernels need CUDA >= 13; otherwise the Triton backend is the measured next best
        cuda_ok = bool(re.search(r"\s1[3-9]\.", " " + rep["torch"]))
        STATE["flags"] = [] if cuda_ok else ["--enable-triton-backend"]
        if not _sh("nvidia-smi -L 2>/dev/null", False).strip():
            STATE["flags"] = ["--cpu"]
        rep["server"] = _start_server(STATE["flags"])
        if fast:
            rep["schema"] = _check_fasth3_schema()
        rep["state"] = "ready"
    except Exception:
        rep["state"] = "error"
        rep["error"] = traceback.format_exc()[-2500:]
    rep["sec"] = round(time.time() - t0, 1)
    STATE["boot"] = rep
    _write(f"{ROOT}/boot.json", rep, f"{ROOT}/boot.done")


def bootstrap(light=False, model="minimax-h3"):
    if model not in ("minimax-h3", FASTH3["model"]):
        raise ValueError("unknown generation model: " + str(model))
    if light and model == FASTH3["model"]:
        raise ValueError("FastH3 requires a full session")
    if STATE.get("boot") and STATE["boot"]["state"] == "ready" and STATE["boot"].get("model", "minimax-h3") != model:
        raise RuntimeError("cannot change the model of a running session; stop it and start a new session")
    if STATE.get("boot") and STATE["boot"]["state"] == "ready" and STATE["boot"].get("light") == light:
        print(json.dumps({"ok": True, "bootstrap": "already ready"}))  # idempotent: a retried exec must not restart it
        return
    if any(t.name == "vosgen-boot" and t.is_alive() for t in threading.enumerate()):
        print(json.dumps({"ok": True, "bootstrap": "running"}))
        return
    for f in ("boot.json", "boot.done", "boot.started"):
        if os.path.exists(f"{ROOT}/{f}"):
            os.remove(f"{ROOT}/{f}")
    open(f"{ROOT}/boot.started", "w").close()
    threading.Thread(target=_bootstrap, args=(light, model), name="vosgen-boot", daemon=True).start()
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


def _check_fasth3_schema():
    """Fail before generation if this runtime cannot provide the selected native recipe."""
    info = json.load(urllib.request.urlopen(f"{URL}/object_info"))
    for cls, names in {
        "MiniMaxH3SigmaShift": ("model", "shift_video", "shift_audio"),
        "MiniMaxH3ReferenceToVideo": ("clip", "prompt", "width", "height", "length"),
        "BlockSparseAttention": ("model", "selection", "start_percent", "end_percent"),
        "ModelAttentionBackend": ("model", "attention"),
    }.items():
        fields = info.get(cls, {}).get("input", {}).get("required", {})
        if not all(n in fields for n in names):
            raise RuntimeError("FastH3 native node schema is unavailable: " + cls)
    choices = info["ModelAttentionBackend"]["input"]["required"]["attention"][0]
    if FASTH3["attention_backend"] not in choices:
        raise RuntimeError("FastH3 requires the Comfy Kitchen attention backend; no fallback is selected")
    return {"native_nodes": True, "attention_backend": FASTH3["attention_backend"]}


# reference-to-video (character / style / keyframes): separate diffusion model + turbo LoRA, fetched on first use
REF_WEIGHTS = [
    ("diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors", "diffusion_models"),
    ("loras/minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors", "loras"),
]


CONTROL_WEIGHTS = [("model_patches/minimax_h3_fun_controlnet_union_pruned_int8_convrot.safetensors", "model_patches")]


def _ensure_control_weights():
    os.environ["HF_XET_HIGH_PERFORMANCE"] = "1"
    return [_fetch(p, d) for p, d in CONTROL_WEIGHTS]


def _ensure_ref_weights():
    os.environ["HF_XET_HIGH_PERFORMANCE"] = "1"
    with cf.ThreadPoolExecutor(4) as ex:
        return [f.result() for f in [ex.submit(_fetch, p, d) for p, d in REF_WEIGHTS]]


def frames_for(seconds):
    """24 fps snapped up to the model's 17k+5 grid (stock template formula)."""
    n = max(5, round(seconds * 24))
    return n + (5 - n % 17) % 17


def _validate_fasth3(r):
    """Reject unvalidated modes/settings even when a caller bypasses the local CLI."""
    if any(r.get(k) != v for k, v in FASTH3.items()):
        raise ValueError("FastH3 request does not match the pinned 8-step VSA recipe")
    if r.get("mode") != "ref2va" or not 1 <= len(r.get("ref_images", [])) <= 9:
        raise ValueError("FastH3 needs 1–9 image references")
    if any(r.get(k) for k in ("first_image", "last_image", "guide_images", "guide_audios", "control_video", "control",
                              "first_frame", "last_frame", "guides", "audio_guides")):
        raise ValueError("FastH3 frame/audio guides and ControlNet are not validated")


def graph(r):
    """API-format T2V(+audio) graph, rebuilt from the stock template `video_minimax_h3_t2v.json`."""
    fast = r.get("model") == FASTH3["model"]
    if fast:
        _validate_fasth3(r)
    g = {}

    def node(nid, cls, **inputs):
        g[nid] = {"class_type": cls, "inputs": inputs}
        return [nid, 0]

    model = node("unet", "UNETLoader", unet_name=r["unet"], weight_dtype="default")
    if fast:
        model = node("shift", "MiniMaxH3SigmaShift", model=model, shift_video=r["shift_video"], shift_audio=r["shift_audio"])
        model = node("backend", "ModelAttentionBackend", model=model, attention=r["attention_backend"])
        model = node("sparse", "BlockSparseAttention", model=model, **{
            "selection": "vsa", "selection.keep_percent": r["vsa_keep_percent"], "start_percent": 0.0, "end_percent": 1.0,
            "dense_blocks": "", "min_tokens": 12288, "extra_tokens": 256,
            "sink_conditioning": "exact_kv_and_rows", "verbose": False})
    if r.get("lora"):
        model = node("lora", "LoraLoaderModelOnly", model=model, lora_name=r["lora"], strength_model=r.get("lora_strength", 1.0))
    if r.get("sol_tau") is not None:
        # dynamic combo = flat dotted keys; other inputs are the node defaults at COMFY_REV
        model = node("sparse", "BlockSparseAttention", model=model, **{
            "selection": "sol-attn", "selection.tau": r["sol_tau"], "start_percent": 0.2, "end_percent": 1.0,
            "dense_blocks": "", "min_tokens": 12288, "extra_tokens": 256,
            "sink_conditioning": "exact_kv_and_rows", "verbose": False})
    if r.get("control_video"):
        # stock template video_minimax_h3_fun_controlnet_union: depth / canny / pose video → model patch (guidance 1.0).
        # Must come AFTER BlockSparseAttention: at COMFY_REV the sparse node replaces every ("double_block", i) patch
        # without chaining, which silently dropped the ControlNet hooks (live: controlled == uncontrolled, 2026-10-01).
        # The ControlNet apply keeps and calls an existing block patch, so this order keeps both.
        cv = node("ctl_load", "LoadVideo", file=r["control_video"])
        g["ctl_parts"] = {"class_type": "GetVideoComponents", "inputs": {"video": cv}}
        frames_in = node("ctl_size", "ImageScale", image=["ctl_parts", 0], upscale_method="lanczos",
                         width=r["width"], height=r["height"], crop="center")
        patch = node("ctl_patch", "ModelPatchLoader", name=CONTROL_WEIGHTS[0][0].split("/")[-1])
        model = node("control", "MiniMaxH3FunControlNetApply", model=model, model_patch=patch, vae=["vvae", 0],
                     strength=r["control"]["strength"], start_percent=0.0, end_percent=r["control"]["end"],
                     control_video=frames_in)
    clip = node("clip", "CLIPLoader", clip_name=r["text_encoder"], type="minimax", device="default")
    vvae = node("vvae", "VAELoader", vae_name=r["video_vae"])
    avae = node("avae", "VAELoader", vae_name=r["audio_vae"])
    length = frames_for(r["seconds"])
    if r.get("mode") == "ref2va":
        # stock template video_minimax_h3_r2v / multiframe_reference: refs are <Picture 1..n> in connection order,
        # guides continue the numbering and pin stills to output frames (MiniMaxH3AddGuide, frame = round(sec*24))
        refs = {f"ref_images.ref_image_{i}": node(f"ref_{i}", "LoadImage", image=name)
                for i, name in enumerate(r.get("ref_images", []))}
        node("cond", "MiniMaxH3ReferenceToVideo", clip=clip, vae=vvae, audio_vae=avae, prompt=r["prompt"],
             width=r["width"], height=r["height"], length=length, ref_image_size=r.get("ref_image_size", "match"), **refs)
        positive = ["cond", 0]
        for i, gd in enumerate(r.get("guide_images", [])):
            img = node(f"guide_img_{i}", "LoadImage", image=gd["image"])
            positive = node(f"guide_{i}", "MiniMaxH3AddGuide", positive=positive, latent=["cond", 1], vae=vvae,
                            audio_vae=avae, image=img, frame_idx=min(length - 1, round(gd["at"] * 24)))
    else:
        frames = {}
        for key in ("first", "last"):  # image→video: frames uploaded to ComfyUI/input, already at exact size
            if r.get(f"{key}_image"):
                frames[f"{key}_frame"] = node(f"img_{key}", "LoadImage", image=r[f"{key}_image"])
        node("cond", "MiniMaxH3ImageToVideo", clip=clip, vae=vvae, prompt=r["prompt"],
             width=r["width"], height=r["height"], length=length, **frames)
        positive = ["cond", 0]
    guider = node("guider", "BasicGuider", model=model, conditioning=positive)
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


# Finishing upscalers: permissive licences only (commercial use OK), fetched on first use.
UPSCALERS = {
    "realesrgan-x2": ("RealESRGAN_x2plus.pth",
                      "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.1/RealESRGAN_x2plus.pth"),
    "realesrgan-x4": ("RealESRGAN_x4plus.pth",
                      "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth"),
}


def _ensure_upscaler(key):
    name, url = UPSCALERS[key]
    dest = f"{COMFY}/models/upscale_models/{name}"
    if not os.path.exists(dest):
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        urllib.request.urlretrieve(url, dest + ".part")
        os.replace(dest + ".part", dest)
    return name


def _probe(path):
    out = _sh(f"ffprobe -v error -select_streams v:0 -show_entries stream=width,height,r_frame_rate,nb_frames "
              f"-of json '{path}'")
    st = json.loads(out)["streams"][0]
    num, den = st["r_frame_rate"].split("/")
    return int(st["width"]), int(st["height"]), f"{num}/{den}", int(st.get("nb_frames") or 0)


def _run_upscale(r, rep):
    """Stream frames through the model: decode → upscale → resize → encode, constant memory for any length.
    (A ComfyUI graph holds the whole clip in RAM; that OOM-killed the server on a 13 GB T4 VM.)"""
    import numpy as np
    import torch
    import torch.nn.functional as F
    from spandrel import ModelLoader

    src = f"{COMFY}/input/{r['src_image']}"
    out = f"{ROOT}/out/{r['id']}.mp4"
    w, h, fps, n = _probe(src)
    W, H = r["width"], r["height"]
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    model = ModelLoader().load_from_file(f"{COMFY}/models/upscale_models/{r['model_file']}").model.to(dev).eval()
    half = dev == "cuda"
    if half:
        model = model.half()
    dec = subprocess.Popen(["ffmpeg", "-v", "error", "-i", src, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                           stdout=subprocess.PIPE)
    enc = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}",
                            "-r", fps, "-i", "-", "-i", src, "-map", "0:v", "-map", "1:a?", "-c:v", "libx264",
                            "-preset", "slow", "-crf", "14", "-pix_fmt", "yuv420p", "-c:a", "copy", "-shortest", out],
                           stdin=subprocess.PIPE)
    frames = 0
    with torch.inference_mode():
        while True:
            buf = dec.stdout.read(w * h * 3)
            if len(buf) < w * h * 3:
                break
            x = torch.from_numpy(np.frombuffer(buf, np.uint8).reshape(h, w, 3).copy()).to(dev)
            x = x.permute(2, 0, 1)[None].float().div(255)
            y = model(x.half() if half else x).float()
            y = F.interpolate(y, size=(H, W), mode="bicubic", antialias=True, align_corners=False).clamp(0, 1)
            enc.stdin.write(y[0].permute(1, 2, 0).mul(255).round().byte().cpu().numpy().tobytes())
            frames += 1
    enc.stdin.close()
    if enc.wait() != 0 or dec.wait() != 0:
        raise RuntimeError("ffmpeg failed while streaming the upscale")
    if n and frames != n:
        raise RuntimeError(f"decoded {frames} frames, source has {n}")
    rep.update(state="ok", output=out, frames=frames, upscaler={"model": r["model"], "file": r["model_file"]})


def _pick_output(entry, jid):
    """The saved video of this job. Loader nodes also report files (LoadVideo lists its *input* control video),
    so only type=output files carrying this job's prefix count (live, 2026-09-25)."""
    files = [o for n in entry.get("outputs", {}).values() for k in n.values() if isinstance(k, list)
             for o in k if isinstance(o, dict) and o.get("filename", "").endswith(".mp4")
             and o.get("type", "output") == "output" and o["filename"].startswith(jid)]
    if not files:
        raise RuntimeError(f"no saved video for {jid} in the ComfyUI history: {json.dumps(entry.get('outputs'))[:800]}")
    return os.path.join(COMFY, "output", files[0].get("subfolder", ""), files[0]["filename"])


def _run_job(r):
    jid = r["id"]
    rep = {"id": jid, "state": "running", "flags": STATE["flags"], "torch": STATE["torch"],
           "comfy_rev": COMFY_REV, "weights_rev": WEIGHTS_REV, "gpu": _sh(
               "nvidia-smi --query-gpu=name --format=csv,noheader", False).strip()}
    t0 = time.time()
    try:
        if not (STATE["boot"] and STATE["boot"]["state"] == "ready"):
            raise RuntimeError("bootstrap not ready")
        if STATE["boot"].get("light") and r.get("kind") != "upscale":
            raise RuntimeError("this session was started with --light (no H3 weights): `vos gen down`, then `vos gen up` without --light")
        boot = STATE["boot"]
        rep.update(comfy_rev=boot["comfy_rev"], weights_rev=boot["weights_rev"],
                   weights_repo=boot.get("weights_repo", WEIGHTS_REPO), model=boot.get("model", "minimax-h3"))
        if r.get("kind") != "upscale":
            if r.get("model", "minimax-h3") != rep["model"]:
                raise ValueError("request model does not match the running session")
            if rep["model"] == FASTH3["model"]:
                _validate_fasth3(r)
                if any(boot.get(k) != FASTH3[k] for k in ("comfy_rev", "weights_repo", "weights_rev")):
                    raise ValueError("FastH3 session revisions do not match the request")
        log_mark = os.path.getsize(f"{ROOT}/server.log")
        if r.get("kind") == "upscale":
            _run_upscale({**r, "model_file": _ensure_upscaler(r["model"])}, rep)
            rep["sec"] = round(time.time() - t0, 1)
            _write(f"{ROOT}/jobs/{jid}.json", rep, f"{ROOT}/jobs/{jid}.done")
            return
        if r.get("mode") == "ref2va" and rep["model"] != FASTH3["model"]:
            rep["ref_weights"] = _ensure_ref_weights()
        if r.get("control_video"):
            rep["control_weights"] = _ensure_control_weights()
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
        src = _pick_output(entry, jid)
        shutil.move(src, f"{ROOT}/out/{jid}.mp4")
        with open(f"{ROOT}/server.log") as f:
            f.seek(log_mark)
            its = re.findall(r"(\d+)/\1 \[[0-9:]+<00:00, +([0-9.]+)s/it", f.read())
        rep.update(state="ok", output=f"{ROOT}/out/{jid}.mp4", s_per_it=float(its[-1][1]) if its else None)
    except Exception:
        tail = ""
        if os.path.exists(f"{ROOT}/server.log"):
            with open(f"{ROOT}/server.log") as f:
                tail = f.read()[-1500:]
        rep.update(state="error", error=traceback.format_exc()[-2500:], log_tail=tail)
    rep["sec"] = round(time.time() - t0, 1)
    _write(f"{ROOT}/jobs/{jid}.json", rep, f"{ROOT}/jobs/{jid}.done")


_ACTIVE = globals().get("_ACTIVE") or set()  # job ids queued or running
_TOKENS = globals().get("_TOKENS") or {}  # client token -> job id: a retried submit is a no-op


def _worker():
    while True:
        r = _JOBS.get()
        open(f"{ROOT}/jobs/{r['id']}.started", "w").close()
        try:
            _run_job(r)
        except Exception:  # never let one job kill the queue
            _write(f"{ROOT}/jobs/{r['id']}.json", {"id": r["id"], "state": "error", "error": traceback.format_exc()[-2000:]},
                   f"{ROOT}/jobs/{r['id']}.done")
        finally:
            _ACTIVE.discard(r["id"])


# one worker per kernel namespace, kept across re-loads (tracked by object, not by thread name)
if not (globals().get("_WORKER") and _WORKER.is_alive()):
    _WORKER = threading.Thread(target=_worker, name="vosgen-worker", daemon=True)
    _WORKER.start()


def submit(r):
    """Queue a job exactly once per client call. The local side retries an exec after a dropped connection with the
    same token, so a token already seen (or a job id already queued/running) must not run the job again."""
    token = r.get("token")
    if token and token in _TOKENS:
        print(json.dumps({"ok": True, "queued": r["id"], "duplicate": True}))
        return
    if r["id"] in _ACTIVE:
        if token:
            _TOKENS[token] = r["id"]
        print(json.dumps({"ok": True, "queued": r["id"], "already_active": True}))
        return
    for ext in ("json", "done", "started"):
        p = f"{ROOT}/jobs/{r['id']}.{ext}"
        if os.path.exists(p):
            os.remove(p)
    if token:
        _TOKENS[token] = r["id"]
    _ACTIVE.add(r["id"])
    _JOBS.put(r)
    print(json.dumps({"ok": True, "queued": r["id"], "depth": _JOBS.qsize()}))


print(json.dumps({"ok": True, "worker": "vosgen", "comfy_rev": COMFY_REV}))


def schema(classes):
    """Live input schema of node classes, to check graphs against the running ComfyUI."""
    info = json.load(urllib.request.urlopen(f"{URL}/object_info"))
    out = {c: (info[c]["input"] if c in info else None) for c in classes}
    _write(f"{ROOT}/schema.json", out, f"{ROOT}/schema.done")
    print(json.dumps({"ok": True, "missing": [c for c, v in out.items() if v is None]}))
