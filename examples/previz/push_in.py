# vos previz scene — PUSH-IN: a slow dolly toward a standing person, medium shot → medium close-up, eye level.
# Intent: attention narrows, a realisation, rising tension. Uses `rig` (python/previz_rig.py).
import math

import bpy

C, D = rig.CLAY, rig.DARK
rig.box("floor", (0, 3, -0.05), (10, 16, 0.1), D)
rig.box("back_wall", (0, 3.5, 2), (10, 0.3, 4), C)
rig.box("window", (1.6, 3.33, 1.7), (1.2, 0.05, 1.4), D)
rig.box("cabinet", (-2.2, 2.9, 0.5), (1.4, 0.6, 1.0), C)
hero = rig.person(at=(0, 1.2, 0))

bpy.ops.object.light_add(type="AREA", location=(2.5, -1, 3.2))
bpy.context.object.data.energy, bpy.context.object.data.size = 400, 3
bpy.ops.object.light_add(type="SUN", location=(0, 0, 10))
bpy.context.object.data.energy = 1.0
bpy.context.object.rotation_euler = (math.radians(40), 0, math.radians(-25))

lens = 40
d0, z0 = rig.framing(hero, "MS", lens)    # waist up, ~10 % headroom
d1, z1 = rig.framing(hero, "MCU", lens)   # chest up
y = hero.location.y
cam = rig.camera(lens=lens, at=(0, y - d0, 1.55))
# eye-level camera, aim drifts from the MS to the MCU aim point; slow and eased — no visible start/stop
rig.move(cam, [(0, y - d0, 1.55), (0, y - d1, 1.55)], look=[(0, y, z0), (0, y, z1)], ease="inout")
