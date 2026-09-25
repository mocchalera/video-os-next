"""Offline tests for guard.py (fake backend, no Colab, no CU). Run: python3 scripts/colab/test_guard.py"""
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

os.environ["VOS_COLAB_HOME"] = tempfile.mkdtemp()
sys.path.insert(0, str(Path(__file__).parent))
import guard  # noqa: E402

guard.spawn_supervisor = lambda name: None  # tests drive supervise() directly
guard.time.sleep = lambda s: None


class FakeBackend:
    colab = "false"

    def __init__(self, balance=200.0, rate=5.3):
        self.balance, self.rate = balance, rate
        self.assigned: dict[str, str] = {}  # endpoint -> name
        self.stop_works = True
        self.new_hangs = False
        self.calls: list = []

    def usage(self):
        return self.balance, (self.rate if self.assigned else 0.0)

    def endpoints(self):
        return set(self.assigned)

    def local_endpoint(self, name):
        return next((e for e, n in self.assigned.items() if n == name), None)

    def new(self, name, gpu, timeout):
        ep = f"gpu-{name}-ep"
        self.assigned[ep] = name
        if self.new_hangs:  # allocation happened, but the client hung and kept no local record
            self.assigned[ep] = None
            raise subprocess.TimeoutExpired("colab new", timeout)
        return subprocess.CompletedProcess([], 0, "", "")

    def stop(self, name):
        self.calls.append(("stop", name))
        if self.stop_works:
            for e in [e for e, n in self.assigned.items() if n == name]:
                del self.assigned[e]

    def unassign(self, endpoint):
        self.calls.append(("unassign", endpoint))
        self.assigned.pop(endpoint, None)

    def exec_file(self, name, file, timeout):
        return 0


def start(be, name, **kw):
    args = ["start", name, "--budget-cu", str(kw.get("budget", 15)), "--lease-min", str(kw.get("lease", 15)),
            "--max-hours", str(kw.get("hours", 2))]
    return guard.main(args, be)


class PolicyTests(unittest.TestCase):
    def led(self, **kw):
        now = 1000.0
        base = dict(name="x", gpu="A100", created_at=now, start_balance=200, budget_cu=15, max_until=now + 7200,
                    lease_min=15, lease_until=now + 900, endpoint="ep", rate_cu_h=5.3, state="running")
        base.update(kw)
        return guard.Ledger(**base)

    def test_keeps_running_when_healthy(self):
        self.assertIsNone(guard.decide(self.led(), 1060, 199.9, {"ep"}))

    def test_budget_by_balance(self):
        self.assertEqual(guard.decide(self.led(), 1060, 185.0, {"ep"}), "budget")

    def test_budget_by_rate_when_balance_lags(self):
        # 3 h at 5.3/h = 15.9 CU even though the balance has not moved yet
        self.assertEqual(guard.decide(self.led(max_until=1e9, lease_until=1e9), 1000 + 3 * 3600, 200.0, {"ep"}), "budget")

    def test_lease_expired_is_the_hang_case(self):
        self.assertEqual(guard.decide(self.led(), 1000 + 901, 199.0, {"ep"}), "lease_expired")

    def test_deadline(self):
        self.assertEqual(guard.decide(self.led(lease_until=1e9, budget_cu=1e9), 1000 + 7201, 199.0, {"ep"}), "deadline")

    def test_vanished(self):
        self.assertEqual(guard.decide(self.led(), 1060, 199.9, set()), "vanished")

    def test_unknown_endpoints_is_not_vanished(self):
        self.assertIsNone(guard.decide(self.led(), 1060, 199.9, None))


class FlowTests(unittest.TestCase):
    def setUp(self):
        for p in guard.HOME.glob("*"):
            p.unlink()

    def test_lease_expiry_stops_vm(self):
        be = FakeBackend()
        self.assertEqual(start(be, "a", lease=15), 0)
        led = guard.load("a")
        led.lease_until = time.time() - 1  # agent went silent
        guard.save(led)
        self.assertEqual(guard.supervise("a", be, once=True), "lease_expired")
        self.assertEqual(be.assigned, {})
        self.assertEqual(guard.load("a").state, "stopped")

    def test_renew_keeps_it_alive(self):
        be = FakeBackend()
        start(be, "b")
        guard.renew("b")
        self.assertIsNone(guard.supervise("b", be, once=True))
        self.assertTrue(be.assigned)

    def test_stop_falls_back_to_unassign(self):
        be = FakeBackend()
        start(be, "c")
        be.stop_works = False
        guard.stop_session(guard.load("c"), be, "manual")
        self.assertIn(("unassign", "gpu-c-ep"), be.calls)
        self.assertEqual(guard.load("c").state, "stopped")

    def test_hung_new_is_adopted_and_released(self):
        be = FakeBackend()
        be.new_hangs = True
        self.assertEqual(start(be, "d"), 1)
        self.assertEqual(be.assigned, {})
        self.assertEqual(guard.load("d").stop_reason, "start_failed")

    def test_start_refuses_with_orphans_and_reap_releases(self):
        be = FakeBackend()
        be.assigned["orphan-ep"] = None
        self.assertEqual(start(be, "e"), 2)
        guard.main(["reap"], be)
        self.assertEqual(be.assigned, {})
        self.assertEqual(start(be, "e"), 0)

    def test_start_refuses_without_balance(self):
        be = FakeBackend(balance=None)
        self.assertEqual(start(be, "f"), 2)
        self.assertEqual(be.assigned, {})


class HardTimeoutTest(unittest.TestCase):
    def test_hanging_client_is_killed(self):
        """The spike failure: a colab client that never returns. It (and its children) must be killed."""
        d = Path(tempfile.mkdtemp())
        fake = d / "colab"
        fake.write_text("#!/bin/sh\nsleep 300 &\nsleep 300\n")
        fake.chmod(0o755)
        be = guard.ColabBackend(colab=str(fake))
        t = time.monotonic()
        rc = be.exec_file("x", "f.py", timeout=1, grace=1)
        self.assertEqual(rc, 124)
        self.assertLess(time.monotonic() - t, 10)
        left = subprocess.run(["pgrep", "-f", str(fake)], capture_output=True, text=True).stdout.strip()
        self.assertEqual(left, "")


if __name__ == "__main__":
    unittest.main(verbosity=1)
