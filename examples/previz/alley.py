# vos previz scene: a narrow alley, camera dollies forward past a doorway toward a lit corner.
# Plain bpy. Available names: bpy, scene, frames, fps, width, height. Units are metres; frames run 1..frames.
import math

import bpy


def box(name, loc, size, color):
    bpy.ops.mesh.primitive_cube_add(location=loc)
    ob = bpy.context.object
    ob.name = name
    ob.scale = (size[0] / 2, size[1] / 2, size[2] / 2)
    m = bpy.data.materials.new(name + "_mat")
    m.diffuse_color = (*color, 1)
    m.use_nodes = True
    m.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (*color, 1)
    ob.data.materials.append(m)
    return ob


clay, dark = (0.62, 0.6, 0.57), (0.35, 0.34, 0.33)
box("ground", (0, 10, -0.05), (6, 30, 0.1), dark)
box("wall_left", (-1.6, 10, 3), (0.4, 30, 6), clay)
box("wall_right", (1.6, 10, 3), (0.4, 30, 6), clay)
box("door", (1.38, 7, 1.1), (0.08, 1.0, 2.2), dark)
box("step", (1.1, 7, 0.1), (0.5, 1.2, 0.2), clay)
box("crate", (-1.0, 12, 0.4), (0.8, 0.8, 0.8), clay)
box("corner_wall", (0, 22, 3), (6, 0.4, 6), clay)
bpy.ops.object.light_add(type="AREA", location=(0.8, 20.5, 3.2))
bpy.context.object.data.energy = 250
bpy.context.object.data.size = 2
bpy.ops.object.light_add(type="SUN", location=(0, 0, 10))
bpy.context.object.data.energy = 1.2
bpy.context.object.rotation_euler = (math.radians(35), 0, math.radians(20))

bpy.ops.object.camera_add(location=(0, 0, 1.4), rotation=(math.radians(88), 0, 0))
cam = bpy.context.object
cam.data.lens = 28
scene.camera = cam
# dolly forward 6 m with a gentle ease, slight drift right
cam.location = (0, 0, 1.4)
cam.keyframe_insert("location", frame=1)
cam.location = (0.25, 6, 1.45)
cam.keyframe_insert("location", frame=frames)
