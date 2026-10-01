---
name: previz-motion
description: Put generated whole-body motion (NVIDIA Kimodo, mocap-trained) on previz actors for blocking — people walking to marks, turning, standing, moving through a set — and turn it into depth / pose control. Use when a previz needs natural body motion or locomotion beyond what rig.perform builds; not for hands, fingers or instrument playing.
---

# Generated body motion in previz (Kimodo)

`rig.perform` (skills/previz-performance) composes a performance from beats; its walk is procedural and it has no
run, jump, sit or captured motion. Kimodo generates whole-body motion from text (+ where to be when) and was trained
on 700 h of optical mocap, so weight shifts, gait and idle sway read as human. Use it for **blocking**: where people
are, how they get there, and the same action seen from several cameras (one take, many angles — something H3 alone
cannot keep consistent across shots).

What it does not do (measured 2026-10-01, projects/band-phase0/NOTES.md): fingers, instrument technique, sync to
music (text only), contact between people or with props (one person at a time, no scene awareness). A generic
"playing guitar" body adds little over prompting H3 directly; leave faces, hands and instruments to H3.

## 1. Block it, then generate

Decide the start, the heading and the marks in scene coordinates (metres, 24 fps frames), like `rig.perform` paths:

```python
import previz_motion as pm, json
c = pm.blocking_constraints(start=(-2, 3), facing=51.3, marks=[(85, (0.5, 1.0)), (121, (0.5, 1.0))])
json.dump(c, open("motion/walk_in.constraints.json", "w"))
```

Then generate on Colab (costs compute units — get the budget from the human; the script stops the VM at the end,
on errors and at `--max-minutes`):

```bash
python3 scripts/kimodo/kimodo_gen.py --out motion/walk_in --prompt "A person walks forward at a normal pace, stops, and looks around." \
    --seconds 5.5 --samples 2 --seed 7 --constraints motion/walk_in.constraints.json --max-minutes 25
```

- One L4 (~1.5 CU/h); a cold run (clone, deps, model download ~16 GB) takes ~10 min, then seconds per take.
- Up to 10 s per prompt. Ask for 2–3 samples and pick one by eye.
- Prompts describe the body: gait, pace, attitude, where the head goes. The marks decide the path; don't fight them
  in words. Kimodo also follows sparse full-body / hand / foot keyframes (see its constraints docs) — not wired yet.
- Needs a HF token (~/.config/vos/hf_token) with access to the gated `meta-llama/Meta-Llama-3-8B-Instruct`
  (Kimodo's text encoder; Meta approves requests by hand) and `nvidia/Kimodo-SOMA-RP-v1`.
- `motion/<name>/motion.json` records prompt, seed, model, Kimodo revision, constraints and file hashes.

## 2. Put it on an actor

```python
import previz_motion as motion
A = rig.actor("A", at=(-2, 3, 0), facing=51.3)
motion.apply(A, motion.load_bvh("/abs/path/motion/walk_in/walk_in_00.bvh"), align="canonical")   # constrained take
B = rig.actor("B", at=(1, 2, 0), facing=-20)
motion.apply(B, motion.load_bvh(".../idle_01.bvh"), start=12)                                     # free take
```

- `align="canonical"` keeps Kimodo's own frame (start at the origin facing +Z) mapped onto the actor's `at` /
  `facing`, so constrained marks land where they were set (ground distances stay in metres). `align="heading"`
  (default) turns a free take so its first heading is `facing` and starts it at `at`.
- `start` = the scene frame the take begins; before it the actor holds the first pose, after the end the last.
  `speed` scales time. Frames are resampled 30 → 24 fps by time.
- Retargeting is by direction onto the clay actor's own bone lengths (it never stretches); height scales from the
  hip height. The pose pass, `rig.eye(actor)` and cameras that follow the actor work as with `rig.perform`.
- Known: feet are not IK-fitted, so small slides or floor contact errors can show when proportions differ — check
  the beauty pass at the contacts before generating.
- Every take read with `load_bvh` is recorded in `previz.json` (`inputs`, with a content hash): replacing a take
  under the same file name re-renders instead of returning the old frames. Use absolute paths.
- Measured (2026-10-01): a take constrained to walk 3.2 m to a mark by frame 85 arrived within 2.7 cm and 4.0 cm
  (two samples), and read as a natural walk that stops and looks around.

## 3. Check, then hand to H3

1. `vos previz render scene.py --size draft --as pv` → `vos look pv --count 8`: does the person reach each mark at
   its frame, and does the walk read (heel strikes, no skating)? The previz is the contract for blocking.
2. `vos look pv_pose --count 4`: complete body-18 skeletons.
3. `vos gen clip --control pv_depth` (layout + bodies) or `--control pv_pose` (motion only). The control must be
   anatomically right: H3 copies whatever body the previz draws (a wrong pose comes back as a wrong body).
4. Natural in-between motion: pin a few moments as `--guides` (keyframes) and let H3 move between them, instead of
   controlling every frame — measured to look far less robotic for performance close-ups.
