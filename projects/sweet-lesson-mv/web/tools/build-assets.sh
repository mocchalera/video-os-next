#!/bin/bash
# Compresses what the web version plays/loads from refs/ (never modifies refs/):
#   web/assets/foley.m4a   ← refs/sfx_stem.wav (41 MB PCM) → AAC-LC 80 kbps stereo, +7.5 dB (the MV puts the stem at +8 dB, i.e. 8–12 dB under the song; this bakes
#                            it in so playback needs no gain — iOS ignores <audio>.volume. Peak of the stem is −8.1 dBFS, so +7.5 dB stays under 0 dBFS after AAC)
#   web/assets/tex-512/*.jpg ← refs/tex/*.jpg (1024², ~7.8 MB) → 512², q82: the texture set for the phone tiers (¼ of the GPU memory and of the transfer)
set -e
P="$(cd "$(dirname "$0")/../.." && pwd)"
ffmpeg -v error -y -i "$P/refs/sfx_stem.wav" -af "volume=7.5dB" -c:a aac -b:a 80k -movflags +faststart "$P/web/assets/foley.m4a"
python3 - <<PY
import os,glob
from PIL import Image
P="$P"; out=P+"/web/assets/tex-512"; os.makedirs(out,exist_ok=True)
for f in sorted(glob.glob(P+"/refs/tex/*.jpg")):
    im=Image.open(f).convert("RGB"); im=im.resize((512,512),Image.LANCZOS); im.save(out+"/"+os.path.basename(f),quality=82,optimize=True)
PY
ls -la "$P/web/assets/foley.m4a"; du -sh "$P/web/assets/tex-512" "$P/refs/tex"
