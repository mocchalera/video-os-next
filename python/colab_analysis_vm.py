"""vos remote — VM-side worker for analysis jobs (describe today) on a guarded Colab session.

Loaded once into the session kernel (`vos-colab exec vos-analysis -f python/colab_analysis_vm.py`), then driven by
small snippets, each carrying one JSON argument (see src/remote/colab.ts pyCall):

    analysis_bootstrap({profile, model, revision})   venv + pinned deps + model snapshot → boot.{json,done}
    analysis_have({token, items})                    which content-addressed inputs are already here → have/<token>.json
    analysis_submit({id, token, kind, inputs, worker, ...})  run one job → jobs/<id>.{started,json,jsonl,done}
    analysis_cancel({id})                            kill a job's subprocess (a local timeout is not a VM stop)

It never re-implements analysis: the job runs the repo's own worker (python/marlin_worker.py), uploaded next to the
inputs and checked by SHA-256 like every other input. Inputs live at in/<sha256>.<ext>; a file whose size or hash
does not match is deleted and reported, so the next call uploads it again.
"""
import hashlib
import json
import os
import queue
import signal
import subprocess
import sys
import threading
import time
import traceback

ROOT = os.environ.get("VOSANA_ROOT", "/content/vosana")
for d in ("in", "jobs", "have", "models"):
    os.makedirs(f"{ROOT}/{d}", exist_ok=True)

# Pinned to python/requirements.lock.txt. torch/torchvision come from the Colab image (CUDA build matched to the VM);
# boot.json records what actually ran.
PROFILES = {
    "marlin": {
        "pip": ["transformers==5.12.1", "accelerate==1.14.0", "torchcodec", "av==17.1.0", "pillow"],
    },
}

STATE = globals().get("STATE") or {"boot": None, "python": None}
_JOBS = globals().get("_JOBS") or queue.Queue()
_ACTIVE = globals().get("_ACTIVE") or {}  # job id -> Popen or None (queued)
_TOKENS = globals().get("_TOKENS") or {}  # client token -> job id: a retried call is a no-op
_VERIFIED = globals().get("_VERIFIED") or {}  # path -> (size, mtime) whose hash was checked


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


def _sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _input_path(item):
    return f"{ROOT}/in/{item['sha256']}.{item.get('ext', 'bin')}"


def _check(item):
    """True when in/<sha>.<ext> exists with the right size and hash. A mismatching file is removed."""
    p = _input_path(item)
    if not os.path.exists(p):
        return False
    st = os.stat(p)
    if st.st_size != item["size"]:
        os.remove(p)
        return False
    if _VERIFIED.get(p) == (st.st_size, st.st_mtime):
        return True
    if _sha256(p) != item["sha256"]:
        os.remove(p)
        return False
    _VERIFIED[p] = (st.st_size, st.st_mtime)
    return True


# ------------------------------------------------------------------ bootstrap

def _python():
    return os.environ.get("VOSANA_PYTHON") or STATE.get("python") or f"{ROOT}/venv/bin/python"


def _versions(py):
    code = ("import json,sys\nout={'python':sys.version.split()[0]}\n"
            "for m in ('torch','transformers','accelerate','torchcodec'):\n"
            "  try:\n    out[m]=__import__(m).__version__\n  except Exception as e:\n    out[m]=None\n"
            "try:\n  import torch\n  out['cuda']=torch.version.cuda\n  out['gpu']=torch.cuda.get_device_name(0) if torch.cuda.is_available() else None\n"
            "  out['bf16']=bool(torch.cuda.is_available() and torch.cuda.is_bf16_supported())\nexcept Exception:\n  pass\n"
            "print(json.dumps(out))")
    r = subprocess.run([py, "-c", code], capture_output=True, text=True)
    try:
        return json.loads(r.stdout.strip().splitlines()[-1])
    except Exception:
        return {"error": r.stderr[-500:]}


def _bootstrap(req):
    rep = {"state": "running", "profile": req["profile"], "model": req.get("model"), "revision": req.get("revision")}
    t0 = time.time()
    try:
        prof = PROFILES[req["profile"]]
        if not os.environ.get("VOSANA_PYTHON"):
            if not os.path.exists(f"{ROOT}/venv/bin/python"):
                # system site packages: reuse the image's CUDA torch instead of downloading another 2.5 GB
                _sh(f"{sys.executable} -m venv --system-site-packages {ROOT}/venv")
            _sh(f"{ROOT}/venv/bin/python -m pip install -q " + " ".join(f"'{x}'" for x in prof["pip"]))
            STATE["python"] = f"{ROOT}/venv/bin/python"
        if req.get("model"):
            os.environ["HF_XET_HIGH_PERFORMANCE"] = "1"
            dest = f"{ROOT}/models/{req['model'].replace('/', '--')}@{req['revision']}"
            if not os.path.exists(f"{dest}/.done"):
                from huggingface_hub import snapshot_download
                snapshot_download(req["model"], revision=req["revision"], local_dir=dest)
                open(f"{dest}/.done", "w").close()
            rep["model_dir"] = dest
        rep["versions"] = _versions(_python())
        rep["state"] = "ready"
    except Exception:
        rep["state"] = "error"
        rep["error"] = traceback.format_exc()[-2500:]
    rep["sec"] = round(time.time() - t0, 1)
    STATE["boot"] = rep
    _write(f"{ROOT}/boot.json", rep, f"{ROOT}/boot.done")


def analysis_bootstrap(req):
    b = STATE.get("boot")
    if b and b["state"] == "ready" and b["profile"] == req["profile"] and b.get("revision") == req.get("revision"):
        print(json.dumps({"ok": True, "bootstrap": "already ready"}))  # idempotent: a retried exec must not restart it
        return
    if any(t.name == "vosana-boot" and t.is_alive() for t in threading.enumerate()):
        print(json.dumps({"ok": True, "bootstrap": "running"}))
        return
    for f in ("boot.json", "boot.done", "boot.started"):
        if os.path.exists(f"{ROOT}/{f}"):
            os.remove(f"{ROOT}/{f}")
    open(f"{ROOT}/boot.started", "w").close()
    threading.Thread(target=_bootstrap, args=(req,), name="vosana-boot", daemon=True).start()
    print(json.dumps({"ok": True, "bootstrap": "started"}))


# ------------------------------------------------------------------ inputs

def analysis_have(req):
    present = [it["sha256"] for it in req["items"] if _check(it)]
    _write(f"{ROOT}/have/{req['token']}.json", {"token": req["token"], "present": present})
    print(json.dumps({"ok": True, "present": len(present), "of": len(req["items"])}))


# ------------------------------------------------------------------ jobs

def _run_describe(r, rep):
    boot = STATE.get("boot") or {}
    if boot.get("state") != "ready":
        raise RuntimeError("bootstrap not ready")
    worker = r["worker"]
    if not _check(worker):
        raise RuntimeError(f"worker {worker['sha256'][:12]} missing or corrupt on the VM")
    bad = [it["sha256"] for it in r["inputs"] if not _check(it)]
    if bad:
        rep["missing_inputs"] = bad
        raise RuntimeError(f"{len(bad)} input(s) missing or corrupt on the VM (removed; they upload again next call)")
    by_path = {_input_path(it): it["sha256"] for it in r["inputs"]}
    env = {**os.environ, "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1"}
    if boot.get("model_dir"):
        env["VOS_MARLIN_MODEL"] = boot["model_dir"]
    for k, v in (r.get("env") or {}).items():
        env[k] = str(v)
    cmd = [_python(), _input_path(worker), "caption", *by_path.keys()]
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env, start_new_session=True)
    _ACTIVE[r["id"]] = p
    try:
        out, err = p.communicate(timeout=r.get("timeout", 3600))
    except subprocess.TimeoutExpired:
        os.killpg(p.pid, signal.SIGKILL)
        out, err = p.communicate()
        raise TimeoutError("describe timed out on the VM")
    if p.returncode < 0:
        raise RuntimeError(f"cancelled (signal {-p.returncode})")
    lines, seen = [], set()
    for line in out.splitlines():
        if not line.startswith("{"):
            continue
        j = json.loads(line)
        sha = by_path.get(j.pop("video", None))
        if not sha or sha in seen:
            continue
        seen.add(sha)
        lines.append(json.dumps({"sha256": sha, **j}, ensure_ascii=False, sort_keys=True))
    body = ("\n".join(lines) + "\n") if lines else ""
    with open(f"{ROOT}/jobs/{r['id']}.jsonl.tmp", "w") as f:
        f.write(body)
    os.replace(f"{ROOT}/jobs/{r['id']}.jsonl.tmp", f"{ROOT}/jobs/{r['id']}.jsonl")
    rep["n"] = len(lines)
    rep["lines_sha256"] = hashlib.sha256(body.encode()).hexdigest()
    rep["stderr_tail"] = err[-800:]
    if len(lines) != len(r["inputs"]):
        raise RuntimeError(f"worker answered for {len(lines)} of {len(r['inputs'])} input(s) (exit {p.returncode}): {err[-600:]}")


KINDS = {"describe": _run_describe}


def _run_job(r):
    boot = STATE.get("boot") or {}
    rep = {"id": r["id"], "kind": r.get("kind"), "state": "running", "versions": boot.get("versions"),
           "model": boot.get("model"), "revision": boot.get("revision")}
    t0 = time.time()
    try:
        KINDS[r["kind"]](r, rep)
        rep["state"] = "ok"
    except Exception:
        rep.update(state="error", error=traceback.format_exc()[-2500:])
    rep["sec"] = round(time.time() - t0, 1)
    _write(f"{ROOT}/jobs/{r['id']}.json", rep, f"{ROOT}/jobs/{r['id']}.done")


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
            _ACTIVE.pop(r["id"], None)


if not (globals().get("_WORKER") and _WORKER.is_alive()):
    _WORKER = threading.Thread(target=_worker, name="vosana-worker", daemon=True)
    _WORKER.start()


def analysis_submit(r):
    """Queue a job exactly once per client call (token), and never twice while it is queued or running."""
    token = r.get("token")
    if token and token in _TOKENS:
        print(json.dumps({"ok": True, "queued": r["id"], "duplicate": True}))
        return
    if token:
        _TOKENS[token] = r["id"]
    if r["id"] in _ACTIVE:
        print(json.dumps({"ok": True, "queued": r["id"], "already_active": True}))
        return
    if r.get("kind") not in KINDS:
        raise ValueError(f"unknown job kind {r.get('kind')!r}")
    for ext in ("json", "jsonl", "done", "started"):
        p = f"{ROOT}/jobs/{r['id']}.{ext}"
        if os.path.exists(p):
            os.remove(p)
    _ACTIVE[r["id"]] = None
    _JOBS.put(r)
    print(json.dumps({"ok": True, "queued": r["id"], "depth": _JOBS.qsize()}))


def analysis_cancel(req):
    p = _ACTIVE.get(req["id"])
    if p is not None and p.poll() is None:
        os.killpg(p.pid, signal.SIGKILL)
        print(json.dumps({"ok": True, "cancelled": req["id"]}))
        return
    print(json.dumps({"ok": True, "cancelled": None}))


print(json.dumps({"ok": True, "worker": "vosana"}))
