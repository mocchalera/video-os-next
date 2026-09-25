"""Round B (after restore.py): kitchen CUDA backend on torch cu130, then target resolution.
Writes /content/bench/b.json. Needs bench.py + h3_workflow.py loaded in the kernel."""
import re
import threading
import traceback

PROMPT = ("Cinematic live-action shot: a cyclist rides through a rain-soaked neon street at night, "
          "camera tracking alongside, reflections on wet asphalt, shallow depth of field. "
          "Audio: rain, tires hissing on water, distant city hum.")
T8 = "minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors"


def _its(steps):
    log = open(f"{BENCH}/server.log").read()
    return re.findall(rf"{steps}/{steps} \[[0-9:]+<00:00, +([0-9.]+)s/it", log)[-1:]


def _backends():
    log = open(f"{BENCH}/server.log").read()
    return [re.sub(r"'capabilities'.*", "", l)[-160:] for l in log.splitlines() if "comfy_kitchen backend" in l or "optimized CUDA" in l]


def bench(tag, flags, seed, **kw):
    out = {"tag": tag, "boot": start_server(flags), "backends": _backends()}
    for i, phase in enumerate(("cold", "warm")):
        r = run(h3_t2v(PROMPT, seed=seed + i, steps=6, lora=T8, prefix=f"bench/{tag}", **kw), label=f"{tag}-{phase}")
        out[phase] = r["sec"]
        out[f"{phase}_vram_mb"] = r["vram_peak_mb"]
        out[f"{phase}_out"] = r["outputs"]
    out["s_per_it"] = _its(6)
    return out


def _job():
    res = {}
    try:
        res["cu130"] = bench("cu130", [], 41)
        res["cu130+triton"] = bench("cu130tri", ["--enable-triton-backend"], 51)
        best = min(("cu130", []), ("cu130+triton", ["--enable-triton-backend"]), key=lambda x: res[x[0]]["warm"])
        res["best"] = best[0]
        try:
            res["target_1344x768_5s"] = bench("target", best[1], 61, width=1344, height=768, seconds=5.0)
        except Exception:
            res["target_1344x768_5s"] = {"error": traceback.format_exc()[-1500:]}
    except Exception:
        res["error"] = traceback.format_exc()[-2000:]
    with open(f"{BENCH}/b.json", "w") as f:
        json.dump(res, f)


threading.Thread(target=_job, daemon=True).start()
print("round B started")
