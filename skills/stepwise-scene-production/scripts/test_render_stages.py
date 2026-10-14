"""Offline checks for render_stages.py with a fake Blender (no render, no model).
Run: python3 -B skills/stepwise-scene-production/scripts/test_render_stages.py"""
import hashlib
import json
import os
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import textwrap
import threading
import time
import unittest
import zlib
from unittest import mock

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import render_stages as rs  # noqa: E402

FAKE = textwrap.dedent('''\
    #!{py}
    import json, os, struct, sys, time, zlib
    if "--version" in sys.argv:
        print("Blender fake 0.0"); sys.exit(0)
    a = sys.argv[sys.argv.index("--") + 1:]
    arg = lambda k: a[a.index(k) + 1]
    out, frames, scene = arg("--out"), int(arg("--frames")), arg("--scene")
    stage = [l.split('"')[1] for l in open(scene) if l.startswith("STAGE = ")][0]
    mode = os.environ.get("FAKE_MODE", "ok")
    if mode == "hang":
        if os.environ.get("FAKE_MARK"):
            open(os.environ["FAKE_MARK"], "w").write(str(os.getpid()))
        time.sleep(60)
    if mode == "fail:" + stage:
        print("Error: fake failure"); sys.exit(3)
    def png(p, w=32, h=18):
        raw = b"".join(b"\\x00" + b"\\x80\\x80\\x80" * w for _ in range(h))
        ch = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
        open(p, "wb").write(b"\\x89PNG\\r\\n\\x1a\\n" + ch(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
                            + ch(b"IDAT", zlib.compress(raw)) + ch(b"IEND", b""))
    for p in ("beauty", "depth"):
        os.makedirs(os.path.join(out, p))
        for f in range(1, frames + 1):
            png(os.path.join(out, p, "%04d.png" % f))
    json.dump({{"engine": "FAKE", "blender": "fake", "depth": {{"near": 1, "far": 2}}}}, open(os.path.join(out, "previz.json"), "w"))
    cam = {{str(f): {{"location": [0, -1 + 0.1 * (f - 1), 1], "rotation_deg": [90, 0, 0], "lens_mm": 40, "sensor_mm": 36}}
           for f in sorted({{1, frames}})}}
    json.dump({{"stage": stage, "camera": cam, "look_at": [0, 0, 1], "unseen_guessed": [], "mesh_objects": 1,
               "materials": []}}, open(os.environ["STEPWISE_META"], "w"))
    print("previz: done", out)
    ''').format(py=sys.executable)

FAKE_FFMPEG = textwrap.dedent('''\
    #!{py}
    import os, sys, time
    if any("xstack" in x for x in sys.argv):   # the contact sheet: hang until signalled
        open(os.environ["FAKE_MARK"], "w").write(str(os.getpid()))
        time.sleep(60)
    os.execv({real!r}, ["ffmpeg"] + sys.argv[1:])
    ''')

SCENE = 'ORDER = ["layout", "form", "material", "motion"]\nSTAGE = "layout"\n# writes STEPWISE_META\n'


def h(p):
    with open(p, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


class RunnerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        t = self.tmp.name
        self.blender = os.path.join(t, "fakebin", "blender")
        os.makedirs(os.path.dirname(self.blender))
        with open(self.blender, "w") as f:
            f.write(FAKE)
        os.chmod(self.blender, 0o755)
        self.scene = os.path.join(t, "scene.py")
        with open(self.scene, "w") as f:
            f.write(SCENE)
        self.ref = os.path.join(t, "ref.png")
        subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=green:s=64x36", "-frames:v", "1", self.ref],
                       check=True)
        # the machine's real process table is not part of these tests (classify() is tested on its own)
        self.ps = mock.patch.object(rs, "ps_rows", return_value=[])
        self.ps.start()

    def tearDown(self):
        self.ps.stop()
        os.environ.pop("FAKE_MODE", None)
        os.environ.pop("FAKE_MARK", None)
        self.tmp.cleanup()

    def main(self, out, *extra):
        return rs.main(["--scene", self.scene, "--ref", self.ref, "--out", out, "--blender", self.blender,
                        "--min-free-gib", "1", *extra])

    def receipt(self, out):
        with open(os.path.join(out, "receipt.json")) as f:
            return json.load(f)

    def test_existing_out_is_refused_and_untouched(self):
        out = os.path.join(self.tmp.name, "old")
        os.makedirs(out)
        for n in ("motion_start.png", "receipt.json"):
            with open(os.path.join(out, n), "w") as f:
                f.write("old " + n)
        before = {n: h(os.path.join(out, n)) for n in os.listdir(out)}
        self.assertEqual(self.main(out, "--stages", "layout"), 2)
        self.assertEqual({n: h(os.path.join(out, n)) for n in os.listdir(out)}, before)

    def test_bad_arguments_create_nothing(self):
        cases = [("--stages", "layout,colour"), ("--stages", "layout,layout"), ("--stages", "form,layout"),
                 ("--stages", ""), ("--size", "500x288"), ("--size", "4096x2304"), ("--motion-frames", "500"),
                 ("--motion-frames", "0"), ("--fps", "0")]
        for i, (k, v) in enumerate(cases):
            out = os.path.join(self.tmp.name, f"bad{i}")
            self.assertEqual(self.main(out, k, v), 2, (k, v))
            self.assertFalse(os.path.exists(out), (k, v))
        inside = os.path.join(rs.REPO, "should-not-exist-stepwise")
        self.assertEqual(self.main(inside), 2)
        self.assertFalse(os.path.exists(inside))

    def test_sheet_has_only_this_runs_stages(self):
        out = os.path.join(self.tmp.name, "run")
        self.assertEqual(self.main(out, "--stages", "layout,form"), 0)
        r = self.receipt(out)
        self.assertEqual(r["status"], "ok")
        self.assertEqual(r["contact_sheet"]["tiles"], ["reference", "layout", "form"])
        self.assertFalse(os.path.exists(os.path.join(out, "motion_start.png")))
        self.assertEqual(r["runner_sha256"], h(rs.__file__))
        self.assertEqual(r["cleanup"]["running_after_cleanup"], [])
        self.assertIn("--python-expr", r["stages"][0]["command"])

    def test_motion_reports_move_for_its_frame_count(self):
        out = os.path.join(self.tmp.name, "mo")
        self.assertEqual(self.main(out, "--stages", "layout,motion", "--motion-frames", "5"), 0)
        r = self.receipt(out)
        self.assertEqual(r["contact_sheet"]["tiles"], ["reference", "layout", "motion start", "motion mid", "motion end"])
        mv = r["stages"][1]["move"]
        self.assertEqual(mv["frames"], 5)
        self.assertAlmostEqual(mv["distance_m"], 0.4, places=3)
        self.assertAlmostEqual(mv["speed_m_s"], 0.4 / (4 / 24), places=3)

    def test_failed_stage_leaves_partial_receipt_and_log(self):
        os.environ["FAKE_MODE"] = "fail:form"
        out = os.path.join(self.tmp.name, "fail")
        self.assertEqual(self.main(out, "--stages", "layout,form,material"), 1)
        r = self.receipt(out)
        self.assertEqual(r["status"], "failed")
        self.assertEqual([(s["stage"], s["ok"]) for s in r["stages"]], [("layout", True), ("form", False)])
        self.assertTrue(os.path.exists(os.path.join(out, "02_form", "blender.log")))
        self.assertEqual(r["contact_sheet"]["tiles"], ["reference", "layout"])

    def test_timeout_stops_only_own_child(self):
        os.environ["FAKE_MODE"] = "hang"
        out = os.path.join(self.tmp.name, "hang")
        self.assertEqual(self.main(out, "--stages", "layout", "--stage-timeout", "2"), 1)
        r = self.receipt(out)
        self.assertEqual(r["status"], "failed")
        self.assertIn("timeout", r["error"])
        started = r["cleanup"]["started"]
        self.assertTrue(all(p["returncode"] is not None for p in started))
        self.assertEqual(r["cleanup"]["running_after_cleanup"], [])
        self.assertTrue(os.path.exists(os.path.join(out, "01_layout", "blender.log")))

    def test_unreadable_process_table_refuses(self):
        out = os.path.join(self.tmp.name, "nops")
        real = subprocess.run

        def fake_run(cmd, *a, **k):
            if cmd and cmd[0] == "ps":
                raise OSError("ps not available")
            return real(cmd, *a, **k)
        self.ps.stop()
        with mock.patch.object(rs.subprocess, "run", fake_run):
            self.assertEqual(self.main(out, "--stages", "layout"), 2)
        self.assertFalse(os.path.exists(out))
        with mock.patch.object(rs.subprocess, "run", lambda *a, **k: subprocess.CompletedProcess(a, 1, "", "")):
            self.assertEqual(self.main(out, "--stages", "layout"), 2)
        self.assertFalse(os.path.exists(out))
        self.ps.start()

    def send_when_marked(self, sig):
        """Send `sig` to this test process once the fake child has written its mark (it is then blocked in it)."""
        mark = os.path.join(self.tmp.name, "mark")
        os.environ["FAKE_MARK"] = mark

        def go():
            for _ in range(200):
                if os.path.exists(mark):
                    time.sleep(0.2)
                    os.kill(os.getpid(), sig)
                    return
                time.sleep(0.05)
        threading.Thread(target=go, daemon=True).start()

    def test_sigterm_during_stage_stops_own_child_and_writes_receipt(self):
        os.environ["FAKE_MODE"] = "hang"
        before = signal.getsignal(signal.SIGTERM)
        out = os.path.join(self.tmp.name, "term")
        self.send_when_marked(signal.SIGTERM)
        self.assertEqual(self.main(out, "--stages", "layout,form"), 130)
        r = self.receipt(out)
        self.assertEqual(r["status"], "interrupted")
        self.assertIn("during stages", r["error"])
        self.assertTrue(all(p["returncode"] is not None for p in r["cleanup"]["started"]))
        self.assertEqual(r["cleanup"]["running_after_cleanup"], [])
        self.assertIs(signal.getsignal(signal.SIGTERM), before)

    def test_ctrl_c_during_contact_sheet_stops_own_ffmpeg_and_writes_receipt(self):
        real = shutil.which("ffmpeg")
        fake = os.path.join(os.path.dirname(self.blender), "ffmpeg")
        with open(fake, "w") as f:
            f.write(FAKE_FFMPEG.format(py=sys.executable, real=real))
        os.chmod(fake, 0o755)
        out = os.path.join(self.tmp.name, "intr")
        self.send_when_marked(signal.SIGINT)
        with mock.patch.dict(os.environ, {"PATH": os.path.dirname(fake) + os.pathsep + os.environ["PATH"]}):
            self.assertEqual(self.main(out, "--stages", "layout"), 130)
        r = self.receipt(out)
        self.assertEqual(r["status"], "interrupted")
        self.assertIn("during contact_sheet", r["error"])
        self.assertEqual([(s["stage"], s["ok"]) for s in r["stages"]], [("layout", True)])
        ff = [p for p in r["cleanup"]["started"] if p["program"] == "ffmpeg"]
        self.assertEqual(len(ff), 1)
        self.assertIsNotNone(ff[0]["returncode"])
        self.assertEqual(r["cleanup"]["running_after_cleanup"], [])
        self.assertNotIn("contact_sheet", r)

    def test_out_inside_any_checkout_is_refused(self):
        t = self.tmp.name
        main = os.path.join(t, "repo")
        g = ["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "core.hooksPath=/dev/null"]
        subprocess.run(["git", "init", "-q", main], check=True)
        subprocess.run(g + ["-C", main, "commit", "-q", "--allow-empty", "-m", "x"], check=True)
        wt = os.path.join(t, "wt")
        subprocess.run(g + ["-C", main, "worktree", "add", "-q", "-b", "b", wt], check=True)
        os.symlink(main, os.path.join(t, "link"))
        with mock.patch.object(rs, "REPO", wt):  # the runner lives in one worktree of `repo`
            for out in (os.path.join(main, "o"), os.path.join(wt, "o"), os.path.join(t, "link", "o"),
                        os.path.join(main, ".git", "o")):
                self.assertEqual(self.main(out, "--stages", "layout"), 2, out)
                self.assertFalse(os.path.lexists(out), out)
            ok = os.path.join(t, "outside")
            self.assertEqual(self.main(ok, "--stages", "layout"), 0)
        with mock.patch.object(rs, "REPO", os.path.join(t, "fakebin")):  # not a git checkout: unverifiable
            out = os.path.join(t, "nogit")
            self.assertEqual(self.main(out, "--stages", "layout"), 2)
            self.assertFalse(os.path.exists(out))

    def test_classify(self):
        rows = [(11, "/Applications/Blender.app/Contents/MacOS/Blender -b x.blend"),
                (12, "/opt/blender-4.2/blender --background"),
                (13, "/Applications/Blender.app/Contents/PlugIns/blender-thumbnailer.appex/Contents/MacOS/blender-thumbnailer"),
                (14, "/Users/x/.cache/uv/bin/python /Users/x/.cache/uv/bin/blender-mcp"),
                (15, "/opt/homebrew/bin/ollama serve"),
                (16, "/opt/homebrew/bin/ollama runner --model m"),
                (17, "/usr/local/bin/llama-server -m q.gguf"),
                (18, "python/.venv/bin/python python/marlin_worker.py"),
                (19, "/opt/homebrew/bin/ffmpeg -i a.mp4 b.mp4"),
                (20, "/custom/bl5/bl -b"),
                (21, "grep ffmpeg")]
        block, report = rs.classify(rows, "/custom/bl5/bl")
        self.assertEqual(sorted(b["pid"] for b in block), [11, 12, 16, 17, 18, 19, 20])
        self.assertEqual(sorted(r["pid"] for r in report), [13, 14, 15])


if __name__ == "__main__":
    unittest.main(verbosity=2)
