"""web (unattended, real time) vs the MV's own page at the same T: mean absolute difference per channel on 8x-downscaled frames (film grain averages out), and the largest block difference."""
import json, os
from PIL import Image, ImageChops, ImageStat
d = os.path.join(os.path.dirname(__file__), "..", "review", "m3", "unattended")
meta = json.load(open(os.path.join(d, "trace.json")))["meta"]
rows = []; tiles = []
for m in meta:
    a = Image.open(os.path.join(d, f"web-{m['label']}.jpg")).convert("RGB"); b = Image.open(os.path.join(d, f"mv-{m['label']}.jpg")).convert("RGB")
    sa, sb = a.resize((a.width // 8, a.height // 8), Image.BOX), b.resize((b.width // 8, b.height // 8), Image.BOX)
    df = ImageChops.difference(sa, sb); mean = round(sum(ImageStat.Stat(df).mean) / 3, 2); mx = max(max(ex) for ex in df.getextrema())
    rows.append({"T": m["T"], "size_web": a.size, "size_mv": b.size, "mean_abs_diff": mean, "max_block_diff": mx}); print(rows[-1])
    t = Image.new("RGB", (480, 135 * 2)); t.paste(a.resize((240, 135)), (0, 0)); t.paste(b.resize((240, 135)), (240, 0)); t.paste(df.resize((240, 135)).point(lambda v: min(255, v * 4)), (0, 135)); tiles.append(t)
json.dump(rows, open(os.path.join(d, "compare.json"), "w"), indent=1)
S = Image.new("RGB", (480 * 4, 270 * 3))
for i, t in enumerate(tiles): S.paste(t, ((i % 4) * 480, (i // 4) * 270))
S.save(os.path.join(d, "compare-sheet.jpg"), quality=86)
