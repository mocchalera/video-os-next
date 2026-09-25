"""Stage A probe for the MiniMax-H3 on Colab spike. Runs ON the Colab VM.

    colab exec -s h3 -f scripts/colab/spike/probe.py

Reports GPU / disk / RAM, lists the candidate Hugging Face repos with file sizes,
and optionally times one real download (set PROBE_DOWNLOAD=<repo>:<path>).
Prints one JSON object on the last line so the caller can parse it.
"""
import json
import os
import shutil
import subprocess
import time

CANDIDATE_REPOS = os.environ.get(
    "PROBE_REPOS", "Comfy-Org/MiniMax-H3,MiniMaxAI/MiniMax-H3"
).split(",")


def sh(cmd: str) -> str:
    try:
        return subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=120).stdout.strip()
    except Exception as e:  # noqa: BLE001 - probe must never die
        return f"ERR {e}"


def gpu() -> dict:
    q = sh("nvidia-smi --query-gpu=name,memory.total,driver_version,compute_cap --format=csv,noheader")
    out = {"nvidia_smi": q}
    try:
        import torch

        out.update(
            torch=torch.__version__,
            cuda=torch.version.cuda,
            available=torch.cuda.is_available(),
            capability=list(torch.cuda.get_device_capability()) if torch.cuda.is_available() else None,
        )
    except Exception as e:  # noqa: BLE001
        out["torch_error"] = str(e)
    return out


def repos() -> dict:
    res = {}
    try:
        from huggingface_hub import HfApi

        api = HfApi()
        for r in CANDIDATE_REPOS:
            try:
                info = api.model_info(r, files_metadata=True)
                res[r] = {
                    "sha": info.sha,
                    "files": sorted(
                        [{"path": s.rfilename, "gb": round((s.size or 0) / 1e9, 2)} for s in info.siblings],
                        key=lambda f: f["path"],
                    ),
                }
            except Exception as e:  # noqa: BLE001
                res[r] = {"error": f"{type(e).__name__}: {e}"}
    except Exception as e:  # noqa: BLE001
        res["_error"] = str(e)
    return res


def download_test() -> dict | None:
    spec = os.environ.get("PROBE_DOWNLOAD")
    if not spec:
        return None
    repo, path = spec.split(":", 1)
    from huggingface_hub import hf_hub_download

    t = time.time()
    p = hf_hub_download(repo, path, local_dir="/content/probe_dl")
    dt = time.time() - t
    size = os.path.getsize(p)
    return {"file": spec, "gb": round(size / 1e9, 2), "sec": round(dt, 1), "mb_s": round(size / 1e6 / dt, 1)}


du = shutil.disk_usage("/content")
report = {
    "gpu": gpu(),
    "disk_free_gb": round(du.free / 1e9, 1),
    "ram": sh("free -g | awk '/Mem:/{print $2\"G total, \"$7\"G avail\"}'"),
    "python": sh("python -V"),
    "hf_xet": sh("python -c 'import hf_xet;print(hf_xet.__version__)' 2>&1"),
    "repos": repos(),
    "download": download_test(),
}
print(json.dumps(report, ensure_ascii=False))
