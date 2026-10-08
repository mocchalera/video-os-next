# vos judge — candidate spans per use, with evidence (d1 PoC)

Status: proof of concept. Compares the existing search (baseline) with LiquidAI d1-3B decisions on real frames.
Nothing here measures selection quality or editing time; those need a person's labels (see Report).

## Flow

1. `vos judge pool --purpose action|talk|screen --out <run-dir> [aliases…] [--channels text]` freezes one candidate
   list: Marlin events, ASR segments, the existing fused search (read-only; per-clip `find --asset` is never used
   because it writes `describe.json`), plus seeded coverage windows no artifact proposed. Artifact hashes are taken
   before/after. The digest covers the whole pool except `created_at` (purpose, query, seed, params, rubric, sources
   incl. transcript text, search, candidates); runners re-derive the transcript text from `transcript.json`.
   Resources: the search embeds the query. Default is the text channel (~130 MB model) + lexical; `--channels
   text,visual` loads the ~4 GB visual model locally.
2. `vos judge score <run-dir> --runner baseline` — rank by the existing search only, in/out = artifact span. With no
   search channel / no hits it is marked **degenerate** (all scores 0; the order is not a ranking).
3. `vos judge score <run-dir> --runner d1` — fixed rubric (`src/judge/rubric.v1.json`, hashed) on 1–3
   representative frames per candidate, one pass per frame; the top candidates are re-read densely on real
   frames to place in/out (the frames looked at and the estimated boundary range are kept apart). Every call is
   logged to `calls.jsonl` (latency, HTTP status, request / raw-reply sha256, the usage the server reported).
4. `vos judge report <run-dir> [--labels f]` — model-proxy numbers (agreement, coverage in top-k, abstentions,
   bound shifts, latency, RSS, disk, provenance, pool coverage share) and human numbers (adoption, misses, in/out
   error, time) which stay `null / not_measured` without a validated labels file a person filled in. Top-k means
   judged candidates only. `miss_rate` counts misses among labeled spans; spans outside the pool cannot be seen.

## Answers are the model's reading, not facts

Criterion statuses: `answered` (a usable model answer — its subjective reading of a frame or text, not an
observation; `action_peak` is inferred from a single still), `low_confidence`, `abstained` ("cannot tell"),
`unobserved` (no face / no words …), `unknown` (not in this purpose's rubric). `confidence` is what the model
reported (uncalibrated); noul answers have none and carry a derived `p_margin` = |P(yes) − 0.5| × 2 instead.

## Frame times

Every time is the decoder's `best_effort_timestamp` minus the container start; nominal fps and sample numbers are
never used as times. Trust ends at the first frame whose time is missing (no PTS and no best-effort), repeats or
goes backwards, or whose PTS repeats; if the frame before it shares that PTS it is dropped too (ambiguous
image). Anomalies keep pts and pkt_dts. Frames whose PTS is N/A but have a best-effort time stay trusted and are
counted (`time_source.best_effort_only`). Spans are half-open: an end on a frame time does not take that frame.
`last_frame_end` is an estimate (last time + median frame gap), labelled so. Every extracted image is checked
against the PTS the decoder delivered (`showinfo`, `-copyts`). ffprobe/ffmpeg versions are recorded.

## Model server (fail closed)

Pinned: `LiquidAI/d1-3B-GGUF@bb1e436…` Q8_0 + mmproj (sha256 in `src/judge/d1.ts`), llama.cpp `b11491`
`llama-server` (`/v1/systemone`). Fetch with `scripts/d1/fetch.sh <dir>` once the human has approved where ~3.5 GB
may be stored (it checks size + sha256 of every file incl. LICENSE); check with `vos judge doctor [--rehash]`.

vos starts the server itself on a **UNIX socket in a private 0700 temp directory** — no TCP port, so web pages in a
browser cannot reach it (CORS / DNS rebinding do not apply) and other users cannot connect; no API key is needed.
`LLAMA_*` variables are removed from its environment; flags: `--offline --no-webui --no-slots
--no-cors-credentials`. HTTP redirects are refused, never followed. The server is stopped on normal exit, errors,
and SIGINT / SIGTERM / SIGHUP; `llama-server.pid` exists in the run directory only while it runs (a SIGKILL of vos
cannot be caught — check that file). Before every d1 run the model files are re-read in full (`--trust-stamp`
skips that). An attached endpoint (`--endpoint unix:/….sock | http://127.0.0.1:PORT`), an unpinned runner or a
stamp-only check leaves provenance gaps; a comparison run refuses them unless `--allow-incomplete-provenance`, and
the result says so. Missing or mismatched files, an older runner, a non-loopback endpoint, an invalid reply or
low disk stop the run — there is no fallback.

License: LFM Open License v1.0 — whether its revenue threshold applies to a given user is not decided here.
