"""vos remote — VM-side worker for analysis jobs (describe, visual embedding) on a guarded Colab session.

Loaded once into the session kernel (`vos-colab exec vos-analysis -f python/colab_analysis_vm.py`), then driven by
small snippets, each carrying one JSON argument (see src/remote/colab.ts pyCall):

    analysis_bootstrap({profiles: [{name, model, revision}], token_file?})   venv + pins + snapshots → boot.{json,done}
    analysis_have({token, items})                    which content-addressed inputs are already here → have/<token>.json
    analysis_submit({id, token, kind, inputs, worker, ...})  run one job → jobs/<id>.{started,json,done} + result files
    analysis_cancel({id})                            kill a job's subprocess (a local timeout is not a VM stop)

It never re-implements analysis: a job runs the repo's own worker (python/marlin_worker.py, python/embed_worker.py),
uploaded next to the inputs and checked by SHA-256 like every other input. Inputs live at in/<sha256>.<ext>; a file
whose size or hash does not match is deleted and reported, so the next call uploads it again. A job's report lists
its result files with their SHA-256 (`files`); the local side downloads and checks each one.
"""
import hashlib
import json
import os
import queue
import shutil
import signal
import subprocess
import sys
import tarfile
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
        "env": "VOS_MARLIN_MODEL",
    },
    "visual": {
        "pip": ["transformers==5.12.1", "accelerate==1.14.0", "sentence-transformers==5.6.0", "qwen-vl-utils==0.0.14", "pillow"],
        "env": "VOS_VISUAL_MODEL",
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
            "for m in ('torch','transformers','accelerate','torchcodec','sentence_transformers'):\n"
            "  try:\n    out[m]=__import__(m).__version__\n  except Exception as e:\n    out[m]=None\n"
            "try:\n  import torch\n  out['cuda']=torch.version.cuda\n  out['gpu']=torch.cuda.get_device_name(0) if torch.cuda.is_available() else None\n"
            "  out['bf16']=bool(torch.cuda.is_available() and torch.cuda.is_bf16_supported())\nexcept Exception:\n  pass\n"
            "print(json.dumps(out))")
    r = subprocess.run([py, "-c", code], capture_output=True, text=True)
    try:
        return json.loads(r.stdout.strip().splitlines()[-1])
    except Exception:
        return {"error": r.stderr[-500:]}


def _token(req):
    """The uploaded Hugging Face token for a gated model, or None. Never logged, never written into boot.json."""
    f = req.get("token_file")
    if not f or not os.path.exists(f):
        return None
    os.chmod(f, 0o600)
    with open(f) as fh:
        return fh.read().strip() or None


def _forget_token(req):
    f = req.get("token_file")
    if f and os.path.exists(f):
        os.remove(f)


def _pins(names):
    """Union of the profiles' pins, in a stable order (the venv marker compares it)."""
    out = []
    for n in names:
        for x in PROFILES[n]["pip"]:
            if x not in out:
                out.append(x)
    return out


def _bootstrap(req):
    names = [p["name"] for p in req["profiles"]]
    rep = {"state": "running", "profiles": {p["name"]: {"model": p["model"], "revision": p["revision"]} for p in req["profiles"]}}
    t0 = time.time()
    try:
        if not os.environ.get("VOSANA_PYTHON"):
            venv = f"{ROOT}/venv"
            marker = f"{venv}/.vos-ready"  # one installed pin per line
            have = None
            if os.path.exists(marker):
                with open(marker) as fh:
                    have = fh.read().split("\n")
            if have is None:
                # A venv only counts once its pins are installed: a half-made one (live: the first attempt died in
                # ensurepip and left a venv without system site packages) is rebuilt, not reused.
                shutil.rmtree(venv, ignore_errors=True)
                # system site packages: reuse the image's CUDA torch instead of downloading another 2.5 GB.
                # --without-pip: Colab's python has no ensurepip; the image's pip (/usr/local/.../dist-packages) is
                # visible through the system site packages and installs into the venv when run by its python.
                _sh(f"{sys.executable} -m venv --system-site-packages --without-pip {venv}")
                have = []
            # Adding a profile to a live session only installs what is missing: a working venv is never removed
            # (jobs of the other profile may be running from it).
            missing = [x for x in _pins(names) if x not in have]
            if missing:
                _sh(f"{venv}/bin/python -m pip install -q " + " ".join(f"'{x}'" for x in missing))
                with open(marker, "w") as f:
                    f.write("\n".join([*have, *missing]))
            STATE["python"] = f"{venv}/bin/python"
        os.environ["HF_XET_HIGH_PERFORMANCE"] = "1"
        token = _token(req)
        for p in req["profiles"]:
            dest = f"{ROOT}/models/{p['model'].replace('/', '--')}@{p['revision']}"
            if not os.path.exists(f"{dest}/.done"):
                from huggingface_hub import snapshot_download
                snapshot_download(p["model"], revision=p["revision"], local_dir=dest, token=token)
                open(f"{dest}/.done", "w").close()
            rep["profiles"][p["name"]]["dir"] = dest
        rep["versions"] = _versions(_python())
        rep["state"] = "ready"
    except Exception:
        rep["state"] = "error"
        rep["error"] = traceback.format_exc()[-2500:]
    finally:
        _forget_token(req)
    rep["sec"] = round(time.time() - t0, 1)
    STATE["boot"] = rep
    _write(f"{ROOT}/boot.json", rep, f"{ROOT}/boot.done")


def _covers(boot, req):
    have = (boot or {}).get("profiles") or {}
    return all(p["name"] in have and have[p["name"]].get("revision") == p["revision"] for p in req["profiles"])


def analysis_bootstrap(req):
    b = STATE.get("boot")
    if b and b["state"] == "ready" and _covers(b, req):
        _forget_token(req)
        print(json.dumps({"ok": True, "bootstrap": "already ready"}))  # idempotent: a retried exec must not restart it
        return
    if any(t.name == "vosana-boot" and t.is_alive() for t in threading.enumerate()):
        _forget_token(req)  # each request has its own token file; the running bootstrap keeps its own
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

def _profile_dir(name):
    boot = STATE.get("boot") or {}
    if boot.get("state") != "ready":
        raise RuntimeError("bootstrap not ready")
    prof = (boot.get("profiles") or {}).get(name)
    if not prof:
        raise RuntimeError(f"this session was not set up for {name} (vos remote up --profile …,{name})")
    return prof.get("dir")


def _require_inputs(r, rep):
    if not _check(r["worker"]):
        raise RuntimeError(f"worker {r['worker']['sha256'][:12]} missing or corrupt on the VM")
    bad = [it["sha256"] for it in r["inputs"] if not _check(it)]
    if bad:
        rep["missing_inputs"] = bad
        raise RuntimeError(f"{len(bad)} input(s) missing or corrupt on the VM (removed; they upload again next call)")


def _spawn(r, cmd, env):
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env, start_new_session=True)
    _ACTIVE[r["id"]] = p
    try:
        out, err = p.communicate(timeout=r.get("timeout", 3600))
    except subprocess.TimeoutExpired:
        os.killpg(p.pid, signal.SIGKILL)
        p.communicate()
        raise TimeoutError(f"{r['kind']} timed out on the VM")
    if p.returncode < 0:
        raise RuntimeError(f"cancelled (signal {-p.returncode})")
    return p.returncode, out, err


def _env(profile, var, extra):
    env = {**os.environ, "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1", "TOKENIZERS_PARALLELISM": "false"}
    d = _profile_dir(profile)
    if d:
        env[var] = d
    for k, v in (extra or {}).items():
        env[k] = str(v)
    return env


def _publish(r, rep, name, data: bytes):
    path = f"{ROOT}/jobs/{r['id']}.{name}"
    with open(path + ".tmp", "wb") as f:
        f.write(data)
    os.replace(path + ".tmp", path)
    rep.setdefault("files", {})[name] = {"path": path, "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}


def _run_describe(r, rep):
    env = _env("marlin", PROFILES["marlin"]["env"], r.get("env"))
    _require_inputs(r, rep)
    by_path = {_input_path(it): it["sha256"] for it in r["inputs"]}
    code, out, err = _spawn(r, [_python(), _input_path(r["worker"]), "caption", *by_path.keys()], env)
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
    _publish(r, rep, "jsonl", (("\n".join(lines) + "\n") if lines else "").encode())
    rep["n"] = len(lines)
    rep["stderr_tail"] = err[-800:]
    if len(lines) != len(r["inputs"]):
        raise RuntimeError(f"worker answered for {len(lines)} of {len(r['inputs'])} input(s) (exit {code}): {err[-600:]}")


def _unpack(item):
    """A frames tarball → its directory (extracted once, next to it). Plain images stand for themselves."""
    p = _input_path(item)
    if item.get("ext") != "tar":
        return p
    d = p + ".d"
    if not os.path.exists(f"{d}/.done"):
        shutil.rmtree(d, ignore_errors=True)
        os.makedirs(d)
        with tarfile.open(p) as t:
            for m in t.getmembers():
                # frames only: flat names, regular files — nothing a tarball could use to write elsewhere
                if not m.isfile() or "/" in m.name or m.name.startswith("."):
                    raise RuntimeError(f"unexpected member {m.name!r} in frames archive")
            if hasattr(tarfile, "data_filter"):
                t.extractall(d, filter="data")  # belt and braces on top of the member check
            else:
                t.extractall(d)
        open(f"{d}/.done", "w").close()
    return d


def _run_embed(r, rep):
    ch = r["channel"]
    if ch != "visual":
        raise RuntimeError(f"channel {ch!r} is not offered remotely")
    env = _env("visual", PROFILES["visual"]["env"], r.get("env"))
    _require_inputs(r, rep)
    where = {it["sha256"]: _unpack(it) for it in r["inputs"]}
    items = []
    for it in r["items"]:
        if it["kind"] == "text":
            items.append({"kind": "text", "text": it["text"], "role": it.get("role", "query")})
            continue
        base = where.get(it["input"])
        if base is None:
            raise RuntimeError(f"item refers to an input that was not sent ({str(it['input'])[:12]})")
        path = os.path.join(base, it["member"]) if it.get("member") else base
        if not os.path.isfile(path):
            raise RuntimeError(f"{it.get('member')} is not in input {it['input'][:12]}")
        items.append({"kind": "image", "path": path})
    req, out = f"{ROOT}/jobs/{r['id']}.req.json", f"{ROOT}/jobs/{r['id']}.rows.tmp"
    _write(req, {"items": items})
    code, stdout, err = _spawn(r, [_python(), _input_path(r["worker"]), ch, req, out], env)
    line = next((l for l in reversed(stdout.splitlines()) if l.startswith("{")), None)
    meta = json.loads(line) if line else {}
    rep["stderr_tail"] = err[-800:]
    if code != 0 or not meta.get("ok"):
        raise RuntimeError(f"embedding failed (exit {code}): {meta.get('error') or err[-600:]}")
    if meta["n"] != len(items):
        raise RuntimeError(f"worker embedded {meta['n']} of {len(items)} item(s)")
    rep.update(n=meta["n"], dim=meta["dim"], device=meta.get("device"), worker_model=meta.get("model"))
    with open(out, "rb") as f:
        _publish(r, rep, "f32", f.read())
    os.remove(out)


KINDS = {"describe": _run_describe, "embed": _run_embed}


def _run_job(r):
    boot = STATE.get("boot") or {}
    rep = {"id": r["id"], "kind": r.get("kind"), "state": "running", "versions": boot.get("versions"), "profiles": boot.get("profiles")}
    t0 = time.time()
    try:
        KINDS[r["kind"]](r, rep)
        rep["state"] = "ok"
    except Exception:
        rep.update(state="error", error=traceback.format_exc()[-2500:])
    rep["sec"] = round(time.time() - t0, 1)
    _write(f"{ROOT}/jobs/{r['id']}.json", rep, f"{ROOT}/jobs/{r['id']}.done")


_CANCELLED = globals().get("_CANCELLED") or set()  # queued job ids to drop instead of run


def _worker():
    while True:
        r = _JOBS.get()
        if r["id"] in _CANCELLED:  # the caller gave up while it was queued: do not spend GPU on it
            _CANCELLED.discard(r["id"])
            _ACTIVE.pop(r["id"], None)
            _write(f"{ROOT}/jobs/{r['id']}.json", {"id": r["id"], "state": "error", "error": "cancelled before it started"},
                   f"{ROOT}/jobs/{r['id']}.done")
            continue
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
    for p in os.listdir(f"{ROOT}/jobs"):
        if p.startswith(r["id"] + "."):
            os.remove(f"{ROOT}/jobs/{p}")
    _ACTIVE[r["id"]] = None
    _JOBS.put(r)
    print(json.dumps({"ok": True, "queued": r["id"], "depth": _JOBS.qsize()}))


def analysis_cancel(req):
    jid = req["id"]
    if jid not in _ACTIVE:
        print(json.dumps({"ok": True, "cancelled": None}))
        return
    p = _ACTIVE.get(jid)
    if p is None:  # still queued
        _CANCELLED.add(jid)
        print(json.dumps({"ok": True, "cancelled": jid, "queued": True}))
        return
    if p.poll() is None:
        os.killpg(p.pid, signal.SIGKILL)
    print(json.dumps({"ok": True, "cancelled": jid}))


print(json.dumps({"ok": True, "worker": "vosana"}))
