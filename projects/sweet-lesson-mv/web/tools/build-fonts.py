#!/usr/bin/env python3
"""Re-subset Noto Sans JP (the family behind the MV's "Room Sans") so the web UI's Japanese strings are in it.
design/fonts/RoomSans.woff2 is a subset of Noto Sans JP 2.004-H2 (variable, wght 100–900) that lacks a few of the UI's characters (二 戻 横 歩 窓 ×).
The original font file is on this Mac (~/Library/Fonts/NotoSansJP-VariableFont_wght.ttf, the same version 2.004-H2: the 400 advance widths I compared are identical).
Output: web/fonts/RoomSans-web.woff2 = (the MV subset's code points) ∪ (every CJK character that appears in web/walk/*.js and web/walk.html) ∪ (the characters of data/credits.json, for the log).
web/fonts.css re-declares "Room Sans" with it, so the same family renders the same outlines — only with more characters. design/ is not touched."""
import re, json, sys, os, glob
from fontTools.ttLib import TTFont
from fontTools import subset
root = os.path.normpath(os.path.join(os.path.dirname(__file__), '..', '..'))
SRC = os.path.expanduser('~/Library/Fonts/NotoSansJP-VariableFont_wght.ttf')
room = TTFont(os.path.join(root, 'design/fonts/RoomSans.woff2'))
cps = set(room.getBestCmap().keys())
ui = ''
for f in glob.glob(os.path.join(root, 'web/walk/*.js')) + [os.path.join(root, 'web/walk.html')]:
    ui += open(f, encoding='utf8').read()
cjk = set(re.findall(r'[‐-―←-⇿─-╿　-ヿ㐀-䶿一-鿿＀-￯×·…—–]', ui))
cr = json.load(open(os.path.join(root, 'data/credits.json'), encoding='utf8'))['events']
log = set(''.join(e.get('text', '') + e.get('jst', '') + e.get('who', '') for e in cr))
want = cps | {ord(c) for c in cjk} | {ord(c) for c in log if ord(c) > 32}
opts = subset.Options(); opts.flavor = 'woff2'; opts.layout_features = ['*']; opts.notdef_outline = True; opts.name_IDs = ['*']; opts.glyph_names = False
font = subset.load_font(SRC, opts); s = subset.Subsetter(opts); s.populate(unicodes=sorted(want)); s.subset(font)
out = os.path.join(root, 'web/fonts/RoomSans-web.woff2'); subset.save_font(font, out, opts)
print(f'{len(want)} code points (MV subset {len(cps)}, UI +{len(cjk - {chr(c) for c in cps})}, log +{len({c for c in log if ord(c) not in cps})}) → {out} {os.path.getsize(out)//1024} KB')
