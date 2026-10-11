#!/usr/bin/env python3
"""Render a stage-aware previz scene one stage at a time, headless, and write a receipt.

    python3 skills/stepwise-scene-production/scripts/render_stages.py \
        --scene examples/previz/stepwise_drum_kit.py --ref <reference.png> --out <NEW dir outside the repo> \
        [--stages layout,form,material,motion] [--size 512x288] [--motion-frames 48] [--min-free-gib 15] [--save-blend]

Scene contract (see SKILL.md §3): one line `STAGE = "<name>"` (and optionally `ORDER = [...]`), and the scene writes
JSON to os.environ["STEPWISE_META"] with keys stage, camera, look_at, unseen_guessed, mesh_objects, materials.

Each run needs a fresh --out (it refuses an existing path, so earlier runs stay untouched). Each stage gets its own
scene copy (<out>/<NN>_<stage>/scene.py) with the STAGE line replaced, rendered by the repo driver
(python/blender_previz.py: beauty + depth) — one Blender job at a time, a resource check before every job.
Stills: stages before `motion` render 1 frame; `motion` renders --motion-frames and gets start/mid/end stills + mp4s.
contact_sheet.png is built only from the stages that succeeded in this run.

receipt.json is written on success, failure, timeout and Ctrl-C (status says which): Blender version, engine, size,
frames, wall time, exact commands, runner / driver / scene / reference / output hashes, camera numbers and the move,
depth range, guessed shapes, preflight per stage, and the state of every process this run started.
Only processes started here (their Popen handles) are ever signalled. Python bytecode is not written (Blender's
embedded Python included); Blender may still use the system temp dir. Stdlib only.
"""
import argparse
import hashlib
import json
import math
import os
import re
import shutil
import signal
import subprocess
import sys
import time

sys.dont_write_bytecode = True
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
DRIVER = os.path.join(REPO, "python", "blender_previz.py")
MAC_BLENDER = "/Applications/Blender.app/Contents/MacOS/Blender"
FONT = "/System/Library/Fonts/Supplemental/Arial.ttf"
DEFAULT_ORDER = ["layout", "form", "material", "motion"]
MAX_PIXELS = 1344 * 768        # nothing above H3's 768p
MAX_FRAMES = 124               # 5 s on H3's grid; the skill's drafts stay at <= 48
META_KEYS = ("stage", "camera", "look_at", "unseen_guessed", "mesh_objects", "materials")
NO_BYTECODE = "import sys; sys.dont_write_bytecode = True; print('stepwise: bytecode off')"

# Running processes that make a render now unsafe (heavy CPU/GPU/RAM), and ones only reported.
BLOCKING = [
    ("blender", re.compile(r"(^|/)blender(\s|$)", re.I)),
    ("ffmpeg", re.compile(r"(^|/)ffmpeg(\s|$)")),
    ("llama-server", re.compile(r"(^|/)llama-server(\s|$)")),
    ("ollama runner", re.compile(r"(^|/)ollama\s+runner\b")),
    ("vos model worker", re.compile(r"(marlin_worker|embed_worker|colab_gen_vm)\.py")),
    ("comfyui", re.compile(r"ComfyUI.*main\.py|comfyui", re.I)),
    ("mlx", re.compile(r"mlx_lm|mlx_vlm")),
]
REPORT_ONLY = [
    ("blender-mcp (MCP server, not a render)", re.compile(r"blender-mcp")),
    ("blender-thumbnailer (macOS Quick Look)", re.compile(r"blender-thumbnailer")),
    ("ollama serve (idle daemon)", re.compile(r"(^|/)ollama\s+serve\b")),
]


class Stop(Exception):
    """Abort the run; the receipt records why."""


def sha(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def free_gib(path):
    st = os.statvfs(path)
    return round(st.f_bavail * st.f_frsize / 2**30, 2)


def ps_rows():
    """[(pid, command)] of all processes. Raises Stop if the process table cannot be read — never 'nothing running'."""
    try:
        r = subprocess.run(["ps", "-axo", "pid=,command="], capture_output=True, text=True, timeout=20)
    except (OSError, subprocess.SubprocessError) as e:
        raise Stop(f"preflight: cannot read the process table ({e}); resource state unverifiable, not rendering")
    if r.returncode != 0 or not r.stdout.strip():
        raise Stop(f"preflight: ps failed (rc={r.returncode}); resource state unverifiable, not rendering")
    rows = []
    for line in r.stdout.splitlines():
        pid, _, cmd = line.strip().partition(" ")
        if pid.isdigit():
            rows.append((int(pid), cmd.strip()))
    return rows


def classify(rows, blender_bin, own_pids=()):
    """Split running processes into blocking / report-only. The configured Blender binary always counts."""
    real = os.path.realpath(blender_bin) if blender_bin else None
    block, report = [], []
    for pid, cmd in rows:
        if pid == os.getpid() or pid in own_pids:
            continue
        exe = cmd.split(" ")[0]
        hit = next((name for name, rx in REPORT_ONLY if rx.search(cmd)), None)
        if hit:
            report.append({"pid": pid, "kind": hit, "command": cmd[:160]})
            continue
        hit = next((name for name, rx in BLOCKING if rx.search(exe) or (name != "blender" and rx.search(cmd))), None)
        if not hit and real and (exe == blender_bin or os.path.realpath(exe) == real):
            hit = "blender"
        if hit:
            block.append({"pid": pid, "kind": hit, "command": cmd[:160]})
    return block, report


def resource_check(out_parent, a, own_pids=()):
    block, report = classify(ps_rows(), a.blender, own_pids)
    st = {"free_gib_internal": free_gib("/"), "free_gib_out": free_gib(out_parent), "min_free_gib": a.min_free_gib,
          "blocking_processes": block, "reported_processes": report}
    if st["free_gib_internal"] < a.min_free_gib or st["free_gib_out"] < a.min_free_gib:
        raise Stop(f"preflight: free space / {st['free_gib_internal']} GiB, out {st['free_gib_out']} GiB "
                   f"(< {a.min_free_gib}); not rendering")
    if block:
        raise Stop(f"preflight: other heavy processes running, not rendering: {block}")
    return st


def validate(a, template):
    """Check every argument before anything is created. Returns (out, stages, w, h)."""
    m = re.search(r"^ORDER = \[([^\]]*)\]", template, re.M)
    order = re.findall(r'"([a-z_]+)"', m.group(1)) if m else DEFAULT_ORDER
    if not re.search(r'^STAGE = "[a-z_]+"$', template, re.M):
        raise Stop('scene must contain a line: STAGE = "<stage>"')
    if "STEPWISE_META" not in template:
        raise Stop("scene does not write os.environ['STEPWISE_META'] (see SKILL.md §3 for the keys)")
    stages = [s.strip() for s in a.stages.split(",") if s.strip()]
    bad = [s for s in stages if s not in order]
    if not stages or bad:
        raise Stop(f"--stages: unknown {bad or 'empty'}; allowed {order}")
    if len(set(stages)) != len(stages):
        raise Stop(f"--stages: duplicates in {stages}")
    if stages != sorted(stages, key=order.index):
        raise Stop(f"--stages must follow the scene's order {order}")
    sm = re.fullmatch(r"(\d+)x(\d+)", a.size)
    if not sm:
        raise Stop(f"--size {a.size}: use WxH")
    w, h = int(sm.group(1)), int(sm.group(2))
    if w <= 0 or h <= 0 or w % 32 or h % 32 or w * h > MAX_PIXELS:
        raise Stop(f"--size {a.size}: multiples of 32, at most {MAX_PIXELS} pixels")
    if not 1 <= a.motion_frames <= MAX_FRAMES:
        raise Stop(f"--motion-frames {a.motion_frames}: 1..{MAX_FRAMES}")
    if not 1 <= a.fps <= 60:
        raise Stop(f"--fps {a.fps}: 1..60")
    if not 0 < a.stage_timeout <= 3600:
        raise Stop(f"--stage-timeout {a.stage_timeout}: 1..3600 s")
    out = os.path.abspath(a.out)
    if os.path.lexists(out):
        raise Stop(f"--out {out} exists; give a new directory (earlier runs are kept as they are)")
    if out == REPO or out.startswith(REPO + os.sep):
        raise Stop(f"--out {out} is inside the repo; write outside it")
    parent = os.path.dirname(out)
    if not os.path.isdir(parent):
        raise Stop(f"--out parent {parent} does not exist")
    for r in a.ref:
        if not os.path.isfile(r):
            raise Stop(f"--ref {r} not found")
    if not os.path.isfile(a.blender) or not os.access(a.blender, os.X_OK):
        raise Stop(f"--blender {a.blender} is not an executable file")
    return out, stages, w, h


class Runner:
    def __init__(self):
        self.procs = []  # (Popen, label) — only these are ever signalled

    def run(self, cmd, env=None, timeout=1800, log_path=None):
        t0 = time.time()
        p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=env)
        self.procs.append((p, os.path.basename(cmd[0])))
        try:
            out, _ = p.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            self.stop(p)
            out, _ = p.communicate()
            if log_path:
                with open(log_path, "w") as f:
                    f.write(out or "")
            raise Stop(f"timeout after {timeout}s: {os.path.basename(cmd[0])}")
        if log_path:
            with open(log_path, "w") as f:
                f.write(out)
        return p.returncode, out, round(time.time() - t0, 2)

    @staticmethod
    def stop(p):
        if p.poll() is None:  # still ours and running: the handle has not been reaped, so the PID is not reused
            p.terminate()
            try:
                p.wait(5)
            except subprocess.TimeoutExpired:
                p.kill()
                p.wait(5)

    def cleanup(self):
        running = [p.pid for p, _ in self.procs if p.poll() is None]
        for p, _ in self.procs:
            self.stop(p)
        return {"started": [{"pid": p.pid, "program": lbl, "returncode": p.returncode} for p, lbl in self.procs],
                "running_at_cleanup": running, "running_after_cleanup": [p.pid for p, _ in self.procs if p.poll() is None]}


def move_summary(meta, frames, fps):
    cams = meta.get("camera", {})
    a, b = cams.get("1"), cams.get(str(frames))
    if not a or not b or frames < 2:
        return None
    d = math.dist(a["location"], b["location"])
    secs = (frames - 1) / fps
    return {"distance_m": round(d, 4), "frames": frames, "seconds_first_to_last": round(secs, 4),
            "speed_m_s": round(d / secs, 4) if secs else None,
            "note": "valid for this frame count only; a different frame count changes speed and timing"}


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--scene", required=True)
    ap.add_argument("--ref", action="append", default=[], help="reference image(s); hashed into the receipt")
    ap.add_argument("--out", required=True, help="a NEW directory outside the repo")
    ap.add_argument("--stages", default="layout,form,material,motion")
    ap.add_argument("--size", default="512x288")
    ap.add_argument("--motion-frames", type=int, default=48)
    ap.add_argument("--fps", type=int, default=24)
    ap.add_argument("--min-free-gib", type=float, default=15.0)
    ap.add_argument("--stage-timeout", type=float, default=900)
    ap.add_argument("--blender", default=os.environ.get("VOS_BLENDER", MAC_BLENDER))
    ap.add_argument("--save-blend", action="store_true",
                    help="also save each stage as .blend: a snapshot of the scene BEFORE the driver sets engine, samples "
                         "and view transform — for inspection; reproduce with the receipt's command")
    a = ap.parse_args(argv)

    try:
        with open(a.scene) as f:
            template = f.read()
        out, stages, w, h = validate(a, template)
        pre = resource_check(os.path.dirname(out), a)
    except Stop as e:
        print(json.dumps({"ok": False, "status": "refused", "error": str(e)}))
        return 2

    os.makedirs(out)
    runner = Runner()
    receipt = {"format": "vos.stepwise-trial/2", "status": "running", "runner": os.path.relpath(__file__, REPO),
               "runner_sha256": sha(__file__), "blender_bin": a.blender, "driver": os.path.relpath(DRIVER, REPO),
               "driver_sha256": sha(DRIVER), "scene_template": os.path.relpath(os.path.abspath(a.scene), REPO)
               if os.path.abspath(a.scene).startswith(REPO + os.sep) else os.path.basename(a.scene),
               "scene_template_sha256": sha(a.scene),
               "references": [{"path": r, "sha256": sha(r), "bytes": os.path.getsize(r)} for r in a.ref],
               "requested_stages": stages, "size": [w, h], "fps": a.fps, "motion_frames": a.motion_frames,
               "preflight": pre, "stages": [], "started": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
               "blend_note": "a .blend is the scene before the driver sets engine/samples/view transform; "
                             "the reproduction path is re-running stages[].command"}
    t_all = time.time()
    try:
        v = runner.run([a.blender, "--version"], timeout=60)[1].strip().splitlines()
        receipt["blender"] = v[0] if v else "unknown"
        for i, st in enumerate(stages, 1):
            d = os.path.join(out, f"{i:02d}_{st}")
            os.makedirs(d)
            entry = {"stage": st, "ok": False, "dir": os.path.relpath(d, out)}
            receipt["stages"].append(entry)
            entry["preflight"] = resource_check(os.path.dirname(out), a)
            scene = os.path.join(d, "scene.py")
            with open(scene, "w") as f:
                f.write(re.sub(r'^STAGE = "[a-z_]+"$', f'STAGE = "{st}"', template, count=1, flags=re.M))
            frames = a.motion_frames if st == "motion" else 1
            env = dict(os.environ, STEPWISE_META=os.path.join(d, "stage_meta.json"), PYTHONDONTWRITEBYTECODE="1")
            if a.save_blend:
                env["STEPWISE_BLEND"] = os.path.join(d, f"{st}.blend")
            cmd = [a.blender, "--factory-startup", "-b", "--python-expr", NO_BYTECODE, "-P", DRIVER, "--",
                   "--scene", scene, "--out", d, "--width", str(w), "--height", str(h), "--frames", str(frames),
                   "--fps", str(a.fps)]
            entry.update(command=cmd, frames=frames, scene=os.path.relpath(scene, out), scene_sha256=sha(scene))
            rc, log, secs = runner.run(cmd, env=env, timeout=a.stage_timeout, log_path=os.path.join(d, "blender.log"))
            entry["seconds"] = secs
            if rc != 0 or "previz: done" not in log:
                entry.update(returncode=rc, log_tail=log[-1500:])
                raise Stop(f"stage {st}: Blender failed (rc={rc}); see {entry['dir']}/blender.log")
            meta_path = os.path.join(d, "stage_meta.json")
            if not os.path.exists(meta_path):
                raise Stop(f"stage {st}: the scene wrote no STEPWISE_META file")
            with open(meta_path) as f:
                meta = json.load(f)
            missing = [k for k in META_KEYS if k not in meta]
            if missing:
                raise Stop(f"stage {st}: STEPWISE_META lacks {missing}")
            with open(os.path.join(d, "previz.json")) as f:
                pv = json.load(f)
            files = {}
            if st == "motion":
                mid = (frames + 1) // 2
                for tag, fr in (("start", 1), ("mid", mid), ("end", frames)):
                    files[f"motion_{tag}"] = os.path.join(out, f"motion_{tag}.png")
                    shutil.copy(os.path.join(d, "beauty", f"{fr:04d}.png"), files[f"motion_{tag}"])
                files["motion_depth_start"] = os.path.join(out, "motion_depth_start.png")
                shutil.copy(os.path.join(d, "depth", "0001.png"), files["motion_depth_start"])
                for p in ("beauty", "depth"):
                    mp4 = os.path.join(out, f"motion_{p}.mp4")
                    erc, elog, _ = runner.run(["ffmpeg", "-v", "error", "-y", "-framerate", str(a.fps), "-i",
                                               os.path.join(d, p, "%04d.png"), "-c:v", "libx264", "-crf", "20",
                                               "-pix_fmt", "yuv420p", mp4], timeout=300)
                    if erc != 0:
                        raise Stop(f"stage {st}: ffmpeg failed: {elog[-300:]}")
                    files[f"motion_{p}_mp4"] = mp4
            else:
                for p, suffix in (("beauty", ""), ("depth", "_depth")):
                    files[p] = os.path.join(out, f"{i:02d}_{st}{suffix}.png")
                    shutil.copy(os.path.join(d, p, "0001.png"), files[p])
                    shutil.rmtree(os.path.join(d, p))  # the copied still is the record; frames are reproducible
            blend = env.get("STEPWISE_BLEND")
            entry.update(ok=True, engine=pv["engine"], blender=pv["blender"], depth=pv["depth"], camera=meta["camera"],
                         look_at=meta["look_at"], move=move_summary(meta, frames, a.fps), mesh_objects=meta["mesh_objects"],
                         materials=meta["materials"], unseen_guessed=meta["unseen_guessed"],
                         blend=os.path.relpath(blend, out) if blend and os.path.exists(blend) else None,
                         outputs={k: {"path": os.path.relpath(v, out), "sha256": sha(v), "bytes": os.path.getsize(v)}
                                  for k, v in files.items()})
            print(f"stage {st}: ok in {secs}s", flush=True)
        receipt["status"] = "ok"
    except Stop as e:
        receipt.update(status="failed", error=str(e))
    except KeyboardInterrupt:
        receipt.update(status="interrupted", error="KeyboardInterrupt")
    except Exception as e:  # noqa: BLE001 — record, clean up, then report
        receipt.update(status="failed", error=f"{type(e).__name__}: {e}")
    finally:
        receipt["cleanup"] = runner.cleanup()

    # contact sheet from this run's successful stages only
    done = [s for s in receipt["stages"] if s.get("ok")]
    tiles = [(a.ref[0], "reference")] if a.ref else []
    for s in done:
        o = s["outputs"]
        if s["stage"] == "motion":
            tiles += [(os.path.join(out, o[f"motion_{t}"]["path"]), f"motion {t}") for t in ("start", "mid", "end")]
        else:
            tiles.append((os.path.join(out, o["beauty"]["path"]), s["stage"]))
            if s["stage"] == "material":
                tiles.append((os.path.join(out, o["depth"]["path"]), "material depth"))
    if len(tiles) > (1 if a.ref else 0):
        try:
            sheet = os.path.join(out, "contact_sheet.png")
            cols, inputs, chains = 4, [], []
            for k, (p, lbl) in enumerate(tiles):
                inputs += ["-i", p]
                txt = f",drawtext=fontfile={FONT}:text='{lbl}':x=6:y=6:fontsize=16:fontcolor=white:box=1:boxcolor=black@0.6" \
                    if os.path.exists(FONT) else ""
                chains.append(f"[{k}:v]scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2{txt}[t{k}]")
            n = len(tiles)
            while n % cols:
                chains.append(f"color=c=gray:s={w}x{h}:d=1[t{n}]")
                n += 1
            layout = "|".join(f"{(k % cols) * w}_{(k // cols) * h}" for k in range(n))
            fc = ";".join(chains) + ";" + "".join(f"[t{k}]" for k in range(n)) + f"xstack=inputs={n}:layout={layout}[o]"
            rc, log, _ = runner.run(["ffmpeg", "-v", "error", "-y", *inputs, "-filter_complex", fc, "-map", "[o]",
                                     "-frames:v", "1", sheet], timeout=120)
            if rc == 0:
                receipt["contact_sheet"] = {"path": "contact_sheet.png", "sha256": sha(sheet), "bytes": os.path.getsize(sheet),
                                            "tiles": [lbl for _, lbl in tiles]}
            else:
                receipt["contact_sheet_error"] = log[-800:]
        except Exception as e:  # noqa: BLE001
            receipt["contact_sheet_error"] = f"{type(e).__name__}: {e}"
        finally:
            receipt["cleanup"] = runner.cleanup()

    receipt["total_seconds"] = round(time.time() - t_all, 2)
    try:
        block, report = classify(ps_rows(), a.blender)
        post_procs = {"blocking_processes": block, "reported_processes": report}
    except Stop as e:
        post_procs = {"error": str(e)}
    receipt["post"] = {"free_gib_internal": free_gib("/"), "free_gib_out": free_gib(out),
                       "out_bytes": sum(os.path.getsize(os.path.join(r, f)) for r, _, fs in os.walk(out) for f in fs),
                       **post_procs}
    with open(os.path.join(out, "receipt.json"), "w") as f:
        json.dump(receipt, f, indent=1)
    ok = receipt["status"] == "ok"
    print(json.dumps({"ok": ok, "status": receipt["status"], "error": receipt.get("error"),
                      "receipt": os.path.join(out, "receipt.json"), "total_seconds": receipt["total_seconds"]}))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
