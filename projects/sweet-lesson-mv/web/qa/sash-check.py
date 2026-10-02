"""Same u → same picture: compare the screenshots of qa/sash.mjs (mean absolute difference per channel over the picture above the UI strip; film grain and the lace's breeze are the only things that move)."""
import json, os, itertools
from PIL import Image, ImageChops, ImageStat
d = os.path.join(os.path.dirname(__file__), "..", "review", "m3", "sash")
def load(n): return Image.open(os.path.join(d, n + ".png")).convert("RGB").crop((0, 0, 1440, 800)).resize((360, 200), Image.BOX)
def diff(a, b): s = ImageStat.Stat(ImageChops.difference(load(a), load(b))).mean; return round(sum(s) / 3, 2)
groups = {"u=0 (closed)": ["00-closed", "02-back-to-0", "06-back-to-0-again", "07-u0-held", "08-u0-released"], "u=0.3": ["01-u0.3-held", "05-u0.3-held-again"]}
out = {}
for g, names in groups.items():
    out[g] = {f"{a} vs {b}": diff(a, b) for a, b in itertools.combinations(names, 2)}
out["different u (for scale)"] = {"u=0 vs u=0.3": diff("00-closed", "01-u0.3-held"), "u=0.3 vs u=0.6": diff("01-u0.3-held", "03-u0.6-held"), "u=0.2 vs u=0.3": diff("04-u0.2-held", "01-u0.3-held")}
print(json.dumps(out, indent=1)); json.dump(out, open(os.path.join(d, "sash-check.json"), "w"), indent=1)
ims = [load(n).resize((480, 267)) for n in ["00-closed", "01-u0.3-held", "02-back-to-0", "03-u0.6-held", "04-u0.2-held", "05-u0.3-held-again", "06-back-to-0-again", "09-opening", "10-open"]]
S = Image.new("RGB", (480 * 3, 267 * 3))
for i, im in enumerate(ims): S.paste(im, ((i % 3) * 480, (i // 3) * 267))
S.save(os.path.join(d, "sash-sheet.jpg"), quality=86)
