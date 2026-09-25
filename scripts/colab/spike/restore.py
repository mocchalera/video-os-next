"""Cold-start restore for the H3 spike VM: ComfyUI + cu130 torch + weights, all in parallel.
Runs ON the VM after bench.py is loaded. Writes /content/bench/restore.json when done.

Speed notes measured in the spike:
  * sequential hf_hub_download ran at 19-60 MB/s (58 GB in ~39 min)
  * this version downloads every file concurrently with HF_XET_HIGH_PERFORMANCE=1
  * torch cu130 is required for comfy-kitchen's CUDA backend (ComfyUI disables it below CUDA 13)
"""
import concurrent.futures as cf

os.environ["HF_XET_HIGH_PERFORMANCE"] = "1"
REPO = "Comfy-Org/MiniMax-H3"
WEIGHTS = [
    ("diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors", "diffusion_models"),
    ("text_encoders/qwen3vl_32b_minimax_h3_int8_convrot.safetensors", "text_encoders"),
    ("vae/minimax_h3_video_vae_fp16.safetensors", "vae"),
    ("vae/minimax_h3_audio_vae_fp32.safetensors", "vae"),
    ("loras/minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors", "loras"),
    ("loras/minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors", "loras"),
]


def _restore():
    out = {}
    t0 = time.time()
    try:
        out["setup"] = setup_comfy("1568e6cf")
        with cf.ThreadPoolExecutor(8) as ex:
            torch_f = ex.submit(sh, "pip install -q 'torch==2.11.0+cu130' torchvision torchaudio "
                                    "--index-url https://download.pytorch.org/whl/cu130 2>&1 | tail -3", False)
            dl = [ex.submit(fetch, REPO, p, d) for p, d in WEIGHTS]
            out["dl"] = [f.result() for f in dl]
            out["dl_wall_sec"] = round(time.time() - t0, 1)
            out["torch_pip"] = torch_f.result()
        out["torch"] = sh("python -c 'import torch;print(torch.__version__, torch.version.cuda)'", False).strip()
    except Exception:
        out["error"] = traceback.format_exc()[-2000:]
    out["total_sec"] = round(time.time() - t0, 1)
    with open(f"{BENCH}/restore.json", "w") as f:
        json.dump(out, f)


import threading, traceback  # noqa: E402

threading.Thread(target=_restore, daemon=True).start()
print("restore started")
