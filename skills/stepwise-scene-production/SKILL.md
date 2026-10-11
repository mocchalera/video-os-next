---
name: stepwise-scene-production
description: Rebuild a shot from a reference image in Blender one stage at a time — layout, form, material, motion — with a check image, acceptance test and return condition per stage, then hand camera and geometry to H3 as a depth control (previz route) or finish materials and light in Blender (Blender-final route). Use when a reference still (keyframe, board frame, frame of an existing cut) should become a 3D set, a previz scene or a Blender-rendered shot.
---

# Stepwise scene production (reference → layout → form → material → motion)

Build the set in passes and look at each pass before the next. A wrong distance found at layout costs one 1 s render;
found after materials and motion it costs everything after it. Each stage is a separate, reproducible scene file.

Origin: a public X thread (2026-10, @hayashimon1) describes building a night laundromat from a generated reference
image with Claude + a Blender MCP, "space → model → texture" and then motion and camera. That is the author's own
account (no logs, files, MCP source or settings published). Here the same order runs on the repo's own headless driver
(`python/blender_previz.py`) — **do not install or connect an unknown Blender MCP**; scene scripts are plain bpy + `rig`.

## 1. Pick the route first

| Route | Use when | Stages in Blender | Material / light decided in |
|---|---|---|---|
| **H3 previz** (default for generated shots) | the shot will be generated with `vos gen clip --control <pv>_depth` | layout → form → motion (material only as a quick light-direction check, or skipped) | the H3 refs + prompt (`../h3-prompt/SKILL.md`) |
| **Blender-final** | the Blender render itself is the picture (graphic set, product, a plate) | layout → form → material → motion | Blender (materials, light, render settings) |

The depth pass carries geometry and camera only; it cannot carry colour, gloss, light or texture
(`../previz-camera/SKILL.md` §7). So in the H3 route, polishing materials in Blender is wasted work — spend it on the
reference images and the prompt instead.

## 2. Stages

| Stage | Build | Check image | Accept when | Return to the previous stage when |
|---|---|---|---|---|
| 0 reference | pick one still; hash it; write the intent line and what is in / out of scope | the reference | it shows the arrangement you want; scope written | — |
| 1 layout | real-size boxes for every object, the set, one human-scale stand-in (`rig.person`), the camera (`../previz-camera/SKILL.md` §1–2) | layout beauty + depth, next to the reference | positions, scale and framing match the reference by eye; nothing important cut | — |
| 2 form | real shapes on the same positions: cylinders, hoops, stands, bevels; counts fixed | form beauty | silhouettes and counts match; nothing moved from layout | a shape needs a different footprint → fix it in layout, not here |
| 3 material | procedural materials + light (Blender-final route); one shared wear/dirt node group, strength per material | material beauty | colour, gloss and light direction read like the reference; no blown / crushed areas | exposure or colour wrong everywhere → light, not materials; a shape looks wrong under light → form |
| 4 motion | small moves only: camera (one move, §3–4 of previz-camera), secondary motion (cymbal sway, flicker) | start / mid / end frames, a short low-res clip, depth start | the move is felt between first and last frame; nothing intersects; depth never all white / black | the move reveals unbuilt geometry → form; it changes the framing intent → layout |

Rules for every stage:

- Keep earlier stages' numbers fixed; change one thing, re-render, look. Save each stage as its own file.
- Parts the reference does not show (backs, hidden legs, pedals, the set beyond the frame) are **guesses** — list them
  in the scene (`UNSEEN`) and in the record. Do not describe a guessed part as matched.
- "Looks right" is your judgement, not the human's. Record human adoption as **not measured** until a human decides.
- Draft size (512×288 or similar, multiples of 32) and ≤ 48 frames until the stage is accepted. No simulations, no
  path-traced finals, no model loads during the stages.

Record each stage with `assets/stage-record.md` (check image path + sha256, what changed, acceptance, return
condition hit or not, open items).

## 3. Running it

The scene script needs one line `STAGE = "layout"` and builds up to that stage (`ORDER.index(STAGE)`); worked
example: `examples/previz/stepwise_drum_kit.py`. Render all stages, one Blender job at a time:

```bash
python3 skills/stepwise-scene-production/scripts/render_stages.py --scene <scene.py> --ref <reference.png> \
  --out <dir outside the repo> [--stages layout,form,material,motion] [--size 512x288] [--motion-frames 48] [--save-blend]
```

It refuses to start below `--min-free-gib` (15) free on `/` or while another Blender/ffmpeg runs, writes each stage's
scene copy, stills, depth, motion start/mid/end, mp4s, `contact_sheet.png` and `receipt.json` (Blender version,
engine, size, frames, wall time, exact commands, reference / scene / output hashes, camera numbers per stage, depth
range, guessed shapes, preflight, and that every process it started has exited). It never touches other processes.
Look at the contact sheet and the full-size stills yourself before accepting a stage.

The per-stage `scene.py` also works unchanged with `vos previz render <scene.py> --size draft --as pv` when the shot
moves on to a project (that path ingests into `assets.json`; the script above does not).

## 4. Hand-off to H3 (previz route)

Order: this skill (stages 1, 2, 4) → `../previz-camera/SKILL.md` §6 checks at the real size
(`vos previz render … --size draft|768p --seconds N`, which snaps frames to H3's 17k+5 grid) → `../h3-prompt/SKILL.md`.

Hand over:

| Item | Goes to | From |
|---|---|---|
| depth pass `<pv>_depth` (geometry + camera move) | `--control` | the accepted motion stage, re-rendered by `vos previz render` |
| camera numbers (position, look-at, lens, move amplitude/speed/ease) | prompt §4: describe the **same** move | `receipt.json` → `stages[].camera` |
| counts, sides, relative sizes fixed in the set | `subject_definitions` | layout / form record |
| the reference still (look, colour, material, light) | `--refs` (and a `--guides <kf>=0` if the opening frame must match) | stage 0 |
| material / light notes (gloss, colour of the set, light direction) | prompt description | material record, or the reference |
| guessed (unseen) shapes | keep out of the prompt; check them in `vos look` after generation | `UNSEEN` |

A material-stage render may be used as a light-direction note, never as a `--refs` image for look: its procedural
clay-to-material look would pull the generation toward CG.

## Field notes

- 2026-10-11, shoegaze-runner-mv s14c kit subset (reference = MV frame at 01:13, keyframe `kf_s14c`), 512×288,
  EEVEE, Blender 5.2: layout→form→material ≈ 0.7 s each, 48-frame motion 10.9 s. Camera fitted by eye in 3 layout
  renders. First material pass was blown out (area lights 1400/450/900 W under the driver's Standard view transform);
  220/70/380 W read like the reference. The reference (a generated keyframe) puts the bassist left of the kit while
  `previz_scenes/s14_band_wide.py` has her right of it — the keyframes did not keep the wide shot's geometry;
  decide which is canon before generating a sequence. H3 not run.
