#!/bin/bash
# the quick tests (Node only, no browser): the server, collision resolution, FreeCam rules. exit 1 on any failure.
cd "$(dirname "$0")/../.." || exit 1
rc=0
for t in serve colliders freecam review-fixes; do echo "== $t"; node web/qa/$t.test.mjs || rc=1; done
exit $rc
