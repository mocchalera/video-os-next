"""Contact sheet of every cursor state: the frame (small) and a 5x crop around the pointer. python3 web/qa/cursor-sheet.py → web/review/cursor/cursor-sheet.jpg"""
import json, os
from PIL import Image, ImageDraw
root = os.path.join(os.path.dirname(__file__), "..", "review", "cursor")
d = json.load(open(os.path.join(root, "cursor.json")))
CSS_CROP = 70  # css px each side of the pointer
cells = []
for s in d["shots"]:
    im = Image.open(os.path.join(root, s["name"] + ".png")).convert("RGB")
    k = im.width / 1440.0
    x, y = s["x"] * k, s["y"] * k
    r = CSS_CROP * k
    box = (int(x - r), int(y - r), int(x + r), int(y + r))
    crop = im.crop(box).resize((420, 420), Image.LANCZOS)
    full = im.resize((560, int(560 * im.height / im.width)), Image.LANCZOS)
    dr = ImageDraw.Draw(full); fx, fy = s["x"] / 1440 * 560, s["y"] / 1440 * 560
    dr.rectangle((fx - CSS_CROP / 1440 * 560, fy - CSS_CROP / 1440 * 560, fx + CSS_CROP / 1440 * 560, fy + CSS_CROP / 1440 * 560), outline=(255, 90, 90), width=1)
    cell = Image.new("RGB", (560 + 420 + 12, max(full.height, 420) + 36), (16, 16, 16))
    cell.paste(full, (0, 36)); cell.paste(crop, (572, 36))
    ImageDraw.Draw(cell).text((8, 10), f'{s["name"]}   mode={s["mode"]}  {"(hidden)" if s["off"] else "(shown)"}   {s["note"]}', fill=(220, 220, 220))
    cells.append(cell)
W = cells[0].width; H = sum(c.height for c in cells)
cols = 2; rows = (len(cells) + 1) // 2
sheet = Image.new("RGB", (W * cols, max(c.height for c in cells) * rows), (16, 16, 16))
for i, c in enumerate(cells):
    sheet.paste(c, ((i % cols) * W, (i // cols) * max(cc.height for cc in cells)))
sheet.save(os.path.join(root, "cursor-sheet.jpg"), quality=86)
print(sheet.size, len(cells))
