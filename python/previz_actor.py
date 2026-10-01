"""vos previz actor — a jointed clay person driven by a performance spec (used through `rig.actor` / `rig.perform`).

    A = rig.actor("A", at=(0, -1, 0), facing=0)
    rig.perform(A, {
        "effort": {"weight": "light", "time": "sustained", "space": "indirect", "flow": "bound"},   # Laban Effort
        "path":   [(1, (0, -1)), (48, (0, 2.5))],        # marks: be at (x, y) at frame f; walk between, hold otherwise
        "facing": [(80, 90)],                            # standing turns (deg, 0 = facing -Y) or (f, target)
        "body":   [(1, {"lean": 4, "weight": "R"}), (72, {"crouch": 0.1, "arms": "face"})],
        "gaze":   [(1, "floor"), (46, letter), (62, "hold"), (73, B)],
        "hands":  [(1, "R", handle), (18, "R", None)],   # IK contact; the hand follows the target if it moves
        "beats":  [(1, "enter"), (46, "notice"), (62, "recognition"), (72, "reaction")],
    })

Everything is solved in Python per frame and baked as one key per frame on a plain armature (no IK constraints, no
Rigify), so it is deterministic and the same spec always gives the same frames:

  root      world position and heading (from path marks and facing keys); feet are planned as footsteps and stay
            locked to the ground while in stance, so they never slide
  pelvis    centre of mass: bobs and shifts over the support foot while walking, over the weight foot when standing
            (with contrapposto: pelvis and chest tilt against each other); crouch lowers it and the legs bend (IK)
  torso     lean, twist; takes part of the gaze turn
  gaze      eyes lead: the head starts turning first, the chest a few frames later (successive offsets), each with its
            own share of the angle
  arms      walking arm swing opposite to the legs, presets (rest, hips, front, crossed, face, reach) or contacts,
            all solved as two-bone IK with the elbow pointing back

Event tuples are (frame, value) or (frame, value, duration_frames); a change starts at its frame and takes the duration
(default from Laban Time). Hands: (frame, "L"|"R"|"both", target, [duration]).
"""
import json
import math

import bpy
from mathutils import Matrix, Vector

import previz_rig as R

# ---- skeleton (rest pose, height 1.7 m, facing -Y; subject's left = +X) --------------------------------------------

BONES = [  # name, parent, head, tail, twist reference ("fwd" = -Y, "back" = +Y, "up" = +Z)
    ("root", None, (0, 0, 0), (0, -0.3, 0), "up"),
    ("pelvis", "root", (0, 0, 0.95), (0, 0, 1.05), "fwd"),
    ("spine", "pelvis", (0, 0, 1.05), (0, 0, 1.25), "fwd"),
    ("chest", "spine", (0, 0, 1.25), (0, 0, 1.45), "fwd"),
    ("neck", "chest", (0, 0, 1.45), (0, 0, 1.55), "fwd"),
    ("head", "neck", (0, 0, 1.55), (0, 0, 1.75), "fwd"),
]
for side, sx in (("L", 1), ("R", -1)):
    BONES += [
        (f"upper_arm.{side}", "chest", (0.2 * sx, 0, 1.42), (0.24 * sx, 0, 1.13), "back"),
        (f"forearm.{side}", f"upper_arm.{side}", (0.24 * sx, 0, 1.13), (0.26 * sx, 0, 0.88), "back"),
        (f"hand.{side}", f"forearm.{side}", (0.26 * sx, 0, 0.88), (0.27 * sx, 0, 0.71), "back"),
        (f"thigh.{side}", "pelvis", (0.1 * sx, 0, 0.95), (0.1 * sx, 0, 0.52), "fwd"),
        (f"shin.{side}", f"thigh.{side}", (0.1 * sx, 0, 0.52), (0.1 * sx, 0, 0.08), "fwd"),
        (f"foot.{side}", f"shin.{side}", (0.1 * sx, 0, 0.08), (0.1 * sx, -0.15, 0.02), "up"),
    ]
REFS = {"fwd": Vector((0, -1, 0)), "back": Vector((0, 1, 0)), "up": Vector((0, 0, 1))}

# OpenPose body-18 keypoints as (bone, rest-space point, visibility rule)
KEYPOINTS = [
    ("head", (0, -0.11, 1.62), "front"),      # 0 nose
    ("chest", (0, 0, 1.42), ""),              # 1 neck
    ("upper_arm.R", (-0.2, 0, 1.42), ""),     # 2 R shoulder
    ("forearm.R", (-0.24, 0, 1.13), ""),      # 3 R elbow
    ("hand.R", (-0.26, 0, 0.88), ""),         # 4 R wrist
    ("upper_arm.L", (0.2, 0, 1.42), ""),      # 5
    ("forearm.L", (0.24, 0, 1.13), ""),       # 6
    ("hand.L", (0.26, 0, 0.88), ""),          # 7
    ("thigh.R", (-0.1, 0, 0.95), ""),         # 8 R hip
    ("shin.R", (-0.1, 0, 0.52), ""),          # 9 R knee
    ("foot.R", (-0.1, 0, 0.08), ""),          # 10 R ankle
    ("thigh.L", (0.1, 0, 0.95), ""),          # 11
    ("shin.L", (0.1, 0, 0.52), ""),           # 12
    ("foot.L", (0.1, 0, 0.08), ""),           # 13
    ("head", (-0.04, -0.095, 1.66), "front"),  # 14 R eye
    ("head", (0.04, -0.095, 1.66), "front"),   # 15 L eye
    ("head", (-0.1, 0, 1.64), "R"),           # 16 R ear
    ("head", (0.1, 0, 1.64), "L"),            # 17 L ear
]

# ---- Laban Effort -> motion parameters -----------------------------------------------------------------------------

EFFORT = {
    "time": {  # how fast changes happen
        "sudden": {"dur": 0.25, "ease": "out"},
        "neutral": {"dur": 0.5, "ease": "inout"},
        "sustained": {"dur": 1.0, "ease": "inout-strong"},
    },
    "weight": {  # how much the body commits its mass
        "light": {"bob": 0.7, "crouch": 0.0, "lean": -1.5, "swing": 0.8, "lift": 0.8},
        "neutral": {"bob": 1.0, "crouch": 0.0, "lean": 0.0, "swing": 1.0, "lift": 1.0},
        "strong": {"bob": 1.3, "crouch": 0.03, "lean": 4.0, "swing": 1.25, "lift": 1.1},
    },
    "space": {  # where attention goes
        "direct": {"wander": 0.0},
        "neutral": {"wander": 1.5},
        "indirect": {"wander": 6.0},
    },
    "flow": {  # how controlled the movement is
        "bound": {"swing": 0.5, "abduct": 4.0, "overlap": 0.5, "elbow": 22.0},
        "neutral": {"swing": 1.0, "abduct": 8.0, "overlap": 1.0, "elbow": 12.0},
        "free": {"swing": 1.3, "abduct": 11.0, "overlap": 1.6, "elbow": 8.0},
    },
}

_EYES = {}  # actor name -> {frame: eye point}, filled by perform() so others can look at / frame this actor


# ---- building ------------------------------------------------------------------------------------------------------

def actor(name="actor", at=(0, 0, 0), facing=0.0, height=1.7, color=R.CLAY):
    """A jointed clay person (feet at `at`, facing in degrees, 0 = -Y). Returns the armature; animate it with
    perform(). Before perform() it stands in the rest pose at `at`."""
    s = height / 1.7
    sc = bpy.context.scene
    data = bpy.data.armatures.new(name)
    arm = bpy.data.objects.new(name, data)
    sc.collection.objects.link(arm)
    bpy.context.view_layer.objects.active = arm
    arm.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    eb = {}
    for bn, parent, head, tail, _ in BONES:
        b = data.edit_bones.new(bn)
        b.head, b.tail = Vector(head) * s, Vector(tail) * s
        b.roll = 0
        b.use_connect = False
        if parent:
            b.parent = eb[parent]
        eb[bn] = b
    bpy.ops.object.mode_set(mode="OBJECT")
    arm.show_in_front = False
    arm.hide_render = True  # the bones are not drawn; the clay parts are
    arm["vos_actor"] = name
    arm["vos_scale"] = s
    arm["vos_eye_height"] = 1.62 * s
    arm["vos_keypoints"] = json.dumps([[b, [c * s for c in p], v] for b, p, v in KEYPOINTS])
    arm["vos_start"] = json.dumps([list(at), facing])
    _body(arm, s, color)
    # stand at `at`, facing: pose only the root
    _EYES.pop(name, None)
    pb = arm.pose.bones["root"]
    rest = arm.data.bones["root"].matrix_local
    pose = Matrix.Translation(Vector(at)) @ Matrix.Rotation(math.radians(facing), 4, "Z") @ rest
    pb.matrix_basis = rest.inverted() @ pose
    bpy.context.view_layer.update()
    return arm


def _body(arm, s, color):
    """Rigid clay parts parented to the bones (the depth pass needs a readable silhouette, not skin deformation)."""
    mat = R._material(arm.name + "_clay", color)
    parts = []

    def ellipsoid(bone, c, r):
        bpy.ops.mesh.primitive_uv_sphere_add(radius=1, location=Vector(c) * s, segments=20, ring_count=10)
        ob = bpy.context.object
        ob.scale = Vector(r) * s
        parts.append((ob, bone))

    def limb(bone, a, b, r):
        a, b = Vector(a) * s, Vector(b) * s
        d = b - a
        bpy.ops.mesh.primitive_cylinder_add(radius=r * s, depth=d.length, vertices=14, location=(a + b) / 2)
        ob = bpy.context.object
        ob.rotation_mode = "QUATERNION"
        ob.rotation_quaternion = Vector((0, 0, 1)).rotation_difference(d)
        parts.append((ob, bone))
        for p in (a, b):  # round joints
            bpy.ops.mesh.primitive_uv_sphere_add(radius=r * s, location=p, segments=12, ring_count=6)
            parts.append((bpy.context.object, bone))

    def block(bone, c, size):
        bpy.ops.mesh.primitive_cube_add(location=Vector(c) * s)
        ob = bpy.context.object
        ob.scale = Vector(size) * s / 2
        parts.append((ob, bone))

    ellipsoid("pelvis", (0, 0, 0.97), (0.17, 0.11, 0.11))
    ellipsoid("spine", (0, 0, 1.15), (0.15, 0.1, 0.13))
    ellipsoid("chest", (0, 0, 1.32), (0.2, 0.12, 0.15))
    limb("neck", (0, 0, 1.43), (0, 0, 1.55), 0.05)
    ellipsoid("head", (0, 0, 1.64), (0.1, 0.11, 0.12))
    block("head", (0, -0.11, 1.62), (0.035, 0.05, 0.045))  # nose: shows where the face points
    for side, sx in (("L", 1), ("R", -1)):
        limb(f"upper_arm.{side}", (0.2 * sx, 0, 1.42), (0.24 * sx, 0, 1.13), 0.045)
        limb(f"forearm.{side}", (0.24 * sx, 0, 1.13), (0.26 * sx, 0, 0.88), 0.038)
        ellipsoid(f"hand.{side}", (0.265 * sx, 0, 0.8), (0.03, 0.05, 0.085))
        limb(f"thigh.{side}", (0.1 * sx, 0, 0.93), (0.1 * sx, 0, 0.52), 0.07)
        limb(f"shin.{side}", (0.1 * sx, 0, 0.52), (0.1 * sx, 0, 0.1), 0.052)
        block(f"foot.{side}", (0.1 * sx, -0.05, 0.035), (0.09, 0.25, 0.07))
    for i, (ob, bone) in enumerate(parts):
        ob.name = f"{arm.name}_{bone}_{i}"
        ob.data.materials.append(mat)
        b = arm.data.bones[bone]
        world = ob.matrix_basis.copy()  # unparented: basis == intended world transform
        ob.parent = arm
        ob.parent_type = "BONE"
        ob.parent_bone = bone
        ob.matrix_parent_inverse = (arm.matrix_world @ b.matrix_local @ Matrix.Translation((0, b.length, 0))).inverted()
        ob.matrix_basis = world


# ---- performance ---------------------------------------------------------------------------------------------------

def perform(arm, spec):
    """Compile a performance spec (see module doc) into one key per frame on the actor's armature."""
    sc = bpy.context.scene
    fs, fe = sc.frame_start, sc.frame_end
    fps = sc.render.fps
    s = arm["vos_scale"]
    at0, facing0 = json.loads(arm["vos_start"])
    eff = {k: EFFORT[k][spec.get("effort", {}).get(k, "neutral")] for k in EFFORT}
    dur0 = max(1, round(eff["time"]["dur"] * fps))
    ease = R.EASES[eff["time"]["ease"]]

    for m in [m for m in sc.timeline_markers if m.name.startswith(f"{arm.name}: ")]:
        sc.timeline_markers.remove(m)  # performing again (e.g. for mutual gaze) replaces this actor's beats
    for f, label in spec.get("beats", []):
        sc.timeline_markers.new(f"{arm.name}: {label}", frame=int(f))

    # 1. root path: marks -> per-frame ground position and walking segments
    root, walking, segs = _root_path(spec.get("path", []), Vector(at0), fs, fe, fps)
    # 2. heading: travel direction while walking; facing keys while standing
    heading = _headings(root, walking, spec.get("facing", []), math.radians(facing0), fs, fe, dur0, ease)
    # 3. footsteps (stance feet locked in the world)
    feet = _footsteps(root, heading, segs, spec.get("facing", []), fs, fe, fps, s, dur0, eff)
    # 4. body tracks
    body = _track(spec.get("body", []), fs, fe, dur0, ease,
                  {"lean": 0.0, "weight": 0.0, "crouch": 0.0, "twist": 0.0, "tilt": 0.0, "arms": "rest"})
    # 5. gaze, per body part with successive delays (eyes lead)
    overlap = eff["flow"]["overlap"]
    gaze_events = spec.get("gaze", [])
    # 6. hands
    hand_events = {"L": [], "R": []}
    for ev in spec.get("hands", []):
        f, side, target = ev[0], ev[1], ev[2]
        d = ev[3] if len(ev) > 3 else dur0
        for sd in (("L", "R") if side == "both" else (side,)):
            hand_events[sd].append((int(f), target, d))

    wander = eff["space"]["wander"]
    pb = arm.pose.bones
    rest = {b.name: b.matrix_local.copy() for b in arm.data.bones}
    frames_rest = {n: _frame(Vector(t) - Vector(h), REFS[r]) for n, _, h, t, r in BONES}
    eyes = {}
    for f in range(fs, fe + 1):
        sc.frame_set(f)
        pose = _solve(f, s, root, heading, feet, body, gaze_events, hand_events, eff, overlap, wander, dur0, ease)
        eyes[f] = pose["_eye"]
        # world pose matrices -> bone basis, in hierarchy order
        P = {}
        for n, parent, *_ in BONES:
            h, t, ref = pose[n]
            Q = _frame(t - h, ref) @ frames_rest[n].transposed()
            m = Q.to_4x4() @ rest[n].to_3x3().to_4x4()
            m.translation = h
            P[n] = m
            if parent:
                basis = (rest[parent].inverted() @ rest[n]).inverted() @ P[parent].inverted() @ m
            else:
                basis = rest[n].inverted() @ m
            pb[n].matrix_basis = basis
            pb[n].keyframe_insert("location", frame=f)
            pb[n].keyframe_insert("rotation_quaternion", frame=f)
    _EYES[arm.name] = eyes
    sc.frame_set(fs)
    return arm


def eye_at(arm, frame=None):
    """Eye point of an actor at `frame` (after perform), else its start position."""
    f = bpy.context.scene.frame_current if frame is None else frame
    eyes = _EYES.get(arm.name)
    if eyes:
        return eyes.get(f, eyes[min(eyes, key=lambda k: abs(k - f))]).copy()
    at0, _ = json.loads(arm["vos_start"])
    return Vector(at0) + Vector((0, 0, arm["vos_eye_height"]))


# ---- solver --------------------------------------------------------------------------------------------------------

def _solve(f, s, root, heading, feet, body, gaze_events, hand_events, eff, overlap, wander, dur0, ease):
    w = eff["weight"]
    fl = eff["flow"]
    g = root[f]
    hd = heading[f]
    H = Matrix.Rotation(hd, 3, "Z")
    fwd, left, up = H @ Vector((0, -1, 0)), H @ Vector((1, 0, 0)), Vector((0, 0, 1))
    b = body(f)
    foot = {sd: feet[sd](f) for sd in ("L", "R")}

    # centre of mass: support foot, bob, weight shift, crouch
    swing_q, support = 0.0, None
    for sd, other in (("L", "R"), ("R", "L")):
        if foot[sd]["q"] is not None:
            swing_q, support = foot[sd]["q"], other
    bob = 0.025 * s * w["bob"]
    crouch = max(0.0, b["crouch"] + w["crouch"])
    if support:
        to_support = (foot[support]["pos"] - g).dot(left)
        lateral = to_support * 0.35 * math.sin(math.pi * swing_q)
        lift = bob * (math.sin(math.pi * swing_q) - 0.5)
        roll = 0.0
    else:
        wt = b["weight"]  # +1 = on the left foot, -1 = right
        lateral = 0.05 * s * wt
        lift = -bob * 0.5 + 0.01 * s * abs(wt)
        roll = -4.0 * wt
    dL, dR = ((foot[sd]["pos"] - g).dot(fwd) for sd in ("L", "R"))
    stride = (dL - dR) / (0.6 * s)
    yaw_p = -6.0 * stride
    lean = b["lean"] + w["lean"] + 25.0 * crouch / s
    pelvis_c = g + up * (0.94 * s - crouch + lift) + left * lateral - fwd * 0.25 * crouch  # 0.94: soft knees
    # the pelvis can only be as high as the legs reach: over a long stride it drops (lowest at double support), so
    # planted feet stay on the ground instead of being lifted by a too-short leg
    leg = 0.985 * 0.87 * s
    for sd, sx in (("L", 1), ("R", -1)):
        if foot[sd]["q"] is not None:
            continue  # a swinging foot peels off (heel rises) rather than pulling the body down
        hip_xy = (pelvis_c + left * 0.1 * sx * s).to_2d()
        ank = foot[sd]["pos"] + up * (0.08 * s + foot[sd]["lift"])
        horiz = (hip_xy - ank.to_2d()).length
        pelvis_c.z = min(pelvis_c.z, ank.z + math.sqrt(max(0.0, leg * leg - horiz * horiz)))
    Mp = H @ _rot(yaw_p, 0.3 * lean if crouch < 0.05 else 0.6 * lean, roll)

    # gaze: eyes lead, head follows after a beat, chest later (successive offsets)
    eye0 = pelvis_c + up * 0.67 * s
    def gaze_angles(ff):
        return _gaze(ff, gaze_events, eye0, hd, dur0, ease, wander)
    gy_h, gp_h = gaze_angles(f - round(2 * overlap))
    gy_c, gp_c = gaze_angles(f - round(5 * overlap))
    rel_c = _wrap(gy_c - hd)
    chest_yaw = max(-35.0, min(35.0, math.degrees(rel_c) * 0.35)) + b["twist"] + 4.0 * stride
    chest_pitch = max(-15.0, min(15.0, math.degrees(gp_c) * 0.2))
    Ms = Mp @ _rot(chest_yaw * 0.4, 0.35 * lean, -roll * 0.4)
    Mc = Ms @ _rot(chest_yaw * 0.6, 0.35 * lean + chest_pitch, -roll * 0.5)
    rel_h = math.degrees(_wrap(gy_h - hd)) - chest_yaw - yaw_p
    rel_h = max(-80.0, min(80.0, rel_h))
    pitch_h = math.degrees(gp_h) - chest_pitch - lean
    pitch_h = max(-45.0, min(55.0, pitch_h))
    Mn = Mc @ _rot(rel_h * 0.4, pitch_h * 0.35, 0.0)
    Mh = Mn @ _rot(rel_h * 0.6, pitch_h * 0.65, b["tilt"])  # torso rolls cancel (contrapposto): head stays level

    P = {}
    P["root"] = (g, g + fwd * 0.3 * s, up)
    pt = pelvis_c + Mp @ Vector((0, 0, 0.1 * s))
    P["pelvis"] = (pelvis_c, pt, Mp @ Vector((0, -1, 0)))
    st = pt + Ms @ Vector((0, 0, 0.2 * s))
    P["spine"] = (pt, st, Ms @ Vector((0, -1, 0)))
    ct = st + Mc @ Vector((0, 0, 0.2 * s))
    P["chest"] = (st, ct, Mc @ Vector((0, -1, 0)))
    nt = ct + Mn @ Vector((0, 0, 0.1 * s))
    P["neck"] = (ct, nt, Mn @ Vector((0, -1, 0)))
    P["head"] = (nt, nt + Mh @ Vector((0, 0, 0.2 * s)), Mh @ Vector((0, -1, 0)))
    P["_eye"] = nt + Mh @ Vector((0, -0.09 * s, 0.11 * s))

    for sd, sx in (("L", 1), ("R", -1)):
        # legs: hip -> ankle target, knee toward the travel/foot direction
        hip = pelvis_c + Mp @ Vector((0.1 * sx * s, 0, 0))
        ft = foot[sd]
        ankle = ft["pos"] + up * (0.08 * s + ft["lift"])
        ffwd = Matrix.Rotation(ft["yaw"], 3, "Z") @ Vector((0, -1, 0))
        pole = (fwd + ffwd).normalized()
        knee, ankle = _ik(hip, ankle, 0.43 * s, 0.44 * s, pole)
        P[f"thigh.{sd}"] = (hip, knee, pole)
        P[f"shin.{sd}"] = (knee, ankle, pole)
        P[f"foot.{sd}"] = (ankle, ankle + ffwd * 0.15 * s - up * 0.06 * s, up)

        # arms: default swing / preset / contact, all as a wrist target + IK
        sh = ct + Mc @ Vector((0.2 * sx * s, 0, -0.03 * s))
        d_leg = dR if sd == "L" else dL  # this arm swings with the opposite leg
        swing = math.degrees(math.atan2(d_leg, 0.9 * s)) * 0.9 * w["swing"] * fl["swing"]
        abd = fl["abduct"] + 3.0 * crouch / s
        up_dir = Mc @ (_rot(0, 0, -abd * sx) @ _rot(0, -swing, 0) @ Vector((0, 0, -1)))
        fo_dir = Mc @ (_rot(0, 0, -abd * sx) @ _rot(0, -(swing + fl["elbow"] + 0.5 * max(swing, 0)), 0) @ Vector((0, 0, -1)))
        wrist_fk = sh + up_dir * 0.293 * s + fo_dir * 0.251 * s
        target = _hand_target(f, sx, s, b["arms"], hand_events[sd], wrist_fk, pelvis_c, Mp, Mc, ct, nt, ease)
        apole = (Mc @ Vector((0.35 * sx, 1, -0.3))).normalized()
        elbow, wrist = _ik(sh, target, 0.293 * s, 0.251 * s, apole)
        hdir = (wrist - elbow).normalized()
        P[f"upper_arm.{sd}"] = (sh, elbow, apole)
        P[f"forearm.{sd}"] = (elbow, wrist, apole)
        P[f"hand.{sd}"] = (wrist, wrist + hdir * 0.17 * s, apole)
    return P


PRESETS = {  # wrist targets: (space, point at s = 1), x mirrored for the right hand
    "hips": ("pelvis", (0.2, 0.03, 0.08)),
    "front": ("pelvis", (0.04, -0.2, 0.02)),
    "crossed": ("chest", (-0.07, -0.17, -0.2)),  # wrist near the opposite elbow; the hand tucks under the other arm
    "face": ("neck", (0.04, -0.16, 0.02)),
    "reach": ("chest", (0.18, -0.55, 0.05)),
    "pocket": ("pelvis", (0.18, -0.02, -0.1)),
}


def _hand_target(f, sx, s, arms, events, wrist_fk, pelvis_c, Mp, Mc, chest_top, neck_top, ease):
    def resolve(t):
        if t is None or t == "rest":
            return wrist_fk
        if isinstance(t, str):
            space, p = PRESETS[t]
            p = Vector((p[0] * sx, p[1], p[2])) * s
            if space == "pelvis":
                return pelvis_c + Mp @ p
            if space == "chest":
                return chest_top + Mc @ p
            return neck_top + Mc @ p
        return R._point(t, f) if isinstance(t, bpy.types.Object) else Vector(t)

    if isinstance(arms, tuple):  # (from, to, u): the body track is blending between two arm presets
        a, b_, u = arms
        target = resolve(a).lerp(resolve(b_), u)
    else:
        target = resolve(arms)
    cur = target
    prev_val = None
    for at, t, d in sorted(events, key=lambda e: e[0]):
        if f < at:
            break
        u = ease(min(1.0, (f - at) / max(1, d)))
        new = resolve(t) if t is not None else target
        start = prev_val if prev_val is not None else target
        cur = start.lerp(new, u)
        prev_val = new if u >= 1.0 else cur
    return cur


def _ik(a, target, l1, l2, pole):
    """Two-bone IK: joint positions for a chain of lengths l1, l2 from a toward target, bending toward pole."""
    d = target - a
    dist = d.length
    reach = (l1 + l2) * 0.999
    if dist > reach:
        target = a + d.normalized() * reach
        dist = reach
    dist = max(dist, abs(l1 - l2) + 1e-4)
    u = d.normalized() if d.length > 1e-6 else Vector((0, 0, -1))
    v = pole - u * pole.dot(u)
    v = v.normalized() if v.length > 1e-6 else Vector((0, -1, 0))
    cos_a = max(-1.0, min(1.0, (l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist)))
    mid = a + u * (l1 * cos_a) + v * (l1 * math.sqrt(max(0.0, 1 - cos_a * cos_a)))
    return mid, a + u * dist


def _gaze(f, events, eye, hd, dur0, ease, wander):
    """World (yaw, pitch) of the gaze at frame f: 0 yaw = -Y, positive pitch = looking down. 'hold' freezes the
    direction reached at its frame; indirect Space adds a slow deterministic wander."""
    cur = _gaze_raw(f, events, eye, hd, dur0, ease)
    if wander:
        k = math.radians(wander)
        cur = (cur[0] + k * (0.7 * math.sin(f * 0.11) + 0.3 * math.sin(f * 0.37 + 1.1)),
               cur[1] + 0.5 * k * math.sin(f * 0.07 + 0.4))
    return cur


def _gaze_raw(f, events, eye, hd, dur0, ease):
    def angles(t):
        if t is None or t == "ahead":
            return hd, 0.0
        if t == "floor":
            return hd, math.radians(35)
        if t == "up":
            return hd, math.radians(-25)
        if t == "camera":
            t = bpy.context.scene.camera
            if t is None:
                raise ValueError('gaze "camera": create the camera (rig.camera) before rig.perform')
        p = R._point(t, max(f, bpy.context.scene.frame_start)) if isinstance(t, bpy.types.Object) else Vector(t)
        d = p - eye
        return math.atan2(d.x, -d.y), math.atan2(-d.z, max(1e-6, math.hypot(d.x, d.y)))

    cur = (hd, 0.0)
    for i, ev in enumerate(events):
        at, t = int(ev[0]), ev[1]
        d = ev[2] if len(ev) > 2 else dur0
        if f < at:
            break
        if t == "hold":
            cur = _gaze_raw(at, events[:i], eye, hd, dur0, ease)
            continue
        u = ease(min(1.0, (f - at) / max(1, d)))
        new = angles(t)
        cur = (cur[0] + _wrap(new[0] - cur[0]) * u, cur[1] + (new[1] - cur[1]) * u)
    return cur


# ---- root, heading, footsteps --------------------------------------------------------------------------------------

def _root_path(marks, start, fs, fe, fps):
    """Per-frame ground position. Each consecutive pair of marks with different positions is a walk (trapezoidal
    speed: accelerate, cruise, settle); a mark value can be a list of waypoints. Returns (pos, walking, segments)."""
    pos, walking, segs = {}, {}, []
    pts = [(fs, [start.to_2d()])]
    for f, p in marks:
        way = [Vector(p)] if isinstance(p[0], (int, float)) else [Vector(q) for q in p]
        pts.append((int(f), way))
    cur = start.to_2d()
    for f in range(fs, fe + 1):
        pos[f] = Vector((cur.x, cur.y, 0))
        walking[f] = False
    for (f0, w0), (f1, w1) in zip(pts, pts[1:]):
        a = w0[-1]
        poly = [a, *w1]
        L = sum((poly[i + 1] - poly[i]).length for i in range(len(poly) - 1))
        if L < 1e-3 or f1 <= f0:
            for f in range(max(f0, fs), fe + 1):
                pos[f] = Vector((*w1[-1], 0))
            continue
        segs.append((f0, f1, poly, L))
        T = f1 - f0
        ramp = min(0.5 * fps, T / 3)
        vmax = L / (T - ramp)
        for f in range(f0, fe + 1):
            t = min(f - f0, T)
            if t < ramp:
                d = 0.5 * vmax * t * t / ramp
            elif t <= T - ramp:
                d = 0.5 * vmax * ramp + vmax * (t - ramp)
            else:
                r = T - t
                d = L - 0.5 * vmax * r * r / ramp
            pos[f] = Vector((*_along(poly, d), 0))
            walking[f] = f0 <= f < f1
    return pos, walking, segs


def _along(poly, d):
    for i in range(len(poly) - 1):
        seg = (poly[i + 1] - poly[i]).length
        if d <= seg or i == len(poly) - 2:
            return poly[i].lerp(poly[i + 1], min(1.0, d / seg) if seg else 0.0)
        d -= seg
    return poly[-1]


def _headings(root, walking, facing_keys, h0, fs, fe, dur0, ease):
    """Heading per frame: the travel direction while walking (turning into it over the first steps), otherwise the
    last heading, changed by facing keys (degrees or a target to face)."""
    out = {}
    cur = h0
    keys = sorted((int(k[0]), k[1], k[2] if len(k) > 2 else dur0) for k in facing_keys)
    turn = None
    for f in range(fs, fe + 1):
        if walking[f]:
            nxt = root[min(fe, f + 6)] - root[f]
            if nxt.length > 1e-4:
                want = math.atan2(nxt.x, -nxt.y)
                cur = cur + _wrap(want - cur) * 0.35
            turn = None
        else:
            for k in keys:
                if k[0] == f:
                    tgt = k[1]
                    if not isinstance(tgt, (int, float)):
                        p = R._point(tgt, f) if isinstance(tgt, bpy.types.Object) else Vector(tgt)
                        d = p - root[f]
                        tgt_rad = math.atan2(d.x, -d.y)
                    else:
                        tgt_rad = math.radians(tgt)
                    turn = (f, cur, cur + _wrap(tgt_rad - cur), k[2])
            if turn:
                f0, a, b, d = turn
                cur = a + (b - a) * ease(min(1.0, (f - f0) / max(1, d)))
        out[f] = cur
    return out


def _footsteps(root, heading, segs, facing_keys, fs, fe, fps, s, dur0, eff):
    """Plan footsteps: returns {side: f(frame) -> {pos, yaw, lift, q}}. Stance feet are fixed in the world."""
    width = 0.1 * s
    lift_h = 0.08 * s * eff["weight"]["lift"]
    swings = {"L": [], "R": []}

    def plant(p, hd, side):
        left = Matrix.Rotation(hd, 3, "Z") @ Vector((1, 0, 0))
        return (Vector((p.x, p.y, 0)) + left * width * (1 if side == "L" else -1), hd)

    cur = {sd: plant(root[fs], heading[fs], sd) for sd in ("L", "R")}
    plan = []  # (frame, event)
    for f0, f1, poly, L in segs:
        plan.append((f0, ("walk", f0, f1, poly, L)))
    for k in facing_keys:
        plan.append((int(k[0]), ("turn", int(k[0]), k[2] if len(k) > 2 else dur0)))
    plan.sort(key=lambda e: e[0])
    lead = "R"
    for _, ev in plan:
        if ev[0] == "walk":
            _, f0, f1, poly, L = ev
            T = f1 - f0
            v = L / (T / fps)
            l = max(0.3, min(0.95, 0.35 + 0.28 * v)) * s
            n = max(1, round(L / l))
            l = L / n
            # distance travelled per frame, to time the steps
            dist = {f: _dist_along(poly, root[f]) for f in range(f0, min(fe, f1) + 1)}

            def frame_at(d):
                for f in range(f0, min(fe, f1) + 1):
                    if dist[f] >= d - 1e-6:
                        return f
                return min(fe, f1)

            side = lead
            last_end = f0
            for j in range(1, n + 2):
                closing = j == n + 1
                d_land = L if closing else j * l
                p = Vector((*_along(poly, d_land), 0))
                ahead = Vector((*_along(poly, min(L, d_land + 0.05)), 0)) - Vector((*_along(poly, max(0, d_land - 0.05)), 0))
                hd = math.atan2(ahead.x, -ahead.y) if ahead.length > 1e-6 else heading[min(fe, f1)]
                if closing:
                    start = max(last_end + 1, frame_at(L - 0.35 * l))
                    end = min(fe, f1 + round(0.25 * fps))
                else:
                    start = max(last_end + (1 if j > 1 else 0), frame_at(max(0.0, (j - 1.3) * l)))
                    end = frame_at((j - 0.5) * l)
                end = max(end, start + 3)
                new = plant(p, hd, side)
                swings[side].append((start, end, cur[side], new))
                cur[side] = new
                last_end = end
                side = "L" if side == "R" else "R"
            lead = side
        else:
            _, f, d = ev
            if f > fe:
                continue
            hd_new = heading[min(fe, f + d)]
            if abs(_wrap(hd_new - heading[f])) < math.radians(20):
                continue
            first = "L" if _wrap(hd_new - heading[f]) < 0 else "R"
            half = max(3, d // 2)
            for i, sd in enumerate((first, "R" if first == "L" else "L")):
                a = f + i * half
                new = plant(root[min(fe, a + half)], hd_new, sd)
                swings[sd].append((a, min(fe, a + half), cur[sd], new))
                cur[sd] = new

    def track(side):
        sw = sorted(swings[side], key=lambda e: e[0])
        start = plant(root[fs], heading[fs], side)

        def at(f):
            last = start
            for a, b, frm, to in sw:
                if f < a:
                    break
                if f <= b:
                    q = (f - a) / max(1, b - a)
                    e = q * q * (3 - 2 * q)
                    pos = frm[0].lerp(to[0], e)
                    yaw = frm[1] + _wrap(to[1] - frm[1]) * e
                    return {"pos": pos, "yaw": yaw, "lift": lift_h * math.sin(math.pi * q), "q": q}
                last = to
            return {"pos": last[0].copy(), "yaw": last[1], "lift": 0.0, "q": None}
        return at

    return {sd: track(sd) for sd in ("L", "R")}


def _dist_along(poly, p):
    """Distance along the polyline of its closest point to p (2D)."""
    best, acc, out = 1e9, 0.0, 0.0
    q = p.to_2d()
    for i in range(len(poly) - 1):
        a, b = poly[i], poly[i + 1]
        ab = b - a
        L = ab.length
        t = max(0.0, min(1.0, (q - a).dot(ab) / (L * L))) if L else 0.0
        dd = (a + ab * t - q).length
        if dd < best - 1e-9:
            best, out = dd, acc + t * L
        acc += L
    return out


def _track(events, fs, fe, dur0, ease, defaults):
    """Body track: numeric keys interpolate; 'weight' accepts L / R / both; 'arms' blends between presets."""
    def norm(v):
        v = dict(v)
        if "weight" in v and isinstance(v["weight"], str):
            v["weight"] = {"L": 1.0, "R": -1.0, "both": 0.0}[v["weight"]]
        return v

    evs = sorted(((int(e[0]), norm(e[1]), e[2] if len(e) > 2 else dur0) for e in events), key=lambda e: e[0])
    cache = {}

    def at(f):
        if f in cache:
            return cache[f]
        cur = dict(defaults)
        for a, vals, d in evs:
            if f < a:
                break
            u = ease(min(1.0, (f - a) / max(1, d)))
            for k, v in vals.items():
                if k == "arms":
                    prev = cur["arms"]
                    prev_to = prev[1] if isinstance(prev, tuple) else prev
                    cur["arms"] = v if u >= 1.0 else (prev_to, v, u)
                else:
                    cur[k] = cur.get(k, 0.0) + (v - cur.get(k, 0.0)) * u
        cache[f] = cur
        return cur
    return at


# ---- maths ---------------------------------------------------------------------------------------------------------

def _rot(yaw, pitch, roll):
    """Body-relative rotation in degrees: yaw about Z (+ = turning toward +X from -Y), pitch about X (+ = leaning
    forward / looking down), roll about Y (+ = top toward the subject's left)."""
    return (Matrix.Rotation(math.radians(yaw), 3, "Z") @ Matrix.Rotation(math.radians(pitch), 3, "X")
            @ Matrix.Rotation(math.radians(roll), 3, "Y"))


def _frame(direction, ref):
    y = direction.normalized()
    z = ref - y * ref.dot(y)
    if z.length < 1e-6:
        z = Vector((0, 0, 1)) - y * y.z
        if z.length < 1e-6:
            z = Vector((0, -1, 0))
    z.normalize()
    x = y.cross(z)
    return Matrix((x, y, z)).transposed()


def _wrap(a):
    return (a + math.pi) % (2 * math.pi) - math.pi
