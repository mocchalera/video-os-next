# vos previz scene — PERFORMANCE: A enters reluctantly, notices a letter on the table, freezes, reacts; B watches.
# Shows the performance spec (python/previz_actor.py, skills/previz-performance/SKILL.md): path marks with footsteps,
# Laban effort, gaze with eye lead and a frozen beat, a weight shift, an arm preset and a hand contact.
import math

import bpy

C, D = rig.CLAY, rig.DARK
rig.box("floor", (0, 1, -0.05), (12, 10, 0.1), D)
rig.box("back_wall", (0, 3.2, 1.6), (12, 0.2, 3.2), C)
rig.box("door_frame_l", (-2.2, 3.05, 1.05), (0.12, 0.12, 2.1), D)
rig.box("door_frame_r", (-1.2, 3.05, 1.05), (0.12, 0.12, 2.1), D)
rig.box("table", (0.9, 0.9, 0.36), (1.0, 0.6, 0.72), C)
letter = rig.box("letter", (0.75, 0.8, 0.73), (0.22, 0.3, 0.01), (0.9, 0.9, 0.88))

bpy.ops.object.light_add(type="AREA", location=(1.5, -1.5, 3.0))
bpy.context.object.data.energy, bpy.context.object.data.size = 500, 3
bpy.ops.object.light_add(type="SUN", location=(0, 0, 10))
bpy.context.object.data.energy = 0.8
bpy.context.object.rotation_euler = (math.radians(40), 0, math.radians(-30))

B = rig.actor("B", at=(2.0, 0.6, 0), facing=-110)
A = rig.actor("A", at=(-1.7, 2.6, 0), facing=160)

rig.perform(A, {  # the looked-at actor is performed first, so B can follow A's eyes frame by frame
    "effort": {"weight": "light", "time": "sustained", "space": "indirect", "flow": "bound"},  # anxious, held in
    "path": [(1, (-1.7, 2.6)), (60, (0.0, 0.3))],                    # ~2.9 m in 2.5 s: a hesitant 1.1 m/s
    "facing": [(64, letter)],
    "body": [(1, {"lean": 5}),                                             # closed, a little hunched
             (80, {"lean": -3, "weight": "L", "arms": "face"}, 10),        # the external reaction, quick
             (104, {"lean": 2, "arms": "front"})],
    "gaze": [(1, "floor"), (60, letter), (70, "hold"), (102, B)],          # eyes find it; the thought stops the body
    "beats": [(1, "enter"), (60, "notice"), (70, "recognition"), (80, "reaction"), (102, "looks at B")],
})
rig.perform(B, {
    "effort": {"weight": "strong", "time": "neutral", "space": "direct", "flow": "free"},
    "body": [(1, {"weight": "R", "arms": "crossed"})],
    "gaze": [(1, A)],
})

cam = rig.camera(lens=32, at=(0.2, -4.3, 1.45), look=(0.0, 1.2, 1.0))
