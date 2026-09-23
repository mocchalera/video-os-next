#!/bin/sh
# Set up the repo-owned toolchain: node_modules (HyperFrames) and python/.venv (Marlin, embeddings).
#   scripts/setup.sh                      online: npm install + uv/pip install from the lock file
#   scripts/setup.sh --offline-from DIR   offline: assemble from an existing install on this machine
#                                         (e.g. a video-os-v2 checkout with node_modules and python/.venv-*)
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
PY=${PYTHON:-python3.13}

if [ "${1:-}" = "--offline-from" ]; then
  SRC=${2:?usage: setup.sh --offline-from <dir>}
  echo "== node: copying the HyperFrames dependency closure from $SRC"
  node scripts/copy_node_closure.mjs "$SRC" . hyperframes
  mkdir -p node_modules/.bin && ln -sf ../hyperframes/dist/cli.js node_modules/.bin/hyperframes
  echo "== python: assembling python/.venv from $SRC/python/.venv-*"
  BASE="$SRC/python/.venv-qwen3vl"
  [ -d python/.venv ] || { cp -a "$BASE" python/.venv; grep -rl "$BASE" python/.venv/bin python/.venv/pyvenv.cfg | while read f; do sed -i '' "s|$BASE|$ROOT/python/.venv|g" "$f"; done; }
  SP=$(echo python/.venv/lib/python3*/site-packages)
  for v in clap marlin; do
    python/.venv/bin/python3 scripts/merge_dists.py "$(echo "$SRC"/python/.venv-$v/lib/python3*/site-packages)" "$SP" librosa soundfile torchaudio torchcodec 2>/dev/null || true
  done
  python/.venv/bin/python3 -c "import onnxruntime" 2>/dev/null || echo "note: onnxruntime missing; copy it with scripts/merge_dists.py from any Python 3.13 that has it"
else
  echo "== node"; npm install
  echo "== python"
  if command -v uv >/dev/null; then uv venv python/.venv --python "$PY" && uv pip install --python python/.venv -r python/requirements.lock.txt
  else "$PY" -m venv python/.venv && python/.venv/bin/pip install -r python/requirements.lock.txt; fi
fi
echo "== text embedding model (multilingual-e5-small, ONNX)"
if [ ! -f "$HOME/.cache/vos/models/multilingual-e5-small/onnx/model_quantized.onnx" ]; then
  python/.venv/bin/python3 -c "from huggingface_hub import snapshot_download as d; d('Xenova/multilingual-e5-small', local_dir='$HOME/.cache/vos/models/multilingual-e5-small', allow_patterns=['*.json','onnx/model_quantized.onnx'])" \
    || echo "note: could not fetch the text model (offline?)"
fi
bin/vos doctor
