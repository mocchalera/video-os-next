---
name: previz-performance
description: Direct people in a Blender previz — break a performance into beats, body mechanics, gaze, contacts and Laban effort, write it as a performance spec for `rig.actor` / `rig.perform`, and check it (beauty, pose pass, beats) before generating. Use before putting a person in any `vos previz` scene.
---

# Performance in previz

"She enters anxiously" is not something a body can execute. A performance becomes directable when it is broken into
**beats, a path and timing, where the weight is, what the eyes do, what the hands touch, and the quality of the
movement**. That breakdown is the performance spec; `rig.perform` compiles it into a jointed clay actor, one key per
frame (`python/previz_actor.py`). Camera choices: `skills/previz-camera/SKILL.md`. Worked example:
`examples/previz/performance_letter.py`.

## 1. From intent to beats

Write the intent in one line, then split it into beats, each with a frame (24 fps; frame 1 = 0 s, 5 s = 124 frames):

```
Enter (1) → Notice (60) → Recognition (70) → Reaction (80) → Looks at B (102)
```

- Put **thinking before acting**. A reaction runs eyes → head → breath stops / torso tenses → weight shifts →
  gesture. Leave 6–12 frames between the internal beat (eyes land, body freezes: `"hold"`) and the external one
  (the gesture). Cutting straight from "sees" to a surprised pose reads cheap.
- Pose-to-pose: give each beat a clear pose (body key), let the transitions come from the effort; do not key every
  frame. Beats also become timeline markers: `vos previz render` prints them and writes them to `previz.json` —
  use them for the prompt's shot timing and for the edit.

## 2. The spec

```python
cam = rig.camera(...)                     # first, if anyone looks at "camera"
A = rig.actor("A", at=(x, y, 0), facing=deg, height=1.7)
rig.perform(A, {
    "effort": {"weight": "light|neutral|strong", "time": "sudden|neutral|sustained",
               "space": "direct|neutral|indirect", "flow": "bound|neutral|free"},
    "path":   [(f, (x, y)), (f, (x, y)) | (f, [(x, y), …waypoints])],   # be there at f; walk between, else hold
    "facing": [(f, deg | target)],                                    # standing turns (pivot steps), 0 = -Y
    "body":   [(f, {"lean": deg, "weight": "L|R|both", "crouch": m, "twist": deg, "tilt": deg, "arms": preset}, [dur])],
    "gaze":   [(f, target | "floor" | "up" | "ahead" | "camera" | "hold", [dur])],
    "hands":  [(f, "L|R|both", target | preset | None, [dur])],
    "beats":  [(f, "label")],
})
```

- Events start at their frame and take `dur` frames (default from Time). Targets: an object (a prop, another actor
  — aimed at its eyes, a moving object is followed), or a point `(x, y, z)`.
- `lean` + forward / − back; `weight` puts the pelvis over that foot with contrapposto (pelvis and chest tilt against
  each other, head stays level); `crouch` lowers the pelvis in metres (knees bend, feet stay; up to ~0.4);
  `twist` turns the chest; `tilt` tilts the head (+ toward the actor's left).
- Arm presets (`body.arms` for both, `hands` per hand): `rest` (hang; swings while walking), `hips`, `front`
  (clasped), `crossed`, `face` (hands to the face), `pocket`, `reach` (forward, chest height).
- `hands` with an object is a **contact**: the hand is solved to it every frame, so it follows a door handle as the
  door opens (animate the prop in bpy). `None` releases back to the body's arm preset. Keep contacts reachable
  (~0.55 m from the shoulder); an unreachable target leaves the arm straight toward it.

## 3. What the rig does for you (body mechanics)

- **Footsteps and foot lock.** Walks are planned as steps along the path: step length from speed, alternating feet,
  a closing step to stand. A planted foot is fixed in the world until it lifts — it never slides.
- **Centre of mass.** Walking: the pelvis shifts over the support foot, rises in single support and sinks at double
  support (it can only be as high as the legs reach). Standing: `weight` shifts it over one foot.
- **Eyes lead.** The head starts turning a couple of frames after the gaze changes, the chest a few frames later,
  each taking a share of the angle (head up to ±80°, chest ±35°). Past that, add a `facing` key a few frames after
  the gaze so the body follows.
- **Overlap.** Flow scales the delays: bound = parts move together (held), free = more follow-through.
- **Walking speed** = distance / time between marks: 0.8 m/s hesitant, 1.1–1.4 normal, 1.8 brisk. Check that the
  numbers match the intent — a "reluctant" 3.7 m in 2 s is a brisk walk.

## 4. Laban Effort → numbers

| Factor | Pole | What the rig does |
|---|---|---|
| Time | sudden / sustained | transitions 0.25 s with a fast start / 1.0 s eased (neutral 0.5 s) |
| Weight | light / strong | smaller / larger bob, arm swing and step lift; strong sinks 3 cm and leans 4° in, light stands tall |
| Space | direct / indirect | gaze locks on / gaze wanders ±6° around the target |
| Flow | bound / free | arm swing ×0.5, elbows bent, arms close, parts in unison / swing ×1.3, arms freer, more overlap |

Starting points (adjust per beat): anger approaching — strong, sudden, direct, bound · anxiety — light, sustained,
indirect, bound · calm confidence — strong, sustained, direct, free · delight — light, sudden, indirect, free.
Tiredness is mostly not an Effort: lean forward, walk slowly, `weight` on one foot, arms `rest`.

## 5. Several actors

- Perform the actor who is looked at first; for mutual gaze perform A, B, then A again (A's second pass sees B's
  motion). A camera that looks at or follows an actor must be moved **after** that actor is performed; an actor that
  looks at `"camera"` needs the camera created **before** it is performed. So: create the camera, perform the actors,
  then move the camera.
- Blocking: think of the camera and the actors together — a look between two actors defines the line for the
  180° rule (camera skill §5).

## 6. Check it

1. `vos previz render scene.py --size draft --as pv` — prints the beats with their times.
2. `vos look pv --count 8`: is each beat readable **from this camera**? Silhouette: hands and arms off the torso in
   the key poses, the head angle visible. Line of action: one clear curve through the body per key pose (lean,
   weight, crouch, twist) — straight-up-and-down reads as a mannequin.
3. `vos look pv_pose --count 4`: the pose pass (OpenPose body-18, drawn only where people are) — the skeleton should
   be complete wherever the body is visible; the nose and eyes only show when the face turns toward the camera.
4. Walks: feet planted, no knee pops; the pace matches the intent.

## 7. Generating from it

- `vos gen clip --control pv_depth …` fixes the set, the camera and the actors' silhouettes;
  `vos gen clip --control pv_pose …` fixes the body motion only, leaving set and camera to the prompt and refs.
  One control video per clip. How strongly H3 follows the pose pass is **not measured yet** — record it below.
- The previz carries no face, fingers, clothing or breath. Put them in the prompt (`skills/h3-prompt/SKILL.md`),
  on the beat times the render printed: "At 00:03.300 her eyes stop on the letter; her breath catches; at 00:03.750
  she brings both hands to her mouth." Describe the same actions the previz performs.

## Limits (today)

Walk only (no run, jump, stairs; flat ground), no sitting on furniture (crouch only), no fingers or face, hands do not
grip or carry props (animate the prop and put the hand on it), no imported mocap yet (BVH/FBX would come in through
the same armature).

## Field notes (record results here)

- (none yet) — technique · control (depth / pose, strength, end) · size · what held and what broke.
- 2026-10-12, previz only (no generation), `examples/previz/stepwise_band_performance.py` (bassist + seated drummer,
  48 f): (1) actors stand on z = 0 — a z in `at` is ignored by the feet and the pelvis, so actors placed on a raised
  platform sink into it (move the world so the floor they stand on is z = 0); (2) an event blends from 0 on its own
  frame, so state that must already hold on frame 1 goes at frame 0; (3) instruments as props on animated targets
  held contact within ≤ 6 mm (wrist), stick tips landed within 3 mm of the heads; (4) the pose pass draws a seated
  drummer's legs straight and through the kit (no occlusion, knees foreshortened) — a pose control would push toward
  standing legs; prefer the depth control for seated players.
- 2026-10-12, same scene, hands repair after a human said "the hands move wrong": a 0 m wrist-to-target error said
  nothing about the hands. A contact puts the WRIST on the target while the 17 cm hand clay continues straight along
  the forearm, so a stick tied to the target came out of the forearm and a fretting hand ran through the neck; a
  pluck path that ended away from its start snapped back in one frame; gaze changes turned the chest (eyes lead) and
  threw the elbows up. What worked, scene-locally: aim the PALM (wrist + 0.08 m along the hand) by correcting the
  target over a few perform passes, re-key the hand bone afterwards to bend the wrist toward the tool, place props
  from the actual palm, keep the gaze/twist still while hands play, use closed continuous hand paths. Judge it on
  every frame of fixed hand crops, not on contact numbers.
