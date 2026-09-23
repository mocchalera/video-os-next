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
| 目 | `vos describe <alias>` / `vos find "<query>" [--asset a]` | Marlin 描写・イベント / 時刻スパン |
| 耳 | `vos beats <alias>` | BPM・オフセット・拍配列・信頼度 |
| 手 | `vos compile [timeline]` | HyperFrames プロジェクト + 解決済み timeline |
| 手 | `vos render [--draft] [--graphics-only]` | MP4 / 透過 MOV + receipt |
| 検証 | `vos inspect [render]` | 時刻付き findings JSON + カット点シート |
| 返す | `vos export fcp7` | Premiere 用 XML（+ 透過グラフィック MOV） |
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

## 10. ロードマップ

- v0.1（本版）: 上記コマンド、PV を本方式で再構築して実証
- v0.2: 埋め込み検索（Qwen3-VL / CLAP）を `find` に統合、`look` の差分比較、OTIO 書き出し
- v0.3: recipe 層（弱いモデル向けの手順書: rough-cut, social-cutdown, interview）
- v0.4: 透過オーバーレイ付き Premiere ラウンドトリップの取り込み側（diff → timeline patch）
