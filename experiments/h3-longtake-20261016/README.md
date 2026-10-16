# H3 LongTakeNoCuts basic pilot

User-authorized budget: **10 CU** for this experiment; Colab A100 only. The
existing `vos-gen` session and the worktree's in-progress generation changes
are not edited. No additional agent is involved.

This is a basic-method experiment, not a reproduction of the unpublished SAM3
masking workflow. A pinned public character sheet supplies facial identity;
the prompt changes clothing and setting to a quiet Japanese street. No input
music, masks, turbo LoRA, post colour grade or upscale.
The author's Fizgig contrast tweaks are also omitted.

## Generation

- 1152×640, 24 fps, three nominal 10 s segments (243 frames on H3's grid).
- FL2VA base with Ref2VA AdaLN overlay at blocks 20–49; base 10 steps.
- Native FL2VA refine, 5 steps, denoise 0.55, original reference conditioning.
- Blend original to refined latent across frames 22–44, keeping original audio.
- Carry the blended latent into the next generation; trim its 22 pinned frames
  from both picture and audio. Expected delivery: 685 frames, 28.542 s.
- Preserve both unrefined and refined videos for each segment. The unrefined
  clips are local comparisons within this refined chain, not an independently
  generated no-refine control chain.
- Download the three saved AV latents before releasing the VM, retaining the
  exact internal state needed to investigate or continue the chain later.
- Default attention is deliberate: current ComfyUI documentation reports
  incompatibility between CK attention and the int8-convrot checkpoints. This
  differs from the author's attention setting.

`source-lock.json` pins upstream source and the SHA-256 of the existing VM
worker reused as a snapshot. No model weights are downloaded onto the Mac.

## Run

For a fresh checkout, first restore the public sample image from the pinned
upstream revision:

```sh
mkdir -p experiments/h3-longtake-20261016/inputs
curl -fL https://raw.githubusercontent.com/xyzDist/H3-LongTakeNoCuts/0cad00ab92e4ad8de3d54ddd5254142bccb702d9/example_workflow/character.png -o experiments/h3-longtake-20261016/inputs/character.png
```

```sh
python3 experiments/h3-longtake-20261016/run.py
python3 experiments/h3-longtake-20261016/run.py --execute --budget-cu 10
```

The first command checks graph references/cycles and writes planned graphs
without allocating anything. The second starts an isolated guarded session,
checks live node availability, generates and hash-verifies downloads, and
releases the VM in `finally`. A 90-minute wall deadline complements the 10 CU
guard; no new segment starts once estimated spend reaches 8 CU. The execution
marker refuses a second rental against the same approval.

`inputs/`, `source-cache/` and `outputs/` are local ignored artifacts. The final
edit should be represented by a `timeline.json` project and rendered with `vos`
so its receipt records the actual edit. See `outputs/run.json` for execution
and stop evidence. A 3-segment pilot tests joins; it does not establish absence
of drift over 3 minutes.

## Sources

- https://github.com/xyzDist/H3-LongTakeNoCuts
- https://github.com/NikoDemon80/ComfyUI-H3-Motion-Context
- https://github.com/scottmudge/ComfyUI_MinimaxH3HybridLoader
- https://docs.comfy.org/tutorials/video/minimax/minimax-h3
