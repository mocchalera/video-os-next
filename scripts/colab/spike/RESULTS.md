# MiniMax-H3 on Colab — step-0 spike results (2026-09-24/25)

Environment: Colab A100-SXM4-**40GB**, driver 580, torch 2.11+cu128 (Colab default), ComfyUI `1568e6cf`,
weights from `Comfy-Org/MiniMax-H3` (pruned int8_convrot DiT 21 GB, Qwen3-VL-32B int8 TE 27 GB, VAEs, turbo LoRAs).
Test: T2V+audio, 864x480, 56 frames (~2.3 s), prompt/seed fixed per row. Rate observed: **A100 = 5.30 CU/h**.

## Speed (per clip, warm = models already loaded, prompt already encoded)

| config | s/step | clip total | vs base |
|---|---|---|---|
| base 20 steps (eager kernels) | 5.38 | ~115 s (201 s cold) | 1.0x |
| + INT8 attention (`ModelAttentionBackend: comfy kitchen attention`) | 5.45 | 115 s | no gain |
| turbo 8-step LoRA @ 6 steps | 5.38 | 40 s | 2.9x |
| turbo 8-step LoRA @ 8 steps | 5.38 | 49 s | 2.3x |
| turbo 4-step LoRA @ 4 steps | 5.38 | 30 s | 3.8x |
| **turbo6 + `--enable-triton-backend`** | **1.42** | **14.2 s** | **~8x** |

Findings
- GPU was at ~100 % util with negligible PCIe traffic: compute-bound, not offload-bound.
- The big win is comfy-kitchen kernels. ComfyUI disables the kitchen **CUDA** backend when torch CUDA < 13
  (Colab ships cu128) and the Triton backend is opt-in → by default int8 layers ran on the slow `eager` path.
  `--enable-triton-backend` alone gave 3.8x per step. Quality checked on frame sheets: no visible degradation.
- Attention backend choice did not matter while matmuls were on the eager path; re-test after kernels are fixed.
- `BlockSparseAttention` (sol-attn) needs every dynamic-combo input in API format (`sink_conditioning`, `start_percent`,
  `end_percent`, `extra_tokens`, `min_tokens`, `dense_blocks`, `verbose`) — measured in round C below.
- Stock templates also ship **FastVideo FastH3 8-step** (DMD2-distilled, T2V only, VSA sparse attention) — not yet measured.
- Cold start is the dominant cost: HF download ran at 19–60 MB/s (58 GB ≈ 39 min ≈ 3.4 CU); first generation after a
  server start is ~200 s (TE load + encode + compile).

## Round B/C (2026-09-25, guarded session, 2.4 CU)

| config (turbo8 LoRA @ 6 steps) | s/step | clip (warm) | cold (first after server start) |
|---|---|---|---|
| 864x480 2.3 s, torch cu128 + `--enable-triton-backend` | 1.42 | 14.2 s | 203 s |
| 864x480 2.3 s, **torch cu130 (kitchen CUDA backend)** | **1.14** | **12.2 s** | 158 s |
| 864x480 2.3 s, cu130 + triton | 1.14 | 12.3 s | 187 s |
| 1344x768 5.2 s, cu130 | 14.57 | 108.9 s | 250 s |
| 1344x768 5.2 s, cu130 + INT8 attention | 15.06 | 111.6 s | – |
| **1344x768 5.2 s, cu130 + sol-attn tau 1.3** | 10.03 (8.3 in sparse steps) | **81.2 s** | – |
| 1344x768 5.2 s, cu130 + sol-attn tau 1.0 | 10.55 | 84.3 s | – |

- cu130: `pip install 'torch==2.11.0+cu130' torchvision torchaudio --index-url .../whl/cu130` (with deps; `--no-deps`
  fails on missing libcudart.so.13; a plain `torch==2.11.*` is a silent no-op because cu128 2.11 is already installed).
- Target size is attention-bound (5.5x tokens -> 12.8x time). sol-attn (training-free, sparse after 20 % of steps) cuts
  25 %. Same seed vs dense: same scene/composition, fine detail differs (SSIM 0.76), no visible artifacts.
- API format for dynamic combos is flat dotted keys: `"selection": "sol-attn", "selection.tau": 1.3`, plus every
  top-level input (`start_percent`, `end_percent`, `dense_blocks`, `min_tokens`, `extra_tokens`, `sink_conditioning`, `verbose`).
- **Cold start fixed**: parallel download + `HF_XET_HIGH_PERFORMANCE=1` pulled 58 GB in **186 s** (148–176 MB/s per
  file) vs 39 min sequential. `restore.py` total incl. ComfyUI setup 193 s; + cu130 install 52 s.
- Recommended default on A100-40GB: cu130 torch, kitchen CUDA backend (no flags), turbo 8-step LoRA @ 6 steps,
  sol-attn tau 1.3. Expected: ~12 s per 864x480 2 s clip, ~81 s per 1344x768 5 s clip (≈0.12 CU), plus ~5 min /
  ~0.5 CU cold start per session.

## Not measured
- SageAttention, FastVideo FastH3 8-step (DMD2 + VSA), sol-attn tau > 1.3 / start_percent < 0.2, Drive-copy vs HF
  (HF is now fast enough that Drive is not needed for weights).

## Incidents (design inputs for `vos gen`)
1. The first VM disappeared mid-run (keep-alive 404 from ~15:45 UTC); cause unknown. All weights were lost.
2. **Budget overrun**: the replacement VM was allocated, a `colab exec` call hung for ~6 h, and the VM idled at
   5.30 CU/h with no work → ~33 CU wasted. Total spike spend 40.8 CU against a 30 CU budget.
   The local budget monitor only *warned* and had expired. The orphaned assignment had no local record, so
   `colab stop` could not see it; it was released via `state.client.unassign(endpoint)` from the CLI's own library.
   → `vos gen` must have: a lease (dead-man switch) that stops the VM when nobody renews it, a local guard that
   *stops* (not warns) at the budget line, orphan detection (`colab sessions` `[?]` rows), and hard timeouts on
   every `colab exec`. (A VM-side self-stop is not possible: the VM holds no credentials to unassign itself, so the
   stopper must live on the local machine — which also means it cannot act while the Mac sleeps.)

## Guard (implemented after the incident): `scripts/colab/vos-colab`
`start <name> --budget-cu N [--lease-min 15] [--max-hours 2]` · `exec <name> -f x.py --timeout S` · `wait <name> <vm-path>` ·
`renew` · `stop` · `status` · `reap [--dry-run]`. Ledger + supervisor log in `~/.config/vos/colab/`.
Offline tests: `python3 scripts/colab/test_guard.py` (fake backend; includes a real hung-process kill test).

## vos gen live checks (2026-09-25)

| what | GPU | result |
|---|---|---|
| t2v 1344x768 5 s | A100 | 82.4 s warm (~0.12 CU); first clip after boot +~70 s (TE load) |
| i2v `--from` 768p 5 s | A100 | 269.8 s incl. cold TE; first frame matches the source frame |
| upscale 1344x768→1920x1098, 5 s | T4 (`--light`) | ~200 s/clip (~0.06 CU) streamed; ComfyUI graph version OOM-killed the server (13 GB RAM VM) |
| ref2va `--refs` 768p 5 s, full 20 steps | A100 | 239.5 s; clean. turbo 4 steps: smears / flare artifacts. Shape of a stylised ref object drifted to a generic one |
