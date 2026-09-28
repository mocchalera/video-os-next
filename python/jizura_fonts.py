"""vos lyrics fonts worker: JIZURA's typefaces for a project, subset to the glyphs it needs.

    python jizura_fonts.py --design <project>/design --chars chars.txt --lyric-chars lyric.txt [--download] [--cache DIR]

Every face of JIZURA's catalogue (all SIL Open Font License, from github.com/google/fonts) is subset to `chars`
(lyrics + JIZURA's scramble / HUD characters + ASCII) and written to design/fonts/jizura/, with @font-face rules in
design/jizura-fonts.css under JIZURA's own family names — so the graphic draws with `"fonts": "jizura"`.
Noto Sans JP / Noto Serif JP stay variable (100–900 / 200–900): JIZURA's 太さ (thin → heavy) animates their weight.
Sources are cached in --cache; a missing source is only downloaded with --download (network is a human decision).
Prints one JSON line: {"ok": true, "faces": [...], "missing": {family: "chars the face lacks among the lyric chars"}}.
"""
import argparse
import json
import os
import sys
import urllib.parse
import urllib.request

BASE = "https://raw.githubusercontent.com/google/fonts/main/ofl/"
# family, css weight ("100 900" = variable), path under google/fonts/ofl
FACES = [
    ("Noto Sans JP", "100 900", "notosansjp/NotoSansJP[wght].ttf"),
    ("Noto Serif JP", "200 900", "notoserifjp/NotoSerifJP[wght].ttf"),
    ("Dela Gothic One", "400", "delagothicone/DelaGothicOne-Regular.ttf"),
    ("Zen Kaku Gothic New", "900", "zenkakugothicnew/ZenKakuGothicNew-Black.ttf"),
    ("Zen Old Mincho", "900", "zenoldmincho/ZenOldMincho-Black.ttf"),
    ("Kaisei Tokumin", "800", "kaiseitokumin/KaiseiTokumin-ExtraBold.ttf"),
    ("M PLUS Rounded 1c", "800", "mplusrounded1c/MPLUSRounded1c-ExtraBold.ttf"),
    ("Mochiy Pop One", "400", "mochiypopone/MochiyPopOne-Regular.ttf"),
    ("DotGothic16", "400", "dotgothic16/DotGothic16-Regular.ttf"),
    ("Yuji Syuku", "400", "yujisyuku/YujiSyuku-Regular.ttf"),
    ("IBM Plex Mono", "500", "ibmplexmono/IBMPlexMono-Medium.ttf"),
    ("Reggae One", "400", "reggaeone/ReggaeOne-Regular.ttf"),
    ("Rampart One", "400", "rampartone/RampartOne-Regular.ttf"),
    ("Potta One", "400", "pottaone/PottaOne-Regular.ttf"),
    ("Kiwi Maru", "500", "kiwimaru/KiwiMaru-Medium.ttf"),
    ("Klee One", "600", "kleeone/KleeOne-SemiBold.ttf"),
    ("Shippori Mincho B1", "800", "shipporiminchob1/ShipporiMinchoB1-ExtraBold.ttf"),
    ("IBM Plex Sans JP", "500", "ibmplexsansjp/IBMPlexSansJP-Medium.ttf"),
]
LATIN_ONLY = {"IBM Plex Mono"}   # no Japanese glyphs by design (JIZURA falls back for kana in mono text)

ap = argparse.ArgumentParser()
ap.add_argument("--design", required=True)
ap.add_argument("--chars", required=True)
ap.add_argument("--lyric-chars", required=True)
ap.add_argument("--cache", default=os.path.expanduser("~/.cache/vos/fonts"))
ap.add_argument("--download", action="store_true")
ap.add_argument("--check", action="store_true", help="report only: no files written")
a = ap.parse_args()

try:
    from fontTools import subset
    from fontTools.ttLib import TTFont
except ImportError:
    print(json.dumps({"ok": False, "error": "fontTools is not installed for this Python (pip install fonttools)"}))
    sys.exit(1)

try:
    import brotli  # noqa: F401  (woff2 needs it; without it the subsets stay TrueType)
    FLAVOR, EXT, FMT = "woff2", "woff2", "woff2"
except ImportError:
    FLAVOR, EXT, FMT = None, "ttf", "truetype"

chars = open(a.chars, encoding="utf-8").read()
lyric = sorted(set(c for c in open(a.lyric_chars, encoding="utf-8").read() if not c.isspace()))
need, missing_src = [], []
for fam, w, rel in FACES:
    src = os.path.join(a.cache, "google", rel)
    if not os.path.exists(src):
        if not a.download:
            missing_src.append(rel)
            continue
        os.makedirs(os.path.dirname(src), exist_ok=True)
        url = BASE + urllib.parse.quote(rel)
        try:
            with urllib.request.urlopen(url, timeout=120) as r, open(src + ".part", "wb") as f:
                f.write(r.read())
            os.replace(src + ".part", src)
        except Exception as e:  # noqa: BLE001
            print(json.dumps({"ok": False, "error": f"download failed: {url}: {e}"}))
            sys.exit(1)
    need.append((fam, w, rel, src))
if missing_src:
    print(json.dumps({"ok": False, "error": "font sources not cached: " + ", ".join(missing_src),
                      "hint": "re-run with --download (fetches the OFL files from github.com/google/fonts; network — ask the human first)"}))
    sys.exit(1)

out_dir = os.path.join(a.design, "fonts", "jizura")
if not a.check:
    os.makedirs(out_dir, exist_ok=True)
faces, missing, css = [], {}, []
for fam, w, rel, src in need:
    font = TTFont(src, lazy=True)
    cmap = font.getBestCmap() or {}
    lacks = "".join(c for c in lyric if ord(c) not in cmap)
    if lacks and fam not in LATIN_ONLY:
        missing[fam] = lacks
    name = os.path.basename(rel).replace("[wght]", "-VF").rsplit(".", 1)[0] + ".subset." + EXT
    dst = os.path.join(out_dir, name)
    if not a.check:
        opts = subset.Options()
        opts.layout_features = ["*"]
        opts.flavor = FLAVOR
        opts.name_IDs = ["*"]
        opts.notdef_outline = True
        font2 = TTFont(src)
        s = subset.Subsetter(opts)
        s.populate(unicodes=[ord(c) for c in set(chars)])
        s.subset(font2)
        font2.flavor = FLAVOR
        font2.save(dst)
    faces.append({"family": fam, "weight": w, "file": os.path.relpath(dst, a.design), "bytes": os.path.getsize(dst) if os.path.exists(dst) else 0})
    css.append(f'@font-face{{font-family:"{fam}";src:url(fonts/jizura/{name}) format("{FMT}");font-weight:{w}}}')
if not a.check:
    head = ("/* JIZURA faces (SIL Open Font License 1.1, github.com/google/fonts), subset by `vos lyrics fonts` to this\n"
            "   project's lyrics + JIZURA's scramble / HUD characters. Re-run it when the lyrics change. Use with \"fonts\": \"jizura\". */\n")
    open(os.path.join(a.design, "jizura-fonts.css"), "w", encoding="utf-8").write(head + "\n".join(css) + "\n")
    open(os.path.join(out_dir, "LICENSE.txt"), "w", encoding="utf-8").write(
        "All faces in this folder are licensed under the SIL Open Font License 1.1 (https://openfontlicense.org).\n"
        "Sources: github.com/google/fonts/ofl/* — " + ", ".join(f for f, _, _ in FACES) + ".\n"
        "They are subsets (only the glyphs this project draws), generated by `vos lyrics fonts`.\n")
print(json.dumps({"ok": True, "faces": faces, "missing": missing}, ensure_ascii=False))
