# AGENTS.md — video-os-next

You are the editor. `vos` gives you eyes, memory, hands and verification.
There is no pipeline to follow; there is a project state to read and an edit document to write.

## Map

| Need | Command | Truth lives in |
|---|---|---|
| What exists, what's missing, what's stale | `vos status` | `assets.json`, `.vos/paths.json`, receipts |
| See footage or a render | `vos look <alias\|render> --at 1,2.5 \| --count 12` → PNG, then read the image | `.vos/cache/look/` |
| What happens in a clip | `vos describe <alias>` (Marlin-2B, local, slow) | `.vos/analysis/<id>/describe.json` |
| Find a moment | `vos find "<words>"` (stored descriptions) / `--asset a` (Marlin temporal find) | same |
| Tempo of music | `vos beats <alias>` | `.vos/analysis/<id>/beats.json` |
| Edit | write `timeline.json` + `graphics/*.html` | those files (the only edit state) |
| Build / render | `vos compile` / `vos render [--draft]` | `.vos/build/`, `out/*.receipt.json` |
| Check | `vos inspect` → findings with times + frame sheets | `out/*.inspect.json` |
| Hand to a human | `vos render --graphics-only` then `vos export fcp7` | `out/*.fcp7.xml` |

Every command takes `--json`. Errors carry a `hint` — read it before guessing.

## Invariants (do not break)

1. `timeline.json` is the only edit state. Never hand-edit `.vos/build/*` — it is regenerated.
2. Media is referenced by alias from `assets.json`; aliases map to content hashes. Never put
   absolute paths in committed files.
3. Graphics are declared clips. Footage shown inside a graphic goes through a `slot`
   (timeline clip with `"slot": "<graphicsClipId>/<name>"`), stills through
   `vos://asset/<alias>@<sec>`, and on-screen facts through bound props
   (`{"$describe": alias}`, `{"$data": "data/x.json"}`, `{"$asset": alias}`, `{"$assets": true}`).
   Do not type facts into graphics that an artifact already knows.
4. Deterministic graphics: no `Math.random`, `Date.now`, network. Per-frame logic goes in
   `onFrame(t => …)` with local time `t`.
5. Declare intent the checks can't guess: markers `expect-black`, `expect-flash`,
   `expect-still`; tracks `"role": "overlay"` for HUD/grain/transitions.
6. A render without a receipt, or with a stale one, proves nothing. Re-render before judging.

## Working loop (a habit, not a gate)

`status` → `look` at sources → write/adjust timeline → `render --draft` → `inspect` →
**look at the sheets it prints** → fix → `render` → `export`.
Judge with your eyes on frames; findings are evidence, not a score.

## Timeline cheatsheet

```jsonc
{ "format": "vos.timeline/1", "name": "x", "duration": "64b", "grid": { "bpm": 120, "offset": 0 },
  "tracks": [ // order = z order, bottom first
    { "id": "V1", "kind": "video", "clips": [ { "id": "c1", "asset": "a", "at": "4b", "in": 12.3, "dur": "2b",
        "fx": { "filter": "blur(3px)" }, "fade": { "in": 0.2 } } ] },
    { "id": "G1", "kind": "graphics", "clips": [ { "id": "ui", "src": "graphics/ui.html", "at": 0, "dur": "8b", "props": {} } ] },
    { "id": "S1", "kind": "video", "clips": [ { "id": "c2", "asset": "b", "slot": "ui/viewer", "at": "2b", "dur": "2b" } ] },
    { "id": "A1", "kind": "audio", "clips": [ { "id": "m", "asset": "music", "at": 0, "dur": "64b", "gain_db": -1 } ] } ],
  "markers": [ { "at": "32b", "dur": 0.2, "label": "drop", "kind": "expect-flash" } ] }
```
Time: `12.5` / `"12.5s"` / `"360f"` / `"16b"` / sums like `"32b-0.3s"`. `grid` may be `{ "from": "<music alias>" }`.

Graphic skeleton: see `examples/videoos-pv/graphics/wipe.html` (small) and `find.html` (slots + bound data).

## Repo

- `src/` TypeScript run directly by Node ≥ 22.18 (type stripping; erasable syntax only — no enums,
  no parameter properties). Zero runtime npm deps. `npm test` runs `node --test`.
- `python/marlin_worker.py` one-shot Marlin-2B worker. Machine tool paths: `vos doctor --write`
  (stored in `~/.config/vos/config.json`, never committed).
- `docs/DESIGN.md` is the design; change it when you change a principle.
