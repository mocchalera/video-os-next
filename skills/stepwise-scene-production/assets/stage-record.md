# Stage record — <project> <shot id>

Route: H3 previz | Blender-final        Intent (one line): …
Reference: <path or alias> · sha256 <…> · what it is (keyframe / board / frame of a cut) and where it came from
In scope: …                             Out of scope (not rebuilt, not claimed): …
Scene file: <path> · receipt: <path>/receipt.json (runner sha256 inside)
Fitted against: <which image> · what still differs (sizes, crops, colours) — acceptance is a workflow step, not a pixel match

| Stage | Check image (path · sha256) | What changed | Accepted? (by whom) | Return condition hit? | Open / unresolved |
|---|---|---|---|---|---|
| 1 layout | | | agent: yes/no · human: not measured | | |
| 2 form | | | agent: yes/no · human: not measured | | |
| 3 material | | | agent: yes/no · human: not measured | | |
| 4 motion | start / mid / end · clip | | agent: yes/no · human: not measured | | |

Guessed shapes (not visible in the reference): …
Camera (from receipt): position · look-at · lens · move (type, amplitude, speed, ease)
Hand-off (H3 route): READY / BLOCKED — canon · subject scope · depth content (proxies?) · refs content · prompt (subjects, move,
  duration for the hand-off frame count) all agree? List each disagreement. control `<pv>_depth` · refs · guides · prompt file (draft / sent)
Iterations that failed (keep them; say why): …
