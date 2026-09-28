# vos previz scene — ORBIT / ARC: the camera circles a person at eye level on a 50 mm lens, sweeping the background
# behind them. Intent: a turning point, the world rearranging around a character, heightened attention. Uses `rig`.
import math

import bpy

C, D = rig.CLAY, rig.DARK
rig.box("ground", (0, 0, -0.05), (30, 30, 0.1), D)
for i, a in enumerate(range(0, 360, 30)):
    r = 7 + (i % 3)
    x, y = r * math.sin(math.radians(a)), r * math.cos(math.radians(a))
    rig.box(f"column{i}", (x, y, 1.5 + (i % 2)), (0.6, 0.6, 3 + 2 * (i % 2)), C)
hero = rig.person(at=(0, 0, 0))

bpy.ops.object.light_add(type="SUN", location=(0, 0, 10))
bpy.context.object.data.energy = 1.5
bpy.context.object.rotation_euler = (math.radians(45), 0, math.radians(30))

cam = rig.camera(lens=50, at=(0, -3.2, 1.55), look=hero)
# from 40° left of her front to 50° right: 90° in 5 s is a steady, readable arc
rig.orbit(cam, center=hero, radius=3.2, height=1.55, degrees=(-40, 50), lens=50, ease="inout")
