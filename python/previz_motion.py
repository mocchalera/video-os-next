"""vos previz motion — put captured / generated whole-body motion (e.g. NVIDIA Kimodo BVH, SOMA skeleton) on a
`rig.actor` clay person, for blocking: where people stand, walk, turn, sit; not hands or fingers.

    import previz_motion as motion
    A = rig.actor("A", at=(0, 2, 0), facing=0)
    m = motion.load_bvh("/abs/path/walk_00.bvh")          # Kimodo: kimodo_gen ... --bvh (30 fps, cm, Y up)
    motion.apply(A, m, start=1, at=(0, 2, 0), facing=0)    # start frame, place + turn the take, then key every frame

Retargeting is by direction: each actor bone points where the matching source segment points (pelvis, spine, chest,
neck, head, arms, legs, feet); the actor keeps its own bone lengths, so the clay body never stretches. The root follows
the source hips projected to the ground; height is scaled from the source hip height to the actor's. The take is
turned so its first heading equals `facing` (0 = -Y) and moved so its first ground point is `at`. Frames are resampled
by time (source fps -> scene fps), held after the end. Deterministic: same file + arguments -> same keys.

The parser (`parse_bvh`, `positions`) is plain Python + numpy so it can be tested outside Blender.
Limits: the actor's legs are not IK-fitted to the source feet (small slides/penetration remain when proportions
differ), fingers are ignored, one take per call (call again with another start for a sequence).
"""
import json
import math

import numpy as np

# SOMA (Kimodo) joint names: actor bone -> (from joint, to joint)
SOMA = {
    "pelvis": ("Hips", "Spine2"),
    "spine": ("Spine2", "Chest"),
    "chest": ("Chest", "Neck1"),
    "neck": ("Neck1", "Head"),
    "head": ("Head", "HeadEnd"),
    "upper_arm.L": ("LeftArm", "LeftForeArm"),
    "forearm.L": ("LeftForeArm", "LeftHand"),
    "hand.L": ("LeftHand", "LeftHandMiddle1"),
    "thigh.L": ("LeftLeg", "LeftShin"),
    "shin.L": ("LeftShin", "LeftFoot"),
    "foot.L": ("LeftFoot", "LeftToeBase"),
    "upper_arm.R": ("RightArm", "RightForeArm"),
    "forearm.R": ("RightForeArm", "RightHand"),
    "hand.R": ("RightHand", "RightHandMiddle1"),
    "thigh.R": ("RightLeg", "RightShin"),
    "shin.R": ("RightShin", "RightFoot"),
    "foot.R": ("RightFoot", "RightToeBase"),
}
# BVH (Y up, +Z forward, +X = subject's left, cm) -> Blender (Z up, -Y forward, +X = subject's left, m)
_AXES = np.array([[1.0, 0, 0], [0, 0, -1.0], [0, 1.0, 0]])


# ---- parsing (no Blender) ------------------------------------------------------------------------------------------

def parse_bvh(text):
    """BVH text -> {"joints": [(name, parent_index, offset(3), channels[list])], "frame_time": s, "frames": ndarray}."""
    tok = text.split()
    i, joints, stack = 0, [], []
    while tok[i] != "MOTION":
        t = tok[i]
        if t in ("ROOT", "JOINT"):
            joints.append([tok[i + 1], stack[-1] if stack else -1, None, []])
            i += 2
        elif t == "End":   # End Site: no channels, not a joint we key
            depth = 0
            while True:
                i += 1
                if tok[i] == "{":
                    depth += 1
                elif tok[i] == "}":
                    depth -= 1
                    if depth == 0:
                        break
            i += 1
        elif t == "{":
            stack.append(len(joints) - 1)
            i += 1
        elif t == "}":
            stack.pop()
            i += 1
        elif t == "OFFSET":
            joints[-1][2] = [float(x) for x in tok[i + 1:i + 4]]
            i += 4
        elif t == "CHANNELS":
            n = int(tok[i + 1])
            joints[-1][3] = tok[i + 2:i + 2 + n]
            i += 2 + n
        else:
            i += 1
    n_frames = int(tok[tok.index("Frames:", i) + 1])
    j = tok.index("Time:", i)
    frame_time = float(tok[j + 1])
    vals = np.array([float(x) for x in tok[j + 2:]], dtype=np.float64)
    width = sum(len(jt[3]) for jt in joints)
    if vals.size != n_frames * width:
        raise ValueError(f"BVH motion has {vals.size} values, expected {n_frames} x {width}")
    return {"joints": [tuple(jt) for jt in joints], "frame_time": frame_time, "frames": vals.reshape(n_frames, width)}


def _rot(axis, deg):
    a = math.radians(deg)
    c, s = math.cos(a), math.sin(a)
    if axis == "X":
        return np.array([[1, 0, 0], [0, c, -s], [0, s, c]])
    if axis == "Y":
        return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])
    return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])


def positions(bvh, unit=0.01):
    """World joint positions per frame, in Blender axes and metres: {name: ndarray (frames, 3)}."""
    joints, frames = bvh["joints"], bvh["frames"]
    nf = frames.shape[0]
    out = {name: np.zeros((nf, 3)) for name, *_ in joints}
    for f in range(nf):
        col = 0
        R, T = [None] * len(joints), [None] * len(joints)
        for k, (name, parent, offset, chans) in enumerate(joints):
            loc = np.array(offset, dtype=np.float64)
            rot = np.eye(3)
            for c in chans:
                v = frames[f, col]
                col += 1
                if c.endswith("position"):
                    loc[" XYZ".index(c[0]) - 1] = v if parent < 0 else loc[" XYZ".index(c[0]) - 1] + v
                else:
                    rot = rot @ _rot(c[0], v)
            if parent < 0:
                R[k], T[k] = rot, loc
            else:
                R[k] = R[parent] @ rot
                T[k] = T[parent] + R[parent] @ loc
            out[name][f] = _AXES @ T[k] * unit
    return out


INPUTS = []   # files read by this render: the driver writes them to previz.json so vos re-renders when they change


def load_bvh(path):
    import hashlib
    import os
    with open(path, "rb") as fh:
        raw = fh.read()
    INPUTS.append({"path": os.path.abspath(path), "sha256": hashlib.sha256(raw).hexdigest()})
    bvh = parse_bvh(raw.decode())
    return {"path": str(path), "fps": 1.0 / bvh["frame_time"], "pos": positions(bvh), "frames": bvh["frames"].shape[0]}


def sample(m, t):
    """Joint positions at time t (s), linear between source frames, held at the ends."""
    x = min(max(t * m["fps"], 0.0), m["frames"] - 1.0)
    a = int(math.floor(x))
    b = min(a + 1, m["frames"] - 1)
    w = x - a
    return {n: p[a] * (1 - w) + p[b] * w for n, p in m["pos"].items()}


def blocking_constraints(start, facing, marks, scene_fps=24, src_fps=30.0, start_frame=1):
    """Previz blocking -> Kimodo `root2d` constraints (kimodo_gen --constraints file.json).

    start: (x, y) where the take begins (scene metres); facing: its heading in degrees (0 = -Y, like rig.actor);
    marks: [(scene_frame, (x, y)), ...] — be there at that frame. Kimodo's frame 0 is `start_frame`; its canonical
    space starts at the origin facing +Z with +X = the subject's left (metres)."""
    a = math.radians(facing)
    fwd = (math.sin(a), -math.cos(a))          # scene direction of facing
    left = (-fwd[1], fwd[0])                   # 90 deg counter-clockwise from forward = the subject's left
    idx, pts = [0], [[0.0, 0.0]]
    for f, (x, y) in marks:
        dx, dy = x - start[0], y - start[1]
        k = round((f - start_frame) / scene_fps * src_fps)
        if k <= 0:
            continue
        idx.append(int(k))
        pts.append([round(dx * left[0] + dy * left[1], 4), round(dx * fwd[0] + dy * fwd[1], 4)])   # [x=left, z=forward]
    return [{"type": "root2d", "frame_indices": idx, "smooth_root_2d": pts}]


def _unit(v):
    n = np.linalg.norm(v)
    return v / n if n > 1e-9 else v


def body_frame(P):
    """Forward (horizontal) and up of a pose: forward = left x up, left from the hips."""
    up = np.array([0.0, 0, 1])
    left = P["LeftLeg"] - P["RightLeg"]
    fwd = np.cross(left, up)
    fwd[2] = 0
    return _unit(fwd), up


# ---- applying (inside Blender) -------------------------------------------------------------------------------------

def apply(arm, m, start=None, at=None, facing=None, speed=1.0, align="heading"):
    """Key a rig.actor() armature from motion `m` (load_bvh) from scene frame `start` to the end of the scene.

    align="heading": turn the take so its first body heading equals `facing` and put its first hip position at `at`
    (free takes). align="canonical": keep Kimodo's canonical frame (origin, +Z forward) mapped onto `at` / `facing`,
    so root2d constraints made by blocking_constraints(at, facing, marks) land exactly on the marks."""
    import bpy
    from mathutils import Matrix, Vector

    import previz_actor as A

    sc = bpy.context.scene
    fs, fe, fps = sc.frame_start, sc.frame_end, sc.render.fps
    start = fs if start is None else int(start)
    s = arm["vos_scale"]
    at0, facing0 = json.loads(arm["vos_start"])
    at = Vector(at0 if at is None else at)
    facing = facing0 if facing is None else facing

    # placement: scale by hip height, turn the first heading onto `facing`, move the first ground point onto `at`
    P0 = sample(m, 0.0)
    ground = min(min(m["pos"][k][:, 2].min() for k in ("LeftToeBase", "RightToeBase", "LeftFoot", "RightFoot")), P0["Hips"][2])
    k = 0.95 * s / max(1e-6, P0["Hips"][2] - ground)
    want = np.array([math.sin(math.radians(facing)), -math.cos(math.radians(facing)), 0.0])   # facing 0 = -Y
    if align == "canonical":
        f0, origin = np.array([0.0, -1.0, 0.0]), np.array([0.0, 0.0, ground])   # Kimodo +Z forward -> -Y here
    else:
        f0, _ = body_frame(P0)
        origin = np.array([P0["Hips"][0], P0["Hips"][1], ground])
    yaw = math.atan2(f0[0] * want[1] - f0[1] * want[0], f0[0] * want[0] + f0[1] * want[1])
    Rz = np.array([[math.cos(yaw), -math.sin(yaw), 0], [math.sin(yaw), math.cos(yaw), 0], [0, 0, 1]])

    kh = 1.0 if align == "canonical" else k   # canonical takes keep ground metres so the marks stay where they were set

    def place(p):
        q = Rz @ (p - origin)
        q = np.array([q[0] * kh, q[1] * kh, q[2] * k])
        return Vector((q[0] + at.x, q[1] + at.y, q[2] + at.z))

    pb = arm.pose.bones
    rest = {b.name: b.matrix_local.copy() for b in arm.data.bones}
    frames_rest = {n: A._frame(Vector(t) - Vector(h), A.REFS[r]) for n, _, h, t, r in A.BONES}
    eyes = {}
    for f in range(fs, fe + 1):
        P = sample(m, max(0.0, (f - start) / fps * speed))
        W = {n: place(p) for n, p in P.items()}
        fwd_np, _ = body_frame({n: Rz @ p for n, p in P.items()})
        fwd = Vector(fwd_np)
        up = Vector((0, 0, 1))
        shoulders = (W["LeftArm"] - W["RightArm"]).cross(up)
        chest_fwd = Vector((shoulders.x, shoulders.y, 0)).normalized() if shoulders.length > 1e-6 else fwd
        eye_mid = (W["LeftEye"] + W["RightEye"]) / 2
        head_fwd = eye_mid - W["Head"]
        refs = {"root": up, "pelvis": fwd, "spine": chest_fwd, "chest": chest_fwd, "neck": head_fwd, "head": head_fwd}
        for sd, side in (("L", "Left"), ("R", "Right")):
            pinky = W[f"{side}HandPinky1"] - W[f"{side}HandIndex1"]
            refs.update({f"upper_arm.{sd}": -chest_fwd, f"forearm.{sd}": pinky, f"hand.{sd}": pinky,
                         f"thigh.{sd}": fwd, f"shin.{sd}": fwd, f"foot.{sd}": up})
        # world pose matrices, parent first: directions from the source, lengths from the actor
        M = {}
        for n, parent, *_ in A.BONES:
            if n == "root":
                h = Vector((W["Hips"].x, W["Hips"].y, at.z))
                d = fwd
            else:
                a_, b_ = SOMA[n]
                d = W[b_] - W[a_]
                if n == "pelvis":
                    h = W["Hips"].copy()
                else:
                    off = rest[parent].inverted() @ rest[n].translation
                    h = M[parent] @ off
            Q = A._frame(d, refs[n]) @ frames_rest[n].transposed()
            mtx = Q.to_4x4() @ rest[n].to_3x3().to_4x4()
            mtx.translation = h
            M[n] = mtx
            if parent:
                basis = (rest[parent].inverted() @ rest[n]).inverted() @ M[parent].inverted() @ mtx
            else:
                basis = rest[n].inverted() @ mtx
            pb[n].matrix_basis = basis
            pb[n].keyframe_insert("location", frame=f)
            pb[n].keyframe_insert("rotation_quaternion", frame=f)
        eyes[f] = M["head"] @ Vector((0, 0.07 * s, 0))   # actor eye height: 7 cm up the head bone
    A._EYES[arm.name] = eyes   # cameras and other actors can look at / follow this actor (rig.eye, eye_at)
    sc.frame_set(fs)
    return arm
