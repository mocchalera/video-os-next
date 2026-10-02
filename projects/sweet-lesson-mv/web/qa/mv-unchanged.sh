#!/bin/bash
# MV unchanged, by the real renderer: `vos render` of the same timelines from the pre-web room.html (/tmp/slproj, see mk-orig-project.sh) and from the current one; md5 of the whole mp4.
#   bash web/qa/mv-unchanged.sh [out.txt]       (run from anywhere; takes a few minutes)
# Exit code: 0 only if every render succeeded, every receipt belongs to THIS run (fresh, this timeline, this build, this file) and every pair is byte-identical. Anything else is non-zero.
set -u
P="$(cd "$(dirname "$0")/../.." && pwd)"; R="$(cd "$P/../.." && pwd)"; OUT="${1:-$P/web/review/m3/mv-unchanged.txt}"; mkdir -p "$(dirname "$OUT")"
WORK="$(mktemp -d /tmp/mu-run.XXXXXX)"   # a directory of its own: nothing from an earlier run can be mistaken for this one
START_EPOCH=$(date +%s); FAIL=0
cd "$R"
echo "# MV unchanged — current room.html (sha1 $(shasum "$P/graphics/room.html" | cut -c1-12)…) vs the pre-web room.html (web/review/m1/room.html.orig); $(date '+%F %T'); work dir $WORK" > "$OUT"
echo "# vos render of the same timelines; md5 of the whole mp4" >> "$OUT"
fail() { echo "FAIL: $*" | tee -a "$OUT" >&2; FAIL=1; }
# what each side is supposed to have rendered from: the receipt must name exactly these room.html files (by sha256)
SHA_ORIG=$(shasum -a 256 "$P/web/review/m1/room.html.orig" | cut -d' ' -f1); SHA_NEW=$(shasum -a 256 "$P/graphics/room.html" | cut -d' ' -f1)
cmp -s "$P/web/review/m1/room.html.orig" /tmp/slproj/graphics/room.html || fail "/tmp/slproj/graphics/room.html is not the pre-web room.html (run web/qa/mk-orig-project.sh)"
receipt_ok() { # receipt, mp4, timeline file (relative to its project), expected room.html sha256, project dir
  python3 - "$@" "$START_EPOCH" <<'PY'
import json, sys, hashlib, datetime, os
rc, mp4, tl, want_room, proj, start = sys.argv[1:7]
try:
    d = json.load(open(rc))
    sha = hashlib.sha256(open(mp4, 'rb').read()).hexdigest()
    tsha = hashlib.sha256(open(os.path.join(proj, tl), 'rb').read()).hexdigest()
    made = datetime.datetime.fromisoformat(d['created_at'].replace('Z', '+00:00')).timestamp()
    errs = []
    if d.get('output_sha256') != sha: errs.append('receipt output_sha256 != the mp4 on disk')
    if d['timeline']['sha256'] != tsha: errs.append('receipt timeline sha256 != this timeline')
    got = d['inputs']['graphics'].get('graphics/room.html')
    if got != want_room: errs.append('receipt names room.html %s..., expected %s...' % (str(got)[:12], want_room[:12]))
    if made < float(start) - 2: errs.append('receipt is older than this run')
    print('; '.join(errs)); sys.exit(1 if errs else 0)
except Exception as e:
    print('receipt unreadable: %s' % e); sys.exit(1)
PY
}
run() { # name, timeline-file (relative), extra flags
  local name="$1" tl="$2" extra="${3:-}"
  node src/cli.ts --project /tmp/slproj render --timeline "$tl" $extra --out "$WORK/$name-orig.mp4" > "$WORK/$name-orig.log" 2>&1 || { fail "$name: render (pre-web) exited non-zero, see $WORK/$name-orig.log"; return; }
  node src/cli.ts --project "$P" render --timeline "$tl" $extra --out "$WORK/$name-new.mp4" > "$WORK/$name-new.log" 2>&1 || { fail "$name: render (current) exited non-zero, see $WORK/$name-new.log"; return; }
  [ -s "$WORK/$name-orig.mp4" ] && [ -s "$WORK/$name-new.mp4" ] || { fail "$name: an output is missing or empty"; return; }
  local e1 e2
  e1=$(receipt_ok "$WORK/$name-orig.receipt.json" "$WORK/$name-orig.mp4" "$tl" "$SHA_ORIG" /tmp/slproj) || fail "$name (pre-web): $e1"
  e2=$(receipt_ok "$WORK/$name-new.receipt.json" "$WORK/$name-new.mp4" "$tl" "$SHA_NEW" "$P") || fail "$name (current): $e2"
  local a b; a=$(md5 -q "$WORK/$name-orig.mp4"); b=$(md5 -q "$WORK/$name-new.mp4")
  if [ "$a" = "$b" ]; then echo "$name  before $a  after $b  IDENTICAL" >> "$OUT"; else echo "$name  before $a  after $b  *** DIFFERENT ***" >> "$OUT"; FAIL=1; fi
}
run m1probe "web/review/m1/timeline.m1probe.json"
run m2probe "web/review/m1/timeline.m2probe.json"
run probe "timeline.probe.json"
run probe-draft "timeline.probe.json" "--draft"
if [ "$FAIL" = 0 ]; then echo "RESULT: all identical" >> "$OUT"; echo done >> "$OUT"; exit 0; else echo "RESULT: FAILED" >> "$OUT"; echo done >> "$OUT"; exit 1; fi
