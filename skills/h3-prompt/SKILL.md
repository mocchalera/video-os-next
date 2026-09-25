---
name: h3-prompt
description: Write MiniMax-H3 prompts for `vos gen clip` (text→video, first-frame, first+last-frame, last-frame) in the official field format, with shot timing, camera, dialogue and sound. Use before every `vos gen clip`.
---

# Writing MiniMax-H3 prompts for `vos gen`

H3 generates picture **and** stereo sound in one pass. It follows a structured "production brief" far better than
free prose: our free-text test prompt ("…a paper boat tips over a small drain grate…") produced the boat but not the
grate. This skill restates the official rules in vos terms.
Sources (read them when in doubt): MiniMax-H3 `skills/h3-prompt-writing/SKILL.md` and
`docs/VIDEO_PROMPT_WRITING_GUIDE_base_en.md` / `…_ref_en.md` (github.com/MiniMax-AI/MiniMax-H3, huggingface.co/MiniMaxAI/MiniMax-H3).

## 1. Pick the mode — vos flags decide it

| Mode | vos call | What the prompt must do |
|---|---|---|
| T2VA text→video | `vos gen clip --prompt-file p.txt` | describe everything |
| I2VA first frame | `--from hero@2.5` | start **exactly** from that frame, develop forward |
| FL2VA first+last | `--from a@1 --to b@3` | describe the **motion path** that connects the two frames |
| L2VA last frame | `--to b@3` | infer a plausible preceding state, converge onto the frame |
| Ref2VA references | *(not yet in vos — see §7)* | |

**Do not write the alignment line yourself.** The official format starts image-anchored prompts with a line such as
`For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.`
vos writes it from `--from`/`--to`, using the real last-frame time of the clip (e.g. 5.13 s for `--seconds 5`) and
your last `[Shot N]`. If you do include one, vos leaves it as is.

## 2. The three fields (always, in this order, blank line between)

```
integrated_multimodal_description: [Shot 1] …

overall_soundscape: …

non_diegetic_music: …
```

- **integrated_multimodal_description** — chronological, one flowing description per shot: style/medium first
  ("Live-action, cinematic, …"), composition, subjects, environment, lighting, actions, camera, dialogue and the
  sounds actions make. Concrete nouns and visible actions beat mood words and plot summary.
- **overall_soundscape** — 1–4 sentences: ambience, physical sounds, non-verbal human sounds (breath, footsteps).
- **non_diegetic_music** — 1–3 sentences: score the characters cannot hear (instrumentation, tempo, where it hits).
  `N/A` when there is none. Name what you want; unspecified audio is left to chance.
- Write the fields in **English**. Keep dialogue, lyrics and on-screen text in their original language (Japanese
  stays Japanese).
- Stay well under ~7000 characters. vos warns if a field is missing or the prompt is too long.

## 3. Shots and time

- The first shot has no timestamp: `[Shot 1] …`
- Later shots give the cut time as `mm:ss.mmm`: `[Shot 2] At 00:02.500, the camera cuts to …`
- The shots must fit the clip: a 5 s clip (`--seconds 5`, 124 frames) ends at 00:05.125. vos warns if a cut time is
  past the end.
- One clip is 4–15 s. Fewer shots per clip hold better; for an edit, prefer several clips and cut them in the timeline.
- Dialogue that runs across a cut: mark the cut with `<scenetrans>` and say the audio "continues seamlessly across the cut".

## 4. Camera

Give every move three things — **type, amplitude, speed** — written as a natural action, not stacked labels:
"The camera pushes in with small amplitude at slow speed", "a fast, wide pan to the left", "tracking alongside at
walking pace", "locked-off, static". Say "static" if you want no movement.

## 5. Dialogue

Stable speaker IDs by order of speaking, a voice description the first time, the words verbatim in `<d>` with a
language tag:

```
The young woman with a quiet, breathy voice (S1) says: <d>[Japanese] 次の駅で降ります。</d>
```

Two voices at once: `(S1,S2)`. Keep the same ID for the same person in every shot.

## 6. For first/last-frame clips

- I2VA: begin "…begins in the position and framing established by Picture 1, …" and move forward from there. Do not
  re-describe a different starting composition — it fights the frame.
- FL2VA: describe the path between them and end with "…settles into the pose, spacing and composition established by
  Picture 2 at the end of the shot."
- Continuing a generated shot: `--from <previous clip>@<a late frame>` and describe only what happens next. This is how
  consecutive clips stay continuous (same boat, same light) until references land in vos.

## 7. References (character / style) — status

The official Ref2VA mode uses six fields (`subject_definitions`, `summary`, `retention_analysis`,
`detailed_description`, `overall_soundscape`, `non_diegetic_music`) with labels `<Subject N>`, `<Picture N>`,
`<Video N>`, `<Audio N>` that keep one meaning throughout, and retention levels (`fully_preserved`,
`partially_preserved`, `attribute_transfer`, `weak_reference`). vos does not drive the ref2va model yet; this section
will be completed when it does.

## 8. Working habit in vos

1. `vos gen library --search "<words>"` first — a matching take is free.
2. Draft cheap: `--size draft --seconds 2` to test framing/motion (~12 s warm), then the real `--seconds 5` at 768p (~80 s).
3. Change one thing at a time; keep `--seed` fixed while fixing the prompt, vary the seed only for alternatives.
4. `vos look <alias> --count 8` and judge frames. A human decides whether a take is kept.
5. Put negatives last in the description when something keeps appearing: "No text, no logos, no extra people."

## Example (I2VA, continuing a generated shot)

`vos gen clip --from boat_768p@4.5 --seconds 5 --prompt-file spin.txt --as boat_spin`, with `spin.txt`:

```
integrated_multimodal_description: [Shot 1] Live-action, cinematic, macro lens. The paper boat begins in the position and framing established by Picture 1, drifting toward the camera along the wet gutter. It reaches a square iron drain grate, its bow dips over the bars and it tips sideways, spinning half a turn before sliding into the dark water between the bars. The camera stays low and static. Orange neon reflections ripple across the water as the boat disappears.

overall_soundscape: Steady rain on asphalt, water gurgling into the drain, a soft paper scrape as the boat catches on the metal grate.

non_diegetic_music: N/A
```
