"""Offline checks for colab_gen_vm.py. Run: python3 python/test_colab_gen_vm.py

The strongest check available without a GPU: the graph vos gen submits must equal the graph that actually ran
on ComfyUI 1568e6cf during the spike (scripts/colab/spike/h3_workflow.py, validated live in rounds B/C)."""
import os
import sys
import tempfile
import unittest
from pathlib import Path

os.environ["VOSGEN_ROOT"] = tempfile.mkdtemp()
HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "scripts" / "colab" / "spike"))
import colab_gen_vm as vm  # noqa: E402
import h3_workflow as spike  # noqa: E402

REQ = {
    "id": "abc123", "prompt": "a cyclist in the rain", "seconds": 5, "width": 1344, "height": 768, "seed": 62,
    "steps": 6, "lora": "minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors", "sol_tau": 1.3,
    "unet": "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
    "text_encoder": "qwen3vl_32b_minimax_h3_int8_convrot.safetensors",
    "video_vae": "minimax_h3_video_vae_fp16.safetensors", "audio_vae": "minimax_h3_audio_vae_fp32.safetensors",
}


class GraphTests(unittest.TestCase):
    def test_matches_the_graph_validated_on_comfyui(self):
        ours = vm.graph(REQ)
        ref = spike.h3_t2v(REQ["prompt"], width=1344, height=768, seconds=5, seed=62, steps=6, lora=REQ["lora"],
                           sol_tau=1.3, prefix="vosgen/abc123")
        self.assertEqual(ours, ref)

    def test_dense_has_no_sparse_node(self):
        g = vm.graph({**REQ, "sol_tau": None})
        self.assertNotIn("sparse", g)
        self.assertEqual(g["guider"]["inputs"]["model"], ["lora", 0])

    def test_image_to_video_wires_loadimage_into_first_and_last_frame(self):
        g = vm.graph({**REQ, "first_image": "vosgen_abc_first.png", "last_image": "vosgen_abc_last.png"})
        self.assertEqual(g["img_first"], {"class_type": "LoadImage", "inputs": {"image": "vosgen_abc_first.png"}})
        self.assertEqual(g["cond"]["inputs"]["first_frame"], ["img_first", 0])
        self.assertEqual(g["cond"]["inputs"]["last_frame"], ["img_last", 0])
        self.assertNotIn("first_frame", vm.graph(REQ)["cond"]["inputs"])

    def test_frames_follow_the_17k_plus_5_grid(self):
        self.assertEqual(vm.frames_for(5), 124)
        self.assertEqual(vm.frames_for(2), 56)
        for s in (1, 3.3, 7, 15):
            self.assertEqual((vm.frames_for(s) - 5) % 17, 0)


class ReloadTests(unittest.TestCase):
    def test_reloading_the_worker_keeps_the_queue_alive(self):
        """Live e2e failure: re-exec of this file made a new queue; the old worker thread never saw new jobs."""
        import time
        src = (HERE / "colab_gen_vm.py").read_text()
        ns = {"__name__": "vosgen_kernel"}
        exec(src, ns)
        done = []
        exec(src, ns)  # second load, as after a hot fix on the VM
        ns["_run_job"] = lambda r: done.append(r["id"])
        ns["submit"]({"id": "reload1"})
        for _ in range(50):
            if done:
                break
            time.sleep(0.05)
        self.assertEqual(done, ["reload1"])
        first = ns["_WORKER"]
        exec(src, ns)
        self.assertIs(ns["_WORKER"], first, "re-load must reuse the live worker, not start another")


if __name__ == "__main__":
    unittest.main(verbosity=1)
