# vos previz scene — CRANE UP / REVEAL: hold low near a person for 1 s, then rise and pull back to a high angle that
# reveals where they are. Intent: the individual becomes small in a larger world — isolation, scale, an ending. Uses `rig`.
import math

import bpy

C, D = rig.CLAY, rig.DARK
rig.box("ground", (0, 8, -0.05), (40, 40, 0.1), D)
for gx in range(-3, 4):
    for gy in range(0, 5):
        if (gx, gy) == (0, 0):
            continue
        h = 2 + ((gx * 7 + gy * 3) % 5)
        rig.box(f"block{gx}_{gy}", (gx * 4.5, 4 + gy * 5, h / 2), (2.8, 3.2, h), C)
hero = rig.person(at=(0, 1.0, 0), facing=180)  # looking away, into the city

bpy.ops.object.light_add(type="SUN", location=(0, 0, 10))
bpy.context.object.data.energy = 1.4
bpy.context.object.rotation_euler = (math.radians(50), 0, math.radians(-35))

cam = rig.camera(lens=28, at=(0.4, -1.4, 0.9), look=hero)
rig.move(cam, [(0.4, -1.4, 0.9), (0.3, -4.5, 3.5), (0.0, -7.0, 8.0)],
         look=[rig.eye(hero), (0, 3.0, 1.0), (0, 7.0, 0.0)],  # tilt down onto the city as we rise
         span=(24, frames), ease="inout")
