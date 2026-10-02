#!/bin/bash
# Builds /tmp/slproj: this project with the PRE-web graphics/room.html (web/review/m1/room.html.orig), compiled by vos,
# so that qa/mvdiff.mjs (and `vos render --project /tmp/slproj …`) can compare the MV before and after the web hooks.
set -e
P="$(cd "$(dirname "$0")/../.." && pwd)"; R="$(cd "$P/../.." && pwd)"
rm -rf /tmp/slproj; mkdir -p /tmp/slproj/.vos /tmp/slproj/graphics /tmp/slproj/out
for f in assets.json vos.project.json timeline.json timeline.probe.json data design refs web; do ln -s "$P/$f" /tmp/slproj/$f; done
cp "$P/web/review/m1/room.html.orig" /tmp/slproj/graphics/room.html; cp "$P/.vos/paths.json" /tmp/slproj/.vos/paths.json
(cd "$R" && node src/cli.ts --project /tmp/slproj compile)
echo "ok: /tmp/slproj (served by web/serve.mjs at /_buildorig/)"
