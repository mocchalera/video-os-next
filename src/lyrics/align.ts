/**
 * Lyrics sheet + transcript word timings → timed lyric lines (`vos lyrics time`).
 *
 * The sheet is the truth for the words; the transcript only says *when*. Both are reduced to comparable characters
 * (letters and digits; katakana folded to hiragana, full-width to half-width, Latin lower-cased) and aligned with a
 * semi-global edit distance (leading / trailing transcript noise is free). A line's start / end come from the transcript
 * characters aligned to its first / last characters — exact matches or substitutions (瞼 heard as ま, 起き as 気:
 * the position is right even when the spelling is not); its confidence counts exact matches only. Lines with too few
 * exact matches (ASR missed the line) are interpolated between their neighbours and flagged, so a human or agent can
 * check exactly those by ear.
 */

export interface SheetLine { text: string; section: boolean; part?: string; srcLine: number }
export interface SheetResult { lines: SheetLine[]; skipped: { srcLine: number; text: string; why: string }[] }
export interface TimedLine { at: number; end?: number; text: string; section?: boolean; part?: string; confidence: number; interpolated?: boolean }
export interface AlignWord { start: number; end: number; word: string }

/** A lyric sheet: one line per lyric; blank line or `[Verse]` header = new part; `# …` and `（…）` notes are skipped. */
export function parseSheet(text: string): SheetResult {
  const lines: SheetLine[] = [], skipped: SheetResult["skipped"] = [];
  let section = false, part: string | undefined;
  String(text).replace(/\r/g, "").split("\n").forEach((raw, i) => {
    let s = raw.trim();
    if (!s) { if (lines.length) section = true; return; }
    if (/^#/.test(s)) return;                                      // markdown title / comment
    const hdr = s.match(/^\[([^\]\d:][^\]]*)\]$/);                 // [Verse] [Chorus 2] (not an LRC time tag)
    if (hdr) { part = hdr[1].trim(); section = lines.length > 0; return; }
    s = s.replace(/^(\[\d+:\d+(?:[.:]\d+)?\])+/, "").trim();     // LRC tags: times come from the audio instead
    if (/^[（(].*[）)]$/.test(s)) { skipped.push({ srcLine: i + 1, text: s, why: "a note, not a lyric — write repeated lines out in full" }); return; }
    if (!s) return;
    lines.push({ text: s, section, part, srcLine: i + 1 });
    section = false;
  });
  return { lines, skipped };
}

/** the characters used for matching (inline JIZURA syntax removed: |note, *emph*, a/b, final !) */
export function matchChars(text: string): string[] {
  const s = String(text).split("|")[0].replace(/[*/]/g, "").replace(/[!！]\s*$/, "");
  const out: string[] = [];
  for (let c of s.normalize("NFKC")) {
    if (!/[\p{L}\p{N}]/u.test(c)) continue;
    const cp = c.codePointAt(0)!;
    if (cp >= 0x30a1 && cp <= 0x30f6) c = String.fromCodePoint(cp - 0x60);   // katakana → hiragana
    out.push(c.toLowerCase());
  }
  return out;
}

export function alignLyrics(sheet: SheetLine[], words: AlignWord[], opts: { minConfidence?: number } = {}): { lines: TimedLine[]; flagged: number[] } {
  const minConf = opts.minConfidence ?? 0.2;
  // lyric characters, each tagged with its line
  const A: { c: string; line: number; k: number }[] = [];
  const nOf = sheet.map((l, li) => { const cs = matchChars(l.text); cs.forEach((c, k) => A.push({ c, line: li, k })); return cs.length; });
  // transcript characters, each with a time slice of its word
  const B: { c: string; t0: number; t1: number; seg: number; bi: number }[] = [];
  let seg = 0;
  words.forEach((w, wi) => {
    if (wi > 0 && w.start - words[wi - 1].end > 0.6) seg++;       // a pause in the voice starts a new run
    const cs = matchChars(w.word);
    const d = Math.max(0.02, w.end - w.start) / Math.max(1, cs.length);
    cs.forEach((c, i) => B.push({ c, t0: w.start + i * d, t1: w.start + (i + 1) * d, seg, bi: B.length }));
  });
  const N = A.length, M = B.length, W = M + 1;
  const D = new Int32Array((N + 1) * W);
  for (let i = 1; i <= N; i++) D[i * W] = i;                     // D[0][j] = 0: skipping leading transcript is free
  for (let i = 1; i <= N; i++) for (let j = 1; j <= M; j++) {
    const sub = D[(i - 1) * W + j - 1] + (A[i - 1].c === B[j - 1].c ? 0 : 1);
    D[i * W + j] = Math.min(sub, D[(i - 1) * W + j] + 1, D[i * W + j - 1] + 1);
  }
  let j = 0;
  for (let jj = 1; jj <= M; jj++) if (D[N * W + jj] < D[N * W + j]) j = jj;   // trailing transcript is free
  const anchor: (typeof B[number] | null)[] = new Array(N).fill(null);   // exact matches
  const pos: (typeof B[number] | null)[] = new Array(N).fill(null);      // matches + substitutions
  const used = new Uint8Array(M);
  for (let i = N; i > 0 && j > 0;) {
    const here = D[i * W + j], same = A[i - 1].c === B[j - 1].c;
    if (here === D[(i - 1) * W + j - 1] + (same ? 0 : 1)) { if (same) anchor[i - 1] = B[j - 1]; pos[i - 1] = B[j - 1]; used[j - 1] = 1; i--; j--; }
    else if (here === D[(i - 1) * W + j] + 1) i--;
    else j--;
  }
  // per line: anchors → start / end
  const durs: number[] = [];
  for (const b of anchor) if (b) durs.push(b.t1 - b.t0);
  durs.sort((x, y) => x - y);
  const charDur = Math.min(0.6, Math.max(0.12, durs.length ? durs[durs.length >> 1] : 0.25));
  // a line with too few exact matches is not trusted: whatever its characters were aligned to (often the first sounds
  // of the next line, as substitutions) goes back to the pool its neighbours may widen into
  // …unless most of its characters were aligned one-to-one: then it was heard, only spelled otherwise (低空飛行で heard
  // as テクヒコで) — its position is right, its confidence stays low
  const exactOf = sheet.map((_, li) => A.filter((a, i) => a.line === li && anchor[i]).length);
  const posOf = sheet.map((_, li) => A.filter((a, i) => a.line === li && pos[i]).length);
  const trusted = sheet.map((_, li) => exactOf[li] >= Math.min(2, Math.max(1, nOf[li])) && exactOf[li] / Math.max(1, nOf[li]) >= minConf);
  const heard = sheet.map((_, li) => trusted[li] || (nOf[li] >= 2 && posOf[li] / nOf[li] >= 0.6 && exactOf[li] >= 1));
  A.forEach((a, i) => { if (!heard[a.line] && pos[i]) { used[pos[i]!.bi] = 0; pos[i] = null; anchor[i] = null; } });
  const res = sheet.map((l, li) => {
    const exact = exactOf[li];
    const idx = A.map((a, i) => (a.line === li && pos[i] ? i : -1)).filter((i) => i >= 0);
    const n = Math.max(1, nOf[li]);
    const conf = exact / n;
    if (!idx.length || !heard[li]) return { at: NaN, end: NaN, conf };
    const f = idx[0], g = idx[idx.length - 1];
    // transcript characters just before / after the line, in the same voiced run and aligned to nothing, are the
    // line's own sounds spelled longer (瞼 → まぶた): widen to them instead of extrapolating
    let b0 = pos[f]!.bi, b1 = pos[g]!.bi;
    while (b0 > 0 && !used[b0 - 1] && B[b0 - 1].seg === B[b0].seg && A[f].k === 0) b0--;
    while (b1 < M - 1 && !used[b1 + 1] && B[b1 + 1].seg === B[b1].seg && A[g].k === n - 1) b1++;
    const at = b0 < pos[f]!.bi ? B[b0].t0 : pos[f]!.t0 - A[f].k * charDur;
    const end = b1 > pos[g]!.bi ? B[b1].t1 : pos[g]!.t1 + (n - 1 - A[g].k) * charDur;
    return { at, end, conf };
  });
  // lines out of order (a chorus matched against the wrong repeat) are treated as unmatched
  let last = -Infinity;
  for (const r of res) { if (!Number.isFinite(r.at)) continue; if (r.at < last - 0.05) { r.at = NaN; r.end = NaN; } else last = r.at; }
  // interpolate the unmatched lines by character count between their anchored neighbours
  const flagged: number[] = [];
  for (let i = 0; i < res.length; i++) {
    if (Number.isFinite(res[i].at)) continue;
    let a = i - 1; while (a >= 0 && !Number.isFinite(res[a].at)) a--;
    let b = i; while (b < res.length && !Number.isFinite(res[b].at)) b++;
    const from = a >= 0 ? res[a].end : (b < res.length ? res[b].at - (b - i + 1) * 3 : 0);
    const to = b < res.length ? res[b].at : from + (b - a) * 3;
    const span = res.slice(a + 1, b).reduce((s, _, k) => s + nOf[a + 1 + k] + 2, 0) || 1;
    let t = Math.max(0, from);
    for (let k = a + 1; k < b; k++) {
      const d = (Math.max(0, to - from) * (nOf[k] + 2)) / span;
      res[k].at = t; res[k].end = t + d * 0.85; t += d;
      flagged.push(k);
    }
    i = b;
  }
  const lines: TimedLine[] = sheet.map((l, i) => {
    const r = res[i], next = res[i + 1];
    const o: TimedLine = { at: round(Math.max(0, r.at)), text: l.text, confidence: round(r.conf) };
    if (l.part) o.part = l.part;
    else if (l.section) o.section = true;
    const end = next ? Math.min(r.end + 0.3, next.at) : r.end + 0.4;
    if (!next || next.at - end > 1.5) o.end = round(Math.max(o.at + 0.5, end));   // a real gap: only the background until then
    if (flagged.includes(i)) o.interpolated = true;
    return o;
  });
  return { lines, flagged };
}

const round = (x: number) => Math.round(x * 100) / 100;
