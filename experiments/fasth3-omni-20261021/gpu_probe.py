"""Bounded, stdlib-only A100 readiness check, run before any model downloads."""
import json
import os
import subprocess
import sys
import time

CUDA_QUERY = r'''
import ctypes as c, json
lib = c.CDLL("libcuda.so.1")
def call(name, args, *values):
    fn = getattr(lib, name); fn.argtypes = args; fn.restype = c.c_int
    code = fn(*values)
    if code: raise RuntimeError(name + " returned CUDA error " + str(code))
call("cuInit", [c.c_uint], 0)
count, version = c.c_int(), c.c_int()
call("cuDeviceGetCount", [c.POINTER(c.c_int)], c.byref(count))
call("cuDriverGetVersion", [c.POINTER(c.c_int)], c.byref(version))
devices = []
for ordinal in range(count.value):
    device, memory, name = c.c_int(), c.c_size_t(), c.create_string_buffer(256)
    call("cuDeviceGet", [c.POINTER(c.c_int), c.c_int], c.byref(device), ordinal)
    call("cuDeviceGetName", [c.c_char_p, c.c_int, c.c_int], name, len(name), device)
    call("cuDeviceTotalMem_v2", [c.POINTER(c.c_size_t), c.c_int], c.byref(memory), device)
    devices.append({"name": name.value.decode(), "memory_mib": memory.value / 1048576})
print(json.dumps({"devices": devices, "driver_api_version": version.value}))
'''


def command(argv):
    try:
        r = subprocess.run(argv, capture_output=True, text=True, timeout=12)
        return {"returncode": r.returncode, "stdout": r.stdout[-4000:], "stderr": r.stderr[-4000:]}
    except subprocess.TimeoutExpired:
        return {"returncode": None, "error": "12-second timeout"}
    except OSError as exc:
        return {"returncode": None, "error": str(exc)}


def probe(run=command, sleep=time.sleep):
    report = {"state": "error", "expected": "one A100 40GB", "attempts": []}
    for attempt in range(3):
        nvml = run(["nvidia-smi", "--query-gpu=name,memory.total,driver_version", "--format=csv,noheader,nounits"])
        cuda = run([sys.executable, "-c", CUDA_QUERY])
        report["attempts"].append({"nvidia_smi": nvml, "cuda_driver": cuda})
        try:
            if cuda["returncode"] != 0:
                raise ValueError("CUDA driver query did not succeed")
            data = json.loads(cuda["stdout"])
            devices = data["devices"]
            if len(devices) != 1 or "A100" not in devices[0]["name"] or not 39000 <= devices[0]["memory_mib"] <= 45000:
                report["error"] = "CUDA device does not match one A100 40GB"
                return report
            if nvml["returncode"] == 0:
                rows = nvml["stdout"].strip().splitlines()
                fields = rows[0].split(",")
                if len(rows) != 1 or len(fields) != 3 or "A100" not in fields[0] or not 39000 <= float(fields[1]) <= 45000:
                    report["error"] = "NVML and CUDA device reports disagree"
                    return report
            report.update(state="ready", cuda=data, verified_by="CUDA driver API")
            if nvml["returncode"] != 0:
                report["warning"] = "nvidia-smi failed; GPU identity and memory verified independently through CUDA"
            return report
        except (KeyError, ValueError, TypeError) as exc:
            report["error"] = str(exc)
        if attempt < 2:
            sleep(5)
    return report


def write_probe():
    report = probe()
    target = "/content/vosgen/hardware.json"
    os.makedirs(os.path.dirname(target), exist_ok=True)
    with open(target + ".tmp", "w") as f:
        json.dump(report, f)
    os.replace(target + ".tmp", target)
    print(json.dumps({"gpu_probe": report["state"]}))
