# Stepwise scene (skills/stepwise-scene-production) — s14c band preview: an anonymous clay BASSIST on the left and an
# anonymous clay DRUMMER behind the kit, playing a short demo phrase. Set and kit are copied unchanged from
# examples/previz/stepwise_drum_kit.py at 9fab612 (copied, not exec'd: vos hashes only this file).
# Local canon for this one cut (from the earlier composition pass): bassist LEFT of the kit, drummer behind it. The
# project's wide previz (previz_scenes/s14_band_wide.py) has the bass on the right — not touched, not decided here.
# Intent (shot list s14c): a deadpan two-shot, locked-off ("正面フィックス"); bodies move to the beat.
#
# People are previz blocking only: rig.actor clay bodies (no face, no fingers, no clothing, no likeness), driven by
# rig.perform. Instruments are props; hands touch them through IK contacts on animated targets (no grip):
#   bassist  left palm in front of the fretboard, hand across the neck; right palm over the strings, small pluck loop
#   drummer  each palm holds its stick 5 cm from the butt; the stick runs from the palm toward the drum head
#   (the IK still ends at the wrist: the scene moves its target so the PALM lands, and bends the hand at the wrist)
# The drummer "sits" by crouching (the rig cannot sit): the pelvis is placed at the throne top; seat contact is not
# simulated. Demo beat: eighth notes of the song's measured bar (3.041 s / 8 = 9.1 f at 24 fps), phase arbitrary —
# NOT synced to the music.
#
# STAGE: layout (boxes + bodies + contacts) · form (shapes: bass body/neck/strings, sticks) · material (materials, light)
# · motion (the performance over all frames; still stages show frame 1 = the prepared pose).
# Shapes and contacts the reference does not show are guesses (UNSEEN); the audit in STEPWISE_META measures contacts,
# floating, penetration proxies and crops on the rendered frames.
import json, math, os
import bpy
from mathutils import Matrix, Vector
from bpy_extras.object_utils import world_to_camera_view

STAGE = "layout"
ORDER = ["layout", "form", "material", "motion"]
LEVEL = ORDER.index(STAGE)
C, D = rig.CLAY, rig.DARK
UNSEEN = [
    "kick pedal, beater and spurs; drum backs and mounts; throne (behind the drummer)",
    "floor-tom legs; left cymbal stand; platform outline beyond the frame; wall distance; the lens (40 mm assumed)",
    "the drummer's seat contact (crouch approximation), feet on pedals (not modelled)",
    "fingers, grips, faces, clothing, hair (not modelled — anonymous clay bodies)",
    "bass strap (the bass is attached to the chest bone instead)",
]

# ---- set (reference: mint seamless, white disc; the kit stands near the disc's back edge) -----------------------
MINT = (0.45, 0.8, 0.7)
# World shift (this scene only): rig.actor plants feet on z = 0 (its flat-ground limit; a z in `at` is ignored), so the
# platform top is z = 0 here and the floor is 0.2 m below it. Every relative position equals the kit scene's; absolute
# z of the set, camera and lights is 0.2 m lower than in stepwise_drum_kit.py.
PLAT_THICK = 0.2
DISC_TOP = 0.0
KIT_X = 0.35
rig.box("floor", (0, 4, -PLAT_THICK - 0.05), (20, 20, 0.1), MINT)
# The reference shows no floor/wall seam (a seamless backdrop). The wall stands just behind the platform so the
# floor/wall corner falls behind the platform's back edge from this low camera (before: y = 7.5, seam visible at y ≈ 0.77).
CYC_Y = 4.4
rig.box("cyc", (0, CYC_Y, 4 - PLAT_THICK), (20, 0.2, 8), MINT)
# Composition pass (2026-10-11): in the reference the platform top shows only as a thin band (y ≈ 0.88–1.0) ending just
# behind the cymbal stands, so the kit stands near the BACK of the disc and its front part is below the frame.
# An elliptical platform (2.2 x 1.1 m half-axes) with its back edge at y = 3.65: its front part, below the frame,
# must stay ~2 m from the low camera, or the driver's depth range (bounding boxes) collapses to near ≈ 0.06 m and the
# depth pass turns black (seen in the first composition render, a round 2 m disc centred at y = 1.65).
bpy.ops.mesh.primitive_cylinder_add(vertices=12 if LEVEL == 0 else 96, radius=1.0, depth=PLAT_THICK,
                                    location=(0.0, 2.55, -PLAT_THICK / 2))
disc = bpy.context.object
disc.scale = (2.2, 1.1, 1.0)
disc.name = "disc"
disc.data.materials.append(rig._material("disc", (0.95, 0.95, 0.95)))
if LEVEL >= 1:
    bev = disc.modifiers.new("bevel", "BEVEL")
    bev.width, bev.segments = 0.03, 4


def cyl(name, at, radius, depth, color=C, rot=(0, 0, 0), verts=48):
    bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=radius, depth=depth, location=at, rotation=rot)
    ob = bpy.context.object
    ob.name = name
    ob.data.materials.append(rig._material(name, color))
    return ob


def ring(name, at, radius, minor, rot=(0, 0, 0), color=D):
    bpy.ops.mesh.primitive_torus_add(major_radius=radius, minor_radius=minor, location=at, rotation=rot,
                                     major_segments=48, minor_segments=8)
    ob = bpy.context.object
    ob.name = name
    ob.data.materials.append(rig._material(name, color))
    return ob


def rod(name, a, b, r=0.012, color=D):
    a, b = [float(v) for v in a], [float(v) for v in b]
    d = [b[i] - a[i] for i in range(3)]
    ln = math.sqrt(sum(v * v for v in d))
    mid = [(a[i] + b[i]) / 2 for i in range(3)]
    ob = cyl(name, mid, r, ln, color, verts=12)
    ob.rotation_euler = Vector((0, 0, 1)).rotation_difference(Vector(d).normalized()).to_euler()  # local +Z along a→b
    return ob


def tripod(name, x, y, top, spread=0.28):
    rod(f"{name}_post", (x, y, DISC_TOP), (x, y, top))
    for k in range(3):
        a = math.radians(90 + k * 120)
        rod(f"{name}_leg{k}", (x, y, DISC_TOP + 0.32), (x + spread * math.cos(a), y + spread * math.sin(a), DISC_TOP))


# drum parts: (name, centre, diameter, depth, axis)  — real-size estimates (22" kick, 16" floor tom, 14" snare).
# Positions fitted to approximate landmarks read off the reference (composition pass; see the stage record): the floor
# tom tucks in left of / behind the kick, rims of tom and snare at about the same height, both cymbals at ~0.9 m.
KICK = ("kick", (KIT_X, 2.85, DISC_TOP + 0.28), 0.56, 0.40, "y")
TOM = ("floor_tom", (KIT_X - 0.23, 3.05, DISC_TOP + 0.46), 0.40, 0.36, "z")
SNARE = ("snare", (KIT_X + 0.38, 3.0, DISC_TOP + 0.58), 0.36, 0.14, "z")
CYM_L = ("cymbal_L", (KIT_X - 0.37, 3.2, DISC_TOP + 0.92), 0.46, 18)
CYM_R = ("cymbal_R", (KIT_X + 0.82, 3.15, DISC_TOP + 0.92), 0.48, -12)
THRONE = ("throne", (KIT_X + 0.1, 3.55, DISC_TOP + 0.5), 0.34, 0.08, "z")

parts = {}
if LEVEL == 0:
    for n, at, dia, dep, ax in (KICK, TOM, SNARE, THRONE):
        size = (dia, dep, dia) if ax == "y" else (dia, dia, dep)
        parts[n] = rig.box(n, at, size, C)
    for n, at, dia, tilt in (CYM_L, CYM_R):
        parts[n] = rig.box(n, at, (dia, dia, 0.02), D)
    sh, ch = SNARE[1][2] - 0.07 - DISC_TOP, CYM_R[1][2] - DISC_TOP
    rig.box("snare_stand", (SNARE[1][0], SNARE[1][1], DISC_TOP + sh / 2), (0.05, 0.05, sh), D)
    rig.box("cymR_stand", (CYM_R[1][0], CYM_R[1][1], DISC_TOP + ch / 2), (0.05, 0.05, ch), D)
else:
    for n, at, dia, dep, ax in (KICK, TOM, SNARE, THRONE):
        rot = (math.pi / 2, 0, 0) if ax == "y" else (0, 0, 0)
        parts[n] = cyl(n, at, dia / 2, dep, C if n != "throne" else D, rot)
        if n == "throne":
            continue
        for s in (-1, 1):  # hoops at both heads
            off = [0, 0, 0]
            off["xyz".index(ax)] = s * dep / 2
            ring(f"{n}_hoop{s:+d}", tuple(at[i] + off[i] for i in range(3)), dia / 2 + 0.008, 0.012, rot)
        if n == "kick":
            hd = cyl("kick_head", (at[0], at[1] - dep / 2 - 0.003, at[2]), dia / 2 - 0.01, 0.004, (0.97, 0.97, 0.95),
                     (math.pi / 2, 0, 0))
            parts["kick_head"] = hd
    for n, at, dia, tilt in (CYM_L, CYM_R):
        bpy.ops.mesh.primitive_cone_add(vertices=64, radius1=dia / 2, radius2=0.03, depth=0.035, location=at,
                                        rotation=(math.radians(tilt * 0.4), math.radians(tilt), 0))
        cy = bpy.context.object
        cy.name = n
        cy.data.materials.append(rig._material(n, (0.78, 0.62, 0.3)))
        parts[n] = cy
    tripod("snare_stand", SNARE[1][0], SNARE[1][1], SNARE[1][2] - 0.07)
    tripod("cymR_stand", CYM_R[1][0], CYM_R[1][1], CYM_R[1][2] - 0.02, 0.32)
    tripod("cymL_stand", CYM_L[1][0] - 0.05, CYM_L[1][1] + 0.1, CYM_L[1][2] - 0.02, 0.25)
    for k in range(3):  # floor-tom legs (unseen: guessed)
        a = math.radians(30 + k * 120)
        x, y = TOM[1][0] + 0.24 * math.cos(a), TOM[1][1] + 0.24 * math.sin(a)
        rod(f"tom_leg{k}", (x, y, DISC_TOP), (x, y, TOM[1][2]))
    for k in (-1, 1):  # kick spurs
        rod(f"kick_spur{k}", (KICK[1][0] + k * 0.3, KICK[1][1] - 0.15, DISC_TOP),
            (KICK[1][0] + k * 0.2, KICK[1][1] - 0.05, KICK[1][2]))


# ---- camera: locked-off. Minimal reframe from the kit pass so both heads and the kit read: 0.35 m further back and
# tilted up ≈ 3.3° instead of ≈ 1.8° (kit pass: (0.11, -0.44, 0.82) looking at (0.11, 5.0, 0.99), i.e. z 0.62 / 0.79
# in this shifted world). The kit is smaller
# in frame (kick ≈ 0.19 of the width instead of ≈ 0.21). Created before the actors: the bassist looks at the camera.
CAM_AT, CAM_LOOK, LENS = (0.11, -0.79, 0.62), (0.11, 4.65, 0.934), 40
cam = rig.camera(lens=LENS, at=CAM_AT, look=CAM_LOOK)

# ---- demo beat (not synced to music) --------------------------------------------------------------------------------
EIGHTH = 3.041 / 8 * fps                      # ≈ 9.1 frames
HITS = [round(12 + k * EIGHTH) for k in range(3)]   # 12, 21, 30: three notes after a ~0.5 s preparation
SNARE_HITS, TOM_HITS, PLUCKS = [HITS[0], HITS[2]], [HITS[1]], HITS
RECOVER = HITS[-1] + 10

# ---- hands: the PALM holds the instrument, not the wrist (hands repair, 2026-10-12) ---------------------------------
# rig.perform solves a hand contact to the WRIST and keeps the 17 cm hand clay straight along the forearm; the palm
# centre is 8 cm past the wrist. So, scene-locally: (1) the IK target is placed so the PALM CENTRE lands where the hand
# should hold (iterated: perform -> measure the forearm -> correct the target -> perform); (2) after the last perform the
# hand bone is re-keyed to bend at the wrist toward the tool (the rig has no wrist flexion); (3) sticks are placed from
# the ACTUAL palm. The ca7abe1 version (wrist on the grip, stick out of the wrist, pluck stroke snapping back to hover)
# looked wrong frame by frame — see the hands-repair OBSERVATIONS.md.
PALM = 0.08             # palm centre past the wrist, along the hand (s = 1)
HAND_LEN = 0.17         # wrist -> fingertip of the hand clay (s = 1)
ITER = 3                # target corrections
sc_ = bpy.context.scene


def smooth(u):
    u = min(1.0, max(0.0, u))
    return u * u * (3 - 2 * u)


def wrist_target(name):
    ob = bpy.data.objects.new(name, None)
    sc_.collection.objects.link(ob)
    return ob


def place_palms(arm, spec, sides, frames_):
    """sides: {side: (target, palm(f) -> world Vector, tool(f) -> world unit Vector, bend 0..1)}. Iterates the IK
    targets so the palm (wrist + hand direction * PALM) lands on palm(f); returns the hand directions to key."""
    s = arm["vos_scale"]
    pb = arm.pose.bones
    hd = {sd: {f: tool(f) for f in frames_} for sd, (_, _, tool, _) in sides.items()}
    for _ in range(ITER):
        for sd, (tgt, palm, tool, bend) in sides.items():
            for f in frames_:
                tgt.location = palm(f) - hd[sd][f] * PALM * s
                tgt.keyframe_insert("location", frame=f)
        rig.perform(arm, spec)
        for f in frames_:
            sc_.frame_set(f)
            for sd, (tgt, palm, tool, bend) in sides.items():
                fa = pb[f"forearm.{sd}"]
                fd = (arm.matrix_world @ fa.tail - arm.matrix_world @ fa.head).normalized()
                hd[sd][f] = (fd * (1 - bend) + tool(f) * bend).normalized()
    return hd


def bend_hands(arm, hd, frames_):
    """Re-key each hand bone so it points along hd[side][f] (wrist flexion the rig does not do). The wrist stays put."""
    pb = arm.pose.bones
    for f in frames_:
        sc_.frame_set(f)
        for sd, dirs in hd.items():
            b = pb[f"hand.{sd}"]
            M = b.matrix.copy()                      # armature space == world (the armature sits at the origin)
            y = dirs[f]
            x = M.col[0].xyz
            x = (x - y * x.dot(y)).normalized()
            z = x.cross(y)
            Mn = Matrix((x, y, z)).transposed().to_4x4()
            Mn.translation = M.translation
            b.matrix = Mn
            b.keyframe_insert("rotation_quaternion", frame=f)
            b.keyframe_insert("location", frame=f)
    sc_.frame_set(1)


def actual_palm(arm, sd):
    b = arm.pose.bones[f"hand.{sd}"]
    w, t = arm.matrix_world @ b.head, arm.matrix_world @ b.tail
    return w + (t - w).normalized() * PALM * arm["vos_scale"], w, (t - w).normalized()


FR = list(range(1, frames + 1))

# ---- drummer: a short wrist-led stroke; the palm moves ±4 cm, the stick rotates -----------------------------------
DRUMMER_AT, DRUMMER_H = (KIT_X + 0.1, 3.45, DISC_TOP), 1.72
SEAT_CROUCH = 0.27   # puts the bottom of the pelvis clay at about the throne top: a seated look, no seat simulation
STICK_LEN, STICK_BUTT = 0.40, 0.05      # the palm holds the stick 5 cm from its butt end
REACH = STICK_LEN - STICK_BUTT          # palm -> tip


def head_top(drum):
    n, at, dia, dep, ax = drum
    return Vector((at[0], at[1], at[2] + dep / 2))


def stroke(f, hits, start=0.6, rest=0.45):
    """0 = tip on the head, 1 = stick up. Keys: top of the backswing 5 f before a hit, the hit, rebound to 0.9 5 f
    after; ease-in into a hit (accelerating), ease-out after it; smoothstep elsewhere. Continuous everywhere."""
    keys = [(1, start, "s")]
    for h in hits:
        keys += [(max(2, h - 5), 1.0, "s"), (h, 0.0, "in"), (h + 5, 0.9, "out")]
    if hits:
        keys.append((hits[-1] + 14, rest, "s"))
    keys = sorted({k[0]: k for k in keys}.values())
    if f <= keys[0][0]:
        return keys[0][1]
    for (fa, va, _), (fb, vb, kind) in zip(keys, keys[1:]):
        if f <= fb:
            u = (f - fa) / (fb - fa)
            if kind == "in":
                e = u * u                      # accelerate into the head
            elif fa in hits:
                e = 1 - (1 - u) ** 2           # rebound decelerates
            else:
                e = smooth(u)
            return va + (vb - va) * e
    return keys[-1][1]


# strike point offset on the head; palm offset from the strike point (scaled to REACH); palm rise; tip-aim lift.
# The right hand plays the drummer-side edge of the floor tom: from behind, a stick crosses the left cymbal over it.
STROKE = {"L": {"strike": (0.0, 0.0, 0.0), "palm": (0.0, 0.30, 0.26), "rise": 0.04, "aim": 0.30},
          "R": {"strike": (0.10, 0.08, 0.0), "palm": (0.10, 0.30, 0.245), "rise": 0.04, "aim": 0.20}}
drummer = rig.actor("drummer", at=DRUMMER_AT, facing=0, height=DRUMMER_H)
sticks = {}
for side, drum, hits in (("L", SNARE, SNARE_HITS), ("R", TOM, TOM_HITS)):
    k_ = STROKE[side]
    top = head_top(drum) + Vector(k_["strike"])
    off = Vector(k_["palm"]).normalized() * REACH
    hs = [h for h in hits if h <= frames]
    palm_w = {f: top + off + Vector((0, 0, k_["rise"] * stroke(f, hs))) for f in FR}
    aim_w = {f: top + Vector((0, 0, k_["aim"] * stroke(f, hs))) for f in FR}
    stick = cyl(f"stick_{side}", (0, 0, 0), 0.007, STICK_LEN, (0.85, 0.7, 0.45), verts=10) if LEVEL >= 1 else None
    if stick:
        stick.rotation_mode = "QUATERNION"
    sticks[side] = {"stick": stick, "palm_w": palm_w, "aim_w": aim_w, "head_top": top, "drum": drum[0], "hits": hits,
                    "target": wrist_target(f"wrist_target_drummer_{side}"), "tips": {}, "butts": {}}

DRUMMER_SPEC = {
    "effort": {"weight": "strong", "time": "neutral", "space": "direct", "flow": "neutral"},
    # no torso twist and one gaze point: in ca7abe1 the twist keys, and in the first repair preview the gaze moving
    # snare -> tom -> snare, turned the chest (eyes lead, chest follows) and the left elbow rose to shoulder height
    "body": [(0, {"crouch": SEAT_CROUCH, "lean": 8, "arms": "front"}, 1),
             (RECOVER, {"crouch": SEAT_CROUCH, "lean": 6, "arms": "front"}, 8)],
    "gaze": [(0, ((SNARE[1][0] + TOM[1][0]) / 2, 3.0, SNARE[1][2])), (RECOVER, "camera")],
    "hands": [(0, sd, sticks[sd]["target"], 1) for sd in ("L", "R")],
    "beats": [(1, "set: sticks up, eyes on the snare"), (SNARE_HITS[0], "snare (L)"), (TOM_HITS[0], "floor tom (R)"),
              (SNARE_HITS[1], "snare (L)"), (RECOVER, "recover, looks up")],
}
DRUM_BEND = 0.55     # hand direction between the forearm (0) and the stick (1)
drum_hd = place_palms(drummer, DRUMMER_SPEC, {
    sd: (sticks[sd]["target"], (lambda f, sd=sd: sticks[sd]["palm_w"][f]),
         (lambda f, sd=sd: (sticks[sd]["aim_w"][f] - sticks[sd]["palm_w"][f]).normalized()), DRUM_BEND)
    for sd in ("L", "R")}, FR)
bend_hands(drummer, drum_hd, FR)
for f in FR:  # sticks from the ACTUAL palm toward the aim point
    sc_.frame_set(f)
    for sd, st in sticks.items():
        palm, _, _ = actual_palm(drummer, sd)
        d = (st["aim_w"][f] - palm).normalized()
        butt, tip = palm - d * STICK_BUTT, palm + d * REACH
        st["tips"][f], st["butts"][f] = tip, butt
        if st["stick"]:
            st["stick"].location = (butt + tip) / 2
            st["stick"].rotation_quaternion = Vector((0, 0, 1)).rotation_difference(d)
            st["stick"].keyframe_insert("location", frame=f)
            st["stick"].keyframe_insert("rotation_quaternion", frame=f)
sc_.frame_set(1)

# ---- bassist and the bass (built in the actor's rest space, attached to the chest bone like the clay parts) --------
BASSIST_AT, BASSIST_H, BASSIST_FACING = (-0.75, 2.75, DISC_TOP), 1.70, 10
bassist = rig.actor("bassist", at=BASSIST_AT, facing=BASSIST_FACING, height=BASSIST_H)
chest = bassist.data.bones["chest"]
CHEST_INV = (bassist.matrix_world @ chest.matrix_local @ Matrix.Translation((0, chest.length, 0))).inverted()


def attach(ob):
    """Parent to the bassist's chest bone, keeping the rest-space placement (same scheme as previz_actor._body)."""
    ob.parent = bassist
    ob.parent_type = "BONE"
    ob.parent_bone = "chest"
    ob.matrix_parent_inverse = CHEST_INV
    return ob


NECK_DEG = 28.0
th = math.radians(-NECK_DEG)
U = Vector((math.cos(th), 0, -math.sin(th)))     # along the neck: to the player's left (+X) and up
V = Vector((math.sin(th), 0, math.cos(th)))      # across the neck (string spacing), "up" across the strings
B0 = Vector((-0.05, -0.185, 0.97))               # body centre, in front of the right hip (rest space, s = 1)
STRING_Y = -0.221                                # string plane (front of the neck)
ROT = (0, th, 0)


def bass_box(name, centre, size, color):
    ob = rig.box(name, tuple(centre), size, color)
    ob.rotation_euler = ROT
    return attach(ob)


BASS_DARK, NECK_BROWN = (0.05, 0.05, 0.06), (0.25, 0.15, 0.08)
NECK_C, NECK_HALF = B0 + U * 0.485 + Vector((0, -0.02, 0)), (0.315, 0.015, 0.025)   # neck box: along U, y, along V
if LEVEL == 0:
    bass_box("bass_body", B0, (0.48, 0.045, 0.34), D)
    bass_box("bass_neck", B0 + U * 0.49 + Vector((0, -0.02, 0)), (0.66, 0.03, 0.06), D)
else:
    bpy.ops.mesh.primitive_uv_sphere_add(radius=1, location=tuple(B0 - U * 0.03), segments=32, ring_count=16)
    body = bpy.context.object
    body.name = "bass_body"
    body.scale = (0.25, 0.022, 0.17)
    body.rotation_euler = ROT
    body.data.materials.append(rig._material("bass_body", BASS_DARK))
    attach(body)
    bass_box("bass_neck", NECK_C, (0.63, 0.03, 0.05), NECK_BROWN)
    bass_box("bass_head", B0 + U * 0.88 + Vector((0, -0.02, 0)), (0.17, 0.02, 0.085), BASS_DARK)
    for k, off in enumerate((-0.027, -0.009, 0.009, 0.027)):
        a = B0 - U * 0.10 + V * off
        b = B0 + U * 0.80 + V * off * 0.7
        a.y = b.y = STRING_Y
        attach(rod(f"bass_string{k}", tuple(a), tuple(b), r=0.0025, color=(0.85, 0.85, 0.82)))

markers = {}
for name in ("bass_space", "headstock_marker"):
    ob = attach(bpy.data.objects.new(name, None))
    sc_.collection.objects.link(ob)
    markers[name] = ob
markers["headstock_marker"].location = B0 + U * 0.93 + Vector((0, -0.02, 0))   # bass_space stays at the rest origin

# Fretting hand: palm in front of the fretboard just below the neck, hand across the neck (fingers over the strings).
# Plucking hand: palm in front of the strings above the string centre, hand pointing down across the strings; a small
# continuous loop across the strings — the fingers pass the string centre moving down on each note (no snap back).
FRET_U = (0.62, 0.59)        # a 3 cm shift (ca7abe1: 10 cm in 4 frames) — smooth over 6 frames from FRET_SHIFT
FRET_SHIFT = 26
FRET_PALM = (-0.035, STRING_Y - 0.06)     # (along V, y) of the fretting palm
PLUCK_U, PLUCK_PALM = 0.04, (0.035, STRING_Y - 0.035)
PLUCK_AMP = 0.012


def pluck_env(f):
    return smooth((f - 4) / 6) * (1 - smooth((f - 34) / 6))


def palm_rest(sd, f):
    if sd == "L":
        u = FRET_U[0] + (FRET_U[1] - FRET_U[0]) * smooth((f - FRET_SHIFT) / 6)
        p = B0 + U * u + V * FRET_PALM[0]
        p.y = FRET_PALM[1]
        return p
    phase = 2 * math.pi * (f - PLUCKS[0]) / EIGHTH
    p = B0 + U * PLUCK_U + V * (PLUCK_PALM[0] - PLUCK_AMP * math.sin(phase) * pluck_env(f))
    p.y = PLUCK_PALM[1] + 0.004 * (1 - math.cos(phase)) * pluck_env(f)
    return p


TOOL_REST = {"L": (V + Vector((0, -0.25, 0))).normalized(),       # across the neck, slightly forward
             "R": (-V + Vector((0, 0.6, 0))).normalized()}        # down across the strings and into them
BASS_BEND = {"L": 0.6, "R": 0.6}
BASS_BODY = [(0, {"crouch": 0.08, "weight": "R", "lean": 3, "twist": -4}, 1),
             (FRET_SHIFT - 4, {"crouch": 0.1, "weight": "L", "lean": 4, "twist": -2}, 10),   # small weight shift
             (RECOVER, {"crouch": 0.08, "weight": "L", "lean": 2, "twist": -4}, 8)]
BASS_GAZE = [(0, "camera")]
BASS_BEATS = [(1, "set: weight right, eyes to camera"), (PLUCKS[0], "pluck 1"), (PLUCKS[1], "pluck 2"),
              (FRET_SHIFT, "left hand shifts 3 cm, weight to the left"), (PLUCKS[2], "pluck 3"), (RECOVER, "hold")]
BASS_EFFORT = {"weight": "strong", "time": "neutral", "space": "direct", "flow": "bound"}   # deadpan, contained
# pass 1 (body + gaze) keys the chest, so the bass (and its palm points) are known in the world at every frame
rig.perform(bassist, {"effort": BASS_EFFORT, "body": BASS_BODY, "gaze": BASS_GAZE})
bass_M = {}
for f in FR:
    sc_.frame_set(f)
    bass_M[f] = markers["bass_space"].matrix_world.copy()
bass_targets = {sd: wrist_target(f"wrist_target_bassist_{sd}") for sd in ("L", "R")}
BASS_SPEC = {"effort": BASS_EFFORT, "body": BASS_BODY, "gaze": BASS_GAZE, "beats": BASS_BEATS,
             "hands": [(0, sd, bass_targets[sd], 1) for sd in ("L", "R")]}
bass_hd = place_palms(bassist, BASS_SPEC, {
    sd: (bass_targets[sd], (lambda f, sd=sd: bass_M[f] @ palm_rest(sd, f)),
         (lambda f, sd=sd: (bass_M[f].to_3x3() @ TOOL_REST[sd]).normalized()), BASS_BEND[sd])
    for sd in ("L", "R")}, FR)
bend_hands(bassist, bass_hd, FR)

# ---- light: plain at layout/form, shaped at material ---------------------------------------------------------------
if LEVEL < 2:
    bpy.ops.object.light_add(type="AREA", location=(0, -2, 5))
    bpy.context.object.data.energy, bpy.context.object.data.size = 900, 6
    bpy.ops.object.light_add(type="SUN", location=(0, 0, 10))
    bpy.context.object.data.energy = 0.6
else:
    # Studio look of the reference: big soft frontal key slightly from camera-left, even wash on the seamless.
    bpy.ops.object.light_add(type="AREA", location=(-1.8, -1.6, 3.2))
    key = bpy.context.object
    key.data.energy, key.data.size = 135, 4
    key.rotation_euler = rig._aim(key.location, rig._point((0.3, 2.8, 0.8)), 0)
    bpy.ops.object.light_add(type="AREA", location=(2.4, -1.0, 2.4))
    fill = bpy.context.object
    fill.data.energy, fill.data.size = 45, 4
    fill.rotation_euler = rig._aim(fill.location, rig._point((0.3, 2.8, 0.8)), 0)
    bpy.ops.object.light_add(type="AREA", location=(0.3, CYC_Y - 3.4, 4.0))  # in front of the moved wall
    wash = bpy.context.object
    wash.data.energy, wash.data.size = 150, 8
    wash.rotation_euler = rig._aim(wash.location, rig._point((0.3, CYC_Y, 1.8)), 0)
    world = bpy.data.worlds.new("mint_world")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.32, 0.52, 0.46, 1)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.3
    bpy.context.scene.world = world

for ob in [o for o in bpy.context.scene.objects if o.type == "LIGHT"]:
    ob.location.z -= PLAT_THICK  # same light rig as the kit scene, moved with the world shift (directions unchanged)

# ---- materials (procedural only; one shared wear group, strength per material) ------------------------------------
def wear_group():
    g = bpy.data.node_groups.new("stepwise_wear", "ShaderNodeTree")
    g.interface.new_socket("Color", in_out="INPUT", socket_type="NodeSocketColor")
    g.interface.new_socket("Strength", in_out="INPUT", socket_type="NodeSocketFloat")
    g.interface.new_socket("Color", in_out="OUTPUT", socket_type="NodeSocketColor")
    n, l = g.nodes, g.links
    gi, go = n.new("NodeGroupInput"), n.new("NodeGroupOutput")
    noise = n.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = 40
    geo = n.new("ShaderNodeNewGeometry")
    sep = n.new("ShaderNodeSeparateXYZ")
    l.new(geo.outputs["Normal"], sep.inputs[0])  # dust gathers on up-facing surfaces
    up = n.new("ShaderNodeMath"); up.operation = "MAXIMUM"; up.inputs[1].default_value = 0
    l.new(sep.outputs["Z"], up.inputs[0])
    m1 = n.new("ShaderNodeMath"); m1.operation = "MULTIPLY"
    l.new(noise.outputs["Fac"], m1.inputs[0]); l.new(up.outputs[0], m1.inputs[1])
    m2 = n.new("ShaderNodeMath"); m2.operation = "MULTIPLY"
    l.new(m1.outputs[0], m2.inputs[0]); l.new(gi.outputs["Strength"], m2.inputs[1])
    mix = n.new("ShaderNodeMix"); mix.data_type = "RGBA"
    mix.inputs["B"].default_value = (0.55, 0.53, 0.5, 1)
    l.new(m2.outputs[0], mix.inputs["Factor"]); l.new(gi.outputs["Color"], mix.inputs["A"])
    l.new(mix.outputs["Result"], go.inputs["Color"])
    return g


def surface(ob_names, color, metallic=0.0, rough=0.5, wear=0.0, coat=0.0):
    m = bpy.data.materials.new("surf_" + ob_names[0])
    m.use_nodes = True
    nt = m.node_tree
    b = nt.nodes["Principled BSDF"]
    b.inputs["Metallic"].default_value = metallic
    b.inputs["Roughness"].default_value = rough
    if coat:
        b.inputs["Coat Weight"].default_value = coat
    if wear:
        g = nt.nodes.new("ShaderNodeGroup"); g.node_tree = WEAR
        g.inputs["Color"].default_value = (*color, 1)
        g.inputs["Strength"].default_value = wear
        nt.links.new(g.outputs["Color"], b.inputs["Base Color"])
    else:
        b.inputs["Base Color"].default_value = (*color, 1)
    for ob in bpy.data.objects:
        if ob.type == "MESH" and any(ob.name.startswith(k) for k in ob_names):  # later calls override earlier ones
            ob.data.materials.clear()
            ob.data.materials.append(m)


if LEVEL >= 2:
    WEAR = wear_group()
    surface(["floor", "cyc"], MINT, rough=0.9)
    surface(["disc"], (0.93, 0.93, 0.92), rough=0.12, coat=0.6, wear=0.15)
    surface(["kick", "floor_tom", "snare"], (0.9, 0.89, 0.86), rough=0.25, coat=0.5, wear=0.03)  # white pearl wraps
    surface(["kick_head"], (0.96, 0.96, 0.94), rough=0.6)                                    # coated head
    surface(["kick_hoop", "floor_tom_hoop", "snare_hoop", "snare_stand", "cymR_stand", "cymL_stand", "tom_leg",
             "kick_spur"], (0.85, 0.86, 0.88), metallic=1.0, rough=0.18)                    # chrome
    surface(["kick_hoop"], (0.96, 0.95, 0.9), rough=0.35)  # the reference shows a light (wood/white) kick hoop
    surface(["cymbal_L", "cymbal_R"], (0.8, 0.6, 0.28), metallic=1.0, rough=0.32, wear=0.2)  # brass
    surface(["throne"], (0.05, 0.05, 0.05), rough=0.6)

if LEVEL >= 2:
    surface(["bass_body", "bass_head"], (0.03, 0.03, 0.035), rough=0.25, coat=0.6)
    surface(["bass_neck"], (0.22, 0.13, 0.07), rough=0.5)
    surface(["bass_string"], (0.8, 0.8, 0.78), metallic=1.0, rough=0.3)
    surface(["stick_"], (0.85, 0.7, 0.45), rough=0.55)


# ---- audit (measured on the baked frames). Three different reference points are reported separately:
#   wrist   — the IK end (rig.perform's contact point) vs its target: says the solver reached, nothing about the hand
#   palm    — the hand clay's centre (wrist + hand direction × 0.08 m) vs where the hand should hold
#   prop    — stick butt/tip, string plane, neck: where the instrument is relative to the palm / hand clay
def performance_audit():
    sc = bpy.context.scene

    def bone(a, n, end="head"):
        return a.matrix_world @ getattr(a.pose.bones[n], end)

    def img(p):
        v = world_to_camera_view(sc, cam, p)
        return round(v.x, 4), round(1 - v.y, 4)

    hit_frames = [h for h in HITS if h <= frames]
    near = sorted({f for h in hit_frames for f in (h - 1, h, h + 1)} | {FRET_SHIFT, FRET_SHIFT + 3, 16, 17, 25, 34})
    contact_frames = sorted({1, frames, (frames + 1) // 2} | {f for f in near if 1 <= f <= frames})
    out = {"actors": 2, "identity": "anonymous clay bodies (rig.actor): no face, fingers, clothing or likeness",
           "beats": sorted(({"frame": m.frame, "sec": round((m.frame - 1) / fps, 3), "label": m.name}
                            for m in sc.timeline_markers), key=lambda m: m["frame"]),
           "demo_beat": {"eighth_frames": round(EIGHTH, 3), "hits": HITS, "synced_to_music": False},
           "measurement_bases": {"wrist": "IK end vs IK target", "palm": "hand clay centre = wrist + hand dir x 0.08 m",
                                 "prop": "stick butt/tip, bass string plane / neck box / body (rest space of the bass)"},
           "limits": ["hand = one rigid clay ellipsoid (0.03 x 0.05 x 0.085 m half-axes): no fingers, no grip",
                      "wrist flexion is re-keyed by the scene (the rig keeps the hand straight)",
                      "collisions are proxies: hand axis segment with a 0.03 m radius vs boxes/planes; body clay vs kit not checked",
                      "seat contact not simulated"]}
    sc.frame_set(1)
    out["actor_roots_frame1"] = {a.name: [round(v, 4) for v in bone(a, "root")] for a in (drummer, bassist)}
    hands = {("drummer", "L"): drummer, ("drummer", "R"): drummer, ("bassist", "L"): bassist, ("bassist", "R"): bassist}
    tgt = {("drummer", sd): sticks[sd]["target"] for sd in ("L", "R")}
    tgt.update({("bassist", sd): bass_targets[sd] for sd in ("L", "R")})
    want = {}
    for f in FR:
        for sd in ("L", "R"):
            want[("drummer", sd, f)] = sticks[sd]["palm_w"][f]
            want[("bassist", sd, f)] = bass_M[f] @ palm_rest(sd, f)
    track = {k: {"palm": [], "wrist": [], "elbow": [], "hand_dir": [], "img_palm": []} for k in hands}
    wrist_err, palm_err, bend_deg, stick_angle = ({k: [] for k in hands} for _ in range(4))
    tip_head, finger_plane, neck_clear, body_clear, string_clear = [], [], [], [], []
    feet, seat, bass_gap, crops = [], [], [], {}
    through = []
    for f in FR:
        sc.frame_set(f)
        for (who, sd), a in hands.items():
            palm, w, d = actual_palm(a, sd)
            el = bone(a, f"forearm.{sd}")
            fd = (w - el).normalized()
            t = track[(who, sd)]
            t["palm"].append(palm); t["wrist"].append(w); t["elbow"].append(el); t["hand_dir"].append(d)
            t["img_palm"].append(img(palm))
            wrist_err[(who, sd)].append((tgt[(who, sd)].matrix_world.translation - w).length)
            palm_err[(who, sd)].append((palm - want[(who, sd, f)]).length)
            bend_deg[(who, sd)].append(math.degrees(fd.angle(d)))
        for sd, st in sticks.items():
            palm, _, d = actual_palm(drummer, sd)
            sdir = (st["tips"][f] - st["butts"][f]).normalized()
            stick_angle[("drummer", sd)].append(math.degrees(d.angle(sdir)))
            if f in st["hits"]:
                tip_head.append({"frame": f, "stick": sd, "drum": st["drum"],
                                 "tip_minus_head_m": round((st["tips"][f] - st["head_top"]).length, 4),
                                 "tip_height_above_head_m": round(st["tips"][f].z - st["head_top"].z, 4)})
            for cn, cdef in (("cymbal_L", CYM_L), ("cymbal_R", CYM_R)):
                mw = parts[cn].matrix_world
                c, n, r = mw.translation, (mw.to_3x3() @ Vector((0, 0, 1))).normalized(), cdef[2] / 2
                a_, b_ = st["butts"][f], st["tips"][f]
                da, db = (a_ - c).dot(n), (b_ - c).dot(n)
                if da * db <= 0 and abs(da - db) > 1e-9 and (a_ + (b_ - a_) * (da / (da - db)) - c).length < r:
                    through.append(f"{f}: stick {sd} through {cn}")
        Minv = bass_M[f].inverted()
        for sd in ("L", "R"):  # bassist hand axis in the bass's rest space
            palm, w, d = actual_palm(bassist, sd)
            pts = [Minv @ (w + d * HAND_LEN * k / 8) for k in range(9)]
            tipr = pts[-1]
            if sd == "R" and f in PLUCKS:
                finger_plane.append({"frame": f, "fingertip_y_minus_string_plane_m": round(tipr.y - STRING_Y, 4),
                                     "fingertip_across_strings_m": round((tipr - B0).dot(V), 4)})
            for q in pts:
                lq = q - NECK_C
                du, dy, dv = abs(lq.dot(U)) - NECK_HALF[0], abs(lq.y) - NECK_HALF[1], abs(lq.dot(V)) - NECK_HALF[2]
                outside = Vector((max(du, 0), max(dy, 0), max(dv, 0))).length
                inside = min(max(du, dy, dv), 0)
                neck_clear.append((outside + inside - 0.03, f, sd))
                lb = q - (B0 - U * 0.03)
                if (lb.dot(U) / 0.25) ** 2 + (lb.dot(V) / 0.17) ** 2 < 1:   # over the body outline
                    body_clear.append(((B0.y - 0.022) - q.y - 0.03, f, sd))
                    string_clear.append((STRING_Y - q.y - 0.03, f, sd))
        for a in (drummer, bassist):
            for sd in ("L", "R"):
                feet.append(bone(a, f"foot.{sd}").z - a["vos_scale"] * 0.08 - DISC_TOP)
        seat.append(bone(drummer, "pelvis").z - (THRONE[1][2] + THRONE[3] / 2))
        fwd = Vector((math.sin(math.radians(BASSIST_FACING)), -math.cos(math.radians(BASSIST_FACING)), 0))
        bass_gap.append((sc.objects["bass_body"].matrix_world.translation - bone(bassist, "pelvis")).dot(fwd)
                        - 0.11 * bassist["vos_scale"] - 0.022)
        if f in contact_frames:
            pts_ = {"bassist head top": bone(bassist, "head", "tail"), "drummer head top": bone(drummer, "head", "tail"),
                    "stick tip L": sticks["L"]["tips"][f], "stick tip R": sticks["R"]["tips"][f],
                    "bass headstock": markers["headstock_marker"].matrix_world.translation.copy(),
                    "kick bottom": Vector((KICK[1][0], KICK[1][1] - KICK[3] / 2, DISC_TOP)),
                    "cymbal R outer": Vector((CYM_R[1][0] + CYM_R[2] / 2, CYM_R[1][1], CYM_R[1][2])),
                    "bassist feet": bone(bassist, "foot.L")}
            for (who, sd), a in hands.items():
                pts_[f"{who} palm {sd}"] = actual_palm(a, sd)[0]
                pts_[f"{who} fingertip {sd}"] = bone(a, f"hand.{sd}", "tail")
            crops[f] = {k: img(v) for k, v in pts_.items()}
    sc.frame_set(1)

    def stats(v):
        return {"max": round(max(v), 4), "mean": round(sum(v) / len(v), 4)}

    def continuity(seq, label):
        d1 = [(seq[k + 1] - seq[k]).length for k in range(len(seq) - 1)]
        d2 = [(seq[k + 1] - 2 * seq[k] + seq[k - 1]).length for k in range(1, len(seq) - 1)]
        top = sorted(range(len(d2)), key=lambda k: -d2[k])[:3]
        return {f"{label}_max_step_m": round(max(d1), 4) if d1 else 0.0,
                f"{label}_max_accel_m": round(max(d2), 4) if d2 else 0.0,
                f"{label}_top_accel_frames": [k + 2 for k in top]}

    out["wrist_ik_error_m"] = {f"{w}.{s_}": stats(v) for (w, s_), v in wrist_err.items()}
    out["palm_vs_intended_m"] = {f"{w}.{s_}": stats(v) for (w, s_), v in palm_err.items()}
    out["wrist_bend_deg"] = {f"{w}.{s_}": {"min": round(min(v), 1), "max": round(max(v), 1)} for (w, s_), v in bend_deg.items()}
    out["hand_to_stick_angle_deg"] = {f"{w}.{s_}": {"min": round(min(v), 1), "max": round(max(v), 1)}
                                      for (w, s_), v in stick_angle.items() if v}
    out["stick_grip"] = f"by construction the palm centre lies on the stick, {STICK_BUTT} m from its butt"
    out["stick_tip_on_head_at_hits"] = tip_head
    out["stick_tip_min_height_above_head_m"] = round(min(min(st["tips"][f].z - st["head_top"].z for f in FR)
                                                         for st in sticks.values()), 4)
    out["stick_through_cymbal"] = through
    out["pluck_fingertip_at_plucks"] = finger_plane
    out["bassist_hand_clearance_m"] = {
        "to_neck_min": round(min(c for c, _, _ in neck_clear), 4),
        "to_neck_min_frame": min(neck_clear)[1:],
        "to_body_front_min": round(min(c for c, _, _ in body_clear), 4) if body_clear else None,
        "to_string_plane_min": round(min(c for c, _, _ in string_clear), 4) if string_clear else None,
        "note": "negative = the hand clay (axis + 0.03 m) reaches into the neck box / body / string plane"}
    out["continuity"] = {}
    for (who, sd), t in track.items():
        c = {}
        for key in ("palm", "wrist", "elbow"):
            c.update(continuity(t[key], key))
        ang = [math.degrees(t["hand_dir"][k + 1].angle(t["hand_dir"][k])) for k in range(len(t["hand_dir"]) - 1)]
        c["hand_dir_max_step_deg"] = round(max(ang), 2) if ang else 0.0
        c["hand_dir_max_step_change_deg"] = round(max(abs(ang[k + 1] - ang[k]) for k in range(len(ang) - 1)), 2) if len(ang) > 1 else 0.0
        ip = t["img_palm"]
        c["img_palm_max_step_px"] = round(max(math.dist(ip[k], ip[k + 1]) * width for k in range(len(ip) - 1)), 2) if len(ip) > 1 else 0.0
        out["continuity"][f"{who}.{sd}"] = c
    out["stick_tip_continuity"] = {sd: continuity([st["tips"][f] for f in FR], "tip") for sd, st in sticks.items()}
    out["feet_height_above_platform_m"] = {"min": round(min(feet), 4), "max": round(max(feet), 4)}
    out["drummer_pelvis_above_throne_top_m"] = {"min": round(min(seat), 4), "max": round(max(seat), 4)}
    out["bass_body_gap_to_pelvis_surface_m"] = {"min": round(min(bass_gap), 4), "max": round(max(bass_gap), 4)}
    out["image_points_at_frames"] = crops
    out["out_of_frame"] = sorted({f"{f}: {k}" for f, d in crops.items() for k, (x, y) in d.items()
                                  if not (0.0 <= x <= 1.0 and 0.0 <= y <= 1.0)})
    out["per_frame"] = {f"{w}.{s_}": {"palm": [[round(v, 4) for v in p] for p in t["palm"]],
                                       "elbow": [[round(v, 4) for v in p] for p in t["elbow"]]}
                        for (w, s_), t in track.items()}
    return out


# ---- record what this stage is (read by skills/stepwise-scene-production/scripts/render_stages.py) ----------------
meta_path = os.environ.get("STEPWISE_META")
if meta_path:
    sc = bpy.context.scene
    camera = {}
    for f in sorted({1, frames}):
        sc.frame_set(f)
        mw = cam.matrix_world
        camera[f] = {"location": [round(v, 4) for v in mw.translation],
                     "rotation_deg": [round(math.degrees(v), 3) for v in mw.to_euler()], "lens_mm": cam.data.lens,
                     "sensor_mm": cam.data.sensor_width}
    sc.frame_set(1)
    audit_ = performance_audit()
    with open(meta_path, "w") as fh:
        json.dump({"stage": STAGE, "camera": camera, "look_at": CAM_LOOK, "unseen_guessed": UNSEEN,
                   "mesh_objects": sum(1 for o in sc.objects if o.type == "MESH"),
                   "materials": sorted({m.name for m in bpy.data.materials if m.users}),
                   "performance_audit": audit_}, fh, indent=1)
# .blend = the scene as built here, BEFORE the driver sets engine, samples and view transform (opening it shows another
# look); reproduce renders with the command in receipt.json, not from this file.
blend_path = os.environ.get("STEPWISE_BLEND")
if blend_path:
    bpy.ops.wm.save_as_mainfile(filepath=blend_path, copy=True)
