"""Offline FastH3 contract checks. No ComfyUI, model downloads or paid compute."""
import copy
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

os.environ["VOSGEN_ROOT"] = tempfile.mkdtemp(prefix="vos-fasth3-test-")
HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import colab_gen_vm as vm  # noqa: E402

ROOT = HERE.parent


def request():
    # Exercise the actual local builder, so the two languages cannot drift apart unnoticed.
    code = ('import {buildRequest} from "./src/gen/colab.ts"; '
            'console.log(JSON.stringify(buildRequest({model:"fasth3-omni",prompt:"x",refs:[{asset:"a",at:0}]})));')
    r = json.loads(subprocess.check_output(["node", "--no-warnings", "--input-type=module", "-e", code], cwd=ROOT))
    return {**r, "ref_images": ["ref.png"]}


class FastH3Tests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.req = request()

    def test_recipe_matches_the_immutable_official_template(self):
        fixture = json.loads((ROOT / "tests/fixtures/fasth3-omni-recipe.json").read_text())
        nodes = {n["type"]: n["values"] for n in fixture["nodes"]}
        g = vm.graph(self.req)
        self.assertEqual(g["unet"]["inputs"]["unet_name"], nodes["UNETLoader"][0])
        self.assertEqual(g["sampler"]["inputs"]["sampler_name"], nodes["KSamplerSelect"][0])
        self.assertEqual(g["sched"]["inputs"]["steps"], nodes["BasicScheduler"][1])
        self.assertEqual(g["sched"]["inputs"]["scheduler"], nodes["BasicScheduler"][0])
        self.assertEqual([g["shift"]["inputs"]["shift_video"], g["shift"]["inputs"]["shift_audio"]], nodes["MiniMaxH3SigmaShift"])
        self.assertEqual(g["backend"]["inputs"], {"model": ["shift", 0], "attention": nodes["ModelAttentionBackend"][0]})
        sparse = g["sparse"]["inputs"]
        self.assertEqual([sparse["selection"], sparse["selection.keep_percent"], sparse["start_percent"], sparse["end_percent"],
                          sparse["dense_blocks"], sparse["min_tokens"], sparse["extra_tokens"], sparse["sink_conditioning"], sparse["verbose"]],
                         nodes["BlockSparseAttention"])
        self.assertEqual(sparse["model"], ["backend", 0])
        self.assertEqual(g["shift"]["inputs"]["model"], ["unet", 0])
        self.assertNotIn("lora", g)
        self.assertEqual(g["guider"]["inputs"], {"model": ["sparse", 0], "conditioning": ["cond", 0]})
        self.assertEqual(g["sched"]["inputs"]["model"], ["sparse", 0])
        self.assertEqual(g["cond"]["class_type"], "MiniMaxH3ReferenceToVideo")
        self.assertEqual(g["cond"]["inputs"]["ref_images.ref_image_0"], ["ref_0", 0])
        self.assertEqual(g["sample"]["inputs"]["latent_image"], ["cond", 1])
        self.assertEqual(g["video"]["inputs"]["audio"], ["adec", 0])
        for k, v in vm.FASTH3.items():
            self.assertEqual(self.req[k], v, k)

    def test_worker_rejects_unvalidated_requests(self):
        for extra in ({"lora": "turbo"}, {"sol_tau": 1.3}, {"steps": 4}, {"sampler": "res_multistep"},
                      {"vsa_keep_percent": 20}, {"weights_rev": "main"}, {"ref_images": []},
                      {"guide_images": [{"image": "a.png", "at": 0}]}, {"guide_audios": [{"audio": "a.wav", "at": 0}]},
                      {"first_image": "a.png"}, {"control_video": "a.mp4"}):
            with self.subTest(extra=extra), self.assertRaises(ValueError):
                vm.graph({**self.req, **extra})

    def test_native_backend_is_required_without_a_silent_fallback(self):
        required = {
            "MiniMaxH3SigmaShift": ("model", "shift_video", "shift_audio"),
            "MiniMaxH3ReferenceToVideo": ("clip", "prompt", "width", "height", "length"),
            "BlockSparseAttention": ("model", "selection", "start_percent", "end_percent"),
            "ModelAttentionBackend": ("model", "attention"),
        }
        info = {cls: {"input": {"required": {n: ["MODEL"] for n in names}}} for cls, names in required.items()}
        info["ModelAttentionBackend"]["input"]["required"]["attention"] = [["pytorch attention", "comfy kitchen attention"]]
        with patch.object(vm.urllib.request, "urlopen", return_value=io.BytesIO(json.dumps(info).encode())):
            self.assertTrue(vm._check_fasth3_schema()["native_nodes"])
        bad = copy.deepcopy(info)
        bad["ModelAttentionBackend"]["input"]["required"]["attention"] = [["pytorch attention"]]
        with patch.object(vm.urllib.request, "urlopen", return_value=io.BytesIO(json.dumps(bad).encode())), self.assertRaises(RuntimeError):
            vm._check_fasth3_schema()
        del info["MiniMaxH3SigmaShift"]
        with patch.object(vm.urllib.request, "urlopen", return_value=io.BytesIO(json.dumps(info).encode())), self.assertRaises(RuntimeError):
            vm._check_fasth3_schema()

    def test_bootstrap_uses_only_pinned_fast_components(self):
        old_boot = vm.STATE.get("boot")
        fetched, commands = [], []
        def fetch(*args):
            fetched.append(args)
            return {"file": args[0]}
        def sh(cmd, *args):
            commands.append(cmd)
            return "GPU" if cmd.startswith("nvidia-smi") else ""
        try:
            with patch.dict(os.environ), patch.object(vm, "_fetch", side_effect=fetch), patch.object(vm, "_sh", side_effect=sh), \
                 patch.object(vm, "_torch_info", return_value="2.11.0+cu130 13.0"), \
                 patch.object(vm, "_start_server", return_value={}), patch.object(vm, "_check_fasth3_schema", return_value={}):
                vm._bootstrap(model="fasth3-omni")
                self.assertEqual(os.environ["HF_XET_HIGH_PERFORMANCE"], "0")
                self.assertEqual(os.environ["HF_XET_NUM_CONCURRENT_RANGE_GETS"], "4")
                self.assertEqual(os.environ["HF_XET_FIXED_DOWNLOAD_CONCURRENCY"], "4")
            self.assertEqual(vm.STATE["boot"]["state"], "ready")
            self.assertEqual(vm.STATE["boot"]["comfy_rev"], vm.FASTH3["comfy_rev"])
            self.assertTrue(any(vm.FASTH3["comfy_rev"] in c for c in commands))
            self.assertEqual({x[0] for x in fetched}, {x[0] for x in vm.FASTH3_WEIGHTS})
            self.assertTrue(all(x[2:] == (vm.FASTH3["weights_repo"], vm.FASTH3["weights_rev"]) for x in fetched))
            self.assertEqual(vm.STATE["boot"]["download_policy"]["parallel_files"], 2)
            with self.assertRaises(RuntimeError):
                vm.bootstrap(model="minimax-h3")
        finally:
            vm.STATE["boot"] = old_boot

    def test_xet_429_resumes_the_same_pinned_download_after_waiting(self):
        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp) / "models/diffusion_models"
            dest.mkdir(parents=True)
            partial = Path(tmp) / "finished.safetensors"
            partial.write_bytes(b"verified fixture")
            error = RuntimeError("CAS Client Error: HTTP status client error (429 Too Many Requests)")
            from unittest.mock import Mock, call
            download = Mock(side_effect=[error, error, str(partial)])
            with patch.object(vm, "COMFY", tmp), patch.dict(sys.modules, {"huggingface_hub": types.SimpleNamespace(hf_hub_download=download)}), \
                 patch.object(vm.time, "sleep") as sleep:
                receipt = vm._fetch("diffusion_models/model.safetensors", "diffusion_models", vm.FASTH3["weights_repo"], vm.FASTH3["weights_rev"])
            self.assertEqual(receipt["download_attempts"], 3)
            self.assertEqual(sleep.call_args_list, [call(30), call(60)])
            self.assertEqual((dest / "model.safetensors").read_bytes(), b"verified fixture")
            self.assertEqual(download.call_count, 3)
            self.assertTrue(all(c.kwargs["revision"] == vm.FASTH3["weights_rev"] for c in download.call_args_list))

    def test_xet_429_stops_after_four_attempts(self):
        from unittest.mock import Mock, call
        error = RuntimeError("CAS Client Error: 429 Too Many Requests")
        download = Mock(side_effect=error)
        with tempfile.TemporaryDirectory() as tmp, patch.object(vm, "COMFY", tmp), \
             patch.dict(sys.modules, {"huggingface_hub": types.SimpleNamespace(hf_hub_download=download)}), \
             patch.object(vm.time, "sleep") as sleep, self.assertRaises(RuntimeError):
            vm._fetch("diffusion_models/model.safetensors", "diffusion_models", vm.FASTH3["weights_repo"], vm.FASTH3["weights_rev"])
        self.assertEqual(download.call_count, 4)
        self.assertEqual(sleep.call_args_list, [call(30), call(60), call(120)])

    def test_other_errors_and_legacy_downloads_are_not_retried(self):
        from unittest.mock import Mock
        for repo, error in [(vm.FASTH3["weights_repo"], RuntimeError("401 Unauthorized")),
                            (vm.FASTH3["weights_repo"], RuntimeError("404 Not Found")),
                            (vm.FASTH3["weights_repo"], ValueError("malformed file")),
                            (vm.WEIGHTS_REPO, RuntimeError("429 Too Many Requests"))]:
            download = Mock(side_effect=error)
            with self.subTest(repo=repo, error=error), tempfile.TemporaryDirectory() as tmp, patch.object(vm, "COMFY", tmp), \
                 patch.dict(sys.modules, {"huggingface_hub": types.SimpleNamespace(hf_hub_download=download)}), \
                 patch.object(vm.time, "sleep") as sleep, self.assertRaises(type(error)):
                vm._fetch("diffusion_models/model.safetensors", "diffusion_models", repo, "pinned")
            self.assertEqual(download.call_count, 1)
            sleep.assert_not_called()

    def test_job_uses_boot_provenance_and_never_loads_legacy_reference_weights(self):
        old_boot = vm.STATE.get("boot")
        boot = {"state": "ready", "model": vm.FASTH3["model"], **{
            k: vm.FASTH3[k] for k in ("comfy_rev", "weights_repo", "weights_rev")}}
        vm.STATE["boot"] = boot
        log = Path(vm.ROOT) / "server.log"
        log.write_text("")
        history = {"p": {"status": {"completed": True, "status_str": "success"}}}
        try:
            with patch.object(vm, "_sh", return_value="fake GPU"), \
                 patch.object(vm, "_post", return_value={"prompt_id": "p"}) as post, \
                 patch.object(vm.urllib.request, "urlopen", return_value=io.BytesIO(json.dumps(history).encode())), \
                 patch.object(vm, "_pick_output", return_value="fake.mp4"), patch.object(vm.shutil, "move"), \
                 patch.object(vm, "_ensure_ref_weights", side_effect=AssertionError("legacy weights must not load")):
                vm._run_job(self.req)
            rep = json.loads((Path(vm.ROOT) / "jobs" / (self.req["id"] + ".json")).read_text())
            self.assertEqual(rep["state"], "ok", rep.get("error"))
            self.assertEqual(rep["weights_repo"], vm.FASTH3["weights_repo"])
            self.assertEqual(rep["comfy_rev"], vm.FASTH3["comfy_rev"])
            self.assertEqual(post.call_count, 1)
            vm.STATE["boot"] = {**boot, "weights_rev": "stale"}
            with patch.object(vm, "_sh", return_value="fake GPU"), patch.object(vm, "_post") as post:
                vm._run_job(self.req)
            rep = json.loads((Path(vm.ROOT) / "jobs" / (self.req["id"] + ".json")).read_text())
            self.assertEqual(rep["state"], "error")
            self.assertIn("revisions", rep["error"])
            post.assert_not_called()
        finally:
            vm.STATE["boot"] = old_boot


if __name__ == "__main__":
    unittest.main()
