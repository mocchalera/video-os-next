---
name: jizura-lyric-type
description: Make lyric motion video (文字PV / kinetic typography) and on-screen Japanese type the JIZURA way — cut model, 文節 chunking, 文字整列 typesetting, 統一感, role palettes, backgrounds, text treatments, cut transitions, glyph shattering, chromatic ghosts. Use before writing lyrics, captions or any typographic graphic, and with examples/graphics/lyric-motion.html.
---

# JIZURA: lyric motion and Japanese type in vos

JIZURA (github.com/852wa/JIZURA, MIT, v0.9.0 @ 8da975f) is a browser lyric-video engine: lyrics → timed cuts →
Canvas2D, deterministic from a seed. vos runs **JIZURA's own engine** with every expression pack inside one graphic,
`examples/graphics/lyric-motion.html` (vendored by `vendor.py`), drives it with `vos lyrics time | fonts | plan`, and
this skill carries its ways of thinking: §11 lists what holds for every graphic you write, §12 what changes for
captions over footage. Every key with its Japanese name:
`VOCABULARY.md`. License and attribution: `LICENSE-JIZURA.txt`.

## 1. The model: a lyric video is a sequence of cuts

One **cut** = one piece of a lyric line on screen, made from independent parts, each picked from a registry:

| part | decides | count | e.g. |
|---|---|---|---|
| layout | the composition | 184 | `center` `vcols` 縦書き `huge` 画面突き抜け `stationSign` 駅名標 `noren` 暖簾 `letterPaper` 便箋 `keycaps` `knSlamStack` |
| enter / hold / exit | arrival, idle motion, departure | 125 / 52 / 109 | `assemble`* `wipe` `type` `tyDotGrow` · `breathe` `heartbeat` · `explode`* `fall`* `drift`* `zoomFar` |
| decor | graphics around the lyric | 130 | `brackets` 枠マーク `leaders` 引き出し線 `tyColophon` 奥付 `moonPhases` `sensu` 扇 |
| treat | how the glyphs themselves are painted | 62 | `outline` 袋文字 `extrude` 立体 `marker` `halftone` 網点 `neonOutline` `karaoke` `ransom` 切り貼り |
| bg | a full-screen background graphic per line | 66 | `seigaiha` 青海波 `houndstooth` 千鳥格子 `topoLines` 等高線 `starfield` `tornPaper` 破れ紙 `bigChar` 巨大文字 |
| cam | camera over the cut | 36 | `push` `dollyIn` `beatPunch` 拍でズーム `handheld` `rackFocus` `whipIn` `knReadPan` |
| trans | how a cut takes over from the one before | 27 | `irisOpen` `pushSlide` `doorsOpen` 観音開き `inkBlob` `shatterTiles` `pixelate` `cubeTurn` |
| scheme | the colours (per part, from the style pack) | 24 styles × 2–4 | |

The typo (文字PV系: type, rules, numbers) and kinetic (word by word, beat-locked) sets are on; horror is off
(`"horror": true`); 和風 motifs are on (`"wa": false`).

`*` = the glyph is split into its strokes / radicals (raster connected components) which fly in, shatter, crumble or
dissolve independently — JIZURA's 字形を砕く演出.

Contracts that make the parts combine freely (keep them in anything you write):
- an entrance at p = 1 is **exactly** the resting item (no leftover offset, alpha or blur); an exit at p = 1 is **fully gone**;
- holds are subtle and scale with a motion amount (0 = no change); subtle beats loud;
- secondary graphics animate in (≈0.3–0.5 s, `outExpo`) and out (`inCubic` on the exit progress) — nothing pops;
- the lyric sits inside a 5 % safe margin at rest, in landscape **and** portrait, for 1–16 glyphs and Latin text;
- front decor never covers the lyric (it frames it); back decor and backgrounds stay low-contrast (`dim`, `sub`);
- randomness is a hash of (seed, index, step) — never `Math.random`/`Date.now` (vos invariant 4 says the same).

## 2. Cutting a line: 文節, not characters

- Split by 文節-ish chunks (Intl.Segmenter `ja`, then merge): hiragana runs of ≤3 attach to the word before; kanji runs
  merge up to 6 glyphs; katakana and Latin runs stay whole; punctuation sticks to the previous chunk; a lone kana joins
  the chunk before; chunks > 10 glyphs are split in balanced halves.
- English: short phrases (≈9 letters or 3 words, or up to a comma), never word-by-word; a trailing short word joins.
- Cuts per line ≈ visible time / 0.9 s (density 0.5; 1.3 s at 0 … 0.5 s at 1), at most chunks + 1. The extra cut is a
  **recap**: the whole line once more at the end, often in a calmer layout.
- Cut lengths follow glyph count (+1.6 per cut), boundaries snap to a beat within 0.13 s, never shorter than 0.22 s.
- A line stays visible at most `max(3.6, 0.5 × glyphs + 1.2)` s; after that the screen may breathe.
- Manual cuts win: `夜明けの/色を` in the lyric text.

## 3. Line breaks inside a cut

Balanced lengths first; then prefer a break after hiragana before a non-hiragana, after punctuation or a space, and at a
chunk boundary. Never start a line with a small kana, ー, っ, 、。, or a particle (を が は に で と の へ も in particle
position); never break inside a Latin word. Vertical columns use the same rules (`まだ眠い｜街をひとりで｜歩く`).
(vos addition: upstream JIZURA balances lengths only; `lyric-motion.html` overrides `J.splitLines` with these rules.)

## 4. 文字整列 (typesetting) — numbers, not taste

Only glyph size and advance change, so every layout keeps working:

| glyph | rule |
|---|---|
| kana | advance × 0.90 (small kana 0.86, ー 0.94): kana set tighter than kanji |
| particle (は が を に で と の へ も, in particle position, line ≥ 3 glyphs) | size × 0.78, baseline kept |
| first glyph of a line ≥ 3 (kanji / kana) | size × 1.18 (頭の字を大きく) |
| Latin / digits | size × 1.08, plus 0.2 em gap where Latin meets Japanese |
| vertical | Latin and ー〜…「」 rotate 90°; small kana shift (+0.11, −0.11) em, 、。 (+0.3, −0.3) em |

And time: **show the lyric 0.2 s before the voice** — reading ahead feels in sync. And restraint: at most one decoration
per cut, and no text treatment on a cut that already has a decoration (effects don't pile up).

## 5. 統一感 (unified look) — what makes it feel hand-made

- A **part** is a block between blank lines (`"section": true`). Within a part keep a small palette: ≤3 layouts
  (reused 90 %), ≤2 entrances, ≤2 exits, 1 hold, ≤2 decorations, 1 treatment, ≤2 transitions. A new part may bring a
  new palette, background and scheme.
- A line that **comes back** (サビ) is shown exactly as the first time: same cuts, layouts, params, motion, joins.
- **Directions alternate** within a part (left ↔ right, up ↔ down); **strong moves are rationed** (spin, zoom, scramble,
  crash zooms, earthquakes…) — swapped for calm ones unless the cut is emphasised, and never twice in a row.
- **キメ**: a line ending in `!` (or, when none is marked, the first line of a part that repeats) is ONE big cut —
  `huge`/`center`, zoom or blur in, a punch-in camera, a chroma spike, flash and shake. Declare `expect-flash` markers
  there so `vos inspect` knows it is intended.
- **モーフ**: the next part of the same line may grow out of this one — shared glyphs glide to their new places, the rest
  melts (likely on a recap, the whole line once more).
- A **short silence inside a part is not a break**: JIZURA clears a line after its visible time and lets the
  background breathe. Only a new part, a real instrumental (≥ 8 s) or the outro become an instrumental cut — splitting
  every line into its own part would make each line a part-opening キメ (learned on a real song: 14 flashes).
- `*word*` emphasis pulls the emphatic layouts (huge, center, condensed, marquee) for the cut that holds the word.

## 6. Backgrounds, treatments, transitions, shattering

- **Background** (bg): one graphic per *line* (occasionally re-rolled per cut), drawn once per frame behind the text and
  outside the camera, from the scheme colours at low contrast; continuous motion runs on absolute time so it flows
  across cuts. Layouts that fill the screen (`busy`) only get `subtle` backgrounds. Picked more often with higher
  `fx.decor` / `fx.bgSwitch`. Families: gradients (オーロラ, メッシュ, 惑星の縁), textiles and 和柄 (青海波, 麻の葉,
  千鳥格子, タータン), geometry (六角格子, 立方体, モアレ, 四角トンネル), scenes (星空, 月夜, 街並み, 夕日, 海, 雨の窓, 雪,
  花火), media (フィルム, VHS, 破れ紙, 大理石), graphic devices (集中線, 放射, 市松, 太枠, シネスコ帯, 巨大文字).
- **Treatment** (treat): applied to *every* glyph item of the cut before its motion — outlines, extrusion, shadows,
  glow, markers / boxes / strikes, fills (halftone, stripes, gradients, chrome, rainbow), width (平体・長体), rhythm
  (大小リズム, 段違い), editorial marks (傍点, かぎ括弧, 丸囲み, 原稿用紙). Layouts that sit the lyric on their own plate
  accept only `safe` treatments; `diag`-like plate layouts accept none.
- **Transition** (trans): the previous cut's resting frame (A) and this cut (B) are composited — at p = 0 exactly A,
  at p = 1 exactly B. It replaces the previous exit and this entrance, so it only happens when the cuts touch
  (no gap), never into the first cut, and a returning line joins its cuts the same way as the first time. A directed
  entrance / exit is kept: no transition or モーフ replaces it unless a transition is directed too.
- **Shattering**: `assemble` flies the strokes in from a scatter, `explode` blows them outward, `fall` makes them tremble
  and drop under gravity, `drift` lets them float up and fade. They read best on large, heavy type (huge, center,
  condensed) and on キメ exits; on dense small text they turn to noise.

## 7. Colour: role palettes, never ad-hoc hex

A scheme has roles: `bg fg sub accent accent2 ink dim ghostA ghostB` (+ `grad`, `paper`). `ink` is the plate/sticker
colour, `dim` the faint background-type colour, `ghostA/B` the chromatic ghosts. Draw with these roles only. A style pack
holds 2–4 schemes (usually one inverted) that the video switches between per part.

| style | look | type |
|---|---|---|
| `noir` | black, white type, cyan / amber colour shift | gothic black |
| `crimson` | deep red, white + black two-tier, data damage, HUD | gothic black |
| `caution` | yellow, red + blue accents, instrument UI | mincho black display |
| `magenta` | shocking pink × white, round gothic, leader lines | round |
| `paper` | paper grain, indigo + magenta, mincho ghosts | mincho black |
| `hud` | charcoal, hairline frames, orange accent | gothic black + mincho |
| `mint` | black × teal × lime, labels, slit scan | gothic black |
| `specimen` | ink black, mincho, dictionary notes + leaders | mincho bold |
| `transit` | olive × yellow, arrows and signs | zenkaku gothic |
| `blueprint` | vivid blue × white × black, diagonal bands | dela gothic |
| `rouge` | light grey, red gradient, capsules | gothic black |
| `mono` | grey space, white mincho, strong RGB split | mincho black |

Twelve more: `sakura` `ocean` `sunset` `forest` `vapor` `newsprint` `synth80` `kraft` `candy` `acid` `sumi` 墨と朱
`gold` 金夜 (+ three horror styles) — descriptions in `VOCABULARY.md`.

Chromatic ghosts: the lyric is drawn three times — pass B lagged 1.6 frames and offset (−3.4, −1.3) px in `ghostB`,
pass A lagged 0.8 frames at (+3.2, +1.9) in `ghostA`, then the main pass. Ghosts use `source-over` on dark backgrounds
and `multiply` on light ones; they spike on キメ and pulse on the beat. Secondary text (`ghost: false`) never splits.

## 8. Type roles

Four roles: `display` (the lyric), `serif` (mincho for contrast, vertical, notes), `body` (labels), `mono` (timecodes,
line numbers, coordinates — the "document" layer). The tension between a heavy gothic lyric and a small mono
annotation is most of the JIZURA look, and so is each style's choice of faces — use `"fonts": "jizura"` with
`vos lyrics fonts` (§9). In vos every face must be declared with `@font-face` in `design/`; to use a project's own
families instead, map JIZURA's font keys by kind (`"fonts": { "gothic": "ZK", "mincho": "NSJ", "round": …, "mono": … }`,
or one key: `"dela": "ZK:900"`) — then 太さ is off. Japanese faces are large: always subset them to the glyphs drawn
(`vos lyrics fonts` does; by hand: `pyftsubset Font.otf --text-file=chars.txt --layout-features='*'`) and re-subset when
the lyrics change — missing glyphs fall back to a system face.

## 9. Making a lyric video in vos

1. **Times from the song.** `vos transcribe music --singing --lang ja` (sung vocals need `--singing`: the speech filter
   drops them — a whole song came back empty without it), write the lyric sheet as text (one line per lyric, `[Verse]`
   headers or blank lines between parts, repeats written out in full, inline syntax allowed), then
   `vos lyrics time lyrics.txt --from music` → `data/lyrics.json`. The sheet is the truth for the words; the transcript
   only says when. `~` lines were heard with other spellings (time usually right), `?` lines were not heard and are
   interpolated — check those by ear and fix `"at"` by hand. Times are the voice; the 0.2 s lead is added later.
2. **The graphic.** Copy `examples/graphics/lyric-motion.html` into `graphics/`; one graphics clip over the whole song
   (`"props": { "lyrics": {"$data": "data/lyrics.json"}, "style": "paper", "seed": 1, "fonts": "jizura", "title": …,
   "artist": … }`), the music on an audio track, `"grid": { "from": "music" }` so cuts snap, ghosts pulse and beat
   cameras hit. JIZURA animates on twos (`"fx": { "koma": 12 }` at 24 fps; `0` = every frame).
3. **Type.** `vos lyrics fonts --download` (first time: fetches JIZURA's 18 OFL faces from google/fonts into
   `~/.cache/vos/fonts` — network, ask the human) subsets them to the lyrics + JIZURA's scramble / HUD characters into
   `design/fonts/jizura/` + `design/jizura-fonts.css` (≈1.5 MB) and reports lyric characters a face lacks. Re-run it when
   the lyrics change. With `"fonts": "jizura"` every style draws in its own faces (Zen Old Mincho, Dela Gothic,
   Kaisei Tokumin, DotGothic16 …) and 太さ animates the variable Noto Sans / Serif JP.
4. **Read the plan before rendering.** `vos lyrics plan` lists every cut in timeline seconds (text, layout / enter /
   hold / exit, treatment, background, camera, transition, モーフ, キメ, recap); `--markers write` puts the
   `expect-flash` / `expect-black` markers the screen effects need into the timeline (replacing its own previous ones).
5. **Direct.** On a line in `data/lyrics.json`: `"layout"`, `"enter"`, `"exit"`, `"hold"`, `"treat"`, `"bg"`, `"cam"`,
   `"trans"`, `"decor": [..]`, `"cuts": n`; one cut only: `"cut": { "1": { "treat": "marker" } }`. Direction replaces
   only the part it names — 統一感, キメ and the part palettes stay. Or change `seed` for another arrangement of
   everything, `style` for another palette and type, `"fx"` (0..1: `motion glitch chroma decor density texture
   bgSwitch`, `flash`, `hud`) for the whole video, `"enabled": { "trans": { "cubeTurn": false } }` to ban a part.
6. **Over footage**: `"background": false` on a graphics track above the video; `"centerFree": true` (or `"lr"`) keeps
   the centre free for a face (中央を空ける); `"keyBg": "green"` for keying.
7. `vos render --draft` → `vos look <render> --count 16` → `vos inspect` → fix → `vos render`.

What to look for on the sheets: a lyric that leaves the safe margin at rest (only `huge` may); particles or small kana
starting a line; two strong moves in a row; decor overlapping the lyric; a background that competes with the text
(pick a quieter one or lower `fx.decor`); a returning line that looks different; a long static or near-white stretch
(an `end` on the last line makes the outro an instrumental cut to the end of the clip).

## 10. Updating the engine

`python3 skills/jizura-lyric-type/vendor.py <JIZURA checkout>` rewrites the vendored block from JIZURA's built
`index.html`. Its patch list (determinism, font readiness, vertical columns, direction, repeats) must each match exactly
once; when JIZURA changes, fix the patches, then run `LYRIC_MOTION_FULL=1 npm test` (forces every one of the ~1000
parts through the planner and renderer, failing on any warning or Math.random / Date.now) and regenerate
`VOCABULARY.md`.

## 11. Writing your own graphics with the same sense

Even outside lyric videos (titles, captions, HUDs in other graphics):
- size by fitting to a box relative to W/H (`min(fit, H × k)`), not fixed px; test 16:9 and 9:16;
- one strong type element + one small mono annotation layer (numbers, timecode, `No.03`, 【見出し】);
- motion = easing curves JIZURA uses: in `outExpo`/`outBack`, out `inCubic`/`inExpo`, holds `inOutSine`; stagger glyphs
  by 0.02–0.06 s; masks for elegance, bands/slices for energy, pieces for impact;
- colours from role tokens (CSS custom properties in a `design/` stylesheet, like `--bg --ink --dim` in
  `examples/videoos-pv/design/tokens.css`; `vos init` creates an empty `design/`); the accent is rare;
- grain / paper as a deterministic texture, never noise from `Math.random`.

## 12. テロップ: JIZURA over footage (captions, not a lyric video)

A lyric video owns the whole frame; a telop sits on someone's footage. The same engine does both — say which:
`"mode": "telop"` on the lyric-motion clip. What it changes (each measured on a 9:16 short over bright gym footage):

| lyric video | telop mode | why |
|---|---|---|
| backgrounds per line, back-layer decorations | none (front decorations stay) | a background paints over the picture (it went black); sun rays / grids read as a grey film |
| HUD (REC, SCENE / CUT) | off | reads as UI noise on footage |
| every layout | no `busy`, no plate layouts (`treat` 'safe' / false: 便箋, ポラロイド, 折り紙, 検索窓 …), none that repeat the caption (ring, stack, tile, marquee, scatter, typeSpecimen …), none that lay a band / plate / mass over the picture (diag, curtain, pile, knPadGrid, gloss …) | plates hide the face; a repeated caption reads as a list |
| every transition | not the 8 that fill the frame mid-way (zoomThrough, knCornerSwing, whipPan, cubeTurn, uncover, doorsOpen, spinOut, knStutterCut) | a 0.3 s black frame at every キメ |
| 0.2 s lead | no lead (`"lead"` to set one) | a telop is placed where it should appear, not ahead of a voice |
| — | a thin edge + soft shadow on the caption layer (`"legible": "dark"` default, `"light"`, `false`) | white type vanishes on a white wall |
| opaque | transparent (`"background": true` to fill) | |

Everything switched off stays reachable: a line's own direction always wins, and
`"enabled": { "layout": { "pill": true, "crossBands": true } }` brings a family back for random picks too.

**Write the telops as lyric lines** (`data/lyrics.json`, array form): `at` = when it appears, `"section": true` where the
footage changes beat (1本目 / レスト / 次の1本 …), `!` at the end for a キメ (one big cut + flash; the `!` itself is not
drawn — a full-width `！` is drawn but is not a キメ), `|note` for the small mono annotation (`走る前の顔|before`),
`/` for manual cuts (`1kmを/3分05秒で/× 5本`). For speech, `{"$transcript": alias}` gives one line per segment.

**Keep what works, change one thing: `vos lyrics lock`.** JIZURA plans each line from its seed *and* from what the
lines before it used (no repeats) and from its part's palette — so directing one line, switching a part off or editing
a text rearranges the lines after it. Before directing, lock the plan you like:

```
vos lyrics lock                      # every line keeps exactly what it shows now (JIZURA's ロック + glyph stagger)
vos lyrics unlock --lines 2          # release the one line to change
# edit line 2 in data/lyrics.json ("layout": "pill", new text …), then
vos lyrics plan                      # 🔒 marks locked cuts; only line 2 moved
```

A locked line replays its stored cuts (layouts, params, motion, decor, colours, joins, accents); a returning line is
locked with its first occurrence. A lock holds while the line still splits into the same cuts — change its text and
`vos lyrics plan` warns that it is replanned (lock it again). Rendering a locked plan is pixel-identical to the
unlocked one it came from.

Also for footage: the timeline grid is in timeline seconds, song time 0 sits at the clip start + `offset` (a clip placed
later keeps the same beats); `"centerFree": "tb"` puts every caption in the top / bottom bands on 9:16 (the face
usually sits in the upper third, so `tb` is not always what you want — look at the sheets).
