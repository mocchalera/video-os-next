"""The social-share image: thumb/thumbnail.jpg (1280×720) → web/assets/og.jpg at exactly 1200×630 (the shape og:image wants). Never modifies thumb/.
16:9 → 1.905:1 means trimming 24 px off the top and bottom of the source (the title and the room sit well inside), then scaling to 1200×630.
   python3 web/tools/build-og.py"""
import os
from PIL import Image
P = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
im = Image.open(os.path.join(P, "thumb", "thumbnail.jpg")).convert("RGB")
w, h = im.size
ch = round(w * 630 / 1200)            # height that gives 1200:630 at this width
top = (h - ch) // 2
out = im.crop((0, top, w, top + ch)).resize((1200, 630), Image.LANCZOS)
dst = os.path.join(P, "web", "assets", "og.jpg"); out.save(dst, quality=88, optimize=True, progressive=True)
print(dst, out.size, os.path.getsize(dst), "bytes")
