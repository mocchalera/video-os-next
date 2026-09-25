# video-os-next 設計書

> 状態: v0.1（walking skeleton）/ 2026-09-24
> 前身: `video-os-v2-spec`。コードは継承せず、思想だけを継承する。

## 0. 一行で

**編集者はモデル。システムは「目・記憶・手・検証」を渡す道具箱。**
固定パイプラインでモデルを誘導するのではなく、強いモデルが自分で見て、考えて、
組んで、確かめられる最小で鋭い道具と、嘘をつかない状態を提供する。

## 1. 継承する思想 / 捨てるもの

| 継承する | 捨てる |
|---|---|
| Artifact が正（隠れた状態を持たない） | 10 ゲート・固定ステージ順の強制 |
| 同じ入力 → 同じ出力（決定論的コンパイル） | 45 スキーマで思考を型に押し込むこと |
| ローカル実行・追加 API コストゼロ（Marlin はローカル） | fail-open で黙って劣化すること |
| Marlin = 目、LLM = 脳 | 単一スコア（score:100）による合否 |
| 最後の一手は人間へ（NLE ハンドオフ） | 「隠れた第二タイムライン」禁止による表現の制限 |

旧北極星「弱いエージェントでも品質が出る」は捨てない。**道具の上に載る任意の recipe**
（手順書）として後から実装する。道具が正しく状態を語れば、レールは薄くて済む。

## 2. 設計原則

1. **Truthful state（嘘をつかない状態）**
   素材が今読めるか、解析がどこまであるか、出力がどのタイムラインから作られたかを
   `vos status` が一目で語る。欠落・食い違い・陳腐化は警告ではなく一級の情報。
2. **Primitives over pipelines**
   各コマンドは単機能・JSON 出力・冪等。組み合わせはモデルが決める。
3. **One edit document**
   カット・音・グラフィックの配置はすべて `timeline.json` 一つに宣言する。
   グラフィックは「宣言されたレイヤー」であり、そこに置く素材もタイムラインが持つ（slot）。
   → 表現の自由と、監査・NLE 書き出し・再編集可能性を両立する。
4. **Time is musical**
   時間は秒・フレーム・拍（`16b`）で書ける。拍グリッドは解析 artifact として共有され、
   コンパイラと検査が同じグリッドを読む。
5. **Verification is evidence, not a score**
   検査は「どこで・何が・どれだけ」を時刻付きで返し、判断材料としてフレームシートを出す。
   合否の単一スコアは出さない。最終判断はモデル（と人間）が画を見て行う。
6. **Provenance by default**
   すべての render は receipt（入力ハッシュ・素材ハッシュ・ツール版）を残す。
   すべての解析はモデル名・スナップショット・日時を残す。
7. **Machine-local vs portable を分ける**
   素材 ID は内容ハッシュ。絶対パスは `.vos/`（コミットしない）だけが知る。
   別マシンで ingest し直しても同じ ID になり、タイムラインはそのまま動く。

## 3. プロジェクト構成

```
<project>/
  vos.project.json        # name, canvas(width/height/fps), render 既定値
  brief.md                # 自由記述の意図（frontmatter 任意）。スキーマで縛らない
  assets.json             # portable: alias → {id(content hash), kind, duration, …}
  timeline.json           # 唯一の編集文書（vos.timeline/1）
  graphics/*.html         # グラフィック・レイヤー（HyperFrames + GSAP、ローカル時間で書く）
  design/                 # フォント・トークン CSS（全ページに読み込まれる）
  .vos/                   # machine-local（gitignore）
    paths.json            # id → 絶対パス
    analysis/<id>/        # marlin.json, beats.json, …（provenance 付き）
    build/<name>/         # コンパイル結果（HyperFrames プロジェクト）
    cache/                # 抽出フレーム等
  out/                    # render 出力 + *.receipt.json + inspect/
```

## 4. 編集文書 `vos.timeline/1`

```jsonc
{
  "format": "vos.timeline/1",
  "name": "videoos-pv",
  "canvas": { "width": 1920, "height": 1080, "fps": 30, "background": "#07090d" },
  "duration": "124b",                       // 秒(number|"12s") / フレーム("360f") / 拍("16b")
  "grid": { "bpm": 120, "offset": 0 },      // or { "from": "bgm" } で beats 解析を参照
  "tracks": [                               // 配列順 = 下から上（z 順）
    { "id": "A1", "kind": "audio", "clips": [
      { "id": "bgm", "asset": "bgm", "at": 0, "in": 0, "dur": "124b" } ] },
    { "id": "V1", "kind": "video", "clips": [
      { "id": "see", "asset": "master_v15", "at": "16b", "in": 16.5, "dur": "8b",
        "fit": "cover", "fx": { "filter": "blur(4px)" }, "fade": { "in": 0, "out": 0.2 } } ] },
    { "id": "G1", "kind": "graphics", "clips": [
      { "id": "find-ui", "src": "graphics/find.html", "at": "32b", "dur": "16b", "props": {} } ] },
    { "id": "S1", "kind": "video", "clips": [
      { "id": "find-a", "asset": "scene4b", "slot": "find-ui/viewer", "at": "32b", "in": 3.2, "dur": "3b" } ] }
  ],
  "markers": [ { "at": "32b", "label": "FIND" } ]
}
```

- `at` = タイムライン上の位置、`in` = 素材上の開始（秒）、`dur` = 長さ。
- `slot` 付きクリップはグラフィック内の `[data-slot]` 要素の中に置かれる（UI 内の
  ビューアや端末モック）。時間はタイムラインが持つので、NLE にも書き出せる。
- 全ての時間はコンパイル時にフレームへ丸める。丸めは決定論的（round half up）。
- `grid` は `{ "from": "<音楽 alias>" }` で `vos beats` の解析結果を参照できる。
- トラックの `"role": "overlay"`（HUD・粒子・トランジション）はカット解析から除外される。
- marker `kind` の `expect-black` / `expect-flash` / `expect-still` は「意図した」区間を検査に伝える。

## 5. グラフィック・レイヤー

```html
<style> .find .title { … } </style>
<div class="find">
  <h1 class="title">FIND</h1>
  <div class="viewer" data-slot="viewer"></div>
  <img src="vos://asset/scene4b@4.2">          <!-- 素材の静止フレーム -->
</div>
<script>
vos.graphic(({ tl, q, qa, props, b, onFrame }) => {
  tl.from(q(".title"), { opacity: 0, duration: b(1) }, 0);   // ローカル時間
  onFrame(t => { q(".tc").textContent = t.toFixed(2); });   // 決定論的な毎フレーム処理
});
</script>
```

- ローカル時間で書き、コンパイラが親タイムラインへ `at` で差し込む。
- `vos://asset/<alias>` / `vos://asset/<alias>@<sec>`（静止画抽出）/ `vos://file/<path>`
  はコンパイラが解決し、receipt に使用素材として記録する。**グラフィック内の素材も監査可能**。
- `Math.random` / `Date.now` / ネットワーク禁止（決定論）。
- **事実はバインドする**: `props` に `{"$describe": alias}` / `{"$data": "data/x.json"}` /
  `{"$asset": alias}` / `{"$assets": true}` を書くとコンパイル時に実データへ解決され、ハッシュが
  receipt に残る。画面の文字を手で打たない（v2 PV では要約した引用や重複画像が紛れ込んでいた）。
- `ctx.slotClips(name)` / `ctx.sourceTime(name, t)` で、スロットに置かれたクリップの実区間を読める
  （タイムコード表示などを timeline と二重管理しない）。

## 6. コマンド（道具箱）

| 役割 | コマンド | 出力 |
|---|---|---|
| 記憶 | `vos init`, `vos ingest <files> [--as alias]`, `vos status` | assets.json / 可用性・解析充足・陳腐化 |
| 目 | `vos look <alias\|render> --at … \| --every … \| --count …` | 時刻焼き込みフレームシート PNG |
| 目 | `vos describe <alias…>` / `--all` | Marlin 描写・イベント（モデル 1 回ロード） |
| 目 | `vos index` / `vos find "<query>" [--image f] [--asset a]` | 埋め込み索引 / 融合検索の時刻スパン |
| 耳 | `vos beats <alias>` | BPM・オフセット・拍配列・信頼度 |
| 手 | `vos compile [timeline]` | HyperFrames プロジェクト + 解決済み timeline |
| 手 | `vos render [--draft] [--graphics-only]` | MP4 / 透過 MOV + receipt |
| 検証 | `vos inspect [render]` | 時刻付き findings JSON + カット点シート |
| 返す | `vos export fcp7` | Premiere 用 XML（+ 透過グラフィック MOV） |
| 作る | `vos gen up --budget-cu N` / `vos gen clip --prompt …` / `status` / `down` | Colab GPU 上の MiniMax-H3 で映像+音声を生成 → `generated/<id>.mp4` + `.gen.json` → ingest |
| 移行 | `vos import vos2 <dir>` | 旧プロジェクトの Marlin 解析を provenance 付きで取り込み |

全コマンド `--json` で機械可読。人間向け表示は既定。

## 7. 検証（inspect）が見るもの

- duration parity（timeline 尺 vs 出力尺）
- ラウドネス（integrated / true peak）
- 黒味・白飛びの区間（意図した区間は timeline の marker `kind:"expect-black"` で宣言）
- フリーズ（動画クリップ区間で画が止まっていたら error = 素材の再生失敗を疑う）
- カット点の拍ずれ（grid があるとき、フレーム単位）
- 素材範囲超過（compile 時に error）
- カット点と一定間隔のフレームシート → **モデルが実際に画を見て判断する**

## 8. レンダラ

HyperFrames を唯一のコンポジタとして使う（動画・音声・グラフィックを同じページで合成）。
コンパイラは timeline + graphics → 単一 `index.html` を純関数的に生成する。
FFmpeg は解析・抽出・検査・後処理に使う。

## 9. 素材の同一性と差し替え

- ID = 内容ハッシュ。同じ中身を別 alias で登録すると `status` が `identical content` として知らせる。
- 再生成した素材は `vos ingest f --as alias --replace`。旧 ID は `replaced` に残り、旧素材で作った
  render は receipt 照合で自動的に stale になる。

## 10. 検索（find）

3 つの独立チャネル。ベクトル空間は混ぜず、各チャネルで順位を付けてから順位融合（RRF, k=60）する。

| チャネル | モデル | 何を索引するか | 次元 |
|---|---|---|---|
| text | multilingual-e5-small（ONNX q8, ローカル） | Marlin の scene / event 記述（時刻スパン付き） | 384 |
| visual | Qwen/Qwen3-VL-Embedding-2B | `--step` 秒ごとのフレーム（画像クエリも可） | 2048 |
| audio | laion/clap-htsat-fused | 5 秒窓・2.5 秒ホップ | 512 |
| lexical | なし | 記述への語一致（モデル不要の最後の砦） | — |

- 索引は `.vos/analysis/<id>/embed.<ch>.{json,f32}`。何から作ったか（`key`）を持ち、記述や step が
  変われば再構築、同じなら `fresh`。
- 融合の規則（実素材で調整済み。理由も残す）:
  1. 各チャネルは自分の分布で z ≥ 1.5 の窓だけを根拠にする（一様にぬるいチャネルは寄与しない）
  2. スパンは同一チャネルの連続窓（visual / audio のスライド窓）から作る。text のイベントは連結しない
     → 長い記述イベントが 1 秒精度の映像一致を飲み込まない
  3. 他チャネルは重なるスパンに「そのチャネルの最良順位 1 回分」だけ加点（窓の多い長尺素材が勝たない）
  4. クリップ全体の記述は半分の重みで持ち上げるだけ
  5. 12 秒超のスパンは緩やかに減点（編集点として使いにくい粗い証拠）。重なるスパンは NMS で 1 つに
  6. audio（CLAP = 音の埋め込み）は、クエリが音に関するとき（音・声・曲・sound …）か明示指定時だけ参加
- 結果には各チャネルの類似度を併記する（どの目が見つけたか分かる）。
- モデルが無いチャネルは `channels_unavailable` に理由付きで出る。黙って劣化しない。
- モデルのダウンロード（`vos models pull`）だけがネットワークを使う。明示操作のみ。

## 10.5 生成（gen）

素材が足りないとき、モデルは生成で調達できる。ただし「ローカル実行・追加コストゼロ」の例外なので、次を守る。

- **お金は人間が決める。** `vos gen up` は `--budget-cu` 必須。Colab の計算単位（CU）は課金対象なので、
  エージェントは数値を人間から受け取る（`vos models pull` と同じく、勝手に使わない）。
- **課金は必ずガード越し。** `scripts/colab/vos-colab` が VM を lease（dead-man switch）で持ち、更新が途絶えたら止める。
  予算・期限・VM 消失でも止め、`colab stop` が効かなければ割り当てを直接解除し、解除を確認する。
  vos は `colab new/stop` を直接呼ばない。
- **生成物は普通の素材。** `generated/<request-id>.mp4` を ingest し、横に `vos.gen/1` の来歴
  （プロンプト・seed・解像度・モデルと重みのリビジョン・実際に使ったカーネル/GPU・所要秒・推定 CU）を置く。
  絶対パスは持たない。
- **同じ依頼は同じファイル。** request id は依頼内容（プロンプト・seed・寸法・秒数・ステップ・モデル/重み/ComfyUI の版）
  のハッシュ。既にあれば GPU を使わずに返す。拡散生成は GPU 間でビット一致しないので、
  「決定論」ではなく「一度作ったものを再利用する」保証。
- **画像→動画。** `--from <alias>@<秒>`（と任意の `--to`）で素材のフレームを始点/終点にする。フレームは手元で
  生成寸法ちょうどに切り出して送る（モデル側のリサイズに任せない）。request には素材の内容 ID と秒だけを入れるので
  依頼 ID は機械をまたいで安定し、実際に送った PNG のハッシュは来歴 `frames` に残る。
- **共有ライブラリ。** 生成物は `gen_library`（例: Google Drive for desktop 内のフォルダ）にも `<id>.mp4 + .gen.json`
  で置き、別プロジェクト・別マシン・別エージェントが同じ依頼を GPU なしで再利用する。中央インデックスは持たない
  （Drive 同期越しの同時書き込みで壊れるため）。sidecar に記録したサイズと内容 ID が一致しない（同期途中の）
  ファイルは使わない。ライブラリのパスはマシン設定で、コミットされるファイルには出ない。
- **アップスケールは最後に一度。** `vos gen upscale` はタイムラインが実際に使う生成テイクだけを、キャンバスを覆う
  最小サイズへ Real-ESRGAN（BSD）で拡大し、alias を差し替える（タイムラインは不変、旧内容は `replaced` に残る）。
  フレームを 1 枚ずつ流す（decode→拡大→encode）ので長さに関係なくメモリ一定。ComfyUI グラフで全フレームを
  抱えると 13 GB RAM の T4 VM でサーバが落ちた（実測）。H3 の重みは不要なので `vos gen up --light --gpu T4`。
- **速さの根拠は実測。** 既定値（cu130 の INT8 カーネル、Turbo LoRA 6 ステップ、sol-attn τ1.3）と測定値は
  `scripts/colab/spike/RESULTS.md`。生成後は `vos look` で画を見てから使う。

## 11. ツールチェーン

- `node_modules/`（HyperFrames）と `python/.venv`（torch / transformers / Marlin / Qwen3-VL / CLAP /
  onnxruntime）はリポジトリ所有。`~/.config/vos/config.json` と環境変数は上書き用途のみ。
- `scripts/colab/`: Colab のガード（`vos-colab`）。`python/colab_gen_vm.py` は VM 側ワーカー（ComfyUI + 重み + 生成キュー）。
- `scripts/setup.sh`: オンラインは lock ファイルから、`--offline-from <dir>` は既存インストールから
  依存閉包をコピーして組み立てる（Node の解決規則どおりに辿る / RECORD 単位で dist をコピー）。

## 12. ロードマップ

- v0.1（本版）: 上記コマンド、PV を本方式で再構築して実証
- v0.2: 埋め込み検索（本版で実装）、`look` の差分比較、OTIO 書き出し
- v0.3: recipe 層（弱いモデル向けの手順書: rough-cut, social-cutdown, interview）
- v0.4: 透過オーバーレイ付き Premiere ラウンドトリップの取り込み側（diff → timeline patch）
