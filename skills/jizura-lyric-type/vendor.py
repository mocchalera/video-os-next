#!/usr/bin/env python3
"""Vendor the JIZURA engine into examples/graphics/lyric-motion.html.

usage: python3 skills/jizura-lyric-type/vendor.py <JIZURA checkout> [--html examples/graphics/lyric-motion.html]

Reads the built single-file edition (<checkout>/index.html, JIZURA v0.9.0 @ 8da975f), cuts out the engine
(util … renderer, before the audio / export / UI code) and every expression pack (layouts, motions, decor, treatments,
backgrounds, cameras, effects, transitions, styles; typo / kinetic / horror sets) plus the part-set rules, applies the
patches below and writes the result between the "JIZURA vendored" markers.
Every patch must match exactly once, so a new JIZURA version fails loudly instead of drifting silently.

Patches (the only differences from upstream):
  determinism  a local J instead of window.J; Math.random → a fixed-seed stream reseeded where the renderer builds
               its grain / paper textures (HyperFrames renders frames in parallel workers: they must agree)
  fonts        metrics and glyph decompositions are cached only once document.fonts is loaded (the page mounts
               before the faces arrive; a cached fallback measurement would stick)
  vcols        split columns with J.splitLines (vos overrides it with 文節 / particle-aware breaking)
  direction    a line override replaces only the part it names and keeps 統一感 (palettes, キメ, モーフ) for the rest
               (upstream switches 統一感 off for any directed line); a directed entrance / exit is not replaced by a
               transition or モーフ unless a transition is directed too
  repeats      統一感: a returning line reuses the first occurrence's cut structure (upstream adds a recap cut when
               the repeat has more time, so the chorus came back looking different)
  lock         a locked line's recap cut weighs what it weighed when it was planned (upstream counts its glyphs), so a
               locked line keeps its cut boundaries
"""
import argparse, os, re, subprocess, sys

VERSION = "0.9.0"
COMMIT = "8da975fb362d966b065217618aedafd5a35a39e0"
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
BEGIN, END = "/* ==== JIZURA vendored: begin ==== */", "/* ==== JIZURA vendored: end ==== */"
HDR = "/* ============================================================\n   JIZURA — "


def once(text, old, new, what):
    n = text.count(old)
    if n != 1:
        sys.exit(f"vendor: patch '{what}' matched {n} times (expected 1) — JIZURA changed; review the patch")
    return text.replace(old, new)


def cut(js, start, stop):
    i = js.index(start)
    j = js.index(stop, i + len(start))
    return js[i:j]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("jizura")
    ap.add_argument("--html", default=os.path.join(ROOT, "examples", "graphics", "lyric-motion.html"))
    a = ap.parse_args()
    ver = open(os.path.join(a.jizura, "VERSION"), encoding="utf-8").read().strip()
    if ver != VERSION:
        sys.exit(f"vendor: JIZURA {ver}, expected {VERSION} (update VERSION/COMMIT and re-check the patches)")
    try:
        head = subprocess.run(["git", "-C", a.jizura, "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
        if head and head != COMMIT:
            print(f"vendor: warning: checkout at {head[:7]}, pinned {COMMIT[:7]}", file=sys.stderr)
    except OSError:
        pass
    page = open(os.path.join(a.jizura, "index.html"), encoding="utf-8").read()
    js = page[page.rindex("<script>") + 8: page.rindex("</script>")]

    core = cut(js, HDR + "util", HDR + "audio")
    # every expression pack, in upstream order (layoutsA–D, typo, kinetic, horror, enter/exit/decor/fx packs, looks,
    # styles, treattrans, bgcamB …); the part-set switches decide what random picks may use
    packs = [cut(js, "/* JIZURA pack: bgcamB", HDR + "which entries")]
    k = js.index("J.BASE_PACKS = ['core'")
    sets = js[js.rindex("/* ====", 0, k): js.index(HDR + "editor UI", k)]

    # determinism
    core = once(core, "'use strict';\nconst J = (window.J = window.J || {});\n", "", "local J")
    core = core.replace("Math.random", "J.__rnd")
    core = once(core, "  constructor() {\n    this.scratch = mk(2, 2);", "  constructor() {\n    J.__reseed(0x6a1);\n    this.scratch = mk(2, 2);", "grain seed")
    core = once(core, "    if (p) return p;\n    const w = Math.round(W / 2)", "    if (p) return p;\n    J.__reseed(0x7a9 + W * 3 + H);\n    const w = Math.round(W / 2)", "paper seed")
    # fonts
    core = once(core, "      this.m.set(k, v);", "      if (J.__fontsReady()) this.m.set(k, v);", "metrics cache")
    core = once(core, "if (!g) { g = decompose(fontKey, ch, res); this.map.set(key, g);", "if (!g) { g = decompose(fontKey, ch, res); if (J.__fontsReady()) this.map.set(key, g);", "glyph cache")
    # vcols
    core = once(core, "      const colsArr = []; const arr = [...text];\n      for (let i = 0; i < arr.length; i += per) colsArr.push(arr.slice(i, i + per).join(''));",
                "      const colsArr = J.splitLines(text, per).split('\\n'); const longest = Math.max(...colsArr.map(c => [...c].length));", "vcols split")
    core = once(core, "const size = Math.min(H * 0.78 / (per * 1.03), W * 0.8 / (colsArr.length * 1.4));", "const size = Math.min(H * 0.78 / (longest * 1.03), W * 0.8 / (colsArr.length * 1.4));", "vcols size")
    core = once(core, "const colH = per * size * 1.03;", "const colH = longest * size * 1.03;", "vcols height")
    # direction keeps 統一感: a line override replaces only the part it names (upstream switches 統一感 off for the line)
    core = once(core, "const UU = U && !ovAny ? U : null;", "const UU = U && !(ov.cuts > 0) ? U : null;", "unify with overrides")
    core = once(core, "if (UU) layout = UU.layout(", "if (UU && !ov.layout) layout = UU.layout(", "unify layout")
    core = once(core, "        enter = UU.enter(li, enter,", "        if (!ov.enter) enter = UU.enter(li, enter,", "unify enter")
    core = once(core, "        exit = UU.exit(li, exit,", "        if (!ov.exit) exit = UU.exit(li, exit,", "unify exit")
    core = once(core, "        hold = UU.hold(li, hold,", "        if (!ov.hold) hold = UU.hold(li, hold,", "unify hold")
    core = once(core, "        if (weightGrow) enter = UU.softEnter(enter, rng);", "        if (weightGrow && !ov.enter) enter = UU.softEnter(enter, rng);", "unify soft enter")
    core = once(core, "if (UU) { decor = UU.decor(li, decor, { layout, kime, rng }); treat = UU.treat(li, treat, { kime, rng, LD }); }",
                "if (UU) { if (!Array.isArray(ov.decor)) decor = UU.decor(li, decor, { layout, kime, rng }); if (!ov.treat) treat = UU.treat(li, treat, { kime, rng, LD }); }", "unify decor/treat")
    core = once(core, "if (UU) cam = UU.cam(li, cam,", "if (UU && !ov.cam) cam = UU.cam(li, cam,", "unify cam")
    core = once(core, "const again = UU ? UU.again(li, k, txt) : null;", "const again = UU && !ovAny ? UU.again(li, k, txt) : null;", "unify again")
    core = once(core, "} else if (canTrans && UU && k > 0 && !kime &&", "} else if (canTrans && UU && k > 0 && !kime && !ov.trans &&", "unify morph")
    core = once(core, "if (trans && UU) trans = UU.trans(", "if (trans && UU && !ov.trans) trans = UU.trans(", "unify trans")
    # …and a directed entrance (or the previous line's directed exit) is not replaced by a transition / モーフ,
    # unless a transition is directed too
    core = once(core, "const canTrans = prevCut && Math.abs(prevCut.end - cs) < 0.06 && prevCut.layout !== 'interlude' && dur > 0.5 && !prevLockedOther;",
                "const canTrans = prevCut && Math.abs(prevCut.end - cs) < 0.06 && prevCut.layout !== 'interlude' && dur > 0.5 && !prevLockedOther\n"
                "        && (!!ov.trans || (!ov.enter && !((project.overrides || {})[prevCut.line] || {}).exit));", "directed motion vs trans")
    # repeats
    core = once(core, "      units = ov.lockedCuts.map(c => ({ text: c.utext, w: [...c.utext].length + 1.6, recap: !!c.recap }));\n",
                "      units = ov.lockedCuts.map(c => ({ text: c.utext, w: [...c.utext].length + 1.6, recap: !!c.recap }));\n"
                "    { const plain = units.filter(u => !u.recap); if (plain.length) for (const u of units) if (u.recap) u.w = plain.reduce((a, x) => a + x.w, 0) / plain.length * 1.25; }   // vos: a locked recap weighs what it did when planned\n"
                "    if (U && !ovAny && !fixedN) units = U.units(li, units);   // vos: a returning line keeps the first occurrence's cuts\n", "repeat units")
    core = once(core, "  const specs = new Map();\n  return {\n",
                "  const specs = new Map(), unitsOf = new Map();\n  return {\n"
                "    units(i, u) { const f = repeatOf[i]; if (f != null && unitsOf.has(f)) u = unitsOf.get(f).map(x => Object.assign({}, x)); unitsOf.set(i, u); return u; },\n", "unify units")

    body = "\n".join([core] + packs + [sets])
    for bad in ("window.J", "Math.random", "fetch("):
        if bad in body:
            sys.exit(f"vendor: '{bad}' left in the vendored code")
    html = open(a.html, encoding="utf-8").read()
    i, j = html.index(BEGIN), html.index(END)
    stamp = f"/* JIZURA v{VERSION} @ {COMMIT[:7]} — MIT (c) 2026 hakoniwa. Generated by skills/jizura-lyric-type/vendor.py; do not edit. */\n"
    html = html[: i + len(BEGIN)] + "\n" + stamp + body.replace("</script", "<\\/script") + "\n" + html[j:]
    open(a.html, "w", encoding="utf-8").write(html)
    print(f"vendor: wrote {a.html} ({len(body) // 1024} KB engine: core + every expression pack + sets)")


if __name__ == "__main__":
    main()
