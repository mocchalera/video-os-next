# vos previz scene — DOLLY ZOOM (vertigo): the camera moves in while zooming out, so the person keeps their size and
# the corridor behind them stretches away. Intent: a sudden inner shift — dread, vertigo, the floor giving way.
# Pillars and a far door give the background enough depth cues for the effect to read. Uses `rig`.
import math

import bpy

C, D = rig.CLAY, rig.DARK
rig.box("floor", (0, 10, -0.05), (5, 30, 0.1), D)
rig.box("wall_l", (-2.2, 10, 2), (0.3, 30, 4), C)
rig.box("wall_r", (2.2, 10, 2), (0.3, 30, 4), C)
for i in range(6):
    y = 3 + i * 3
    rig.box(f"pillar_l{i}", (-1.8, y, 2), (0.4, 0.4, 4), D)
    rig.box(f"pillar_r{i}", (1.8, y, 2), (0.4, 0.4, 4), D)
rig.box("far_door", (0, 21, 1.1), (1.2, 0.2, 2.2), C)
hero = rig.person(at=(0, 1.5, 0))

bpy.ops.object.light_add(type="SUN", location=(0, 0, 10))
bpy.context.object.data.energy = 1.4
bpy.context.object.rotation_euler = (math.radians(30), 0, math.radians(15))

# 6 m away on 85 mm → 2 m away on ~28 mm: same face size, background falls away
cam = rig.camera(lens=85, at=(0, -4.5, 1.58), look=hero)
rig.dolly_zoom(cam, hero, distances=(6.0, 2.0), lens=85, ease="inout")
