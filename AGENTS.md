# AGENTS.md — video-os-next

You are the editor. `vos` gives you eyes, memory, hands and verification.
There is no pipeline to follow; there is a project state to read and an edit document to write.

## Map

| Need | Command | Truth lives in |
|---|---|---|
| What exists, what's missing, what's stale | `vos status` | `assets.json`, `.vos/paths.json`, receipts |
| See footage or a render | `vos look <alias\|render> --at 1,2.5 \| --count 12` → PNG, then read the image | `.vos/cache/look/` |
| What happens in a clip | `vos describe <alias…>` / `--all` (Marlin-2B, local, one model load) | `.vos/analysis/<id>/describe.json` |
| Make footage searchable | `vos index [--channels text,visual,audio]` | `.vos/analysis/<id>/embed.<channel>.{json,f32}` |
| Find a moment | `vos find "<words>"` (text+visual+audio+lexical, rank-fused; ja/en) · `--image f.jpg` · `--asset a` (Marlin temporal find inside one clip) | same |
| Missing footage → generate it | `vos gen library --search "…"` first (free) → else `vos gen up --budget-cu N` (N from the human) → `vos gen clip --prompt "…" [--from hero@2.5] --as a` → `vos look a` → `vos gen down` | `generated/*.gen.json`, `assets.json`, shared library |
| Heavy analysis off this machine | `vos remote up --budget-cu N [--profile marlin,visual]` (N from the human) → `vos describe --all --on colab` / `vos index --channels visual --on colab` / `vos find "…" --on colab` → `vos remote down` | same `describe.json` / `embed.visual.*`; `provenance.ran` says where it ran |
| Plan space + camera for generated shots | read `skills/previz-camera/SKILL.md` → write a bpy scene with `rig` (see `examples/previz/*.py`) → `vos previz render scene.py --as pv` → `vos look pv` → `vos gen clip --control pv_depth [--refs …] --prompt-file …` | `previz/<name>/`, `assets.json` |
| Finish generated footage (last step) | `vos gen upscale --dry-run` → `vos gen up --light --gpu T4 --budget-cu N` → `vos gen upscale` → `vos render` | aliases rebound; `generated/*.gen.json` (`vos.gen-upscale/1`) |
| Models present? | `vos models` / `vos models pull visual\|audio` (network, ask the human first) | HF cache, `~/.cache/vos/models` |
| Tempo of music | `vos beats <alias>` | `.vos/analysis/<id>/beats.json` |
| What is said, and when | `vos transcribe <alias> [--lang ja] [--vocab "固有名詞, …"]` (local faster-whisper, cached models only) → captions via `{"$transcript": alias}` (see `examples/graphics/captions.html`) | `.vos/analysis/<id>/transcript.json` |
| Lyrics / on-screen type in motion (文字PV) | read `skills/jizura-lyric-type/SKILL.md` → `vos transcribe music --singing` → `vos lyrics time sheet.txt --from music` → copy `examples/graphics/lyric-motion.html` → `vos lyrics fonts` → `vos lyrics plan [--markers write]` (example: `examples/lyric-motion/`). Telops over footage: `"mode": "telop"`; keep lines while changing one: `vos lyrics lock` / `unlock --lines n` (SKILL §12) | `data/lyrics.json` + clip props; the cut plan is derived from them + `seed` |
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
   (`{"$describe": alias}`, `{"$transcript": alias}`, `{"$data": "data/x.json"}`, `{"$asset": alias}`, `{"$assets": true}`).
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
  "markers": [ { "at": "32b", "dur": 0.2, "label": "drop", "kind": "expect-flash" } ],
  "master": { "loudness": -14, "true_peak": -1 } }   // default; null loudness = leave the level alone
// audio: vos mixes the final sound itself (ffmpeg): gain_db may be > 0 (≤ +24); a video clip's own sound needs "audio": true;
// duck music under narration: { "id": "A1", "kind": "audio", "duck": { "by": "A2", "db": -12 }, "clips": [...] }
```
Time: `12.5` / `"12.5s"` / `"360f"` / `"16b"` / sums like `"32b-0.3s"`. `grid` may be `{ "from": "<music alias>" }`.

Graphic skeleton: see `examples/videoos-pv/graphics/wipe.html` (small) and `find.html` (slots + bound data).
3D: `vos.graphic(({ three }) => { const g = three(); …; g.update = t => …; })` — three.js r182, one frame per
timeline frame, deterministic (no Clock / requestAnimationFrame). Example: `examples/graphics/three-cube.html`.
Fonts must be declared with `@font-face` in `design/` (lint rejects undeclared families).

## Repo

- `src/` TypeScript run directly by Node ≥ 22.18 (type stripping; erasable syntax only — no enums,
  no parameter properties). Zero runtime npm deps. `npm test` runs `node --test`.
- Toolchain is repo-owned: `node_modules/` (HyperFrames) and `python/.venv` (torch, transformers,
  Marlin, Qwen3-VL embedding, CLAP, onnxruntime). Set up with `scripts/setup.sh`
  (`--offline-from <dir>` assembles from an existing install). `python/requirements.lock.txt` is the pin.
- Workers: `python/marlin_worker.py` (describe/find), `python/embed_worker.py` (text/visual/audio;
  `VOS_EMBED_MOCK=1` gives deterministic vectors for tests).
- Search channels never mix vector spaces; `find` fuses ranks (RRF) and says which channels it
  could not use and why. A missing model is reported, never silently skipped.
- Before writing lyrics, captions or any typographic graphic, read `skills/jizura-lyric-type/SKILL.md` (JIZURA's typesetting and motion rules).
- Before writing a previz scene, read `skills/previz-camera/SKILL.md` (intent → lens, shot size and camera move, built with `rig`).
- Before any `vos gen clip`, read `skills/h3-prompt/SKILL.md` (official H3 prompt format; vos adds the frame-alignment line).
- Generated footage is 24 fps. A piece built mostly on it should use a 24 fps canvas (`vos init --fps 24`,
  or `"canvas": {"fps": 24}` in the timeline); the timeline warns about judder otherwise.
- `vos gen` spends money. Never start it without a budget from the human; always `vos gen down` when done
  (the guard stops an unattended VM anyway, but that is the safety net, not the plan).
- `docs/DESIGN.md` is the design; change it when you change a principle.
