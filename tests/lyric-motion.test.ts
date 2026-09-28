// examples/graphics/lyric-motion.html (JIZURA vendored + vos adapter) run headless on a stub canvas, and the
// `vos lyrics` tools: the planner / typesetting rules from skills/jizura-lyric-type, determinism, direction that keeps
// 統一感, lyric-sheet alignment, the plan tool, and a smoke render forcing parts one by one.
// LYRIC_MOTION_FULL=1 forces every one of the ~1000 parts (slow); by default layouts / motions / decor are sampled.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { loadLyricMotion } from "../src/lyrics/engine.ts";
import { alignLyrics, matchChars, parseSheet } from "../src/lyrics/align.ts";
import { lyricPlans } from "../src/lyrics/plan.ts";
import { loadProject } from "../src/core/project.ts";
import { lockLyrics, parseLineSpec } from "../src/lyrics/lock.ts";
import * as fs from "node:fs";
import * as os from "node:os";

const ROOT = path.join(import.meta.dirname, "..");
const SRC = path.join(ROOT, "examples", "graphics", "lyric-motion.html");
const FULL = process.env.LYRIC_MOTION_FULL === "1";
const load = (props: Record<string, unknown>, cfg = { width: 1920, height: 1080 }) => loadLyricMotion(SRC, props, cfg);
const clean = (m: { warnings: string[] }, what: string) => assert.deepEqual([...new Set(m.warnings)].slice(0, 6), [], `${what}: engine warnings`);

const LYRICS = [
  { at: 0.8, text: "夜明けの色を 覚えてる" },
  { at: 3.6, text: "まだ眠い街を/ひとりで歩く" },
  { at: 6.6, text: "信号が青に変わるまで|signal" },
  { at: 9.8, text: "走り出せ!", section: true },
  { at: 11.4, text: "君の名前を *呼んで* いた" },
  { at: 14.6, text: "Good morning 新しい朝" },
  { at: 17.8, text: "夜明けの色を 覚えてる" },
  { at: 21.0, text: "もう一度だけ", end: 23.4 },
];
const key = (c: any) => [c.text, c.layout, c.enter, c.exit, c.hold, c.treat, c.bg, c.cam, c.trans, c.start.toFixed(3)].join("|");

test("same seed, same plan; another seed, another arrangement; no Math.random / Date.now", () => {
  const a = load({ lyrics: LYRICS, seed: 3 }).plan.cuts.map(key);
  assert.deepEqual(load({ lyrics: LYRICS, seed: 3 }).plan.cuts.map(key), a);
  assert.notDeepEqual(load({ lyrics: LYRICS, seed: 4 }).plan.cuts.map(key), a);
});

test("キメ is one cut, a returning line comes back the same way, lyrics lead the voice by 0.2 s", () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const { plan } = load({ lyrics: LYRICS, seed });
    const kime = plan.cuts.filter((c: any) => c.line === 3);
    assert.equal(kime.length, 1, `seed ${seed}`);
    assert.ok(kime[0].kime);
    assert.ok(Math.abs(plan.lines[3].start - 9.6) < 1e-9);
    const shape = (li: number) => plan.cuts.filter((c: any) => c.line === li).map((c: any) => [c.text, c.layout, JSON.stringify(c.params)]);
    assert.deepEqual(shape(6), shape(0), `seed ${seed}: repeat`);
  }
  const { plan } = load({ lyrics: LYRICS, seed: 3 });
  assert.deepEqual(plan.cuts.filter((c: any) => c.line === 1).slice(0, 2).map((c: any) => c.text), ["まだ眠い街を", "ひとりで歩く"]);
});

test("direction replaces only the part it names: a directed キメ keeps its big layout; directed motion beats transitions", () => {
  const KIME_LAYOUTS = ["huge", "columnsBig", "halftoneBig", "center"];
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const lines = LYRICS.map((l, i) => (i === 3 ? { ...l, exit: "explode" } : i === 1 ? { ...l, treat: "extrude" } : i === 4 ? { ...l, enter: "assemble" } : l));
    const { plan } = load({ lyrics: lines, seed });
    const k = plan.cuts.filter((c: any) => c.line === 3);
    assert.equal(k.length, 1);
    assert.ok(k[0].kime && KIME_LAYOUTS.includes(k[0].layout), `seed ${seed}: ${k[0].layout}`);
    assert.equal(k[0].exit, "explode", `seed ${seed}: directed exit survives the next line's join`);
    assert.ok(plan.cuts.filter((c: any) => c.line === 1).every((c: any) => c.treat === "extrude"), "treat on every cut of the line");
    assert.ok(plan.cuts.filter((c: any) => c.line === 4).every((c: any) => c.enter === "assemble" && !c.trans && !c.morph), `seed ${seed}: directed entrance`);
  }
});

test("a new \"part\" starts a new section", () => {
  const { project } = load({ lyrics: [{ at: 1, text: "ひとつめ", part: "A" }, { at: 3, text: "ふたつめ", part: "A" }, { at: 5, text: "みっつめ", part: "B" }] });
  assert.equal(project.lyrics, "[00:01.00]ひとつめ\n[00:03.00]ふたつめ\n\n[00:05.00]みっつめ");   // blank line = new part for JIZURA
});

test("line breaks: balanced, no particle / small kana at a line start, no break inside a Latin word", () => {
  const { J } = load({ lyrics: LYRICS });
  assert.equal(J.splitLines("まだ眠い街をひとりで歩く", 4), "まだ眠い\n街をひとりで\n歩く");
  assert.equal(J.splitLines("Goodmorning新しい朝", 4), "Good\nmorning\n新しい朝");
  for (const s of ["夜明けの色を覚えてる", "信号が青に変わるまで", "君の名前を呼んでいた", "ちょっと待ってよ"])
    for (const line of J.splitLines(s, 4).split("\n").slice(1)) assert.doesNotMatch(line, /^[をがはにでとのへもっゃゅょーァィゥェォッャュョ、。]/, `${s} → ${line}`);
});

test("文字整列: kana tighter, particles smaller, first glyph larger, Latin gap", () => {
  const { J } = load({ lyrics: LYRICS });
  J.setTypeset(true);
  const t = J.typesetLine([..."君の名前をLove"]);
  assert.equal(t[0].f, 1.18); assert.equal(t[1].f, 0.78); assert.equal(t[1].adv, 0.9); assert.equal(t[4].f, 0.78);
  assert.equal(t[5].f, 1.08); assert.equal(t[5].gap, 0.2);
});

test("every expression pack is there, and random picks use them", () => {
  const { J } = load({ lyrics: LYRICS });
  const min: Record<string, number> = { layout: 180, enter: 120, hold: 50, exit: 100, decor: 120, treat: 60, bg: 60, cam: 30, trans: 25 };
  for (const [g, n] of Object.entries(min)) assert.ok(J.order(g).length >= n, `${g}: ${J.order(g).length}`);
  assert.ok(Object.keys(J.STYLES).length >= 24);
  assert.ok(J.ENTER.assemble.pieces);
  for (const k of ["explode", "fall", "drift"]) assert.ok(J.EXIT[k].pieces, k);
  const used: Record<string, Set<string>> = { layout: new Set(), bg: new Set(), treat: new Set(), trans: new Set(), cam: new Set() };
  for (let seed = 1; seed <= 12; seed++) for (const c of load({ lyrics: LYRICS, seed, typeset: seed % 2 === 0, style: ["noir", "paper", "caution", "blueprint"][seed % 4] }).plan.cuts) {
    used.layout.add(c.layout); used.cam.add(c.cam);
    if (c.bg && c.bg !== "none") used.bg.add(c.bg);
    if (c.treat && c.treat !== "none") used.treat.add(c.treat);
    if (c.trans) used.trans.add(c.trans);
  }
  assert.ok(used.layout.size >= 30 && used.bg.size >= 5 && used.treat.size >= 3 && used.trans.size >= 3 && used.cam.size >= 5, JSON.stringify(Object.fromEntries(Object.entries(used).map(([k, v]) => [k, v.size]))));
});

test(`forced parts render without throwing, warnings or randomness (${FULL ? "every part" : "bg / treat / trans / shatter all, the rest sampled"})`, () => {
  const { J } = load({ lyrics: LYRICS });
  const every = (g: string, sample: boolean) => { const ks = J.order(g).filter((k: string) => k !== "none" && !(J.registry(g)[k] || {}).special); return sample && !FULL ? ks.filter((_: string, i: number) => i % Math.ceil(ks.length / 24) === 0) : ks; };
  const groups: [string, string[]][] = [["bg", every("bg", false)], ["treat", every("treat", false)], ["trans", every("trans", false)], ["enter", ["assemble"]], ["exit", ["explode", "fall", "drift"]],
    ["layout", every("layout", true)], ["enter", every("enter", true)], ["exit", every("exit", true)], ["hold", every("hold", true)], ["decor", every("decor", true)], ["cam", every("cam", true)]];
  for (const [g, keys] of groups) {
    // a transition joins a cut to the one before it, so the forced lines follow a plain lead-in line
    const lines = [{ at: 0.2, text: "はじまり" }, ...keys.map((k, i) => ({ at: 1.2 + i * 1.6, text: i % 2 ? "夜明けの色/覚えてる" : "走り出せ Good", [g]: g === "decor" ? [k] : k }))];
    const m = load({ lyrics: lines, seed: 7, style: "paper", fx: { koma: 0 } });
    const used = new Set(m.plan.cuts.flatMap((c: any) => (g === "decor" ? (c.decor || []).map((d: any) => d.id) : [c[g]])).filter(Boolean));
    for (const k of keys) assert.ok(used.has(k), `${g}.${k} planned`);
    for (let t = 0; t < 1.2 + keys.length * 1.6 + 1; t += 0.2) m.frame(t);
    assert.ok(m.stats.text > 0, g);
    clean(m, g);
  }
});

test("every style renders (16:9 and 9:16, array / LRC text / transcript, overlay, centre free, keying, horror)", () => {
  const lrc = "[00:01.00]夜明けの色を 覚えてる\n\n[00:04.00]*走り出せ*!\n[00:06.00]Good morning, brand new day\n[00:09.00][interlude 3]";
  const transcript = { segments: [{ start: 0.5, end: 2.5, text: "まだ眠い街を" }, { start: 2.6, end: 5, text: "ひとりで歩く" }] };
  const { J } = load({ lyrics: LYRICS });
  Object.keys(J.STYLES).forEach((style, i) => {
    for (const [lyrics, canvas] of [[LYRICS, { width: 1920, height: 1080 }], [i % 2 ? lrc : transcript, { width: 1080, height: 1920 }]] as const) {
      const m = load({ lyrics, style, seed: i + 1, title: i === 2 ? "夜明け" : "", debug: i === 0, centerFree: i === 5, background: i !== 6, keyBg: i === 7 ? "green" : "off", bpm: i % 3 ? 120 : 0, horror: style.startsWith("hr"), fonts: i % 4 === 0 ? "jizura" : undefined }, canvas);
      assert.ok(m.plan.cuts.length > 0);
      for (let t = 0; t < 24; t += FULL ? 1 / 12 : 1 / 4) m.frame(t);
      assert.ok(m.stats.text > 0, `${style} drew text`);
      clean(m, style);
    }
  });
});

test("lyric sheet: parts from headers and blank lines, notes skipped, inline syntax kept", () => {
  const s = parseSheet("# Title\n[Verse]\n夜明けの色を 覚えてる\nまだ眠い街を/ひとりで歩く\n\n[Chorus]\n走り出せ!\n（1番と同じ）\n[00:12.00]君の名前を *呼んで* いた|note");
  assert.deepEqual(s.lines.map((l) => [l.text, l.part, l.section]), [["夜明けの色を 覚えてる", "Verse", false], ["まだ眠い街を/ひとりで歩く", "Verse", false], ["走り出せ!", "Chorus", true], ["君の名前を *呼んで* いた|note", "Chorus", false]]);
  assert.equal(s.skipped.length, 1);
  assert.deepEqual(matchChars("走り出せ! *ヨル*|note"), ["走", "り", "出", "せ", "よ", "る"]);
});

test("lyric sheet + transcript words → line times; unheard lines are interpolated and flagged", () => {
  const sheet = parseSheet("誰が願ったの、夜の終わりを\n目覚めのときは、訪れてしまう\n淡い角度で、差し込む光が\n瞼を透かして、しまうから\nもう起きようぜ").lines;
  // what ASR heard (singing): other kanji / kana here and there, one line missing, noise before and after
  const words = [
    { start: 2, end: 3, word: "ラララ" },
    { start: 21.4, end: 27.2, word: "誰か願ったの夜の終わりを" },
    { start: 31.9, end: 39.0, word: "目覚めの時は落とすれてしまう" },
    { start: 53.3, end: 58.8, word: "まぶたをすかしてしまうから" },
    { start: 107.8, end: 110.0, word: "もう起きようぜ" },
    { start: 200, end: 201, word: "ありがとう" },
  ];
  const r = alignLyrics(sheet, words);
  const at = r.lines.map((l) => l.at);
  assert.ok(Math.abs(at[0] - 21.4) < 0.6, `line 0 at ${at[0]}`);
  assert.ok(Math.abs(at[1] - 31.9) < 0.6, `line 1 at ${at[1]}`);
  assert.ok(Math.abs(at[3] - 53.3) < 0.8, `line 3 at ${at[3]}`);
  assert.ok(Math.abs(at[4] - 107.8) < 0.6, `line 4 at ${at[4]}`);
  assert.deepEqual(r.flagged, [2]);
  assert.ok(at[2] > at[1] && at[2] < at[3], "interpolated between its neighbours");
  assert.ok(r.lines[3].end !== undefined, "a long instrumental gap after line 3 keeps an end");
});

test("vos lyrics plan: timeline seconds, キメ and flash markers from the example project", () => {
  const [pl] = lyricPlans(loadProject(path.join(ROOT, "examples", "lyric-motion")));
  assert.equal(pl.clip, "lyrics");
  assert.ok(pl.cuts.length >= 8);
  for (let i = 1; i < pl.cuts.length; i++) assert.ok(pl.cuts[i].t0 >= pl.cuts[i - 1].t0);
  const kime = pl.cuts.find((c) => c.kime)!;
  assert.equal(kime.text, "走り出せ");
  assert.ok(pl.markers.some((mk) => mk.kind === "expect-flash" && Math.abs(mk.at - kime.t0) < 0.3), JSON.stringify(pl.markers));
  assert.deepEqual(pl.warnings, []);
});

// ---- テロップ: JIZURA over footage (captions, not a lyric video) ----

const TELOP = [
  { at: 0.3, text: "1kmを/3分05秒で/× 5本" },
  { at: 2.7, text: "走る前の顔|before" },
  { at: 4.75, text: "時計、セット。" },
  { at: 6.55, text: "時速 約19.5km", section: true },
  { at: 8.65, text: "前半は、まだ余裕…" },
  { at: 12.25, text: "押し切る!" },
  { at: 13.85, text: "1本、クリア。", section: true },
  { at: 15.85, text: "今日もみんな、頑張ろうぜ", end: 19 },
];
const V916 = { width: 1080, height: 1920 };

test("telop mode: no backgrounds / HUD / plates / repeats / frame-filling transitions, no lead; enabled brings one back", () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const m = load({ lyrics: TELOP, seed, style: "hud", mode: "telop" }, V916);
    clean(m, `seed ${seed}`);
    const { plan, J } = m;
    assert.equal(plan.hud, false, "HUD off");
    for (const c of plan.cuts) {
      assert.equal(c.bg, "none", `seed ${seed}: bg ${c.bg} on "${c.text}"`);
      for (const d of c.decor || []) assert.notEqual(J.DECOR[d.id]?.layer, "back", `seed ${seed}: back decor ${d.id}`);
      if (c.layout === "interlude") { assert.deepEqual(c.decor, []); continue; }
      const L = J.LAYOUTS[c.layout];
      assert.ok(!L.busy && L.treat !== "safe" && L.treat !== false && !["ring", "stack", "tile", "marquee", "curtain", "scatter", "diag", "typeSpecimen", "knPadGrid"].includes(c.layout), `seed ${seed}: layout ${c.layout}`);
      assert.ok(!c.trans || !["zoomThrough", "knCornerSwing", "whipPan", "cubeTurn", "uncover", "doorsOpen", "spinOut", "knStutterCut"].includes(c.trans), `seed ${seed}: trans ${c.trans}`);
    }
    assert.ok(Math.abs(plan.lines[0].start - 0.3) < 0.011, `no lead: ${plan.lines[0].start}`);
  }
  const lyric = load({ lyrics: TELOP, seed: 1, style: "hud" }, V916).plan;
  assert.ok(Math.abs(lyric.lines[0].start - 0.1) < 0.011, "lyric mode keeps the 0.2 s lead");
  const back = load({ lyrics: TELOP.map((l, i) => (i === 2 ? { ...l, layout: "searchBar" } : l)), seed: 1, mode: "telop", enabled: { layout: { pill: true } } }, V916);
  assert.ok(back.plan.cuts.filter((c: any) => c.line === 2).every((c: any) => c.layout === "searchBar"), "a line's direction wins over the telop defaults");
  assert.notEqual(back.project.enabled.layout.pill, false, "enabled switches an entry back on");
});

test("lock: a locked line replays exactly (params, motion, stagger, joins) while another line is directed", () => {
  const snap = (m: any, li: number) => {
    const s = m.J.lineSnapshot(m.plan, li), mine = m.plan.cuts.filter((c: any) => c.line === li && c.utext != null);
    s.forEach((x: any, i: number) => { x.stagger = mine[i].stagger; });
    return { lock: true, lockedSeed: m.plan.lines[li].seed, lockedCuts: s };
  };
  const deep = (c: any) => JSON.stringify([c.text, c.start.toFixed(4), c.end.toFixed(4), c.layout, c.enter, c.exit, c.hold, c.treat, c.cam, c.trans, !!c.morph, c.stagger, c.params, c.decor, c.scheme]);
  for (const mode of ["telop", "lyric"]) for (const seed of [1, 2, 3, 4]) {
    const props = { seed, style: "hud", mode };
    const a = load({ ...props, lyrics: TELOP }, V916);
    const lines = a.plan.lines.filter((l: any) => !l.interlude).map((l: any) => l.index);
    const locked = TELOP.map((l, i) => ({ ...l, ...(lines.includes(i) ? snap(a, i) : {}) }));
    const b = load({ ...props, lyrics: locked }, V916);
    assert.deepEqual(b.plan.cuts.map(deep), a.plan.cuts.map(deep), `${mode} seed ${seed}: locking changes nothing`);
    // unlock line 2 and direct it: only line 2 changes
    const c = load({ ...props, lyrics: locked.map((l, i) => (i === 2 ? { at: l.at, text: l.text, layout: "pill" } : l)) }, V916);
    const other = (p: any) => p.cuts.filter((x: any) => x.line !== 2 && x.layout !== "interlude").map(deep);
    assert.deepEqual(other(c.plan), other(a.plan), `${mode} seed ${seed}: the other lines stay`);
    assert.ok(c.plan.cuts.filter((x: any) => x.line === 2).every((x: any) => x.layout === "pill"));
  }
});

test("a clip that starts later keeps the timeline beat grid (song time = timeline − start − offset)", () => {
  const grid = { bpm: 120, offset: 0 };
  const key2 = (c: any) => [c.text, c.layout, c.enter, c.exit, (c.start).toFixed(3)].join("|");
  const whole = load({ lyrics: TELOP, seed: 2, mode: "telop" }, { ...V916, grid, clipStart: 0 } as any).plan.cuts.map(key2);
  // the same lyrics in a clip placed at 6.7 s whose song time is shifted back by an offset of −6.7 s
  const later = load({ lyrics: TELOP, seed: 2, mode: "telop", offset: -6.7 }, { ...V916, grid, clipStart: 6.7 } as any).plan.cuts.map(key2);
  assert.deepEqual(later, whole);
});

test("vos lyrics lock / unlock write the lyric data; the plan marks locked cuts and stale locks", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vos-lock-"));
  fs.cpSync(path.join(ROOT, "examples", "lyric-motion"), dir, { recursive: true, filter: (f) => !/[\\/](out|\.vos)([\\/]|$)/.test(f) });
  try {
    const p = loadProject(dir);
    assert.deepEqual(parseLineSpec("0,2-4"), [0, 2, 3, 4]);
    assert.equal(parseLineSpec("all"), null);
    const before = lyricPlans(p)[0];
    const r = lockLyrics(p, { lines: "0-2" });
    assert.deepEqual(r.locked.map((l) => l.line), [0, 1, 2, 6], "line 6 returns line 0: locked with it");
    const data = JSON.parse(fs.readFileSync(path.join(dir, "data", "lyrics.json"), "utf8"));
    assert.ok(data[0].lock && Array.isArray(data[0].lockedCuts) && data[0].lockedCuts.every((c: any) => "stagger" in c));
    const after = lyricPlans(p)[0];
    const strip = (c: any) => { const { locked, ...rest } = c; return rest; };
    assert.deepEqual(after.cuts.map(strip), before.cuts.map(strip), "locking does not move anything");
    const isLocked = (li: number) => li <= 2 || li === 6;
    assert.ok(after.cuts.filter((c) => isLocked(c.line)).every((c) => c.locked) && !after.cuts.some((c) => !isLocked(c.line) && c.locked));
    data[1].text = "まだ眠い町を/ひとりで歩いた";                 // the text changed: the lock can no longer apply
    fs.writeFileSync(path.join(dir, "data", "lyrics.json"), JSON.stringify(data));
    assert.ok(lyricPlans(p)[0].warnings.some((w) => /L1 is locked but/.test(w)));
    const u = lockLyrics(p, { unlock: true });
    assert.equal(u.unlocked.length, 4);
    assert.ok(!JSON.parse(fs.readFileSync(path.join(dir, "data", "lyrics.json"), "utf8")).some((l: any) => l.lock));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
