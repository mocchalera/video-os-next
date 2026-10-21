"""Standalone, offline comparison gallery with the original MP4 bytes embedded."""
import base64
import html
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE / "outputs"


def data(file, mime):
    return "data:" + mime + ";base64," + base64.b64encode(file.read_bytes()).decode()


def main():
    metrics = json.loads((OUT / "measurements.json").read_text())
    run = json.loads((OUT / "run.json").read_text())
    review = json.loads((OUT / "visual-review.json").read_text())
    assert len(metrics) == 4 and run["state"] == "generated"
    assert all(p["release_verified"] for p in run["phases"])
    cards = []
    for m in metrics:
        label = ("FastH3 Omni" if m["model"] == "fasth3-omni" else "MiniMax-H3") + " · seed " + str(m["seed"])
        cards.append(f'''<article><h2>{label}</h2><video controls playsinline preload="metadata" src="{data(OUT / (m['alias']+'.mp4'), 'video/mp4')}"></video>
<p class="numbers">VMジョブ <b>{m['vm_sec']:.1f}秒</b>　取得・照合まで {m['wall_sec']:.1f}秒<br>音量 {m['loudness']['integrated_lufs']:.1f} LUFS-I</p>
<p>{html.escape(review['clips'][m['alias']])}</p><details><summary>8時点のフレーム</summary><img alt="{label} の同じ8時点" src="{data(OUT / (m['alias']+'-sheet.png'), 'image/png')}"></details></article>''')
    rows = []
    for p in run["phases"]:
        rows.append(f"<tr><td>{html.escape(p['model'])}</td><td>{p['boot']['sec']:.1f}秒</td><td>{(p['ended_at']-p['started_at'])/1000:.1f}秒</td><td>解除確認済み</td></tr>")
    document = f'''<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>放課後のベーシスト — H3比較</title><style>
*{{box-sizing:border-box}}body{{margin:0;padding:clamp(18px,4vw,48px);background:#f4efe4;color:#243e38;font:16px/1.8 'Hiragino Kaku Gothic ProN',Meiryo,sans-serif}}
header{{max-width:900px;border-top:8px solid #b66f36;padding-top:18px}}.eyebrow{{letter-spacing:.16em;color:#78562f;font-size:13px}}h1{{font:600 clamp(27px,4vw,46px)/1.3 'Hiragino Mincho ProN',serif;margin:14px 0}}.lead{{font-size:19px}}.gallery{{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:26px;margin:30px 0}}article{{background:#fffdf7;border:1px solid #cfc7b7;padding:18px;box-shadow:0 6px 20px #31443a0b}}h2{{font-size:20px;margin:0 0 12px}}video,img{{display:block;width:100%;height:auto;background:#1b2825}}.numbers{{border-bottom:1px solid #ded8cc;padding-bottom:12px;color:#78562f;font-variant-numeric:tabular-nums}}details{{margin-top:16px}}summary{{cursor:pointer;text-decoration:underline}}table{{width:100%;border-collapse:collapse;margin:20px 0;font-size:14px}}th,td{{text-align:left;padding:10px;border-bottom:1px solid #cfc7b7}}.note{{max-width:950px;color:#4d5d56}}footer{{margin-top:30px;border-top:2px solid #b66f36;padding-top:16px}}@media(max-width:760px){{.gallery{{grid-template-columns:1fr}}table{{font-size:12px}}th,td{{padding:6px}}}}
</style><header><div class="eyebrow">ANIME BASS / A100 40GB / 2026.10.21</div><h1>放課後のベーシスト</h1><p class="lead">{html.escape(review['conclusion'])}</p><p>同じ参照絵・同じ指示。新旧各2本、1344×768 / 24fps / 約5.17秒。音は1本ずつ再生してください。</p></header>
<main><div class="gallery">{''.join(cards)}</div><table><thead><tr><th>モデル</th><th>起動・取得等</th><th>割り当て前確認〜解除後確認</th><th>VM</th></tr></thead><tbody>{''.join(rows)}</tbody></table>
<p class="note">{html.escape(review['limits'])}</p><p class="note">上限6 CU。表示残高差 {run['observed_cu']:.2f} CU。表示には反映遅延があり、課金確定額とは区別します。GPUの全割り当てを解除済みです。</p></main>
<footer>元のMP4を補正せず埋め込んでいます。顔・手指・楽器の形を見比べ、演奏音は各動画で確認できます。保存版ソース {run['source']['source_commit'][:7]}。</footer></html>'''
    target = OUT / "comparison.html"
    target.write_text(document)
    print(json.dumps({"file":str(target),"bytes":target.stat().st_size,"clips":4}))


if __name__ == "__main__":
    main()
