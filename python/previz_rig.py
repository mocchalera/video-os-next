"""vos previz rig — camera moves and scale proxies for previz scene scripts (available there as `rig`).

World convention (same as examples/previz/alley.py): metres, Z up, +Y is "into the scene". A camera at negative Y
looking toward +Y sees the set; a person with facing=0 faces -Y, i.e. toward that camera.

Every move is baked as one key per frame (no interpolation between keys matters: previz renders integer frames only),
so the result is deterministic, version-independent and any easing is exact. Later calls on the same object overwrite
earlier keys only inside their `span`.

    cam = rig.camera(lens=35, at=(0, -6, 1.6), look=(0, 0, 1.5))
    hero = rig.person(at=(0, 0, 0))
    d, z = rig.framing(hero, "MS", 40)                                              # distance + aim for a waist-up shot
    rig.move(cam, [(0, -6, 1.6), (0, -2.5, 1.6)], look=hero)                        # push-in
    rig.dolly_zoom(cam, hero, distances=(2.0, 6.0), lens=28)                        # vertigo
    rig.orbit(cam, center=hero, radius=3, height=1.6, degrees=(-30, 60), lens=50)   # arc
    rig.move(cam, [(0, -5, 0.6), (0, -5, 4.5)], look=hero, span=(24, frames))       # crane up after a 1 s hold
"""
import math

import bpy
from mathutils import Euler, Quaternion, Vector

CLAY = (0.62, 0.6, 0.57)
DARK = (0.35, 0.34, 0.33)
SENSOR_MM = 36.0

# Visible vertical extent (metres) that defines each shot size for a standing adult; approximate, for a first placement.
SHOT_SIZES = {
    "ECU": 0.15,  # extreme close-up: eyes / mouth
    "CU": 0.35,   # close-up: head, top of shoulders
    "MCU": 0.6,   # medium close-up: chest up
    "MS": 0.95,   # medium: waist up
    "MLS": 1.35,  # medium long / cowboy: knees up
    "FS": 2.1,    # full shot: whole body with head- and foot-room
    "WS": 4.5,    # wide: person small in the setting
}

EASES = {
    "linear": lambda u: u,
    "in": lambda u: u * u * u,
    "out": lambda u: 1 - (1 - u) ** 3,
    "inout": lambda u: u * u * (3 - 2 * u),
    "inout-strong": lambda u: u * u * u * (u * (6 * u - 15) + 10),
}


def _scene():
    return bpy.context.scene


def _frames():
    sc = _scene()
    return sc.frame_start, sc.frame_end


def _material(name, color):
    m = bpy.data.materials.new(name + "_mat")
    m.diffuse_color = (*color, 1)
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        bsdf.inputs["Base Color"].default_value = (*color, 1)
    return m


def box(name, at, size, color=CLAY):
    """An axis-aligned box: `at` is its centre, `size` its full (x, y, z) extent in metres."""
    bpy.ops.mesh.primitive_cube_add(location=at)
    ob = bpy.context.object
    ob.name = name
    ob.scale = (size[0] / 2, size[1] / 2, size[2] / 2)
    ob.data.materials.append(_material(name, color))
    return ob


def person(at=(0, 0, 0), height=1.7, facing=0.0, color=CLAY, name="person"):
    """A clay stand-in for a standing adult (feet at `at`). facing: degrees about Z, 0 = facing -Y (toward a camera
    placed at negative Y), 90 = facing +X. The nose block shows the facing in the beauty pass. Returns the root empty;
    move it with walk(). eye(person) gives the eye point."""
    s = height / 1.7
    root = bpy.data.objects.new(name, None)
    _scene().collection.objects.link(root)
    root.location = at
    root.rotation_euler = (0, 0, math.radians(facing))
    root["vos_eye_height"] = 1.58 * s
    parts = [
        ("legs", (0, 0, 0.41 * s), (0.32 * s, 0.2 * s, 0.82 * s)),
        ("hips", (0, 0, 0.92 * s), (0.36 * s, 0.22 * s, 0.2 * s)),     # waist line at ~1.02 m: reads MS vs MCU
        ("chest", (0, 0, 1.23 * s), (0.46 * s, 0.25 * s, 0.42 * s)),   # shoulders at ~1.44 m
        ("neck", (0, 0, 1.46 * s), (0.1 * s, 0.1 * s, 0.1 * s)),
        ("nose", (0, -0.11 * s, 1.56 * s), (0.04 * s, 0.05 * s, 0.05 * s)),
    ]
    mat = _material(name, color)
    for part, loc, size in parts:
        ob = box(f"{name}_{part}", loc, size, color)
        ob.data.materials.clear()
        ob.data.materials.append(mat)
        ob.parent = root
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.115 * s, location=(0, 0, 1.6 * s), segments=24, ring_count=12)
    head = bpy.context.object
    head.name = f"{name}_head"
    head.data.materials.append(mat)
    head.parent = root
    return root


def eye(ob):
    """World-space eye point of a person() (at the current frame); for other objects, their origin."""
    m = ob.matrix_world
    return m @ Vector((0, 0, ob.get("vos_eye_height", 0.0)))


def camera(lens=35.0, at=(0, -6, 1.6), look=(0, 0, 1.5), roll=0.0, name="cam"):
    """A camera with a 36 mm-wide sensor fitted horizontally (so lens mm mean the same as on a full-frame body in any
    aspect ratio), aimed at `look` (a point or an object), made the scene camera."""
    data = bpy.data.cameras.new(name)
    data.lens = lens
    data.sensor_width = SENSOR_MM
    data.sensor_fit = "HORIZONTAL"
    data.clip_start, data.clip_end = 0.05, 500
    cam = bpy.data.objects.new(name, data)
    _scene().collection.objects.link(cam)
    cam.location = at
    cam.rotation_euler = _aim(Vector(at), _point(look), roll)
    _scene().camera = cam
    return cam


def vertical_fov_mm():
    sc = _scene()
    return SENSOR_MM * sc.render.resolution_y / sc.render.resolution_x


def shot_distance(size, lens, subject_height=1.7):
    """Camera-to-subject distance (metres) that frames `size` (a SHOT_SIZES key or a visible height in metres) with
    this lens at the scene's aspect ratio. A starting value; judge the framing on the beauty pass."""
    h = SHOT_SIZES[size] * subject_height / 1.7 if isinstance(size, str) else float(size)
    return h * lens / vertical_fov_mm()


def framing(subject, size, lens, height=None):
    """(distance, aim_z) that frame a person() at `size` with this lens: the distance from shot_distance(), and an aim
    height that leaves ~10 % headroom above the head (ECU: centred on the eyes). Put the camera `distance` in front of
    the subject and aim at (subject x, subject y, aim_z); pass `height` to know where the camera sits (default: aim)."""
    tall = subject.get("vos_eye_height", 1.58) / 1.58 * 1.7
    visible = SHOT_SIZES[size] * tall / 1.7 if isinstance(size, str) else float(size)
    d = shot_distance(visible, lens)
    top = subject.matrix_world.translation.z + tall
    aim_z = eye(subject).z if visible < 0.3 else top + 0.1 * visible - visible / 2
    return d, aim_z


# ---- moves ---------------------------------------------------------------------------------------------------------

def move(cam, path, look=None, lens=None, roll=None, ease="inout", span=None, shake=0.0):
    """Move along `path` (2+ points; 3+ are joined by a smooth curve travelled at even speed), aiming at `look`
    (a point, an object — followed if it moves — or a list of points travelled with the move; None keeps the
    current rotation). lens / roll: a number, or (from, to) for a zoom / a roll change. span=(f0, f1) limits the move
    to those frames (holds before and after). shake: handheld wobble amplitude in degrees (deterministic)."""
    pos = _curve([Vector(p) for p in path])
    aim = _looker(look)
    base = cam.rotation_euler.copy()

    def at(u, f):
        p = pos(u)
        rot = _aim(p, aim(u, f), _lerp(roll, u, 0.0)) if aim else base
        return p, rot, _lerp(lens, u, None)

    _bake(cam, at, ease, span, shake)
    return cam


def orbit(cam, center, radius, height, degrees=(0, 90), look=None, lens=None, roll=None, ease="inout", span=None, shake=0.0):
    """Arc around `center` (a point or an object) at `radius` and camera `height`. degrees: (from, to) about Z,
    0 = camera on the -Y side, positive = counter-clockwise seen from above. look defaults to the centre (the eye of a
    person())."""
    c = lambda f: _point(center, f)
    aim = _looker(look if look is not None else center)
    a0, a1 = map(math.radians, degrees)

    def at(u, f):
        a = a0 + (a1 - a0) * u
        cc = c(f)
        p = Vector((cc.x + radius * math.sin(a), cc.y - radius * math.cos(a), height))
        return p, _aim(p, aim(u, f), _lerp(roll, u, 0.0)), _lerp(lens, u, None)

    _bake(cam, at, ease, span, shake)
    return cam


def dolly_zoom(cam, subject, distances=(2.0, 6.0), lens=28.0, heading=(0, -1, 0), height=None, ease="inout", span=None):
    """Vertigo / dolly zoom: the camera travels from distances[0] to distances[1] from the subject along `heading`
    (direction from subject to camera) while the focal length changes in proportion, so the subject keeps its size and
    only the perspective changes: moving away while zooming in flattens the space and the background looms up behind
    the subject; moving in while zooming out stretches the space and the background falls away. lens is the focal
    length at distances[0]."""
    d0, d1 = distances
    hdg = Vector(heading).normalized()

    def at(u, f):
        tgt = _point(subject, f)
        d = d0 + (d1 - d0) * u
        p = tgt + hdg * d
        if height is not None:
            p.z = height
        return p, _aim(p, tgt, 0.0), lens * d / d0

    _bake(cam, at, ease, span, 0.0)
    return cam


def walk(ob, path, ease="linear", span=None):
    """Move an object (e.g. a person()) along `path` on the ground; it turns to face its direction of travel."""
    pos = _curve([Vector(p) for p in path])

    def at(u, f):
        p = pos(u)
        q = pos(min(1.0, u + 1e-3)) - pos(max(0.0, u - 1e-3))
        rot = Euler((0, 0, math.atan2(q.x, -q.y))) if q.length > 1e-6 else ob.rotation_euler.copy()
        return p, rot, None

    _bake(ob, at, ease, span, 0.0)
    return ob


# ---- internals -----------------------------------------------------------------------------------------------------

def _point(x, frame=None):
    if isinstance(x, bpy.types.Object):
        if frame is not None and _scene().frame_current != frame:
            _scene().frame_set(frame)
        else:
            bpy.context.view_layer.update()  # matrix_world of just-created objects is stale until an update
        return eye(x) if "vos_eye_height" in x else x.matrix_world.translation.copy()
    return Vector(x)


def _looker(look):
    if look is None:
        return None
    if isinstance(look, (list, tuple)) and look and isinstance(look[0], (list, tuple, Vector)):
        c = _curve([Vector(p) for p in look])
        return lambda u, f: c(u)
    return lambda u, f: _point(look, f)


def _aim(frm, to, roll_deg):
    d = to - frm
    if d.length < 1e-6:
        d = Vector((0, 1, 0))
    q = d.to_track_quat("-Z", "Y")
    if roll_deg:
        q = q @ Quaternion((0, 0, 1), math.radians(roll_deg))
    return q.to_euler()


def _lerp(v, u, default):
    if v is None:
        return default
    if isinstance(v, (list, tuple)):
        return v[0] + (v[1] - v[0]) * u
    return v


def _curve(pts):
    """u in [0, 1] -> point: straight for 2 points, Catmull-Rom through 3+, re-parameterised by arc length."""
    if len(pts) < 2:
        raise ValueError("a path needs at least 2 points")
    if len(pts) == 2:
        a, b = pts
        return lambda u: a.lerp(b, u)
    ext = [pts[0] * 2 - pts[1], *pts, pts[-1] * 2 - pts[-2]]

    def cr(t):
        n = len(pts) - 1
        i = min(int(t * n), n - 1)
        s = t * n - i
        p0, p1, p2, p3 = ext[i], ext[i + 1], ext[i + 2], ext[i + 3]
        return 0.5 * ((2 * p1) + (-p0 + p2) * s + (2 * p0 - 5 * p1 + 4 * p2 - p3) * s * s + (-p0 + 3 * p1 - 3 * p2 + p3) * s ** 3)

    samples = [cr(i / 400) for i in range(401)]
    acc = [0.0]
    for i in range(1, len(samples)):
        acc.append(acc[-1] + (samples[i] - samples[i - 1]).length)
    total = acc[-1] or 1.0

    def at(u):
        target = u * total
        lo, hi = 0, len(acc) - 1
        while hi - lo > 1:
            mid = (lo + hi) // 2
            lo, hi = (mid, hi) if acc[mid] <= target else (lo, mid)
        seg = acc[hi] - acc[lo]
        return samples[lo].lerp(samples[hi], (target - acc[lo]) / seg if seg else 0.0)

    return at


def _shake(f, amp):
    """Deterministic handheld wobble (degrees -> radians offsets on pitch, yaw, roll)."""
    k = math.radians(amp)
    w = lambda a, b, c: k * (0.6 * math.sin(f * a) + 0.3 * math.sin(f * b + 1.3) + 0.1 * math.sin(f * c + 2.1))
    return Vector((w(0.31, 0.83, 2.1), w(0.23, 0.71, 1.7), 0.5 * w(0.17, 0.59, 1.3)))


def _bake(ob, at, ease, span, shake):
    fs, fe = _frames()
    f0, f1 = span if span else (fs, fe)
    f0, f1 = max(fs, int(f0)), min(fe, int(f1))
    e = EASES[ease] if isinstance(ease, str) else ease
    prev = None
    for f in range(f0, f1 + 1):  # keys only inside the span; Blender holds the end values outside it
        u = 0.0 if f1 == f0 else min(1.0, max(0.0, (f - f0) / (f1 - f0)))
        p, rot, lens = at(e(u), f)
        rot = rot.to_quaternion().to_euler("XYZ", prev) if prev is not None else rot
        if shake:
            s = _shake(f, shake)
            rot = Euler((rot.x + s.x, rot.y + s.z, rot.z + s.y), "XYZ")
        ob.location = p
        ob.rotation_euler = rot
        ob.keyframe_insert("location", frame=f)
        ob.keyframe_insert("rotation_euler", frame=f)
        if lens is not None and ob.type == "CAMERA":
            ob.data.lens = lens
            ob.data.keyframe_insert("lens", frame=f)
        prev = rot
    _scene().frame_set(fs)
