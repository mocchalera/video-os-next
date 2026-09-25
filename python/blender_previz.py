"""vos previz — runs INSIDE Blender (headless):

    Blender --factory-startup -b -P python/blender_previz.py -- --scene scene.py --out DIR \
        --width 1344 --height 768 --frames 124 --fps 24

The scene script is plain bpy code that builds objects, lights, a camera and its animation in an empty scene
(frames 1..N). This driver then renders two passes of the same camera:

  beauty  EEVEE with the scene's own materials (a clay-look layout pass: composition, blocking, light direction)
  depth   the same shot with a material override: emission = encoded camera distance, near = white, far/sky = black;
          default encoding is normalised disparity (1/z), the relative-depth convention depth ControlNets are trained
          on; the range is taken from the scene over the whole shot

Output: DIR/beauty/####.png, DIR/depth/####.png and DIR/previz.json (settings, depth range, blender version).
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
ns = {"bpy": bpy, "scene": sc, "frames": a.frames, "fps": a.fps, "width": a.width, "height": a.height,
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
with open(os.path.join(a.out, "previz.json"), "w") as f:
    json.dump({"format": "vos.previz/1", "blender": bpy.app.version_string, "engine": sc.render.engine,
               "width": a.width, "height": a.height, "frames": a.frames, "fps": a.fps,
               "depth": {"near": round(near, 4), "far": round(far, 4), "encoding": f"{a.depth_encoding}, near=white, clamped"}}, f)
print("previz: done", a.out)
