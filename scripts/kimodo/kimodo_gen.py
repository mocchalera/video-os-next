#!/usr/bin/env python3
"""Generate whole-body motion with NVIDIA Kimodo on a rented Colab GPU (costs compute units: get a budget from the human).

    python3 scripts/kimodo/kimodo_gen.py --out motion/walk_in --prompt "A person walks in and stops." \
        --seconds 5.5 --samples 2 --seed 7 [--constraints blocking.json] --max-minutes 30

Writes <out>/<name>_NN.bvh (+ .npz) and <out>/motion.json (prompt, seed, model, kimodo commit, constraints, files,
sha256). Use them in a previz scene with python/previz_motion.py (load_bvh + apply).

Needs: the `colab` CLI (authenticated), an L4 entitlement, and a Hugging Face token with access to the gated
meta-llama/Meta-Llama-3-8B-Instruct (Kimodo's text encoder) and nvidia/Kimodo-SOMA-RP-v1 in ~/.config/vos/hf_token
(VOS_HF_TOKEN_FILE overrides; the token goes to the VM as a file, never on a command line).
The VM is always stopped at the end, also on errors and when --max-minutes runs out.
"""
import argparse
import hashlib
import json
import os
import shlex
import subprocess
import sys
import tempfile
import time
from pathlib import Path

KIMODO_REPO = "https://github.com/nv-tlabs/kimodo"
KIMODO_REV = "58e781898b3d7e328a676a75d3e338c45dce3ad9"   # tested 2026-10-01
MODEL = "Kimodo-SOMA-RP-v1"
DEPS = ["transformers==5.1.0", "hydra-core>=1.3", "omegaconf>=2.3", "peft>=0.18", "einops>=0.7", "bvhio",
        "trimesh>=3.21.7", "av>=16.1.0", "boto3", "pydantic>=2.0", "git+https://github.com/NVlabs/SOMA-X.git"]
QUIET = ("new version", "colab update", "silence this check")


def colab(*args, stdin=None, timeout=90):
    """One `colab` call with a hard timeout (a hung websocket must not keep a paid VM waiting)."""
    try:
        r = subprocess.run(["colab", *args], input=stdin, capture_output=True, text=True, timeout=timeout)
        out = r.stdout + r.stderr
    except subprocess.TimeoutExpired as e:
        out = (e.stdout or "") if isinstance(e.stdout, str) else ""
        out += "\n[kimodo_gen] colab call timed out"
    return "\n".join(l for l in out.splitlines() if not any(q in l for q in QUIET))


def vm_py(session, code, timeout=90):
    return colab("exec", "-s", session, stdin=code, timeout=timeout)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", required=True, help="local output directory (e.g. <project>/motion/<name>)")
    ap.add_argument("--prompt", required=True)
    ap.add_argument("--seconds", type=float, default=5.0, help="motion length (Kimodo: up to 10 s per prompt)")
    ap.add_argument("--samples", type=int, default=2)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--constraints", default=None, help="Kimodo constraints JSON (see previz_motion.blocking_constraints)")
    ap.add_argument("--gpu", default="L4")
    ap.add_argument("--max-minutes", type=float, default=30.0, help="hard stop for the whole run (VM time)")
    ap.add_argument("--session", default="vos-kimodo")
    a = ap.parse_args()
    if not 0 < a.seconds <= 10:
        sys.exit("--seconds must be in (0, 10]: Kimodo generates up to 10 s per prompt")
    out = Path(a.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    name = out.name
    tok = Path(os.environ.get("VOS_HF_TOKEN_FILE", Path.home() / ".config/vos/hf_token"))
    if not tok.is_file():
        sys.exit(f"no Hugging Face token file at {tok}")
    deadline = time.monotonic() + a.max_minutes * 60
    s = a.session

    print(colab("new", "-s", s, "--gpu", a.gpu, timeout=600))
    try:
        print(colab("upload", "-s", s, str(tok), "/content/.hf_token", timeout=120))
        if a.constraints:
            print(colab("upload", "-s", s, str(Path(a.constraints).resolve()), "/content/constraints.json", timeout=120))
        gen = (f"kimodo_gen {shlex.quote(a.prompt)} --model {MODEL} --duration {a.seconds} --num_samples {a.samples} "
               f"--seed {a.seed} --output /content/out/{name} --bvh"
               + (" --constraints /content/constraints.json" if a.constraints else ""))
        steps = [
            "cd /content && rm -rf out && mkdir -p out",
            f"cd /content && ([ -d kimodo ] || git clone -q {KIMODO_REPO} kimodo)",
            f"cd /content/kimodo && git checkout -q {KIMODO_REV}",
            "cd /content/kimodo && python -m pip install -q --no-deps --no-build-isolation -e .",
            "python -m pip install -q " + " ".join(shlex.quote(d) for d in DEPS),
            "python -m pip uninstall -y -q torchao",   # Colab's torchao 0.10 breaks transformers 5.1
            "cd /content && " + gen,
        ]
        script = " && ".join(f"( {x} ) >> /content/kimodo.log 2>&1" for x in steps)
        launch = f"""
import os, subprocess
if os.path.exists('/content/kimodo.pid') and os.path.exists('/proc/' + open('/content/kimodo.pid').read().strip()):
    print('launched (already running)')
else:
    tok = open('/content/.hf_token').read().strip()
    open('/content/kimodo.log', 'w').close()
    env = dict(os.environ, HF_TOKEN=tok, HUGGING_FACE_HUB_TOKEN=tok)
    p = subprocess.Popen(['bash', '-c', {script!r} + '; echo KIMODO_EXIT $? >> /content/kimodo.log'], env=env,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    open('/content/kimodo.pid', 'w').write(str(p.pid))
    print('launched')
"""
        for attempt in range(3):   # a fresh kernel can be slow to answer; the launch is idempotent (pid file)
            r = vm_py(s, launch, timeout=300)
            if "launched" in r:
                break
        else:
            raise SystemExit(f"could not start the job on the VM:\n{r}")
        while True:
            if time.monotonic() > deadline:
                raise SystemExit(f"--max-minutes {a.max_minutes} reached; stopping the VM")
            time.sleep(30)
            r = vm_py(s, "print(open('/content/kimodo.log').read()[-600:])", timeout=120)
            if "KIMODO_EXIT" in r:
                break
        if "KIMODO_EXIT 0" not in r:
            raise SystemExit(f"Kimodo failed on the VM:\n{r}")
        print(vm_py(s, "import shutil; shutil.make_archive('/content/kimodo_out', 'zip', '/content/out'); print('zipped')"))
        with tempfile.TemporaryDirectory() as td:
            z = Path(td) / "out.zip"
            print(colab("download", "-s", s, "/content/kimodo_out.zip", str(z), timeout=300))
            subprocess.run(["unzip", "-o", "-q", str(z), "-d", str(Path(td) / "x")], check=True)
            for p in (Path(td) / "x").rglob("*"):   # one sample -> <name>.bvh, several -> <name>/<name>_NN.bvh
                if p.suffix in (".bvh", ".npz"):
                    p.replace(out / p.name)
    finally:
        print(colab("stop", "-s", s, timeout=180))

    files = sorted(p for p in out.iterdir() if p.suffix in (".bvh", ".npz"))
    record = {
        "format": "vos.motion/1", "generator": "kimodo", "model": MODEL, "kimodo_rev": KIMODO_REV,
        "prompt": a.prompt, "seconds": a.seconds, "samples": a.samples, "seed": a.seed, "gpu": a.gpu,
        "constraints": json.loads(Path(a.constraints).read_text()) if a.constraints else None,
        "fps": 30, "skeleton": "SOMA-77 (BVH, cm, Y up, +Z forward)",
        "files": {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in files},
        "at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "license": "Kimodo code Apache-2.0; SOMA-RP weights NVIDIA Open Model License",
    }
    (out / "motion.json").write_text(json.dumps(record, indent=1, ensure_ascii=False))
    print(json.dumps({"ok": True, "out": str(out), "files": [p.name for p in files]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
