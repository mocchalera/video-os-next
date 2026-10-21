"""Exercise real probe decisions without a VM or a model download."""
import importlib.util
import json
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("gpu_probe", Path(__file__).with_name("gpu_probe.py"))
gpu = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gpu)


def cuda(name="NVIDIA A100-SXM4-40GB", memory=40960):
    return {"returncode": 0, "stdout": json.dumps({"devices": [{"name": name, "memory_mib": memory}], "driver_api_version": 13000}), "stderr": ""}


class ProbeTests(unittest.TestCase):
    def run_probe(self, responses):
        commands, waits = [], []
        def run(argv):
            commands.append(argv)
            return responses[len(commands)-1]
        result = gpu.probe(run, waits.append)
        return result, commands, waits

    def test_nvml_error_six_is_retained_with_independent_cuda_proof(self):
        nvml = {"returncode": 6, "stdout": "No devices were found", "stderr": "query failed"}
        result, commands, waits = self.run_probe([nvml, cuda()])
        self.assertEqual(result["state"], "ready")
        self.assertEqual(result["verified_by"], "CUDA driver API")
        self.assertEqual(result["attempts"][0]["nvidia_smi"], nvml)
        self.assertEqual(len(commands), 2)
        self.assertEqual(waits, [])

    def test_no_cuda_stops_after_three_checks(self):
        error = {"returncode": 1, "stdout": "", "stderr": "cuInit returned CUDA error 100"}
        result, commands, waits = self.run_probe([error]*6)
        self.assertEqual(result["state"], "error")
        self.assertEqual(len(commands), 6)
        self.assertEqual(waits, [5, 5])

    def test_wrong_gpu_and_wrong_capacity_cannot_pass(self):
        nvml = {"returncode": 6, "stdout": "", "stderr": ""}
        for response in [cuda("NVIDIA T4", 15360), cuda(memory=81920)]:
            result, commands, _ = self.run_probe([nvml, response])
            self.assertEqual(result["state"], "error")
            self.assertEqual(len(commands), 2)

    def test_disagreeing_successful_nvml_is_rejected(self):
        nvml = {"returncode": 0, "stdout": "NVIDIA T4, 15360, 580.82.07", "stderr": ""}
        result, _, _ = self.run_probe([nvml, cuda()])
        self.assertEqual(result["state"], "error")

    def test_transient_cuda_error_can_recover_in_same_vm(self):
        fail = {"returncode": 1, "stdout": "", "stderr": "not ready"}
        ok = {"returncode": 0, "stdout": "NVIDIA A100-SXM4-40GB, 40960, 580.82.07", "stderr": ""}
        result, _, waits = self.run_probe([fail, fail, ok, cuda()])
        self.assertEqual(result["state"], "ready")
        self.assertEqual(waits, [5])

    def test_commands_are_bounded_and_timeout_is_preserved(self):
        with patch.object(gpu.subprocess, "run", side_effect=subprocess.TimeoutExpired("nvidia-smi", 12)) as run:
            result = gpu.command(["nvidia-smi"])
        self.assertIsNone(result["returncode"])
        self.assertIn("timeout", result["error"])
        self.assertEqual(run.call_args.kwargs["timeout"], 12)


if __name__ == "__main__":
    unittest.main()
