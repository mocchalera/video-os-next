"""vos previz — runs INSIDE Blender (headless):

    Blender --factory-startup -b -P python/blender_previz.py -- --scene scene.py --out DIR \
        --width 1344 --height 768 --frames 124 --fps 24

The scene script is plain bpy code that builds objects, lights, a camera and its animation in an empty scene
(frames 1..N); `rig` (python/previz_rig.py: camera moves, lens / shot-size maths, a person proxy) is in its
namespace. This driver then renders two passes of the same camera:

  beauty  EEVEE with the scene's own materials (a clay-look layout pass: composition, blocking, light direction)
  depth   the same shot with a material override: emission = encoded camera distance, near = white, far/sky = black;
          default encoding is normalised disparity (1/z), the relative-depth convention depth ControlNets are trained
          on; the range is taken from the scene over the whole shot
  pose    only when the scene has actors (armatures with `vos_keypoints`): OpenPose body-18 skeletons on black, the
          format pose ControlNets are trained on; keypoints also go to DIR/pose.json

Output: DIR/beauty/####.png, DIR/depth/####.png, [DIR/pose/####.png] and DIR/previz.json (settings, depth range,
passes, timeline markers = performance beats, blender version).
Everything is deterministic (no noise, fixed samples), so the same scene script gives the same frames.
"""
import argparse
import json
import math
import os
import sys

import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
ap = argparse.ArgumentParser()
ap.add_argument("--scene", required=True)
ap.add_argument("--out", required=True)
ap.add_argument("--width", type=int, default=1344)
ap.add_argument("--height", type=int, default=768)
ap.add_argument("--frames", type=int, default=124)
ap.add_argument("--fps", type=int, default=24)
ap.add_argument("--near", type=float)
ap.add_argument("--far", type=float)
ap.add_argument("--depth-encoding", choices=["disparity", "log", "linear"], default="disparity")
a = ap.parse_args(argv)

# ---- empty scene, then the user's scene script
for ob in list(bpy.data.objects):
    bpy.data.objects.remove(ob, do_unlink=True)
sc = bpy.context.scene
sc.frame_start, sc.frame_end = 1, a.frames
sc.render.fps = a.fps
sc.render.resolution_x, sc.render.resolution_y = a.width, a.height
sc.render.resolution_percentage = 100
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import previz_rig  # noqa: E402  camera moves + scale proxies, exposed to the scene as `rig`

ns = {"bpy": bpy, "scene": sc, "frames": a.frames, "fps": a.fps, "width": a.width, "height": a.height, "rig": previz_rig,
      "__file__": os.path.abspath(a.scene)}
with open(a.scene) as f:
    exec(compile(f.read(), a.scene, "exec"), ns)
cam = sc.camera
if cam is None:
    raise SystemExit("previz: the scene script must set scene.camera")

engines = {e.identifier for e in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items}
sc.render.engine = "BLENDER_EEVEE" if "BLENDER_EEVEE" in engines else "BLENDER_EEVEE_NEXT"
try:
    sc.eevee.taa_render_samples = 16
except AttributeError:
    pass
sc.render.image_settings.file_format = "PNG"
sc.render.image_settings.color_mode = "RGB"
sc.view_settings.view_transform = "Standard"
sc.render.film_transparent = False


def depth_range():
    """Nearest / farthest visible geometry distance from the camera over the shot (bounding-box corners)."""
    near, far = math.inf, 0.0
    deps = bpy.context.evaluated_depsgraph_get()
    for fr in range(1, a.frames + 1, max(1, a.frames // 12)):
        sc.frame_set(fr)
        cm = cam.matrix_world
        fwd = -(cm.to_3x3() @ Vector((0, 0, 1))).normalized()
        for ob in sc.objects:
            if ob.type != "MESH":
                continue
            for c in ob.evaluated_get(deps).bound_box:
                v = ob.matrix_world @ Vector(c) - cm.translation
                z = v.dot(fwd)
                if z > 0.01:
                    near, far = min(near, z), max(far, z)
    if not math.isfinite(near):
        near, far = 0.1, 100.0
    return max(0.05, near * 0.9), far * 1.05


def depth_material(near, far, encoding):
    """Emission = encoded camera distance, near = white. 'disparity' (1/z, normalised) matches the relative depth maps
    (Depth Anything style) depth ControlNets are trained on; 'log' shows more mid-range gradation; 'linear' is raw."""
    m = bpy.data.materials.new("vos_depth")
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    cd = nt.nodes.new("ShaderNodeCameraData")
    mr = nt.nodes.new("ShaderNodeMapRange")
    mr.clamp = True
    src = cd.outputs["View Z Depth"]
    if encoding == "disparity":
        inv = nt.nodes.new("ShaderNodeMath")
        inv.operation = "DIVIDE"
        inv.inputs[0].default_value = 1.0
        nt.links.new(src, inv.inputs[1])
        src, lo, hi, to_lo, to_hi = inv.outputs[0], 1 / far, 1 / near, 0.0, 1.0
    elif encoding == "log":
        lg = nt.nodes.new("ShaderNodeMath")
        lg.operation = "LOGARITHM"
        lg.inputs[1].default_value = math.e
        nt.links.new(src, lg.inputs[0])
        src, lo, hi, to_lo, to_hi = lg.outputs[0], math.log(near), math.log(far), 1.0, 0.0
    else:
        lo, hi, to_lo, to_hi = near, far, 1.0, 0.0
    mr.inputs["From Min"].default_value = lo
    mr.inputs["From Max"].default_value = hi
    mr.inputs["To Min"].default_value = to_lo
    mr.inputs["To Max"].default_value = to_hi
    em = nt.nodes.new("ShaderNodeEmission")
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    nt.links.new(src, mr.inputs["Value"])
    nt.links.new(mr.outputs["Result"], em.inputs["Color"])
    nt.links.new(em.outputs["Emission"], out.inputs["Surface"])
    return m


def render(pass_name):
    d = os.path.join(a.out, pass_name)
    os.makedirs(d, exist_ok=True)
    sc.render.filepath = os.path.join(d, "")
    sc.render.use_file_extension = True
    bpy.ops.render.render(animation=True)


# OpenPose body-18: limb pairs and colours (as drawn by the common OpenPose / controlnet_aux renderers)
LIMBS = [(1, 2), (1, 5), (2, 3), (3, 4), (5, 6), (6, 7), (1, 8), (8, 9), (9, 10), (1, 11), (11, 12), (12, 13), (1, 0),
         (0, 14), (14, 16), (0, 15), (15, 17)]
COLORS = [(255, 0, 0), (255, 85, 0), (255, 170, 0), (255, 255, 0), (170, 255, 0), (85, 255, 0), (0, 255, 0),
          (0, 255, 85), (0, 255, 170), (0, 255, 255), (0, 170, 255), (0, 85, 255), (0, 0, 255), (85, 0, 255),
          (170, 0, 255), (255, 0, 255), (255, 0, 170), (255, 0, 85)]


def keypoints(arm):
    """Image-space OpenPose keypoints of one actor at the current frame: [(x_px, y_px) | None] * 18."""
    from bpy_extras.object_utils import world_to_camera_view as w2c
    spec = json.loads(arm["vos_keypoints"])
    cam_pos = cam.matrix_world.translation
    head = arm.pose.bones["head"]
    hm = arm.matrix_world @ head.matrix @ head.bone.matrix_local.inverted()
    fwd = (hm.to_3x3() @ Vector((0, -1, 0))).normalized()
    side = (hm.to_3x3() @ Vector((1, 0, 0))).normalized()
    out = []
    for bone, rest_p, vis in spec:
        pb = arm.pose.bones[bone]
        p = arm.matrix_world @ pb.matrix @ pb.bone.matrix_local.inverted() @ Vector(rest_p)
        to_cam = (cam_pos - p).normalized()
        if (vis == "front" and fwd.dot(to_cam) < 0.1) or (vis == "L" and side.dot(to_cam) < -0.3) or \
                (vis == "R" and side.dot(to_cam) > 0.3):
            out.append(None)
            continue
        v = w2c(sc, cam, p)
        out.append((v.x * a.width, (1 - v.y) * a.height) if v.z > 0 and -0.2 < v.x < 1.2 and -0.2 < v.y < 1.2 else None)
    return out


def draw_pose(people):
    import numpy as np
    h, w = a.height, a.width
    img = np.zeros((h, w, 3), dtype=np.float32)
    k = max(1.0, min(w, h) / 512)
    stick, dot = 4 * k, 4 * k
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32) + 0.5

    def fill(mask_fn, box, color):
        x0, y0, x1, y1 = (max(0, int(box[0])), max(0, int(box[1])), min(w, int(box[2]) + 1), min(h, int(box[3]) + 1))
        if x0 >= x1 or y0 >= y1:
            return
        m = mask_fn(xx[y0:y1, x0:x1], yy[y0:y1, x0:x1])
        img[y0:y1, x0:x1][m] = color

    for kp in people:
        for i, (p, q) in enumerate(LIMBS):
            if kp[p] is None or kp[q] is None:
                continue
            (ax, ay), (bx, by) = kp[p], kp[q]
            c = [0.6 * v / 255 for v in COLORS[i]]
            dx, dy = bx - ax, by - ay
            ll = max(1e-6, dx * dx + dy * dy)

            def seg(X, Y, ax=ax, ay=ay, dx=dx, dy=dy, ll=ll):
                t = np.clip(((X - ax) * dx + (Y - ay) * dy) / ll, 0, 1)
                return (X - ax - t * dx) ** 2 + (Y - ay - t * dy) ** 2 <= stick * stick
            fill(seg, (min(ax, bx) - stick, min(ay, by) - stick, max(ax, bx) + stick, max(ay, by) + stick), c)
        for i, pt in enumerate(kp):
            if pt is None:
                continue
            x, y = pt
            fill(lambda X, Y, x=x, y=y: (X - x) ** 2 + (Y - y) ** 2 <= dot * dot, (x - dot, y - dot, x + dot, y + dot),
                 [v / 255 for v in COLORS[i]])
    return img


def render_pose(actors):
    import numpy as np
    d = os.path.join(a.out, "pose")
    os.makedirs(d, exist_ok=True)
    im = bpy.data.images.new("vos_pose", a.width, a.height, alpha=False)
    frames_kp = {}
    for fr in range(1, a.frames + 1):
        sc.frame_set(fr)
        people = [keypoints(arm) for arm in actors]
        frames_kp[fr] = {arm["vos_actor"]: [list(map(lambda v: round(v, 1), p)) if p else None for p in kp]
                         for arm, kp in zip(actors, people)}
        rgb = draw_pose(people)[::-1]  # Blender images are stored bottom row first
        rgba = np.concatenate([rgb, np.ones((a.height, a.width, 1), dtype=np.float32)], axis=2)
        im.pixels.foreach_set(rgba.ravel())
        im.filepath_raw = os.path.join(d, f"{fr:04d}.png")
        im.file_format = "PNG"
        im.save()
    with open(os.path.join(a.out, "pose.json"), "w") as f:
        json.dump({"format": "vos.previz-pose/1", "keypoints": "openpose-body18", "frames": frames_kp}, f)


near, far = (a.near, a.far) if a.near and a.far else depth_range()
render("beauty")
vl = bpy.context.view_layer
world = sc.world
sc.world = None  # background = black = infinitely far
vl.material_override = depth_material(near, far, a.depth_encoding)
sc.view_settings.view_transform = "Standard"
render("depth")
vl.material_override = None
sc.world = world
passes = ["beauty", "depth"]
actors = [ob for ob in sc.objects if ob.type == "ARMATURE" and "vos_keypoints" in ob]
if actors:
    render_pose(actors)
    passes.append("pose")
markers = sorted(({"frame": m.frame, "sec": round((m.frame - 1) / a.fps, 3), "label": m.name} for m in sc.timeline_markers),
                 key=lambda m: m["frame"])
# external files the scene read (e.g. motion takes via previz_motion.load_bvh): part of the cache check in vos
inputs = list(getattr(sys.modules.get("previz_motion"), "INPUTS", []))
with open(os.path.join(a.out, "previz.json"), "w") as f:
    json.dump({"format": "vos.previz/1", "blender": bpy.app.version_string, "engine": sc.render.engine,
               "width": a.width, "height": a.height, "frames": a.frames, "fps": a.fps, "passes": passes, "markers": markers,
               "inputs": inputs,
               "depth": {"near": round(near, 4), "far": round(far, 4), "encoding": f"{a.depth_encoding}, near=white, clamped"}}, f)
print("previz: done", a.out)
