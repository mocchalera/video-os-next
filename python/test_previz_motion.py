"""Offline checks for previz_motion.py (no Blender). Run: python/.venv/bin/python python/test_previz_motion.py"""
import math
import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import previz_motion as pm  # noqa: E402

# A two-frame BVH in Kimodo's convention (cm, Y up, +Z forward, +X = subject's left): a root, hips 100 cm up, a left
# hip 10 cm to the left, a right hip 10 cm to the right, an arm 50 cm long along +X from a chest joint.
BVH = """HIERARCHY
ROOT Root
{
  OFFSET 0 0 0
  CHANNELS 6 Xposition Yposition Zposition Zrotation Yrotation Xrotation
  JOINT Hips
  {
    OFFSET 0 100 0
    CHANNELS 3 Zrotation Yrotation Xrotation
    JOINT LeftLeg
    {
      OFFSET 10 0 0
      CHANNELS 3 Zrotation Yrotation Xrotation
      End Site
      {
        OFFSET 0 -40 0
      }
    }
    JOINT RightLeg
    {
      OFFSET -10 0 0
      CHANNELS 3 Zrotation Yrotation Xrotation
      End Site
      {
        OFFSET 0 -40 0
      }
    }
    JOINT Arm
    {
      OFFSET 0 50 0
      CHANNELS 3 Zrotation Yrotation Xrotation
      JOINT Hand
      {
        OFFSET 50 0 0
        CHANNELS 3 Zrotation Yrotation Xrotation
        End Site
        {
          OFFSET 10 0 0
        }
      }
    }
  }
}
MOTION
Frames: 2
Frame Time: 0.0333333
0 0 0 0 0 0  0 0 0  0 0 0  0 0 0  0 0 0  0 0 0
30 0 60 0 90 0  0 0 0  0 0 0  0 0 0  90 0 0  0 0 0
"""


class ParseTests(unittest.TestCase):
    def setUp(self):
        self.bvh = pm.parse_bvh(BVH)
        self.pos = pm.positions(self.bvh)

    def test_hierarchy_channels_and_frames(self):
        names = [j[0] for j in self.bvh["joints"]]
        self.assertEqual(names, ["Root", "Hips", "LeftLeg", "RightLeg", "Arm", "Hand"])   # End Sites are skipped
        self.assertEqual(self.bvh["frames"].shape, (2, 21))
        self.assertAlmostEqual(1 / self.bvh["frame_time"], 30.0, places=2)

    def test_axes_and_units(self):
        # frame 0: hips 1 m up (Blender Z), left hip on +X, the hand 0.5 m along +X from the arm
        np.testing.assert_allclose(self.pos["Hips"][0], [0, 0, 1.0], atol=1e-9)
        np.testing.assert_allclose(self.pos["LeftLeg"][0], [0.1, 0, 1.0], atol=1e-9)
        np.testing.assert_allclose(self.pos["Hand"][0], [0.5, 0, 1.5], atol=1e-9)

    def test_root_translation_rotation_and_child_rotation(self):
        # frame 1: root at x=30 cm, z=60 cm (BVH forward) -> Blender (0.3, -0.6); root yawed 90 deg about Y;
        # the arm rotated 90 deg about its Z: the hand swings from the side to straight up
        h = self.pos["Hips"][1]
        np.testing.assert_allclose(h, [0.3, -0.6, 1.0], atol=1e-9)
        arm, hand = self.pos["Arm"][1], self.pos["Hand"][1]
        np.testing.assert_allclose(arm, h + [0, 0, 0.5], atol=1e-9)
        np.testing.assert_allclose(hand - arm, [0, 0, 0.5], atol=1e-9)
        # yaw 90 deg about BVH Y turns the left hip from +X toward BVH -Z = Blender +Y
        np.testing.assert_allclose(self.pos["LeftLeg"][1] - h, [0, 0.1, 0], atol=1e-9)

    def test_forward_is_minus_y_for_an_unturned_take(self):
        P = {n: p[0] for n, p in self.pos.items()}
        fwd, up = pm.body_frame(P)
        np.testing.assert_allclose(fwd, [0, -1, 0], atol=1e-9)

    def test_sampling_interpolates_and_holds(self):
        m = {"fps": 30.0, "frames": 2, "pos": self.pos}
        mid = pm.sample(m, 0.5 / 30)
        np.testing.assert_allclose(mid["Hips"], [0.15, -0.3, 1.0], atol=1e-9)
        np.testing.assert_allclose(pm.sample(m, 99)["Hips"], self.pos["Hips"][1], atol=1e-9)
        np.testing.assert_allclose(pm.sample(m, -1)["Hips"], self.pos["Hips"][0], atol=1e-9)

    def test_bad_frame_count_is_rejected(self):
        with self.assertRaises(ValueError):
            pm.parse_bvh(BVH.replace("Frames: 2", "Frames: 3"))


class BlockingTests(unittest.TestCase):
    def test_marks_become_root2d_waypoints_in_kimodo_space(self):
        # start at (1, 2) facing 0 (= -Y): walking 2 m toward -Y is +Z (forward) in Kimodo; 1 m toward +X is +X (left)
        c = pm.blocking_constraints((1, 2), 0, [(49, (1, 0)), (97, (2, 0))])
        self.assertEqual(c[0]["type"], "root2d")
        self.assertEqual(c[0]["frame_indices"], [0, 60, 120])     # scene frames 49 / 97 at 24 fps -> 2 s / 4 s at 30
        self.assertEqual(c[0]["smooth_root_2d"], [[0.0, 0.0], [0.0, 2.0], [1.0, 2.0]])

    def test_facing_turns_the_frame(self):
        # facing 90 deg: forward is +X in the scene; a mark 1 m along +X is 1 m forward
        c = pm.blocking_constraints((0, 0), 90, [(25, (1, 0))])
        self.assertEqual(c[0]["smooth_root_2d"][1], [0.0, 1.0])
        self.assertEqual(c[0]["frame_indices"][1], 30)

    def test_marks_at_or_before_the_start_are_dropped(self):
        c = pm.blocking_constraints((0, 0), 0, [(1, (5, 5))])
        self.assertEqual(c[0]["frame_indices"], [0])


if __name__ == "__main__":
    unittest.main()
