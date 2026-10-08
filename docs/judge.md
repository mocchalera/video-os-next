# vos judge — candidate spans per use, with evidence (d1 PoC)

Status: proof of concept. Compares the existing search (baseline) with LiquidAI d1-3B decisions on real frames.

## Flow

1. `vos judge pool --purpose action|talk|screen --out <run-dir> [aliases…]` freezes one candidate list:
   Marlin events, ASR segments, the existing fused search (read-only; per-clip `find --asset` is never used
   because it writes `describe.json`), plus seeded coverage windows no artifact proposed. Artifact hashes are
   taken before/after; both runners refuse a pool whose artifacts changed.
2. `vos judge score <run-dir> --runner baseline` — rank by the existing search only, in/out = artifact span.
3. `vos judge score <run-dir> --runner d1` — fixed rubric (`src/judge/rubric.v1.json`, hashed) on 1–3
   representative frames per candidate, one pass per frame; the top candidates are re-read densely on real
   frames to place in/out (observed frames and the estimated boundary range are kept apart).
4. `vos judge report <run-dir> [--labels f]` — model-proxy numbers (agreement, coverage in top-k, abstentions,
   bound shifts, latency, RSS, disk) and human numbers (adoption, misses, in/out error, time) which stay
   `null / not_measured` without a labels file a person filled in. A labels template includes seeded audit picks
   outside both top-k lists.

## Frame times

Every time is the decoder's `best_effort_timestamp` minus the container start. Nominal fps and sample numbers are
never used as times. A missing, repeated or backwards timestamp ends the trusted part of a stream; candidates
there are abstained. Every extracted image is checked against the PTS the decoder delivered (`showinfo`, `-copyts`).

## Model (fail closed)

Pinned: `LiquidAI/d1-3B-GGUF@bb1e436…` Q8_0 + mmproj (sha256 in `src/judge/d1.ts`), llama.cpp `b11491`
`llama-server` (`/v1/systemone`, loopback only). Fetch with `scripts/d1/fetch.sh <dir>` once the human has
approved where ~3.5 GB may be stored; check with `vos judge doctor`. Missing or mismatched files, an older
runner, a non-loopback endpoint, an invalid reply or low disk stop the run — there is no fallback.
Model outputs are the model's subjective reading (probabilities kept), not facts about the footage.
License: LFM Open License v1.0 — check its revenue threshold terms for commercial use.
