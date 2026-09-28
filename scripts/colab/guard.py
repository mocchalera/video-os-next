"""vos-colab guard: every billable Colab VM runs under a lease that stops it unless someone keeps it alive.

Why: in the H3 spike a `colab exec` hung for ~6 h while the VM idled at 5.30 CU/h (≈33 CU wasted),
the budget monitor only warned, and the orphaned assignment was invisible to `colab stop`.

Model
  * A session is started only through `start`, which writes a ledger and spawns a detached supervisor.
  * The ledger carries a **lease** (dead-man switch). `exec`, `wait` and `renew` extend it. If the agent
    hangs, crashes or ends its turn, the lease runs out and the supervisor stops the VM.
  * The supervisor also stops on: hard deadline (`--max-hours`), budget (`--budget-cu`, from the balance
    drop *or* rate × elapsed, whichever is larger), and a session that vanished server-side.
  * Stopping = `colab stop`, then unassign any remaining endpoint directly, then verify it is gone.
  * `exec` enforces a hard wall-clock timeout from outside the colab client (the client itself can hang).
  * `reap` finds server-side assignments no ledger owns (`[?]` in `colab sessions`) and releases them.

Run with the colab CLI's interpreter (the `vos-colab` shim does this). Ledgers: ~/.config/vos/colab/<name>.json
"""
from __future__ import annotations

import argparse
import json
import os
import re
import signal
import subprocess
import sys
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path

HOME = Path(os.environ.get("VOS_COLAB_HOME", Path.home() / ".config/vos/colab"))
TICK_SEC = float(os.environ.get("VOS_COLAB_TICK", "30"))


# ---------------------------------------------------------------- ledger

@dataclass
class Ledger:
    name: str
    gpu: str
    created_at: float
    start_balance: float
    budget_cu: float
    max_until: float
    lease_min: float
    lease_until: float
    endpoint: str | None = None
    rate_cu_h: float = 0.0
    supervisor_pid: int | None = None
    state: str = "starting"  # starting | running | stopping | stopped
    stop_reason: str | None = None
    events: list = field(default_factory=list)

    def event(self, kind: str, **data) -> None:
        self.events.append({"t": round(time.time(), 1), "kind": kind, **data})


def ledger_path(name: str) -> Path:
    return HOME / f"{name}.json"


def load(name: str) -> Ledger | None:
    p = ledger_path(name)
    if not p.exists():
        return None
    return Ledger(**json.loads(p.read_text()))


def save(led: Ledger) -> None:
    HOME.mkdir(parents=True, exist_ok=True)
    tmp = ledger_path(led.name).with_suffix(".tmp")
    tmp.write_text(json.dumps(asdict(led), indent=1))
    tmp.replace(ledger_path(led.name))


def all_ledgers() -> list[Ledger]:
    if not HOME.exists():
        return []
    return [l for p in sorted(HOME.glob("*.json")) if (l := load(p.stem))]


# ---------------------------------------------------------------- policy (pure, unit-tested)

def spent(led: Ledger, balance: float | None, now: float) -> float:
    by_balance = (led.start_balance - balance) if balance is not None else 0.0
    by_rate = led.rate_cu_h * (now - led.created_at) / 3600.0
    return max(by_balance, by_rate)


def decide(led: Ledger, now: float, balance: float | None, endpoints: set[str] | None) -> str | None:
    """Return a stop reason, or None to keep running. Order = most important first."""
    if led.state in ("stopped",):
        return None
    if spent(led, balance, now) >= led.budget_cu:
        return "budget"
    if now >= led.max_until:
        return "deadline"
    if now >= led.lease_until:
        return "lease_expired"
    if endpoints is not None and led.endpoint and led.endpoint not in endpoints:
        return "vanished"
    return None


# ---------------------------------------------------------------- backend (the only code that talks to Colab)

class ColabBackend:
    def __init__(self, colab: str = "colab") -> None:
        self.colab = colab

    def _run(self, args: list[str], timeout: float) -> subprocess.CompletedProcess:
        return subprocess.run([self.colab, *args], capture_output=True, text=True, timeout=timeout)

    def usage(self) -> tuple[float | None, float | None]:
        try:
            out = self._run(["usage"], 60).stdout
        except subprocess.TimeoutExpired:
            return None, None
        bal = re.search(r"Current balance:\s*([\d.]+)", out)
        rate = re.search(r"Usage rate:\s*([\d.]+)", out)
        return (float(bal.group(1)) if bal else None, float(rate.group(1)) if rate else None)

    def endpoints(self) -> set[str] | None:
        try:
            from colab_cli.common import state
            return {a.endpoint for a in state.client.list_assignments()}
        except Exception:  # noqa: BLE001 - unknown is not "empty"
            return None

    def local_endpoint(self, name: str) -> str | None:
        try:
            from colab_cli.common import state
            s = state.store.get(name)
            return getattr(s, "endpoint", None) if s else None
        except Exception:  # noqa: BLE001
            return None

    def new(self, name: str, gpu: str, timeout: float) -> subprocess.CompletedProcess:
        args = ["new", "-s", name] + (["--gpu", gpu] if gpu and gpu != "cpu" else [])
        return self._run(args, timeout)

    def stop(self, name: str) -> None:
        try:
            self._run(["stop", "-s", name], 120)
        except subprocess.TimeoutExpired:
            pass

    def unassign(self, endpoint: str) -> None:
        from colab_cli.common import state
        state.client.unassign(endpoint)

    def exec_file(self, name: str, file: str, timeout: float, grace: float = 30.0) -> int:
        """Stream output; kill the whole client process group at the hard timeout."""
        p = subprocess.Popen([self.colab, "exec", "-s", name, "--timeout", str(int(timeout)), "-f", file],
                             start_new_session=True)
        try:
            return p.wait(timeout=timeout + grace)
        except subprocess.TimeoutExpired:
            os.killpg(p.pid, signal.SIGKILL)
            p.wait()
            return 124


# ---------------------------------------------------------------- actions

def stop_session(led: Ledger, be, reason: str) -> Ledger:
    led.state, led.stop_reason = "stopping", reason
    led.event("stop", reason=reason)
    save(led)
    be.stop(led.name)
    for _ in range(3):
        eps = be.endpoints()
        if eps is not None and (not led.endpoint or led.endpoint not in eps):
            break
        if led.endpoint:
            try:
                be.unassign(led.endpoint)
                led.event("unassign", endpoint=led.endpoint)
            except Exception as e:  # noqa: BLE001
                led.event("unassign_error", error=str(e)[:300])
        time.sleep(5)
    eps = be.endpoints()
    released = eps is not None and (not led.endpoint or led.endpoint not in eps)
    led.state = "stopped" if released else "stopping"
    led.event("stopped" if released else "stop_unverified")
    save(led)
    return led


def supervise(name: str, be, tick: float = TICK_SEC, once: bool = False) -> str | None:
    while True:
        led = load(name)
        if led is None or led.state == "stopped":
            return None
        now = time.time()
        balance, rate = be.usage()
        if rate:
            led.rate_cu_h = max(led.rate_cu_h, rate)
        endpoints = be.endpoints()
        reason = decide(led, now, balance, endpoints)
        if reason:
            stop_session(led, be, reason)
            return reason
        save(led)
        if once:
            return None
        time.sleep(tick)


def cmd_start(a, be) -> int:
    if (old := load(a.name)) and old.state != "stopped":
        print(json.dumps({"ok": False, "error": f"session {a.name} already {old.state}"}))
        return 2
    orphans = find_orphans(be)
    if orphans:
        print(json.dumps({"ok": False, "error": "orphaned assignments are billing; run reap first", "orphans": sorted(orphans)}))
        return 2
    balance, _ = be.usage()
    if balance is None:
        print(json.dumps({"ok": False, "error": "could not read CU balance; refusing to start unguarded"}))
        return 2
    now = time.time()
    led = Ledger(name=a.name, gpu=a.gpu, created_at=now, start_balance=balance, budget_cu=a.budget_cu,
                 max_until=now + a.max_hours * 3600, lease_min=a.lease_min, lease_until=now + a.lease_min * 60)
    led.event("start", balance=balance)
    save(led)
    led.supervisor_pid = spawn_supervisor(a.name)
    save(led)
    before = be.endpoints() or set()
    try:
        r = be.new(a.name, a.gpu, a.new_timeout)
        ok = r.returncode == 0
        led.event("new", rc=r.returncode, err=r.stderr[-300:])
    except subprocess.TimeoutExpired:
        ok = False
        led.event("new_timeout")
    led.endpoint = be.local_endpoint(a.name)
    if not led.endpoint:  # `new` hung or lost its local record: adopt whatever appeared
        fresh = (be.endpoints() or set()) - before
        led.endpoint = next(iter(fresh), None)
    led.state = "running" if ok else "stopping"
    save(led)
    if not ok:
        stop_session(led, be, "start_failed")
        print(json.dumps({"ok": False, "error": "colab new failed; any allocation was released", "ledger": str(ledger_path(a.name))}))
        return 1
    print(json.dumps({"ok": True, "name": a.name, "endpoint": led.endpoint, "balance": balance,
                      "budget_cu": a.budget_cu, "lease_min": a.lease_min, "max_hours": a.max_hours}))
    return 0


def spawn_supervisor(name: str) -> int:
    HOME.mkdir(parents=True, exist_ok=True)
    log = open(HOME / f"{name}.supervisor.log", "a")
    p = subprocess.Popen([sys.executable, os.path.abspath(__file__), "_supervise", name],
                         stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, start_new_session=True)
    return p.pid


def renew(name: str, minutes: float | None = None) -> Ledger:
    led = load(name)
    if led is None or led.state != "running":
        raise SystemExit(json.dumps({"ok": False, "error": f"no running guarded session {name}"}))
    led.lease_until = max(led.lease_until, time.time() + (minutes or led.lease_min) * 60)
    save(led)
    return led


def cmd_exec(a, be) -> int:
    renew(a.name, max(a.timeout / 60 + 5, 0))
    rc = be.exec_file(a.name, a.file, a.timeout)
    renew(a.name)
    if rc == 124:
        print(f"[vos-colab] exec killed after {a.timeout:.0f}s hard timeout", file=sys.stderr)
    return rc


KEEPALIVE_CODE = "pass  # vos-colab keep-alive: kernel activity so Colab does not reclaim an idle-looking runtime\n"


def keepalive_file() -> str:
    f = HOME / "keepalive.py"
    HOME.mkdir(parents=True, exist_ok=True)
    if not f.exists():
        f.write_text(KEEPALIVE_CODE)
    return str(f)


def cmd_wait(a, be) -> int:
    """Poll for a file on the VM, renewing the lease while waiting (for background jobs).

    Colab reclaims a runtime whose kernel has run nothing for ~20 minutes, even while a background job (ComfyUI,
    a worker) is busy on the GPU; polling files does not count as activity. So every `--keepalive` seconds (0 = off)
    run a no-op in the kernel. Measured 2026-09-29: VMs vanished 21-22 min after the last kernel exec, mid-job."""
    deadline = time.time() + a.timeout
    last_ping = time.time()
    while time.time() < deadline:
        renew(a.name)
        if a.keepalive > 0 and time.time() - last_ping >= a.keepalive:
            rc = be.exec_file(a.name, keepalive_file(), 60)
            print(json.dumps({"keepalive": rc}), file=sys.stderr)
            last_ping = time.time()
        r = subprocess.run([be.colab, "ls", "-s", a.name, os.path.dirname(a.path)], capture_output=True, text=True, timeout=60)
        if os.path.basename(a.path) in r.stdout.split():
            print(json.dumps({"ok": True, "found": a.path}))
            return 0
        time.sleep(a.every)
    print(json.dumps({"ok": False, "error": "wait timed out", "path": a.path}))
    return 124


def find_orphans(be) -> set[str]:
    eps = be.endpoints() or set()
    owned = {l.endpoint for l in all_ledgers() if l.state != "stopped" and l.endpoint}
    return eps - owned


def cmd_reap(a, be) -> int:
    orphans = find_orphans(be)
    released = []
    if not a.dry_run:
        for ep in orphans:
            be.unassign(ep)
            released.append(ep)
    print(json.dumps({"ok": True, "orphans": sorted(orphans), "released": released}))
    return 0


def cmd_status(a, be) -> int:
    balance, rate = be.usage()
    now = time.time()
    rows = []
    for l in all_ledgers():
        if a.name and l.name != a.name:
            continue
        alive = False
        if l.supervisor_pid:
            try:
                os.kill(l.supervisor_pid, 0)
                alive = True
            except OSError:
                pass
        rows.append({"name": l.name, "state": l.state, "stop_reason": l.stop_reason, "endpoint": l.endpoint,
                     "spent_cu": round(spent(l, balance, now), 2) if l.state != "stopped" else None,
                     "budget_cu": l.budget_cu, "lease_left_min": round((l.lease_until - now) / 60, 1),
                     "deadline_left_min": round((l.max_until - now) / 60, 1), "supervisor_alive": alive})
    print(json.dumps({"ok": True, "balance": balance, "rate_cu_h": rate, "orphans": sorted(find_orphans(be)), "sessions": rows}, indent=1))
    return 0


def main(argv: list[str] | None = None, be=None) -> int:
    be = be or ColabBackend()
    ap = argparse.ArgumentParser(prog="vos-colab")
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("start")
    s.add_argument("name")
    s.add_argument("--gpu", default="A100")
    s.add_argument("--budget-cu", type=float, required=True)
    s.add_argument("--max-hours", type=float, default=2.0)
    s.add_argument("--lease-min", type=float, default=15.0)
    s.add_argument("--new-timeout", type=float, default=600.0)
    e = sub.add_parser("exec")
    e.add_argument("name")
    e.add_argument("-f", "--file", required=True)
    e.add_argument("--timeout", type=float, default=300.0)
    w = sub.add_parser("wait")
    w.add_argument("name")
    w.add_argument("path")
    w.add_argument("--timeout", type=float, default=1800.0)
    w.add_argument("--every", type=float, default=30.0)
    w.add_argument("--keepalive", type=float, default=300.0, help="seconds between no-op kernel execs (0 = off)")
    r = sub.add_parser("renew")
    r.add_argument("name")
    r.add_argument("--minutes", type=float)
    st = sub.add_parser("stop")
    st.add_argument("name")
    rp = sub.add_parser("reap")
    rp.add_argument("--dry-run", action="store_true")
    ss = sub.add_parser("status")
    ss.add_argument("name", nargs="?")
    sv = sub.add_parser("_supervise")
    sv.add_argument("name")
    a = ap.parse_args(argv)

    if a.cmd == "start":
        return cmd_start(a, be)
    if a.cmd == "exec":
        return cmd_exec(a, be)
    if a.cmd == "wait":
        return cmd_wait(a, be)
    if a.cmd == "renew":
        led = renew(a.name, a.minutes)
        print(json.dumps({"ok": True, "lease_left_min": round((led.lease_until - time.time()) / 60, 1)}))
        return 0
    if a.cmd == "stop":
        led = load(a.name)
        if led is None:
            print(json.dumps({"ok": False, "error": f"no ledger for {a.name}"}))
            return 2
        led = stop_session(led, be, "manual")
        print(json.dumps({"ok": led.state == "stopped", "state": led.state}))
        return 0 if led.state == "stopped" else 1
    if a.cmd == "reap":
        return cmd_reap(a, be)
    if a.cmd == "status":
        return cmd_status(a, be)
    if a.cmd == "_supervise":
        supervise(a.name, be)
        return 0
    return 2


if __name__ == "__main__":
    sys.exit(main())
