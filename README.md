# video-os-next

**編集者はモデル。システムは「目・記憶・手・検証」を渡す道具箱。**

Opus 5.5 / GPT-6 級のモデルが、映像を自分で見て、組んで、確かめて、人間に返すための
ローカル映像編集ツールキット。前身 [video-os-v2](https://github.com/mocchalera/video-os-v2) の思想
（artifact が正・決定論・ローカル・最後の一手は人間へ）を継承し、固定パイプラインを捨てて作り直した。

```bash
scripts/setup.sh                     # node_modules（HyperFrames）と python/.venv（Marlin・埋め込み）を用意
bin/vos doctor                       # ffmpeg / HyperFrames / Python / モデルの有無
bin/vos init my-film && cd my-film
../bin/vos ingest ~/footage/*.mp4    # 内容ハッシュで登録（別マシンでも同じ ID）
../bin/vos look shot_03 --count 12   # フレームシートで素材を見る
../bin/vos describe shot_03          # Marlin-2B（ローカル）で描写・イベント
../bin/vos describe --all            # 全動画を Marlin で記述（モデル読み込み 1 回）
../bin/vos index                     # 埋め込み索引（text / visual / audio）
../bin/vos find "空を見上げる女性"     # 3 チャネル + 語彙検索を順位融合、時刻スパンで返す
../bin/vos beats music               # BPM・拍グリッド
$EDITOR timeline.json graphics/*.html
../bin/vos render --draft && ../bin/vos inspect   # 時刻付き findings + カット点シート
../bin/vos render --graphics-only && ../bin/vos export fcp7   # Premiere へ（透過グラフィック付き）
```

## 何が違うか（v2 比）

| | video-os-v2 | video-os-next |
|---|---|---|
| 主役 | 10 ゲートの固定パイプライン | モデル。道具は単機能 + JSON |
| 編集状態 | 45 スキーマ + 複数 artifact | `timeline.json` 一つ（カット・音・グラフィック・スロット） |
| グラフィック | 登録テンプレートのみ（表現が狭い） | HyperFrames HTML を宣言レイヤーとして自由に。素材はスロット、事実は artifact バインド |
| 素材 ID | パス依存 | 内容ハッシュ（同一ファイルの重複・差し替えを検出） |
| 検証 | 単一スコア（score 100 が出る） | 時刻付き findings + フレームシート。判断は画を見て |
| 陳腐化 | 気づけない | receipt と内容ハッシュで render の stale を自動判定 |
| 実行 | 大量の npm 依存 | Node ≥ 22.18 だけ（TS 直実行、ランタイム依存ゼロ） |

## 実証: このツールで PV を作り直した

`examples/videoos-pv/` は Video OS の 60 秒 PV を、すべて `timeline.json`（39 メディアクリップ、
14 グラフィック）として再構築したもの。画面上の Marlin 描写・検索結果・タイムライン・レビュー文は
すべて artifact にバインドされている。作り直す過程で、道具が前回の手作りでは見逃していた事実を見つけた:

- 「v04 → v15」の版履歴のうち v04 と v05 の画像はバイト単位で同一だった（内容ハッシュで検出 → 表示から除外）
- 前回の PV に出したレビュー文は原文の要約（言い換え）だった → 原文にバインド
- BGM は AAC 化でトゥルーピークが -1 dBTP を超えていた（inspect で検出 → timeline で -1 dB）
- 意図していない 0.33 秒の黒味（inspect で検出 → 意図として宣言）

## 映像を生成する（Colab の GPU × MiniMax H3）

足りない素材は、エージェントが Google Colab の GPU を借りて ComfyUI（MiniMax H3）で生成できる。
課金中の VM は必ず見張り番（リース・予算上限・最大時間）の下で動き、放置されれば自動で止まる。

```bash
bin/vos gen library --search "boat"             # 共有ライブラリを探す（無料）
bin/vos gen up --budget-cu 2 --wait             # A100 を借りる（予算は人間が決める）
bin/vos gen clip --prompt-file shot.txt --as a  # 生成 → 取り込み → 来歴 .gen.json
bin/vos look a && bin/vos gen down              # 目で確かめて、返す
```

仕組みの解説（非エンジニア向け）: [docs/articles/colab-comfyui-for-agents.md](docs/articles/colab-comfyui-for-agents.md)
／ 実測と失敗の記録: [scripts/colab/spike/RESULTS.md](scripts/colab/spike/RESULTS.md)

## 構成

```
bin/vos                CLI
src/core               project / assets / time / timeline / status
src/compile            timeline + graphics → HyperFrames ページ（純関数・決定論）
src/render             HyperFrames 実行 + receipt
src/inspect            look（フレームシート）/ inspect（証拠）
src/analyze            beats / Marlin / embed（検索）
src/export             FCP7 XML（Premiere）
python/                marlin_worker.py, embed_worker.py, requirements.lock.txt, .venv/（gitignore）
scripts/setup.sh       環境構築（オンライン / --offline-from）
docs/DESIGN.md         設計
AGENTS.md              エージェント向けの地図
```

テスト: `npm test`（Node 標準の test runner、ffmpeg が必要）。
