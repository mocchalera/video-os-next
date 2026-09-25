"""API-format MiniMax-H3 text-to-video(+audio) graph, rebuilt from the stock ComfyUI template
`video_minimax_h3_t2v.json` (subgraph "Image to Video (MiniMax H3)", ComfyUI 1568e6cf).

Speed knobs are explicit arguments so each can be benchmarked in isolation:
  steps / lora (turbo)        -> fewer sampling steps
  attention="comfy kitchen attention" -> INT8 quantized dense attention (ModelAttentionBackend)
  sol_tau=<float>             -> training-free block-sparse attention (BlockSparseAttention sol-attn)
"""


def frames_for(seconds: float) -> int:
    """Template formula: 24 fps snapped up to the model's 17k+5 grid."""
    n = max(5, round(seconds * 24))
    return n + (5 - n % 17) % 17


def h3_t2v(
    prompt: str,
    width: int = 864,
    height: int = 480,
    seconds: float = 2.0,
    seed: int = 1,
    steps: int = 20,
    sampler: str = "res_multistep",
    unet: str = "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
    clip: str = "qwen3vl_32b_minimax_h3_int8_convrot.safetensors",
    video_vae: str = "minimax_h3_video_vae_fp16.safetensors",
    audio_vae: str = "minimax_h3_audio_vae_fp32.safetensors",
    lora: str | None = None,
    lora_strength: float = 1.0,
    attention: str | None = None,
    sol_tau: float | None = None,
    prefix: str = "bench/h3",
) -> dict:
    g: dict = {}

    def node(nid: str, cls: str, **inputs) -> list:
        g[nid] = {"class_type": cls, "inputs": inputs}
        return [nid, 0]

    model = node("unet", "UNETLoader", unet_name=unet, weight_dtype="default")
    if lora:
        model = node("lora", "LoraLoaderModelOnly", model=model, lora_name=lora, strength_model=lora_strength)
    if attention:
        model = node("attn", "ModelAttentionBackend", model=model, attention=attention)
    if sol_tau is not None:
        # dynamic combo = flat dotted keys; other inputs are the node defaults (ComfyUI 1568e6cf)
        model = node("sparse", "BlockSparseAttention", model=model, **{
            "selection": "sol-attn", "selection.tau": sol_tau, "start_percent": 0.2, "end_percent": 1.0,
            "dense_blocks": "", "min_tokens": 12288, "extra_tokens": 256,
            "sink_conditioning": "exact_kv_and_rows", "verbose": False})
    clip_ = node("clip", "CLIPLoader", clip_name=clip, type="minimax", device="default")
    vvae = node("vvae", "VAELoader", vae_name=video_vae)
    avae = node("avae", "VAELoader", vae_name=audio_vae)
    node("cond", "MiniMaxH3ImageToVideo", clip=clip_, vae=vvae, prompt=prompt,
         width=width, height=height, length=frames_for(seconds))
    guider = node("guider", "BasicGuider", model=model, conditioning=["cond", 0])
    sigmas = node("sched", "BasicScheduler", model=model, scheduler="simple", steps=steps, denoise=1.0)
    noise = node("noise", "RandomNoise", noise_seed=seed)
    samp = node("sampler", "KSamplerSelect", sampler_name=sampler)
    out = node("sample", "SamplerCustomAdvanced", noise=noise, guider=guider, sampler=samp,
               sigmas=sigmas, latent_image=["cond", 1])
    img = node("vdec", "VAEDecode", samples=out, vae=vvae)
    aud = node("adec", "VAEDecodeAudio", samples=out, vae=avae)
    vid = node("video", "CreateVideo", images=img, audio=aud, fps=24)
    node("save", "SaveVideo", video=vid, filename_prefix=prefix, format="auto", codec="auto")
    return g
