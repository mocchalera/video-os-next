"""Offline checks for colab_analysis_vm.py (no GPU, no network). Run: python3 python/test_colab_analysis_vm.py

The real Marlin worker is replaced by a tiny script with the same CLI and output contract."""
import hashlib
import json
import os
import sys
import tarfile
import tempfile
import textwrap
import threading
import time
import unittest
from pathlib import Path

HERE = Path(__file__).parent
SRC = (HERE / "colab_analysis_vm.py").read_text()

FAKE_WORKER = textwrap.dedent("""
    import json, os, sys, time
    if os.environ.get("FAKE_SLEEP"):
        time.sleep(float(os.environ["FAKE_SLEEP"]))
    vids = sys.argv[2:]
    if os.environ.get("FAKE_SKIP_LAST"):
        vids = vids[:-1]
    for v in vids:
        print(json.dumps({"ok": True, "model": os.environ.get("VOS_MARLIN_MODEL", "m"), "video": v,
                          "result": {"scene": "scene " + os.path.basename(v)[:8], "events": [{"start": 0, "end": 1, "description": "e"}]}}))
    print(json.dumps({"ok": True, "model": "m", "video": "/etc/passwd", "result": {}}))  # a stray path is ignored
""")


def sha(b):
    return hashlib.sha256(b).hexdigest()


class Kernel:
    """One fresh 'session kernel' with its own root."""

    def __init__(self):
        self.root = tempfile.mkdtemp()
        os.environ["VOSANA_ROOT"] = self.root
        os.environ["VOSANA_PYTHON"] = sys.executable
        self.ns = {"__name__": "vosana_kernel"}
        exec(SRC, self.ns)
        self.ns["STATE"]["boot"] = {"state": "ready", "versions": {"torch": "x"}, "profiles": {
            "marlin": {"model": "NemoStation/Marlin-2B", "revision": "r1", "dir": "/models/marlin"},
            "visual": {"model": "Qwen/Qwen3-VL-Embedding-2B", "revision": "v1", "dir": "/models/visual"}}}

    def put(self, data: bytes, ext: str):
        item = {"sha256": sha(data), "size": len(data), "ext": ext}
        Path(self.root, "in", f"{item['sha256']}.{ext}").write_bytes(data)
        return item

    def worker(self):
        return self.put(FAKE_WORKER.encode(), "py")

    def wait_done(self, jid, timeout=10):
        done = Path(self.root, "jobs", f"{jid}.done")
        t = time.time()
        while not done.exists():
            if time.time() - t > timeout:
                raise AssertionError(f"job {jid} never finished")
            time.sleep(0.02)
        return json.loads(Path(self.root, "jobs", f"{jid}.json").read_text())


class HaveTests(unittest.TestCase):
    def test_reports_present_inputs_and_removes_corrupt_ones(self):
        k = Kernel()
        good = k.put(b"video-a", "mp4")
        bad = k.put(b"video-b", "mp4")
        Path(k.root, "in", f"{bad['sha256']}.mp4").write_bytes(b"video-X")  # same size, different bytes
        missing = {"sha256": sha(b"nope"), "size": 4, "ext": "mp4"}
        k.ns["analysis_have"]({"token": "t", "items": [good, bad, missing]})
        out = json.loads(Path(k.root, "have", "t.json").read_text())
        self.assertEqual(out["present"], [good["sha256"]])
        self.assertFalse(Path(k.root, "in", f"{bad['sha256']}.mp4").exists(), "a corrupt upload is deleted so it is sent again")


class DescribeJobTests(unittest.TestCase):
    def test_answers_by_content_hash_with_a_checksum_of_the_result(self):
        k = Kernel()
        a, b = k.put(b"clip-a", "mp4"), k.put(b"clip-b", "mov")
        k.ns["analysis_submit"]({"id": "j1", "token": "t1", "kind": "describe", "inputs": [a, b], "worker": k.worker()})
        rep = k.wait_done("j1")
        self.assertEqual(rep["state"], "ok", rep.get("error"))
        body = Path(k.root, "jobs", "j1.jsonl").read_bytes()
        self.assertEqual(rep["files"]["jsonl"]["sha256"], hashlib.sha256(body).hexdigest())
        lines = [json.loads(x) for x in body.decode().splitlines()]
        self.assertEqual(sorted(x["sha256"] for x in lines), sorted([a["sha256"], b["sha256"]]))
        self.assertTrue(all("video" not in x for x in lines), "VM paths never leak into results")
        self.assertEqual(rep["profiles"]["marlin"]["revision"], "r1")

    def test_missing_or_corrupt_input_fails_the_job_and_names_it(self):
        k = Kernel()
        a = k.put(b"clip-a", "mp4")
        ghost = {"sha256": sha(b"ghost"), "size": 5, "ext": "mp4"}
        k.ns["analysis_submit"]({"id": "j2", "token": "t2", "kind": "describe", "inputs": [a, ghost], "worker": k.worker()})
        rep = k.wait_done("j2")
        self.assertEqual(rep["state"], "error")
        self.assertEqual(rep["missing_inputs"], [ghost["sha256"]])

    def test_a_worker_that_skips_an_input_is_an_error_not_a_partial_success(self):
        k = Kernel()
        os.environ["FAKE_SKIP_LAST"] = "1"
        try:
            a, b = k.put(b"clip-a", "mp4"), k.put(b"clip-b", "mp4")
            k.ns["analysis_submit"]({"id": "j3", "token": "t3", "kind": "describe", "inputs": [a, b], "worker": k.worker()})
            rep = k.wait_done("j3")
        finally:
            del os.environ["FAKE_SKIP_LAST"]
        self.assertEqual(rep["state"], "error")
        self.assertIn("1 of 2", rep["error"])

    def test_a_retried_submit_runs_once_and_cancel_kills_the_subprocess(self):
        k = Kernel()
        os.environ["FAKE_SLEEP"] = "30"
        try:
            a = k.put(b"clip-a", "mp4")
            job = {"id": "j4", "token": "t4", "kind": "describe", "inputs": [a], "worker": k.worker()}
            k.ns["analysis_submit"](job)
            k.ns["analysis_submit"](job)  # the retry after a dropped connection
            k.ns["analysis_submit"]({**job, "token": "other"})  # still running: not queued again
            for _ in range(200):
                if k.ns["_ACTIVE"].get("j4") is not None:
                    break
                time.sleep(0.02)
            self.assertEqual(k.ns["_JOBS"].qsize(), 0, "queued once: nothing left behind the running job")
            t = time.time()
            k.ns["analysis_cancel"]({"id": "j4"})
            rep = k.wait_done("j4")
            self.assertLess(time.time() - t, 5, "cancel is not a 30 s wait")
        finally:
            del os.environ["FAKE_SLEEP"]
        self.assertEqual(rep["state"], "error")
        self.assertIn("cancelled", rep["error"])

    def test_worker_hash_is_checked_like_any_input(self):
        k = Kernel()
        w = k.worker()
        Path(k.root, "in", f"{w['sha256']}.py").write_text("print('tampered')" + " " * (w["size"] - 17))
        a = k.put(b"clip-a", "mp4")
        k.ns["analysis_submit"]({"id": "j5", "token": "t5", "kind": "describe", "inputs": [a], "worker": w})
        rep = k.wait_done("j5")
        self.assertEqual(rep["state"], "error")
        self.assertIn("worker", rep["error"])


FAKE_EMBED = textwrap.dedent("""
    import hashlib, json, os, struct, sys
    ch, req, out = sys.argv[1:]
    items = json.load(open(req))["items"]
    if os.environ.get("FAKE_SHORT"):
        items = items[:-1]
    rows = []
    for it in items:
        key = it["text"] if it["kind"] == "text" else open(it["path"], "rb").read().decode()
        h = hashlib.sha256(key.encode()).digest()
        rows.append([b / 255.0 for b in h[:8]])
    with open(out, "wb") as f:
        for r in rows:
            f.write(struct.pack("<8f", *r))
    print(json.dumps({"ok": True, "dim": 8, "n": len(rows), "model": os.environ.get("VOS_VISUAL_MODEL"), "device": "cpu"}))
""")


def frames_tar(k, frames):
    import io
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as t:
        for name, data in frames.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            t.addfile(info, io.BytesIO(data))
    return k.put(buf.getvalue(), "tar")


class EmbedJobTests(unittest.TestCase):
    def test_frames_travel_as_one_tarball_and_rows_come_back_in_item_order(self):
        k = Kernel()
        tar = frames_tar(k, {"00001.jpg": b"frame-1", "00002.jpg": b"frame-2"})
        img = k.put(b"a still", "png")
        w = k.put(FAKE_EMBED.encode(), "py")
        items = [{"kind": "image", "input": tar["sha256"], "member": "00002.jpg"}, {"kind": "image", "input": tar["sha256"], "member": "00001.jpg"},
                 {"kind": "image", "input": img["sha256"]}, {"kind": "text", "text": "a query", "role": "query"}]
        k.ns["analysis_submit"]({"id": "e1", "token": "e1", "kind": "embed", "channel": "visual", "inputs": [tar, img], "items": items, "worker": w})
        rep = k.wait_done("e1")
        self.assertEqual(rep["state"], "ok", rep.get("error"))
        self.assertEqual((rep["n"], rep["dim"]), (4, 8))
        self.assertEqual(rep["worker_model"], "/models/visual", "the snapshot the boot downloaded")
        data = Path(rep["files"]["f32"]["path"]).read_bytes()
        self.assertEqual(rep["files"]["f32"]["sha256"], hashlib.sha256(data).hexdigest())
        import struct
        rows = [struct.unpack("<8f", data[i * 32:(i + 1) * 32]) for i in range(4)]
        expect = lambda key: tuple(b / 255.0 for b in hashlib.sha256(key.encode()).digest()[:8])
        for got, key in zip(rows, ["frame-2", "frame-1", "a still", "a query"]):
            self.assertEqual([round(x, 5) for x in got], [round(x, 5) for x in expect(key)])

    def test_an_archive_with_a_path_member_is_refused(self):
        k = Kernel()
        tar = frames_tar(k, {"../evil.jpg": b"x"})
        w = k.put(FAKE_EMBED.encode(), "py")
        k.ns["analysis_submit"]({"id": "e2", "token": "e2", "kind": "embed", "channel": "visual", "inputs": [tar],
                                 "items": [{"kind": "image", "input": tar["sha256"], "member": "../evil.jpg"}], "worker": w})
        rep = k.wait_done("e2")
        self.assertEqual(rep["state"], "error")
        self.assertIn("unexpected member", rep["error"])

    def test_short_output_and_unknown_inputs_are_errors(self):
        k = Kernel()
        img = k.put(b"a still", "png")
        w = k.put(FAKE_EMBED.encode(), "py")
        k.ns["analysis_submit"]({"id": "e3", "token": "e3", "kind": "embed", "channel": "visual", "inputs": [img],
                                 "items": [{"kind": "image", "input": "f" * 64}], "worker": w})
        self.assertIn("not sent", k.wait_done("e3")["error"])
        os.environ["FAKE_SHORT"] = "1"
        try:
            k.ns["analysis_submit"]({"id": "e4", "token": "e4", "kind": "embed", "channel": "visual", "inputs": [img],
                                     "items": [{"kind": "image", "input": img["sha256"]}, {"kind": "text", "text": "q"}], "worker": w})
            self.assertIn("1 of 2", k.wait_done("e4")["error"])
        finally:
            del os.environ["FAKE_SHORT"]

    def test_a_session_without_the_profile_says_how_to_get_it(self):
        k = Kernel()
        del k.ns["STATE"]["boot"]["profiles"]["visual"]
        img = k.put(b"a still", "png")
        k.ns["analysis_submit"]({"id": "e5", "token": "e5", "kind": "embed", "channel": "visual", "inputs": [img],
                                 "items": [{"kind": "image", "input": img["sha256"]}], "worker": k.put(FAKE_EMBED.encode(), "py")})
        self.assertIn("--profile", k.wait_done("e5")["error"])


class TokenTests(unittest.TestCase):
    def _boot(self, fail):
        import types
        k = Kernel()
        seen = {}

        def snapshot_download(repo, revision, local_dir, token=None):
            seen["token"] = token
            if fail:
                raise RuntimeError("401 gated")
            os.makedirs(local_dir, exist_ok=True)

        sys.modules["huggingface_hub"] = types.SimpleNamespace(snapshot_download=snapshot_download)
        tok = Path(k.root, ".hf_token")
        tok.write_text("hf_secret_value\n")
        try:
            k.ns["_bootstrap"]({"profiles": [{"name": "marlin", "model": "NemoStation/Marlin-2B", "revision": "r1"}], "token_file": str(tok)})
        finally:
            del sys.modules["huggingface_hub"]
        return k, tok, seen

    def test_token_is_used_for_the_download_then_deleted_and_never_recorded(self):
        k, tok, seen = self._boot(fail=False)
        self.assertEqual(seen["token"], "hf_secret_value")
        self.assertFalse(tok.exists())
        boot = Path(k.root, "boot.json").read_text()
        self.assertEqual(json.loads(boot)["state"], "ready")
        self.assertNotIn("hf_secret_value", boot)

    def test_token_is_deleted_even_when_the_download_fails(self):
        k, tok, _ = self._boot(fail=True)
        self.assertFalse(tok.exists())
        boot = Path(k.root, "boot.json").read_text()
        self.assertEqual(json.loads(boot)["state"], "error")
        self.assertNotIn("hf_secret_value", boot)


class ReloadTests(unittest.TestCase):
    def test_reloading_keeps_one_worker_and_the_token_memory(self):
        k = Kernel()
        first = k.ns["_WORKER"]
        exec(SRC, k.ns)
        self.assertIs(k.ns["_WORKER"], first)
        self.assertTrue(isinstance(threading.enumerate(), list))


if __name__ == "__main__":
    unittest.main(verbosity=1)
