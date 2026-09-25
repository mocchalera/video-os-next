"""Render cover/figure HTML in this folder to ../<name>.png at 2x (needs Python playwright + Google Chrome).
Usage: python3 render.py [name ...]   (default: every *.html here)"""
import pathlib, sys
from playwright.sync_api import sync_playwright
here = pathlib.Path(__file__).resolve().parent
names = sys.argv[1:] or sorted(p.stem for p in here.glob("*.html"))
with sync_playwright() as pw:
    b = pw.chromium.launch(channel="chrome")
    for n in names:
        pg = b.new_page(viewport={"width": 1280, "height": 800}, device_scale_factor=2)
        pg.goto((here / f"{n}.html").as_uri()); pg.evaluate("document.fonts.ready")
        el = pg.query_selector(".c") or pg.query_selector(".fig")
        el.screenshot(path=str(here.parent / f"{n}.png"))
        print(n, el.bounding_box())
    b.close()
