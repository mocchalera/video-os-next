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
  Accepting a stage means "the workflow can continue", not "matches the reference pixel for pixel": write down which
  image you fitted against and what still differs (sizes, crops, colours).
- Draft size (512×288 or similar, multiples of 32) and ≤ 48 frames until the stage is accepted. No simulations, no
  path-traced finals, no model loads during the stages.

Record each stage with `assets/stage-record.md` (check image path + sha256, what changed, acceptance, return
condition hit or not, open items).

## 3. Running it

Scene contract (worked example `examples/previz/stepwise_drum_kit.py`):

- one line `STAGE = "layout"`; optionally `ORDER = [...]` (default layout, form, material, motion); the scene builds up
  to `ORDER.index(STAGE)`;
- it writes JSON to `os.environ["STEPWISE_META"]` with `stage`, `camera` (`{"<frame>": {location, rotation_deg,
  lens_mm, sensor_mm}}` for frame 1 and the last frame), `look_at`, `unseen_guessed` (list), `mesh_objects`,
  `materials` — the runner stops the run if the file or a key is missing;
- optionally saves `os.environ["STEPWISE_BLEND"]` (a snapshot **before** the driver sets engine, samples and view
  transform, so it opens with another look; reproduce from the receipt's command, not from the .blend).

Render, one Blender job at a time, into a **new** directory outside every checkout of this repo:

```bash
python3 -B skills/stepwise-scene-production/scripts/render_stages.py --scene <scene.py> --ref <reference.png> \
  --out <new dir outside the repo> [--stages layout,form,material,motion] [--size 512x288] [--motion-frames 48] [--save-blend]
```

Before creating anything it checks the arguments (known stage names, no duplicates, scene order, size a multiple of
32 and ≤ 768p pixels, 1–124 frames, fps, `--out` new and outside the main checkout and every worktree listed by
`git worktree list`, symlinks resolved; if git cannot list them, it refuses). Before the run and again before every
stage it refuses when `/` or the output volume has less than `--min-free-gib` (15) free, when the process table
cannot be read, or when another Blender (any path, including `--blender`), ffmpeg, `llama-server`, `ollama runner`
(a loaded model), a vos model worker, ComfyUI or MLX is running; `blender-mcp`, the Blender Quick Look thumbnailer and
an idle `ollama serve` are only reported. It writes each stage's scene copy, stills, depth, motion start/mid/end,
mp4s, `contact_sheet.png` (only the stages that succeeded in this run) and `receipt.json` — also on failure, timeout,
Ctrl-C or SIGTERM in any phase once `--out` exists (`status`, `phase`). Not covered: SIGKILL; a signal in the instant
between a child's start and its registration; a second signal while the receipt is written. The receipt has the runner, driver, scene, reference and output hashes, exact commands, camera
numbers and the move (`stages[].move`: distance, seconds, m/s for that frame count), depth range, guessed shapes,
preflight per stage, and every process the run started with its exit code. Only those processes (their own handles)
are ever signalled, and only while still running. Python bytecode is not written; Blender may still use the system
temp dir. Output sha256 values are **byte** identity: the PNGs carry render metadata (date, render time), so a
re-render with identical pixels gets a new hash. To show pixel identity use an existing tool, e.g.
`ffmpeg -i a.png -i b.png -lavfi psnr -f null -` (`average:inf` = identical).
Look at the contact sheet and the full-size stills yourself before accepting a stage.
Offline test (fake Blender, no render): `python3 -B skills/stepwise-scene-production/scripts/test_render_stages.py`.

The per-stage `scene.py` also works with `vos previz render <scene.py> --size draft --as pv` when the shot moves on
to a project. That writes into the project (ingest into `assets.json`, rebuilds `previz/<name>/`): fine within an
authorization the project owner has already given for that project, otherwise ask first; never reuse an existing
alias by accident.

## 4. Hand-off to H3 (previz route)

Order: this skill (stages 1, 2, 4) → `../previz-camera/SKILL.md` §6 checks at the real size
(`vos previz render … --size draft|768p --seconds N`, which snaps frames to H3's 17k+5 grid) → `../h3-prompt/SKILL.md`.

**A hand-off is READY only when all of these agree; until then mark it BLOCKED and list what disagrees.** BLOCKED is
a written gate only — `vos gen` does not read it. So while BLOCKED, do not keep a send-ready prompt file under its
active name: keep only the list of conditions there and park any draft fields in a versioned copy.

1. canon — which image / previz is the truth for positions and sides (a keyframe and a wide previz can disagree);
2. subject scope — what the clip must contain (e.g. kit only, or the band);
3. depth content — every silhouette in the control is something the prompt defines. A scale proxy left in the depth
   is generated as *something* (a person, a pillar): remove it for a scope without people, or replace it with
   `rig.actor` players and define them;
4. refs content — the `--refs` images show only what is in scope, or the prompt says which parts of them to use;
5. prompt — describes the same subjects, the same move and the same duration as the control render.

Hand over:

| Item | Goes to | From |
|---|---|---|
| depth pass `<pv>_depth` (geometry + camera move) | `--control` | the accepted motion stage, re-rendered by `vos previz render` at the generation size |
| camera numbers (position, look-at, lens, ease) | prompt §4: describe the **same** move | `receipt.json` → `stages[].camera` |
| move speed and timing | prompt §4 ("slow", "over N seconds") | **recomputed for the hand-off render's frame count**: a move keyed over the whole clip keeps its distance but changes speed (48 f → 1.96 s; `--seconds 2` → 56 f = 2.29 s; `--seconds 5` → 124 f), and beat-timed motion lands on different frames |
| counts, sides, relative sizes fixed in the set | `subject_definitions` | layout / form record |
| the reference still (look, colour, material, light) | `--refs` (and a `--guides <kf>=0` if the opening frame must match) | stage 0, checked against condition 4 |
| material / light notes (gloss, colour of the set, light direction) | prompt description | material record, or the reference |
| guessed (unseen) shapes | keep out of the prompt; check them in `vos look` after generation | `UNSEEN` |

A material-stage render may be used as a light-direction note, never as a `--refs` image for look: its procedural
clay-to-material look would pull the generation toward CG.

## Field notes

- 2026-10-11, shoegaze-runner-mv s14c kit subset, 512×288, EEVEE, Blender 5.2: layout→form→material ≈ 0.7 s each,
  48-frame motion 10.9 s. Reference = a scratch frame of an MV render at 01:13 (caption/shot list → s14c; which
  clip version it shows is not confirmed — the current timeline uses `clip_s14c_v22`); its keyframe `kf_s14c` was
  viewed too. Camera fitted by eye in 3 layout renders, accepted as a workflow step, not a match: the kick is ≈ 0.19
  of the frame width vs ≈ 0.27 in the scratch frame (closer to kf_s14c's ≈ 0.21), and the stand-in's head touches the
  top edge and leaves the frame at the end of the push-in. First material pass was blown out (area lights
  1400/450/900 W under the driver's Standard view transform); 220/70/380 W read like the reference. The reference
  puts the bassist left of the kit while `previz_scenes/s14_band_wide.py` has her right of it — canon undecided. The
  H3 hand-off draft was BLOCKED (stand-in silhouette in the depth, two players in the ref, kit-only prompt). H3 not run.
