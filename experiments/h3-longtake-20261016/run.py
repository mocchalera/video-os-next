"""One authorized 10-CU pilot, with a guarded VM and unconditional cleanup."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import time

from workflow import build_graph, delivered_frames

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
OUT = HERE / "outputs"
GUARD = REPO / "scripts/colab/vos-colab"
SESSION = "h3-longtake-20261016"
REMOTE = "/content/h3pilot"


def log(message):
    print(time.strftime("%H:%M:%S"), message, flush=True)


def run(args, timeout=120, check=True):
    result = subprocess.run([str(a) for a in args], text=True, capture_output=True, timeout=timeout)
    with (OUT / "commands.log").open("a") as f:
        f.write(json.dumps({"args": [str(a) for a in args], "rc": result.returncode,
                            "stdout": result.stdout, "stderr": result.stderr}) + "\n")
    if check and result.returncode:
        raise RuntimeError(f"Command failed ({result.returncode}): {args[0]} {args[1]}\n{result.stdout[-1500:]}\n{result.stderr[-2000:]}")
    return result


def guard(*args, timeout=180):
    result = run([GUARD, *args], timeout=timeout)
    data = json.loads(result.stdout)
    if data.get("ok") is False:
        raise RuntimeError(json.dumps(data))
    return data


def execute(code, name, timeout=90):
    file = OUT / f"exec_{name}.py"
    file.write_text(code + "\n")
    run([GUARD, "exec", SESSION, "-f", file, "--timeout", timeout], timeout=timeout + 60)


def download(name, check=True):
    target = OUT / name
    result = run(["colab", "download", "-s", SESSION, f"{REMOTE}/{name}", target], timeout=120, check=check)
    return target if result.returncode == 0 else None


def wait_for(name, timeout):
    run([GUARD, "wait", SESSION, f"{REMOTE}/{name}.done", "--timeout", timeout, "--every", "10"], timeout=timeout + 120)
    path = download(f"{name}.json")
    data = json.loads(path.read_text())
    if data.get("state") not in ("ready", "ok"):
        raise RuntimeError(json.dumps(data, ensure_ascii=False)[-6500:])
    return data


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--budget-cu", type=float)
    args = parser.parse_args()
    prompt = (HERE / "prompt.txt").read_text()
    graphs = [build_graph(index, prompt) for index in (1, 2, 3)]
    OUT.mkdir(exist_ok=True)
    for index, graph in enumerate(graphs, 1):
        (OUT / f"planned_graph_{index:02d}.json").write_text(json.dumps(graph, indent=2) + "\n")
    log(f"Validated 3 acyclic graphs; delivery {sum(delivered_frames(i) for i in (1, 2, 3))}/24 seconds")
    if not args.execute:
        log("Dry run only: no GPU or model downloads")
        return
    if args.budget_cu != 10:
        raise SystemExit("This pilot is authorized only with --budget-cu 10")
    if not (HERE / "inputs/character.png").is_file():
        raise SystemExit("Missing pinned sample image: follow README preparation before allocating a VM")
    # A second invocation cannot silently rent another VM against the same approval.
    with (OUT / "execution.started").open("x") as marker:
        marker.write(time.strftime("%Y-%m-%dT%H:%M:%S%z") + "\n")
    snapshot = OUT / "base_worker.py"
    shutil.copy2(REPO / "python/colab_gen_vm.py", snapshot)
    lock = json.loads((HERE / "source-lock.json").read_text())
    if hashlib.sha256(snapshot.read_bytes()).hexdigest() != lock["local_base_worker"]["sha256"]:
        raise RuntimeError("The existing worker changed since preflight; inspect before spending")
    attempt = {"budget_cu": 10, "session": SESSION, "state": "starting", "started_at": time.time()}
    allocation_attempted = False
    try:
        before = guard("status", SESSION)
        if before.get("orphans") or any(s["state"] != "stopped" for s in before.get("sessions", [])):
            raise RuntimeError("Existing/orphaned session found; refusing to interfere")
        attempt["balance_before"] = before["balance"]
        allocation_attempted = True
        log("Starting isolated A100; guard budget 10 CU, wall deadline 90 min")
        attempt["start"] = guard("start", SESSION, "--gpu", "A100", "--budget-cu", "10",
                                  "--max-hours", "1.5", "--lease-min", "10", timeout=900)
        execute(f"from pathlib import Path\nPath({REMOTE!r}).mkdir(exist_ok=True)", "mkdir")
        files = [(snapshot, "base_worker.py"), (HERE / "workflow.py", "workflow.py"),
                 (HERE / "vm_worker.py", "vm_worker.py"), (HERE / "source-lock.json", "source-lock.json"),
                 (HERE / "prompt.txt", "prompt.txt"), (HERE / "inputs/character.png", "character.png")]
        for source, name in files:
            run(["colab", "upload", "-s", SESSION, source, f"{REMOTE}/{name}"], timeout=90)
        execute(f"exec(compile(open({REMOTE + '/vm_worker.py'!r}).read(), 'vm_worker.py', 'exec'), globals())\npilot_launch('setup')", "setup")
        log("Preparing pinned ComfyUI, custom nodes and model weights")
        setup = wait_for("setup", 1800)
        attempt["setup"] = setup
        download("schemas.json")
        if "A100" not in setup["gpu"]:
            raise RuntimeError(f"Allocated GPU is not the authorized A100: {setup['gpu']}")
        log(f"Ready: {setup['gpu']}; setup {setup['sec']} s")
        attempt["segments"] = []
        for index in (1, 2, 3):
            current = guard("status", SESSION)
            row = next(s for s in current["sessions"] if s["name"] == SESSION)
            if row["state"] != "running" or row["spent_cu"] >= 8.0:
                raise RuntimeError("Stopping before another segment: runtime stopped or <2 CU reserve")
            log(f"Segment {index}/3: base 10 steps + refine 5 steps; estimated spend {row['spent_cu']} CU")
            execute(f"pilot_launch('segment', {index})", f"segment_{index:02d}")
            receipt = wait_for(f"segment_{index:02d}", 1560)
            latent = OUT / f"latent_{index:02d}.safetensors"
            run(["colab", "download", "-s", SESSION,
                 f"/content/ComfyUI/output/h3pilot/latents/clip_{index:05d}.safetensors", latent])
            if latent.stat().st_size != receipt["latent_bytes"]:
                raise RuntimeError(f"Latent download size mismatch: {latent.name}")
            receipt["downloaded_latent"] = {"file": latent.name,
                                           "sha256": hashlib.sha256(latent.read_bytes()).hexdigest()}
            for label, output in receipt["outputs"].items():
                path = download(f"segment_{index:02d}_{label}.mp4")
                if hashlib.sha256(path.read_bytes()).hexdigest() != output["sha256"]:
                    raise RuntimeError(f"Download hash mismatch: {path.name}")
            download(f"graph_{index:02d}.json")
            download(f"history_{index:02d}.json")
            attempt["segments"].append(receipt)
            (OUT / "run.json").write_text(json.dumps(attempt, indent=2) + "\n")
            log(f"Segment {index} downloaded and hash-checked ({receipt['sec']} s)")
        attempt["state"] = "generated"
    except BaseException as exc:
        attempt.update(state="error", error=str(exc))
        log(f"Pilot stopped: {str(exc)[-2000:]}")
        raise
    finally:
        if allocation_attempted:
            # Preserve the diagnostic log before release, without allowing a failed
            # download to skip the VM stop.
            try:
                run(["colab", "download", "-s", SESSION, f"{REMOTE}/runtime/server.log", OUT / "server.log"], timeout=30, check=False)
            except Exception as exc:
                attempt["diagnostic_download_error"] = str(exc)
            log("Releasing the experiment VM")
            try:
                attempt["stop"] = guard("stop", SESSION, timeout=240)
            except Exception as exc:
                attempt["stop_error"] = str(exc)
            finally:
                try:
                    attempt["after"] = guard("status", SESSION)
                except Exception as exc:
                    attempt["stop_verification_error"] = str(exc)
        attempt["ended_at"] = time.time()
        (OUT / "run.json").write_text(json.dumps(attempt, indent=2) + "\n")
        log(f"Final run record: {OUT / 'run.json'}")
        if allocation_attempted and not any(
            s.get("name") == SESSION and s.get("state") == "stopped"
            for s in attempt.get("after", {}).get("sessions", [])
        ):
            raise RuntimeError("VM release is not confirmed; inspect the guarded session before leaving")


if __name__ == "__main__":
    main()
