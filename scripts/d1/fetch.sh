#!/usr/bin/env bash
# Fetch the pinned d1-3B GGUF files and the pinned llama.cpp runner, verifying size + sha256.
# Network + ~3.5 GB of disk: run only after the human has approved WHERE it may be stored.
#   scripts/d1/fetch.sh <dir>        → <dir>/models/LiquidAI--d1-3B-GGUF@<rev>/  and  <dir>/bin/llama-b11491/
# Pins must match src/judge/d1.ts (D1_PIN, RUNNER_PIN). Existing verified files are not downloaded again.
set -euo pipefail
[ $# -eq 1 ] || { echo "usage: $0 <dir>" >&2; exit 2; }
DIR="$1"
REV=bb1e436ea78eb96a3f1acb6da865f70c2fbeb563
MDIR="$DIR/models/LiquidAI--d1-3B-GGUF@$REV"
BDIR="$DIR/bin"
TAG=b11491
ASSET="llama-$TAG-bin-macos-arm64.tar.gz"
ASSET_SHA=5dc61b413298db5e5c547c39b40d1148844eca23f247f8741444837a7cc3626d
mkdir -p "$MDIR" "$BDIR"

get() { # url dest size sha256
  local url="$1" dest="$2" size="$3" sum="$4"
  if [ -f "$dest" ] && [ "$(stat -f %z "$dest")" = "$size" ] && [ "$(shasum -a 256 "$dest" | cut -d' ' -f1)" = "$sum" ]; then
    echo "ok (present) $(basename "$dest")"; return
  fi
  curl -fL --retry 3 -C - -o "$dest.part" "$url"
  [ "$(stat -f %z "$dest.part")" = "$size" ] || { echo "size mismatch: $dest.part" >&2; exit 1; }
  [ "$(shasum -a 256 "$dest.part" | cut -d' ' -f1)" = "$sum" ] || { echo "sha256 mismatch: $dest.part" >&2; exit 1; }
  mv "$dest.part" "$dest"; echo "ok $(basename "$dest")"
}

HF="https://huggingface.co/LiquidAI/d1-3B-GGUF/resolve/$REV"
get "$HF/d1-3B-Q8_0.gguf" "$MDIR/d1-3B-Q8_0.gguf" 2874781280 2f0942d5a5f64cf69c3356d2be439b71644b1f0eb3a580912a5a0179eeaba77d
get "$HF/mmproj-d1-3B-Q8_0.gguf" "$MDIR/mmproj-d1-3B-Q8_0.gguf" 583109728 2505920ce464b7c54acd8b7b74a931c0c671f06d0c8833760b2fbceeb253e92a
curl -fsL -o "$MDIR/LICENSE" "$HF/LICENSE"

if [ ! -f "$BDIR/$ASSET" ] || [ "$(shasum -a 256 "$BDIR/$ASSET" | cut -d' ' -f1)" != "$ASSET_SHA" ]; then
  curl -fL --retry 3 -o "$BDIR/$ASSET.part" "https://github.com/ggml-org/llama.cpp/releases/download/$TAG/$ASSET"
  [ "$(shasum -a 256 "$BDIR/$ASSET.part" | cut -d' ' -f1)" = "$ASSET_SHA" ] || { echo "sha256 mismatch: $ASSET" >&2; exit 1; }
  mv "$BDIR/$ASSET.part" "$BDIR/$ASSET"
fi
mkdir -p "$BDIR/llama-$TAG"
tar -xzf "$BDIR/$ASSET" -C "$BDIR/llama-$TAG" --strip-components=1
echo
echo "VOS_D1_MODEL_DIR=\"$MDIR\""
echo "VOS_LLAMA_SERVER=\"$BDIR/llama-$TAG/llama-server\""
echo "check: vos judge doctor --model-dir \"\$VOS_D1_MODEL_DIR\" --llama-server \"\$VOS_LLAMA_SERVER\""
