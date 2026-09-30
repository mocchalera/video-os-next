"""Build the editable VOS timeline and readable captions from editorial data.

Current no-audio mode is explicitly a visual preview. Once Gemini audio exists,
replace estimated captions with verified timings before the final render.
"""
import argparse
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument("--proof", action="store_true", help="4 seconds per scene for visual QA")
args = parser.parse_args()
film = json.loads(ROOT.joinpath("data/film.json").read_text())

written = {
    "チャットジーピーティー":"ChatGPT", "ジーピーティー、ろくてんいち、ソル":"GPT-6.1 Sol",
    "エージェンツ、エーピーアイ":"Agents API", "ディシジョンズ、エーピーアイ":"Decisions API",
    "サインイン、ウィズ、チャットジーピーティー":"Sign in with ChatGPT", "プライベートインテリジェンス":"Private Intelligence",
    "セキュリティークラウド":"Security Cloud", "ウルトラファスト":"Ultrafast", "コンピューターユース":"Computer Use",
    "ミーティングズ":"Meetings", "コーデックス":"Codex", "ページズ":"Pages", "スラック":"Slack", "チームズ":"Teams",
    "ワークイン、クラウド、環境を選択":"Work in → Cloud → Select environment",
    "クラウドピーシー":"クラウドPC", "エーダブリューエス":"AWS", "エーピーアイ":"API", "シーエルアイ":"CLI",
    "ギットハブ":"GitHub", "ギットラボ":"GitLab", "エムシーピー":"MCP", "アストラ":"Astra",
    "スペース":"Space", "ドッツ":"Dots", "ワーク":"Work", "ソル":"Sol", "デブデイ":"DevDay", "エーアイ":"AI",
    "アット、ChatGPT":"@ChatGPT", "百万トークン":"100万トークン", "プロ、五百ドル":"Pro 500ドル",
}

def caption_chunks(text):
    # Punctuation-aware, at most two short lines. Never break a Latin name.
    bits = re.findall(r"[^。、？！]+[。、？！]?", text)
    chunks, buf = [], ""
    for bit in bits:
        if len(buf + bit) > 43 and buf:
            chunks.append(buf.strip("、")); buf = ""
        if len(bit) > 43:
            chunks.append(bit); continue
        buf += bit
    if buf: chunks.append(buf.strip("、"))
    return chunks

at = 0
clips, slots, markers = [], [], []
for i, d in enumerate(film["scenes"]):
    duration = round((len(d["narration"])/6.67+1.15)*30)/30
    text = d["narration"]
    for old, new in written.items(): text = text.replace(old,new)
    chunks = caption_chunks(text)
    weights = [max(5,len(c)) for c in chunks]
    durations = [(duration-1.0)*n/sum(weights) for n in weights]
    cap_at = .6
    d["captions"] = []
    for c, dur in zip(chunks,durations):
        d["captions"].append({"text":c,"at":round(cap_at,3),"dur":round(dur,3)})
        cap_at += dur
    if args.proof:
        duration=4
        d["captions"]=[{"text":chunks[0],"at":.6,"dur":3.3}]
    d["planned_start"] = round(at,3); d["planned_duration"] = round(duration,3)
    clips.append({"id":d["id"],"src":"graphics/scene.html","at":f"{round(at*30)}f","dur":f"{round(duration*30)}f","props":{"film":{"$data":"data/film.json"},"index":i,"start":at,"duration":duration,"total":0,"preview":True}})
    if d["layout"]=="demo":
        slots.append({"id":"dots-demo","asset":"dots_official","at":f"{round((at+.8)*30)}f","in":1,"dur":min(14,duration-.9),"slot":d["id"]+"/demo"})
    markers.append({"at":f"{round(at*30)}f","label":d["chapter"],"kind":"chapter"})
    if d["layout"]!="demo" and not args.proof:
        markers.append({"at":f"{round((at+1.5)*30)}f","dur":round(duration-1.5,3),"label":"Reading hold: "+d["id"],"kind":"expect-still"})
    at += duration
for c in clips: c["props"]["total"] = at
timeline={"format":"vos.timeline/1","name":"devday-2026-visual-proof" if args.proof else "devday-2026-visual-preview","canvas":{"width":1920,"height":1080,"fps":30,"background":"#101d25"},"duration":f"{round(at*30)}f","tracks":[{"id":"G1","kind":"graphics","clips":clips},{"id":"S1","kind":"video","clips":slots}],"markers":markers,"master":{"loudness":-16,"true_peak":-1}}
ROOT.joinpath("timeline.proof.json" if args.proof else "timeline.json").write_text(json.dumps(timeline,ensure_ascii=False,indent=2)+"\n")
ROOT.joinpath("data/film.json").write_text(json.dumps(film,ensure_ascii=False,indent=2)+"\n")
print(json.dumps({"seconds":round(at,3),"frames":round(at*30),"narration":"pending-gemini-3.8-flash-tts","mode":"proof" if args.proof else "visual-preview"}))
