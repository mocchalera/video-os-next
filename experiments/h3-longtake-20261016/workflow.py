"""Small, explicit API graph for the public LongTakeNoCuts basic workflow."""

FPS = 24
WIDTH, HEIGHT = 1152, 640
SECONDS = 10
CONTEXT_FRAMES = 22
BASE_STEPS, REFINE_STEPS = 10, 5
FL2VA = "minimax_h3_fl2va_pruned_int8_convrot.safetensors"
REF2VA = "minimax_h3_ref2va_pruned_int8_convrot.safetensors"
TEXT_ENCODER = "qwen3vl_32b_minimax_h3_int8_convrot.safetensors"
VIDEO_VAE = "minimax_h3_video_vae_fp16.safetensors"
AUDIO_VAE = "minimax_h3_audio_vae_fp32.safetensors"


def frame_count(seconds=SECONDS):
    n = max(5, round(seconds * FPS))
    return n + (5 - n % 17) % 17


def build_graph(index, prompt, seed=20261016):
    if index not in (1, 2, 3):
        raise ValueError("This pilot has exactly three numbered segments")
    g = {}

    def node(key, cls, **inputs):
        g[key] = {"class_type": cls, "inputs": inputs}
        return [key, 0]

    model = node("hybrid", "MiniMaxH3HybridLoader", base_model=FL2VA,
                 overlay_model=REF2VA, overlay_preset="block_range_adaln",
                 block_range_start=20, block_range_end=49,
                 final_adaln_from_overlay=False, custom_overlays="", custom_base="",
                 weight_dtype="default")
    # Keep ordinary attention: current ComfyUI documents CK attention as
    # incompatible with these convrot checkpoints. No turbo LoRA or sparse patch.
    refine_model = node("refine_model", "UNETLoader", unet_name=FL2VA, weight_dtype="default")
    clip = node("clip", "CLIPLoader", clip_name=TEXT_ENCODER, type="minimax", device="default")
    vv = node("vvae", "VAELoader", vae_name=VIDEO_VAE)
    av = node("avae", "VAELoader", vae_name=AUDIO_VAE)
    ref = node("reference", "LoadImage", image="character.png")
    node("cond", "MiniMaxH3ReferenceToVideo", clip=clip, vae=vv, audio_vae=av,
         prompt=prompt, width=WIDTH, height=HEIGHT, length=frame_count(),
         ref_image_size="match", **{"ref_images.ref_image_0": ref})
    prev = node("previous", "MiniMaxH3MotionContextLoadLatent",
                latent_path="h3pilot/latents", clip_index=index - 1)
    node("context", "MiniMaxH3MotionContext", conditioning=["cond", 0], vae=vv,
         latent=["cond", 1], context_length=str(CONTEXT_FRAMES), audio_context_length=24,
         context_latent=prev, audio_vae=av)
    guider = node("guider", "BasicGuider", model=model, conditioning=["context", 0])
    noise = node("noise", "RandomNoise", noise_seed=seed + index)
    sampler = node("sampler", "KSamplerSelect", sampler_name="res_multistep")
    sigmas = node("schedule", "BasicScheduler", model=model, scheduler="simple",
                  steps=BASE_STEPS, denoise=1.0)
    node("base", "SamplerCustomAdvanced", noise=noise, guider=guider,
         sampler=sampler, sigmas=sigmas, latent_image=["cond", 1])
    # Refine against the original reference conditioning, without motion context,
    # as in the author's basic workflow. The subsequent blend preserves the head.
    rg = node("refine_guider", "BasicGuider", model=refine_model, conditioning=["cond", 0])
    rn = node("refine_noise", "RandomNoise", noise_seed=seed + 100 + index)
    rs = node("refine_schedule", "BasicScheduler", model=refine_model,
              scheduler="simple", steps=REFINE_STEPS, denoise=0.55)
    node("refine", "SamplerCustomAdvanced", noise=rn, guider=rg,
         sampler=sampler, sigmas=rs, latent_image=["base", 0])
    blend = node("blend", "H3BlendLatentsByFrames", latent1=["base", 0],
                 latent2=["refine", 1], keyframes="0:0, 22:0, 44:1",
                 duration=frame_count() / FPS, fps=FPS, interpolation="linear",
                 audio_source="latent1", blend_audio=False)
    node("save_latent", "MiniMaxH3MotionContextSaveLatent", latent=blend,
         filename_prefix="h3pilot/latents/clip", clip_index=index)
    for label, latent in (("base", ["base", 0]), ("refined", blend)):
        images = node(f"{label}_vdec", "VAEDecode", samples=latent, vae=vv)
        audio = node(f"{label}_adec", "VAEDecodeAudio", samples=latent, vae=av)
        node(f"{label}_trim", "MiniMaxH3MotionContextTrim", images=images,
             audio=audio, trim_frames=["context", 1], fps=FPS, match_tail=True)
        video = node(f"{label}_video", "CreateVideo", images=[f"{label}_trim", 0],
                     audio=[f"{label}_trim", 1], fps=FPS)
        node(f"save_{label}", "SaveVideo", video=video,
             filename_prefix=f"h3pilot/segment_{index:02d}_{label}", format="auto", codec="auto")
    validate_graph(g)
    return g


def validate_graph(g):
    """Reject broken links and cycles before renting a VM."""
    visiting, visited = set(), set()

    def visit(key):
        if key in visiting:
            raise ValueError(f"Graph cycle at {key}")
        if key in visited:
            return
        visiting.add(key)
        for value in g[key]["inputs"].values():
            if isinstance(value, list) and len(value) == 2:
                if value[0] not in g:
                    raise ValueError(f"Unknown node {value[0]}")
                visit(value[0])
        visiting.remove(key)
        visited.add(key)

    for key in g:
        visit(key)


def delivered_frames(index):
    return frame_count() - (CONTEXT_FRAMES if index > 1 else 0)
