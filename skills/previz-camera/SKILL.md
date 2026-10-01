---
name: previz-camera
description: Choose a camera technique from the intent of a shot and build it as a Blender previz (lens, height, shot size, move) with the `rig` helpers, then check it before generating. Use before writing any `vos previz` scene.
---

# Camera and shot design in previz

The previz depth pass drives `vos gen clip --control <pv>_depth`, so **the camera is decided here, in numbers**, not
in the prompt: focal length, camera height, distance, path, speed, easing. A move that is wrong in the beauty pass
will be wrong in the generated shot; a move that is right here costs nothing to check.

Scene scripts get `rig` (`python/previz_rig.py`). Worked examples: `examples/previz/push_in.py`, `dolly_zoom.py`,
`orbit.py`, `crane.py` (plain bpy without rig: `alley.py`). World: metres, Z up, +Y into the scene, camera usually at
negative Y. A 5 s shot is 124 frames at 24 fps (`frames` in the script); frame 24 is 1 s.

## 1. Start from the intent, not the technique

Write one line first: *what should the viewer feel or notice in this shot?* Then pick:

| Intent | Technique | Build with |
|---|---|---|
| This matters / tension rises / a realisation | slow **push-in** | `rig.move` toward the subject, `ease="inout"`, 0.1–0.3 m/s |
| Letting go, isolation, an ending | **pull-out** (optionally revealing surroundings) | `rig.move` away; widen the view |
| Show the place, scale, the person made small | **crane up + tilt down** reveal | `rig.move` with a `look=[…]` path, hold first with `span` |
| Inner shock, vertigo, the ground giving way | **dolly zoom** | `rig.dolly_zoom` |
| A turning point, the world turning around someone | **orbit / arc** | `rig.orbit`, 45–120° per 5 s |
| Momentum, following, companionship | **tracking** alongside / behind | `rig.walk` the subject + `rig.move` parallel with `look=subject` |
| Power, threat, heroism | **low angle** | camera 0.3–0.9 m, looking up |
| Vulnerability, being watched | **high angle / overhead** | camera 3–8 m, looking down |
| Something is wrong | **dutch angle** | `roll=8…20` (or `roll=(0, 15)` to tilt during the shot) |
| Urgency, documentary presence | **handheld** | `shake=0.3…1.0` (degrees) — see §6 |
| Observe, let the action play | **locked-off static** | `rig.camera` only, no move |

Prefer one clear move per shot. Two moves at once (push + orbit + zoom) read as noise unless the intent is chaos.

## 2. Lens and shot size

| Lens (36 mm-wide sensor) | Reads as |
|---|---|
| 16–24 mm | space, immersion, energy; distorts faces up close; exaggerates camera motion |
| 28–35 mm | natural, documentary, "in the room" |
| 40–50 mm | neutral, attentive |
| 85–135 mm | compression, isolation of a face, intimacy — or voyeurism from far away |

`rig.camera` fits the sensor horizontally, so millimetres mean the same in 16:9, 9:16 or 1:1.

Shot sizes (`rig.SHOT_SIZES`, visible height for a 1.7 m adult): ECU 0.15 · CU 0.35 · MCU 0.6 · MS 0.95 · MLS 1.35 ·
FS 2.1 · WS 4.5 m. Get a starting placement instead of guessing:

```python
hero = rig.person(at=(0, 1.2, 0))            # clay stand-in; facing=0 faces the camera side (-Y)
d, aim_z = rig.framing(hero, "MS", 40)       # distance for a waist-up shot on 40 mm, aim height for ~10 % headroom
cam = rig.camera(lens=40, at=(0, 1.2 - d, 1.55), look=(0, 1.2, aim_z))
```

Always put a `rig.person` (static stand-in) or a `rig.actor` (jointed, performs — `skills/previz-performance/SKILL.md`)
or a real-size prop in the set: without a human scale reference neither you nor the beauty pass can tell a close-up
from a wide shot. Camera height: eye level 1.5–1.6 m; chest 1.2 m (slightly heroic);
hip 0.9 m (low); ground 0.3 m (very low).

## 3. Moves (`rig`)

```python
rig.move(cam, [p0, p1, …], look=target, lens=None|mm|(from, to), roll=None|deg|(from, to),
         ease="inout", span=(f0, f1), shake=0.0)            # push/pull, truck, pedestal, crane, zoom, pan (look path)
rig.orbit(cam, center, radius, height, degrees=(a0, a1), lens=…, ease=…, span=…)   # 0° = on the -Y side, + = CCW
rig.dolly_zoom(cam, subject, distances=(d0, d1), lens=mm_at_d0, heading=(0, -1, 0))
rig.walk(person, [p0, p1, …], ease="linear", span=…)       # subject moves; faces its direction of travel
```

- `look`: a point, an object (followed if it moves; a `person` is aimed at its eyes), or a list of points travelled
  with the move (a pan or tilt during the move). `None` keeps the camera rotation (a pure translation).
- 3+ path points make a smooth curve travelled at even speed. `span` holds before/after: `span=(24, frames)` holds 1 s.
- Eases: `linear` (mechanical, or continuing motion), `in` (accelerates), `out` (settles), `inout` (a real dolly
  move, default), `inout-strong`.
- Dolly zoom: moving **in** while zooming **out** (e.g. `distances=(6, 2), lens=85`) stretches the space and the
  background falls away; moving **out** while zooming **in** flattens it and the background looms up. Give the
  background strong depth cues (pillars, a corridor) or the effect does not read.
- Anything rig does not cover: key the camera yourself in plain bpy, as `alley.py` does.

## 4. Speed

- Slow push-in / pull-out: 0.1–0.3 m/s (0.5–1.5 m in 5 s). Walking-pace tracking: 1.0–1.4 m/s.
- Orbit: 45–90° in 5 s reads steady; 180°+ in 5 s is energetic.
- Pans at 24 fps: if something crosses the full frame width in less than ~5–7 s, it judders (a rule of thumb for
  normal shutter). Go slower, or go deliberately fast (a whip pan, which is meant to blur).
- A move needs a visible start and end state. If the first and last frames look almost the same, the move will not
  be felt — make it bigger or cut it.

## 5. Several shots of one scene

- Keep the set identical across shot scripts (copy the set block unchanged). The cache hashes only the scene file,
  the driver and the rig, so do not `exec` a shared set file — edits to it would not re-render.
- 180° rule: draw the line between the two people (or along the direction of travel). All cameras of the sequence
  stay on one side, so looks and movements keep their screen direction. Cross it only on screen (a move across it)
  or on purpose.
- Shot/reverse-shot: mirror the camera height, lens and distance for both people unless the imbalance is the point.
- People of different heights: give each `rig.person` its real `height`. Generation from references alone flattened
  a 13 cm difference between two characters; the previz is where the difference is fixed for keyframes and control.
- Match on action: end shot A and start shot B at the same moment of one movement; plan both paths from the same
  `rig.walk`.

## 6. Check before generating

1. `vos previz render scene.py --size draft --as pv` (~50–70 s for 5 s on this Mac; Blender 5.2 EEVEE).
2. `vos look pv --count 8`: subject never cut unintentionally, headroom, horizon, the camera never passes through
   geometry, the move is visible between the first and last frame, the intent line from §1 is readable.
3. `vos look pv_depth --count 4`: the subject separates from the background; no frame is all white (camera too close)
   or all black (only sky). Depth is normalised over the whole shot, so brightness changes as distances change — that
   is expected.
4. Only then render at the real size and hand it to generation.

## 7. What the depth pass cannot carry — put it in the prompt

The control video fixes geometry and camera motion. It does **not** carry focus (depth of field, rack focus),
lighting, time of day, materials, weather, motion blur or handheld texture. Write those in the H3 prompt
(`skills/h3-prompt/SKILL.md`), and describe **the same camera move** the previz makes (type, amplitude, speed) —
a different move in the text fights the control.

## Field notes (record results here)

How closely H3's Fun ControlNet follows each technique is not measured yet: especially the perspective change of a
dolly zoom, fast pans, and `shake`. After a test, add one line: technique · control strength/end · size · what held
and what broke.

- Tracking alongside a large vehicle, seen from above · strength 1 / end 1 · draft, 15 s, 2 refs + guide at 0 · the
  first ~6 s followed the guide; then the vehicle was redrawn (6 wheels became 8 and moved under the hull), and from
  a high camera over flat ground it read as a toy on a table. Redone at ground level (0.8 m, 50 mm) with a relief on
  the ground; not generated yet.

For looking at real examples of a technique, a human can browse https://melies.co/cinematic-techniques.
