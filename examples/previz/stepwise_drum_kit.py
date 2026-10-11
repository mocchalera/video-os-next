# Stepwise scene (skills/stepwise-scene-production): a drum kit on a white disc against a mint seamless, rebuilt from a
# reference still (a scratch frame of the shoegaze-runner-mv MV at 01:13, cut s14c; exact clip version unconfirmed) one
# stage at a time. The kit/disc/backdrop subset only — the two players are NOT rebuilt. A clay stand-in at the
# bassist's place exists for scale checks only (SCALE_PROXY, off: the real-size kit holds the scale).
# Intent (from the shot list): a deadpan two-shot, knees up, locked-off; the kit reads clearly behind the bassist.
#
# STAGE selects how far the build goes; every stage keeps the previous one's positions and camera:
#   layout   bounding boxes at real size + camera            (check: placement, scale, framing vs the reference)
#   form     real shapes (shells, hoops, cymbals, stands)    (check: silhouettes, counts, proportions)
#   material materials + light                               (check: colour, gloss, light direction vs the reference)
#   motion   cymbal sway on the beat + a slow push-in        (check: the move is felt between first and last frame)
# Shapes the reference does not show are guesses; they are listed in UNSEEN and printed into the stage metadata.
import json, math, os
import bpy
from mathutils import Vector

STAGE = "layout"
ORDER = ["layout", "form", "material", "motion"]
LEVEL = ORDER.index(STAGE)
C, D = rig.CLAY, rig.DARK
UNSEEN = [
    "kick pedal, beater and spurs (hidden behind the kick / bassist)",
    "back side and mounting of every drum (only fronts are visible)",
    "drum throne (hidden by the drummer, who is not rebuilt)",
    "floor-tom legs below the shell (hidden by the bassist's legs)",
    "cymbal diameters and the left cymbal's stand (estimated from apparent size)",
    "disc diameter, thickness and position beyond the frame edge",
    "how far the mint seamless curves into the floor and how far back the wall is (no seam is visible)",
    "the camera lens (40 mm assumed; distance and height are derived from it)",
]

# ---- set (reference: mint seamless, white disc; the kit stands near the disc's back edge) -----------------------
MINT = (0.45, 0.8, 0.7)
DISC_TOP = 0.2
KIT_X = 0.35
rig.box("floor", (0, 4, -0.05), (20, 20, 0.1), MINT)
# The reference shows no floor/wall seam (a seamless backdrop). The wall stands just behind the platform so the
# floor/wall corner falls behind the platform's back edge from this low camera (before: y = 7.5, seam visible at y ≈ 0.77).
CYC_Y = 4.4
rig.box("cyc", (0, CYC_Y, 4), (20, 0.2, 8), MINT)
# Composition pass (2026-10-11): in the reference the platform top shows only as a thin band (y ≈ 0.88–1.0) ending just
# behind the cymbal stands, so the kit stands near the BACK of the disc and its front part is below the frame.
bpy.ops.mesh.primitive_cylinder_add(vertices=12 if LEVEL == 0 else 96, radius=2.0, depth=DISC_TOP,
                                    location=(0.0, 1.65, DISC_TOP / 2))
disc = bpy.context.object
disc.name = "disc"
disc.data.materials.append(rig._material("disc", (0.95, 0.95, 0.95)))
if LEVEL >= 1:
    bev = disc.modifiers.new("bevel", "BEVEL")
    bev.width, bev.segments = 0.03, 4


def cyl(name, at, radius, depth, color=C, rot=(0, 0, 0), verts=48):
    bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=radius, depth=depth, location=at, rotation=rot)
    ob = bpy.context.object
    ob.name = name
    ob.data.materials.append(rig._material(name, color))
    return ob


def ring(name, at, radius, minor, rot=(0, 0, 0), color=D):
    bpy.ops.mesh.primitive_torus_add(major_radius=radius, minor_radius=minor, location=at, rotation=rot,
                                     major_segments=48, minor_segments=8)
    ob = bpy.context.object
    ob.name = name
    ob.data.materials.append(rig._material(name, color))
    return ob


def rod(name, a, b, r=0.012, color=D):
    a, b = [float(v) for v in a], [float(v) for v in b]
    d = [b[i] - a[i] for i in range(3)]
    ln = math.sqrt(sum(v * v for v in d))
    mid = [(a[i] + b[i]) / 2 for i in range(3)]
    ob = cyl(name, mid, r, ln, color, verts=12)
    ob.rotation_euler = Vector((0, 0, 1)).rotation_difference(Vector(d).normalized()).to_euler()  # local +Z along a→b
    return ob


def tripod(name, x, y, top, spread=0.28):
    rod(f"{name}_post", (x, y, DISC_TOP), (x, y, top))
    for k in range(3):
        a = math.radians(90 + k * 120)
        rod(f"{name}_leg{k}", (x, y, DISC_TOP + 0.32), (x + spread * math.cos(a), y + spread * math.sin(a), DISC_TOP))


# drum parts: (name, centre, diameter, depth, axis)  — real-size estimates (22" kick, 16" floor tom, 14" snare).
# Positions fitted to approximate landmarks read off the reference (composition pass; see the stage record): the floor
# tom tucks in left of / behind the kick, rims of tom and snare at about the same height, both cymbals at ~0.9 m.
KICK = ("kick", (KIT_X, 2.85, DISC_TOP + 0.28), 0.56, 0.40, "y")
TOM = ("floor_tom", (KIT_X - 0.23, 3.05, DISC_TOP + 0.46), 0.40, 0.36, "z")
SNARE = ("snare", (KIT_X + 0.38, 3.0, DISC_TOP + 0.58), 0.36, 0.14, "z")
CYM_L = ("cymbal_L", (KIT_X - 0.37, 3.2, DISC_TOP + 0.92), 0.46, 18)
CYM_R = ("cymbal_R", (KIT_X + 0.82, 3.15, DISC_TOP + 0.92), 0.48, -12)
THRONE = ("throne", (KIT_X + 0.1, 3.55, DISC_TOP + 0.5), 0.34, 0.08, "z")

parts = {}
if LEVEL == 0:
    for n, at, dia, dep, ax in (KICK, TOM, SNARE, THRONE):
        size = (dia, dep, dia) if ax == "y" else (dia, dia, dep)
        parts[n] = rig.box(n, at, size, C)
    for n, at, dia, tilt in (CYM_L, CYM_R):
        parts[n] = rig.box(n, at, (dia, dia, 0.02), D)
    sh, ch = SNARE[1][2] - 0.07 - DISC_TOP, CYM_R[1][2] - DISC_TOP
    rig.box("snare_stand", (SNARE[1][0], SNARE[1][1], DISC_TOP + sh / 2), (0.05, 0.05, sh), D)
    rig.box("cymR_stand", (CYM_R[1][0], CYM_R[1][1], DISC_TOP + ch / 2), (0.05, 0.05, ch), D)
else:
    for n, at, dia, dep, ax in (KICK, TOM, SNARE, THRONE):
        rot = (math.pi / 2, 0, 0) if ax == "y" else (0, 0, 0)
        parts[n] = cyl(n, at, dia / 2, dep, C if n != "throne" else D, rot)
        if n == "throne":
            continue
        for s in (-1, 1):  # hoops at both heads
            off = [0, 0, 0]
            off["xyz".index(ax)] = s * dep / 2
            ring(f"{n}_hoop{s:+d}", tuple(at[i] + off[i] for i in range(3)), dia / 2 + 0.008, 0.012, rot)
        if n == "kick":
            hd = cyl("kick_head", (at[0], at[1] - dep / 2 - 0.003, at[2]), dia / 2 - 0.01, 0.004, (0.97, 0.97, 0.95),
                     (math.pi / 2, 0, 0))
            parts["kick_head"] = hd
    for n, at, dia, tilt in (CYM_L, CYM_R):
        bpy.ops.mesh.primitive_cone_add(vertices=64, radius1=dia / 2, radius2=0.03, depth=0.035, location=at,
                                        rotation=(math.radians(tilt * 0.4), math.radians(tilt), 0))
        cy = bpy.context.object
        cy.name = n
        cy.data.materials.append(rig._material(n, (0.78, 0.62, 0.3)))
        parts[n] = cy
    tripod("snare_stand", SNARE[1][0], SNARE[1][1], SNARE[1][2] - 0.07)
    tripod("cymR_stand", CYM_R[1][0], CYM_R[1][1], CYM_R[1][2] - 0.02, 0.32)
    tripod("cymL_stand", CYM_L[1][0] - 0.05, CYM_L[1][1] + 0.1, CYM_L[1][2] - 0.02, 0.25)
    for k in range(3):  # floor-tom legs (unseen: guessed)
        a = math.radians(30 + k * 120)
        x, y = TOM[1][0] + 0.24 * math.cos(a), TOM[1][1] + 0.24 * math.sin(a)
        rod(f"tom_leg{k}", (x, y, DISC_TOP), (x, y, TOM[1][2]))
    for k in (-1, 1):  # kick spurs
        rod(f"kick_spur{k}", (KICK[1][0] + k * 0.3, KICK[1][1] - 0.15, DISC_TOP),
            (KICK[1][0] + k * 0.2, KICK[1][1] - 0.05, KICK[1][2]))

# One clay stand-in where the bassist stands (scale reference only; not a performer rebuild). It is in the depth pass
# too, as the nearest silhouette: a depth control would make H3 generate *something* there. For a kit-only control
# render set SCALE_PROXY = False (after checking scale with it on); for a band shot replace it with rig.actor players.
SCALE_PROXY = False  # composition pass: kit-only beauty/depth; scale is held by the real-size kit
if SCALE_PROXY:
    stand_in = rig.person(at=(-0.5, 1.75, 0), height=1.68, facing=15, name="standin_bassist")

# ---- camera (locked-off; numbers fitted to the reference by eye at the layout stage) ------------------------------
# Composition pass: low camera (≈ 0.62 m above the platform top), tilted up ≈ 1.9°, kick front head ≈ 3.1 m away,
# derived from the reference's kick width (≈ 0.21 of the frame) and ground-contact heights, assuming 40 mm (the
# reference lens is unknown). Before (a929b40): (0.0, -0.7, 1.12) looking at (0.12, 2.8, 0.98).
CAM_AT, CAM_LOOK, LENS = (0.11, -0.44, 0.82), (0.11, 5.0, 0.99), 40
cam = rig.camera(lens=LENS, at=CAM_AT, look=CAM_LOOK)

# ---- light: plain at layout/form, shaped at material ---------------------------------------------------------------
if LEVEL < 2:
    bpy.ops.object.light_add(type="AREA", location=(0, -2, 5))
    bpy.context.object.data.energy, bpy.context.object.data.size = 900, 6
    bpy.ops.object.light_add(type="SUN", location=(0, 0, 10))
    bpy.context.object.data.energy = 0.6
else:
    # Studio look of the reference: big soft frontal key slightly from camera-left, even wash on the seamless.
    bpy.ops.object.light_add(type="AREA", location=(-1.8, -1.6, 3.2))
    key = bpy.context.object
    key.data.energy, key.data.size = 220, 4
    key.rotation_euler = rig._aim(key.location, rig._point((0.3, 2.8, 0.8)), 0)
    bpy.ops.object.light_add(type="AREA", location=(2.4, -1.0, 2.4))
    fill = bpy.context.object
    fill.data.energy, fill.data.size = 70, 4
    fill.rotation_euler = rig._aim(fill.location, rig._point((0.3, 2.8, 0.8)), 0)
    bpy.ops.object.light_add(type="AREA", location=(0.3, CYC_Y - 3.4, 4.0))  # in front of the moved wall
    wash = bpy.context.object
    wash.data.energy, wash.data.size = 380, 8
    wash.rotation_euler = rig._aim(wash.location, rig._point((0.3, CYC_Y, 1.8)), 0)
    world = bpy.data.worlds.new("mint_world")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.32, 0.52, 0.46, 1)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.35
    bpy.context.scene.world = world

# ---- materials (procedural only; one shared wear group, strength per material) ------------------------------------
def wear_group():
    g = bpy.data.node_groups.new("stepwise_wear", "ShaderNodeTree")
    g.interface.new_socket("Color", in_out="INPUT", socket_type="NodeSocketColor")
    g.interface.new_socket("Strength", in_out="INPUT", socket_type="NodeSocketFloat")
    g.interface.new_socket("Color", in_out="OUTPUT", socket_type="NodeSocketColor")
    n, l = g.nodes, g.links
    gi, go = n.new("NodeGroupInput"), n.new("NodeGroupOutput")
    noise = n.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = 40
    geo = n.new("ShaderNodeNewGeometry")
    sep = n.new("ShaderNodeSeparateXYZ")
    l.new(geo.outputs["Normal"], sep.inputs[0])  # dust gathers on up-facing surfaces
    up = n.new("ShaderNodeMath"); up.operation = "MAXIMUM"; up.inputs[1].default_value = 0
    l.new(sep.outputs["Z"], up.inputs[0])
    m1 = n.new("ShaderNodeMath"); m1.operation = "MULTIPLY"
    l.new(noise.outputs["Fac"], m1.inputs[0]); l.new(up.outputs[0], m1.inputs[1])
    m2 = n.new("ShaderNodeMath"); m2.operation = "MULTIPLY"
    l.new(m1.outputs[0], m2.inputs[0]); l.new(gi.outputs["Strength"], m2.inputs[1])
    mix = n.new("ShaderNodeMix"); mix.data_type = "RGBA"
    mix.inputs["B"].default_value = (0.55, 0.53, 0.5, 1)
    l.new(m2.outputs[0], mix.inputs["Factor"]); l.new(gi.outputs["Color"], mix.inputs["A"])
    l.new(mix.outputs["Result"], go.inputs["Color"])
    return g


def surface(ob_names, color, metallic=0.0, rough=0.5, wear=0.0, coat=0.0):
    m = bpy.data.materials.new("surf_" + ob_names[0])
    m.use_nodes = True
    nt = m.node_tree
    b = nt.nodes["Principled BSDF"]
    b.inputs["Metallic"].default_value = metallic
    b.inputs["Roughness"].default_value = rough
    if coat:
        b.inputs["Coat Weight"].default_value = coat
    if wear:
        g = nt.nodes.new("ShaderNodeGroup"); g.node_tree = WEAR
        g.inputs["Color"].default_value = (*color, 1)
        g.inputs["Strength"].default_value = wear
        nt.links.new(g.outputs["Color"], b.inputs["Base Color"])
    else:
        b.inputs["Base Color"].default_value = (*color, 1)
    for ob in bpy.data.objects:
        if ob.type == "MESH" and any(ob.name.startswith(k) for k in ob_names):  # later calls override earlier ones
            ob.data.materials.clear()
            ob.data.materials.append(m)


if LEVEL >= 2:
    WEAR = wear_group()
    surface(["floor", "cyc"], MINT, rough=0.9)
    surface(["disc"], (0.93, 0.93, 0.92), rough=0.12, coat=0.6, wear=0.15)
    surface(["kick", "floor_tom", "snare"], (0.9, 0.89, 0.86), rough=0.25, coat=0.5, wear=0.03)  # white pearl wraps
    surface(["kick_head"], (0.96, 0.96, 0.94), rough=0.6)                                    # coated head
    surface(["kick_hoop", "floor_tom_hoop", "snare_hoop", "snare_stand", "cymR_stand", "cymL_stand", "tom_leg",
             "kick_spur"], (0.85, 0.86, 0.88), metallic=1.0, rough=0.18)                    # chrome
    surface(["kick_hoop"], (0.96, 0.95, 0.9), rough=0.35)  # the reference shows a light (wood/white) kick hoop
    surface(["cymbal_L", "cymbal_R"], (0.8, 0.6, 0.28), metallic=1.0, rough=0.32, wear=0.2)  # brass
    surface(["throne"], (0.05, 0.05, 0.05), rough=0.6)

# ---- motion: cymbals sway after each beat (no stick is modelled: it is a secondary-motion test), slow push-in over the
# WHOLE clip — speed and the number of beats depend on `frames` (48 f: 0.245 m in 1.96 s; 56 f: same distance in 2.29 s)
if LEVEL >= 3:
    beat = 3.041 / 4 * fps  # one bar = 3.041 s in this song (shots.md); a beat ≈ 18.2 frames
    hits = [f for f in (4, 4 + beat, 4 + 2 * beat) if f <= frames]
    for n, amp in (("cymbal_R", 7.0), ("cymbal_L", 4.0)):
        ob = parts[n]
        base = ob.rotation_euler.copy()
        for f in range(1, frames + 1):
            w = 0.0
            for h in hits:
                if f >= h:
                    t = (f - h) / fps
                    w += math.radians(amp) * math.exp(-t * 3.0) * math.sin(t * 2 * math.pi * 2.2)
            ob.rotation_euler = (base[0] + w, base[1], base[2])
            ob.keyframe_insert("rotation_euler", frame=f)
    # Same amplitude as before (0.245 m), now a pure translation toward the kick centre with the rotation held, so the
    # kick stays put in frame while the kit grows. NOTE: the source shot list calls the band world locked-off
    # ("正面フィックス"); this push-in is the skill's motion-stage test, not a decided camera for s14c.
    k = KICK[1]
    dv = [k[i] - CAM_AT[i] for i in range(3)]
    n = math.sqrt(sum(v * v for v in dv))
    end = tuple(CAM_AT[i] + dv[i] / n * 0.245 for i in range(3))
    rig.move(cam, [CAM_AT, end], look=None, ease="inout")

# ---- record what this stage is (read by skills/stepwise-scene-production/scripts/render_stages.py) ----------------
meta_path = os.environ.get("STEPWISE_META")
if meta_path:
    sc = bpy.context.scene
    camera = {}
    for f in sorted({1, frames}):
        sc.frame_set(f)
        mw = cam.matrix_world
        camera[f] = {"location": [round(v, 4) for v in mw.translation],
                     "rotation_deg": [round(math.degrees(v), 3) for v in mw.to_euler()], "lens_mm": cam.data.lens,
                     "sensor_mm": cam.data.sensor_width}
    sc.frame_set(1)
    with open(meta_path, "w") as fh:
        json.dump({"stage": STAGE, "camera": camera, "look_at": CAM_LOOK, "unseen_guessed": UNSEEN,
                   "mesh_objects": sum(1 for o in sc.objects if o.type == "MESH"),
                   "materials": sorted({m.name for m in bpy.data.materials if m.users})}, fh, indent=1)
# .blend = the scene as built here, BEFORE the driver sets engine, samples and view transform (opening it shows another
# look); reproduce renders with the command in receipt.json, not from this file.
blend_path = os.environ.get("STEPWISE_BLEND")
if blend_path:
    bpy.ops.wm.save_as_mainfile(filepath=blend_path, copy=True)
