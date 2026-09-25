"""Round C: attention variants at target size (1344x768, 5 s), cu130 kitchen CUDA backend.
Server from round B (target, no extra flags) is reused. Writes /content/bench/c.json."""
import re
import threading
import traceback


def sol_selection(tau):
    """Build the full dynamic-combo payload from live /object_info defaults."""
    spec = object_info()["BlockSparseAttention"]["input"]["required"]
    sel = {"selection": "sol-attn"}
    opts = spec["selection"][1]["options"]
    for o in opts:
        if o["key"] == "sol-attn":
            for name, s in o["inputs"].get("required", {}).items():
                sel[name] = s[1].get("default") if len(s) > 1 and isinstance(s[1], dict) else None
    sel["tau"] = tau
    extra = {n: (s[1].get("default") if len(s) > 1 and isinstance(s[1], dict) else None)
             for n, s in spec.items() if n not in ("model", "selection")}
    return sel, extra


_orig = h3_t2v


def h3_c(prompt, sol_tau=None, **kw):
    g = _orig(prompt, **kw)
    if sol_tau is not None:
        sel, extra = sol_selection(sol_tau)
        src = g["guider"]["inputs"]["model"]
        g["sparse"] = {"class_type": "BlockSparseAttention", "inputs": {"model": src, "selection": sel, **extra}}
        g["guider"]["inputs"]["model"] = ["sparse", 0]
        g["sched"]["inputs"]["model"] = ["sparse", 0]
    return g


def _job():
    res = {"sol_payload": None}
    try:
        res["sol_payload"] = sol_selection(1.3)
        base = dict(steps=6, lora=T8, width=1344, height=768, seconds=5.0)
        for label, kw in [("t-int8attn", dict(attention="comfy kitchen attention")),
                          ("t-sol1.3", dict(sol_tau=1.3)),
                          ("t-int8attn+sol1.3", dict(attention="comfy kitchen attention", sol_tau=1.3))]:
            try:
                r = run(h3_c(PROMPT, seed=61 + 1, prefix=f"bench/{label}", **base, **kw), label=label)
                res[label] = {"sec": r["sec"], "vram": r["vram_peak_mb"], "status": r["status"], "out": r["outputs"],
                              "s_per_it": re.findall(r"6/6 \[[0-9:]+<00:00, +([0-9.]+)s/it", open(f"{BENCH}/server.log").read())[-1:]}
            except Exception:
                res[label] = {"error": traceback.format_exc()[-1200:]}
    except Exception:
        res["error"] = traceback.format_exc()[-1500:]
    with open(f"{BENCH}/c.json", "w") as f:
        json.dump(res, f)


threading.Thread(target=_job, daemon=True).start()
print("round C started")
