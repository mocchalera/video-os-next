#!/usr/bin/env python3
"""Render a stage-aware previz scene one stage at a time, headless, and write a receipt.

    python3 skills/stepwise-scene-production/scripts/render_stages.py \
        --scene examples/previz/stepwise_drum_kit.py --ref <reference.png> --out <dir> \
        [--stages layout,form,material,motion] [--size 512x288] [--motion-frames 48] [--min-free-gib 15]

The scene script must contain a line `STAGE = "<name>"`; each stage gets its own copy (<out>/<NN>_<stage>/scene.py)
with that line replaced, so every stage stays reproducible on its own and works unchanged with `vos previz render`.
It is rendered by the repo driver (python/blender_previz.py: beauty + depth passes), one Blender job at a time.
Stills: stages before `motion` render 1 frame. `motion` renders --motion-frames and gets start/mid/end stills + mp4s.

Output: <out>/<NN>_<stage>.png (+ _depth.png), motion_{start,mid,end}.png, motion_beauty.mp4, motion_depth.mp4,
contact_sheet.png, receipt.json (Blender version, engine, size, frames, wall time, exact commands, hashes, camera
numbers, depth range, unseen/guessed shapes, resource preflight and cleanup of the processes this script started).
Nothing is written outside --out. Only Blender and ffmpeg processes started here are waited for / killed.
Stdlib only.
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
DRIVER = os.path.join(REPO, "python", "blender_previz.py")
MAC_BLENDER = "/Applications/Blender.app/Contents/MacOS/Blender"
FONT = "/System/Library/Fonts/Supplemental/Arial.ttf"
OWN_PIDS = []


def sha(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def free_gib(path):
    st = os.statvfs(path)
    return round(st.f_bavail * st.f_frsize / 2**30, 2)


def heavy_processes():
    """Other Blender / ffmpeg processes already running (reported, never touched)."""
    out = subprocess.run(["ps", "-axo", "pid=,command="], capture_output=True, text=True).stdout
    rows = []
    for line in out.splitlines():
        pid, _, cmd = line.strip().partition(" ")
        if int(pid) == os.getpid():
            continue
        if re.search(r"Blender\.app/Contents/MacOS/Blender|(^|/)ffmpeg\s", cmd):
            rows.append({"pid": int(pid), "command": cmd[:160]})
    return rows


def run(cmd, env=None, timeout=1800):
    t0 = time.time()
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=env)
    OWN_PIDS.append(p.pid)
    try:
        out, _ = p.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        p.kill()
        out, _ = p.communicate()
        raise SystemExit(f"timeout after {timeout}s: {' '.join(cmd)}\n{out[-2000:]}")
    return p.returncode, out, round(time.time() - t0, 2)


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--scene", required=True)
    ap.add_argument("--ref", action="append", default=[], help="reference image(s); hashed into the receipt")
    ap.add_argument("--out", required=True)
    ap.add_argument("--stages", default="layout,form,material,motion")
    ap.add_argument("--size", default="512x288")
    ap.add_argument("--motion-frames", type=int, default=48)
    ap.add_argument("--fps", type=int, default=24)
    ap.add_argument("--min-free-gib", type=float, default=15.0)
    ap.add_argument("--blender", default=os.environ.get("VOS_BLENDER", MAC_BLENDER))
    ap.add_argument("--save-blend", action="store_true", help="also save each stage as .blend (scene state before render)")
    a = ap.parse_args()

    out = os.path.abspath(a.out)
    os.makedirs(out, exist_ok=True)
    w, h = (int(v) for v in a.size.split("x"))
    stages = a.stages.split(",")
    template = open(a.scene).read()
    if not re.search(r'^STAGE = "[a-z]+"$', template, re.M):
        raise SystemExit('scene must contain a line: STAGE = "<stage>"')

    pre = {"free_gib_internal": free_gib("/"), "free_gib_out": free_gib(out), "other_heavy_processes": heavy_processes(),
           "min_free_gib": a.min_free_gib}
    if pre["free_gib_internal"] < a.min_free_gib:
        raise SystemExit(f"preflight: only {pre['free_gib_internal']} GiB free on / (< {a.min_free_gib}); not rendering")
    if pre["other_heavy_processes"]:
        raise SystemExit(f"preflight: other Blender/ffmpeg running, not rendering: {pre['other_heavy_processes']}")

    ver = subprocess.run([a.blender, "--version"], capture_output=True, text=True).stdout.splitlines()[0]
    receipt = {"format": "vos.stepwise-trial/1", "blender": ver, "blender_bin": a.blender, "driver": os.path.relpath(DRIVER, REPO),
               "driver_sha256": sha(DRIVER), "scene_template": os.path.relpath(os.path.abspath(a.scene), REPO)
               if os.path.abspath(a.scene).startswith(REPO) else os.path.basename(a.scene),
               "scene_template_sha256": sha(a.scene), "references": [{"path": r, "sha256": sha(r), "bytes": os.path.getsize(r)}
                                                                     for r in a.ref],
               "size": [w, h], "fps": a.fps, "preflight": pre, "stages": [], "started": time.strftime("%Y-%m-%dT%H:%M:%S%z")}
    t_all = time.time()
    for i, st in enumerate(stages, 1):
        d = os.path.join(out, f"{i:02d}_{st}")
        if os.path.isdir(d):
            shutil.rmtree(d)
        os.makedirs(d)
        scene = os.path.join(d, "scene.py")
        with open(scene, "w") as f:
            f.write(re.sub(r'^STAGE = "[a-z]+"$', f'STAGE = "{st}"', template, count=1, flags=re.M))
        frames = a.motion_frames if st == "motion" else 1
        env = dict(os.environ, STEPWISE_META=os.path.join(d, "stage_meta.json"))
        if a.save_blend:
            env["STEPWISE_BLEND"] = os.path.join(d, f"{st}.blend")
        cmd = [a.blender, "--factory-startup", "-b", "-P", DRIVER, "--", "--scene", scene, "--out", d, "--width", str(w),
               "--height", str(h), "--frames", str(frames), "--fps", str(a.fps)]
        rc, log, secs = run(cmd, env=env)
        with open(os.path.join(d, "blender.log"), "w") as f:
            f.write(log)
        if rc != 0 or "previz: done" not in log:
            receipt["stages"].append({"stage": st, "ok": False, "returncode": rc, "seconds": secs, "command": cmd,
                                      "log_tail": log[-1500:]})
            break
        pv = json.load(open(os.path.join(d, "previz.json")))
        meta = json.load(open(os.path.join(d, "stage_meta.json")))
        files = {}
        if st == "motion":
            mid = (frames + 1) // 2
            for tag, fr in (("start", 1), ("mid", mid), ("end", frames)):
                dst = os.path.join(out, f"motion_{tag}.png")
                shutil.copy(os.path.join(d, "beauty", f"{fr:04d}.png"), dst)
                files[f"motion_{tag}"] = dst
            dst = os.path.join(out, "motion_depth_start.png")
            shutil.copy(os.path.join(d, "depth", "0001.png"), dst)
            files["motion_depth_start"] = dst
            for p in ("beauty", "depth"):
                mp4 = os.path.join(out, f"motion_{p}.mp4")
                enc = ["ffmpeg", "-v", "error", "-y", "-framerate", str(a.fps), "-i", os.path.join(d, p, "%04d.png"),
                       "-c:v", "libx264", "-crf", "20", "-pix_fmt", "yuv420p", mp4]
                erc, elog, esecs = run(enc)
                if erc != 0:
                    raise SystemExit(elog)
                files[f"motion_{p}_mp4"] = mp4
        else:
            for p, suffix in (("beauty", ""), ("depth", "_depth")):
                dst = os.path.join(out, f"{i:02d}_{st}{suffix}.png")
                shutil.copy(os.path.join(d, p, "0001.png"), dst)
                files[f"{p}"] = dst
        if st != "motion":
            for p in ("beauty", "depth"):
                shutil.rmtree(os.path.join(d, p))  # the copied stills are the record; frames are reproducible
        receipt["stages"].append({
            "stage": st, "ok": True, "seconds": secs, "frames": frames, "command": cmd,
            "scene": os.path.relpath(scene, out), "scene_sha256": sha(scene), "engine": pv["engine"], "blender": pv["blender"],
            "depth": pv["depth"], "camera": meta["camera"], "look_at": meta["look_at"], "mesh_objects": meta["mesh_objects"],
            "materials": meta["materials"], "unseen_guessed": meta["unseen_guessed"],
            "blend": os.path.relpath(env["STEPWISE_BLEND"], out) if a.save_blend and os.path.exists(env["STEPWISE_BLEND"]) else None,
            "outputs": {k: {"path": os.path.relpath(v, out), "sha256": sha(v), "bytes": os.path.getsize(v)} for k, v in files.items()}})
        print(f"stage {st}: ok in {secs}s", flush=True)

    # contact sheet: reference | stage stills ; depth | motion start / mid / end
    tiles = ([(a.ref[0], "reference")] if a.ref else [])
    tiles += [(os.path.join(out, f"{i:02d}_{st}.png"), st) for i, st in enumerate(stages, 1) if st != "motion"]
    tiles += [(os.path.join(out, f"{i:02d}_{st}_depth.png"), f"{st} depth") for i, st in enumerate(stages, 1)
              if st == "material"]
    tiles += [(os.path.join(out, f"motion_{t}.png"), f"motion {t}") for t in ("start", "mid", "end")]
    tiles = [(p, lbl) for p, lbl in tiles if os.path.exists(p)]
    if tiles:
        cols = 4
        inputs, chains = [], []
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
        sheet = os.path.join(out, "contact_sheet.png")
        rc, log, _ = run(["ffmpeg", "-v", "error", "-y", *inputs, "-filter_complex", fc, "-map", "[o]", "-frames:v", "1", sheet])
        if rc == 0:
            receipt["contact_sheet"] = {"path": "contact_sheet.png", "sha256": sha(sheet), "bytes": os.path.getsize(sheet),
                                        "tiles": [lbl for _, lbl in tiles]}
        else:
            receipt["contact_sheet_error"] = log[-800:]

    receipt["total_seconds"] = round(time.time() - t_all, 2)
    left = [p for p in OWN_PIDS if alive(p)]
    for p in left:
        os.kill(p, signal.SIGTERM)
    receipt["cleanup"] = {"own_pids": OWN_PIDS, "still_alive_before_cleanup": left,
                          "still_alive_after_cleanup": [p for p in OWN_PIDS if alive(p)]}
    receipt["post"] = {"free_gib_internal": free_gib("/"), "free_gib_out": free_gib(out),
                       "out_bytes": sum(os.path.getsize(os.path.join(r, f)) for r, _, fs in os.walk(out) for f in fs),
                       "other_heavy_processes": heavy_processes()}
    with open(os.path.join(out, "receipt.json"), "w") as f:
        json.dump(receipt, f, indent=1)
    ok = all(s["ok"] for s in receipt["stages"]) and len(receipt["stages"]) == len(stages)
    print(json.dumps({"ok": ok, "receipt": os.path.join(out, "receipt.json"), "total_seconds": receipt["total_seconds"]}))
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
