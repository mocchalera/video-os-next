# Sweet Lesson — web（入れる部屋）

状態: **M4 通常の縦スクロール（隔離ブランチ・未公開）**（M0 試走は `m0-report.md`、M1 は `m1-report.md`、M2 は `m2-report.md`、M3 は `m3-report.md`）。`graphics/room.html` を shim 経由で、音声の再生位置に同期してブラウザで動かす。
このリポジトリの `projects/` は gitignore 済み。デプロイ・外部公開はしていない。

## 作品ページ

短いヘッダー → ほぼ一画面の部屋 → 歌詞 → 制作背景 → クレジット。ページ全体は通常の縦スクロールで、部屋だけをクリップする。部屋に近づくと弱いスナップで一画面に収め、続けてスクロールすれば本文へ抜ける。スクロールによるシーク・自動スクロールはない。

- 部屋の高さは `100dvh` から常設バーの実測高を引く。本文を読んでいる間はスナップを解除し、reduced-motionではスナップを無効にする。詳細と検証は `m4-snap-report.md`。
- ヘッダーの「部屋へ」はアンカー移動だけ。音は既存の「入る」から明示的に開始する。
- 常設バーで再生／一時停止、最初から再生、ミュート、音量、部屋へ戻る操作ができる。最初の入室前にバーから音を開始しない。
- スクロール・本文から戻る操作は音源、canvas、カメラのコントローラを作り直さない。自然終了は audio.ended を待ち、既存の静かなエピローグを維持する。
- 明示的な再再生も同じ音源・canvas・AudioContextを使う。エピローグ用オブジェクトだけを破棄する。
- WASD等は部屋の stage にフォーカスしたときだけ。フォーカス離脱、blur、スクロール、Esc で押下・ジェスチャーを解除する。本文や音量スライダーの矢印入力は歩行に使わない。
- スマホの既定は縦スクロール。「部屋を操作する」で視点／二本指歩行へ切り替え、「操作を終える（スクロール）」またはEscで戻る。
- WebGL失敗時は部屋内の失敗表示に留め、本文は読める。歌詞は `data/lyrics.json` からビルド時にHTMLへ生成し、JavaScriptなしでも読める。
- 制作背景とクレジットは既存のYouTube掲載用メタデータにある文だけを使用。note原稿は使用しない。

ローカル確認:

```sh
node projects/sweet-lesson-mv/web/build.mjs
node projects/sweet-lesson-mv/web/serve.mjs 8876
node projects/sweet-lesson-mv/web/qa/scroll.browser.mjs
node projects/sweet-lesson-mv/web/qa/snap.browser.mjs
```

`scroll.browser.mjs` はインストール済みChromeを別の一時プロファイルで起動し、低解像度の部屋を一つずつ検証する。既存のタブやブラウザ設定は変更しない。`web/review/scroll/browser-results.json` に結果と画像を保存する。実機iPhoneの音量／音声ポリシーは別途確認が必要（HTMLMediaElement.volumeに端末側の制限がある）。

## 起動

```sh
cd projects/sweet-lesson-mv
node web/build.mjs                   # web/dist を作る（製品として見せるのはこれだけ）
node web/serve.mjs 8731              # 既定は web/dist だけを配る。127.0.0.1 のみ。依存なし（Node ≥ 22）
HOST=<tailscale ip> node web/serve.mjs 8741   # スマホで試すとき（tailnet 内だけ。dist だけが見える）
node web/serve.mjs 8731 --qa         # 開発用: web/ 全体と QA のマウント（/_build 等）、MV のファイルをその場に。見せるためには使わない
open http://127.0.0.1:8731/walk.html   # M1: 入る — enter で再生。歩ける
open http://127.0.0.1:8731/m0.html     # M0 の測定ページ（残してある）
```

`walk.html` の URL パラメータ: `?tier=0..4`（画質の段 1080/900/720/540/432 を固定。未指定は自動: スマホは 540 から、起動時の測定が遅ければ一段下げる）、`?res=1080|900|720|540`（内部の描画解像度だけ）、`?glmem=1`（QA: GPU 確保の台帳）、`?qa=1`（QA 用の `window.__walk` と撮影の API を登録する。**指定しない限り存在しない**。エピローグ中は撮影できず、予約も捨てる）、`?hud=1`（時刻・状態・位置の表示。QA 用）、`?auto=1&muted=1&t=20`（入口を飛ばして 20 秒から無音で開始。QA 用）。

### 操作（BRIEF §3）

| 入力 | 動き |
|---|---|
| ドラッグ | 見回し（慣性つき、上下 ±75°）。部屋内では OS の矢印カーソルは出さない（BRIEF §2 v1.1「痕跡としてのカーソル」: `walk/cursor.js`） |
| WASD / 矢印 | 歩く（1.1 m/s、加減速つき、目の高さ 1.55 m）。Q / E で左右に向く |
| 二本指ドラッグ（スマホ） | 歩く（重心の上下左右）。床をダブルタップ = その場所へ歩く。縦画面は画角を広げて同じ構図を保つ |
| Shift + 矢印 / T / `[` `]` | キーボードだけで: 見回し / 時間の線 / ∓10 秒シーク。エピローグは Enter で窓を開け、`R`・`L`。Tab でフォーカス（灰色の 1px と等幅のブロック） |
| 離す | 約 4 秒かけて、ばねのように流れ（MV のカメラ）へ戻される |
| Space / M / C | 一時停止（止まっていても歩ける）/ ミュート / 字幕（off → ja → en） |
| クリック／タップ | 時間の線を出す・消す。線を押す／ドラッグでシーク。133.0〜134.38 秒の間のキー／タップは Esc |
| エピローグ | 曲のあと。窓の曇りに指（マウス）で書く → 窓の枠か上のほうを横に引いて開ける（Enter でも）。`R` 同じ音源で最初から再生、`L` 制作ログ |

## 構成

| ファイル | 役割 |
|---|---|
| `serve.mjs` | 静的サーバ。**既定は `web/dist` だけ**（`--qa` のときだけ、`web/` に加えて QA のマウント `/_build` 等と、MV プロジェクトのファイルを**読み取り専用でその場にマウント**する（コピーしない）: `/_src/room.html`・`timeline.json`・`assets.json`・`data/`・`design/`・`refs/tex/`・`refs/audio/`（mp3/wav のみ）・`out/*.srt`、`/_vendor/three.js`（repo の `src/runtime/three.js` r182）、`/_build/`（QA 専用: 本物の vos ランタイムのページ）。Range 対応。`HOST` 環境変数で待受アドレスを変える（既定 127.0.0.1）。 |
| `shim/vos-shim.js` | vos ランタイムの代役。`room.html` を fetch して `<style>`・マークアップ・`<script>` に分け、`vos.graphic(ctx => …)` を差し込んで実行する（`three / q / qa / props / fps / onFrame`）。props は `timeline.json` の room クリップのもの。`vos://asset/<alias>` は静的ファイルに書き換え。 |
| `walk.html` / `walk/walk.js` | M1 のページ。音声位置 = 曲の時刻。入口（読み込み中に全時刻 + 立ち位置からの目で 1 フレームずつ描いてシェーダを温める。`rendering… N objects` の N は実際に一度でも描かれた物の数）、ループ、入力、QA 用の `window.__walk`。 |
| `walk/segments.js` | **強制区間の表（ここ一か所）**。時刻・理由・出典（camera.json / room.html の行）。0.8 秒の下げ幅、その前の「引き戻し」3 秒。`validate()` が camera.json の変更を検知して警告。 |
| `walk/freecam.js` | 自由視点。出力 = 流れ ⊕ f(T)·Δ。握っている間は絶対姿勢、離すと Δ を臨界減衰ばね（ω = 1.5）で 0 へ。焦点は視線の中心（部屋への光線）へゆっくり、絞りは控えめ。 |
| `walk/colliders.js` | 六畳（壁・ベッド・机・モニタ・棚・バッグ・椅子・ごみ箱）と白い部屋（セルの壁と戸口）の当たり判定、焦点用の光線。 |
| `qa/purity.mjs` + `qa/purity-page.js` | **純関数の検査**: 連続再生（vos と同じ 24 fps の順送り）と、全編一周後のランダムな T への直接ジャンプを、画素とシーンの状態で比べる。 |
| `qa/shots-m1.mjs` + `qa/sheet.py`, `qa/epilogue-run.mjs` | 受け入れの画面。台本どおりに入力して実時間で撮る（エピローグは実際のマウスイベント）。 |
| `qa/run-node-tests.sh` | 速いテスト（Node のみ）: `serve.test.mjs`（不正 URL）、`colliders.test.mjs`（衝突解決の結果は常に有効）、`freecam.test.mjs`（強制区間の入力・綱・衝突）。 |
| `qa/mvdiff.mjs` | MV 不変（画素、エンコーダ非依存）: 実 vos ランタイムのページを元の room.html と現在の room.html で作り、同じフレームの全バイトのハッシュを比べる。 |
| `qa/audio-check.mjs` | 足音・Esc のクリックの音量を曲と比べる（`review/m2/audio-levels.json`、`footsteps-mix.wav`）。 |
| `walk/cursor.js` | 痕跡としてのカーソル（部屋: 中空の輪 / 押せる物: `▍` が 1 Hz で点滅 / 時間の線: 縦線 / 曇った窓: やわらかい円と指の温度）。DOM 1 個を transform だけで動かす。タッチ端末では出さない。起動したら初めて OS のカーソルを消す（`html.cur-on`）。 |
| `walk/tiers.js`, `walk/foley.js`, `walk/pick.js` | M3: 画質の段（解像度・MSAA・影・データセンタ・テクスチャ）と自動選択、フォーリー（AAC を曲に同期して流す）、画面 → 床の光線（ダブルタップ）。 |
| `qa/mobile.mjs`, `qa/tiers.mjs`, `qa/tier-shots.mjs`, `qa/hidden.mjs`, `qa/keyboard.mjs`, `qa/cursor.mjs`, `qa/cursor-kbd.mjs`, `qa/transfer.mjs`, `qa/mv-unchanged.sh` | M3 の検査（`m3-report.md`）。 |
| `walk/ui.js`, `walk/sfx.js`, `walk/traces.js`, `walk/epilogue.js` | M2: 画面の文字（context、時間の線、CC、一行の案内、制作ログ）、足音と Esc の音（合成）、息の曇り、エピローグ（窓に書く・開ける）。 |
| `tools/cdp.mjs` | 実機 Chrome を CDP で動かす（測定・撮影・実際のキー/マウス）。 |
| `m0.html` / `m0.js` | M0 の測定ページ。 |
| `review/m0/`, `review/m1/` | 生データ、スクリーンショット、MV 不変の証拠。 |

## room.html に足した追加フック（オフのときの挙動は不変。差分は `review/m1/room.html.diff`）

| フック | 内容 |
|---|---|
| `window.__roomWebRes` | 内部解像度の段（未設定 = 1920×1080）。M0 では shim が文字列を書き換えていたものの置き換え。 |
| `__roomDbg.web` | 設定されると: ① **純関数化**（各フレームの頭で、時間の窓の中でしか動かされない物 — スマホ、太陽、手が運ぶ物、付箋、袋、缶、紙飛行機、本 — を作った直後の状態へ戻し、通常の処理がその T で必要な分を上書きする）② `web.cam(T, flow)` 部屋のカメラのフック ③ `web.wcam(T, flow)` 白い部屋のカメラのフック（1 フレームに 1 回）④ `web.scenes`（シーンの一覧）。 |
| `__roomDbg.wcam` | 白い部屋のカメラの静的な上書き（`__roomDbg.cam` の白い部屋版。QA 用）。 |
| `web.escAt` | 視聴者の Esc の時刻（既定 134.38）。モニタのプロンプト・`^[  compact: cancelled`・キーの沈みが従う。未設定のときは `+ 0` で値が同じ。 |
| `web.monT` / `web.dustT` / `web.frame` | モニタ・塵・グレインの時計を T から切り離す（エピローグ: T を窓の戸の 195.6 に保ったまま塵が漂い、制作ログがゆっくり流れる）。 |
| `window.__roomWebQ` | `{msaa, shadow, dc}`（MSAA サンプル数・影のマップの倍率・データセンタ描画の倍率）。未設定 = 4・1・1（vos と同じ）。 |
| `web.handheld` / `web.flashScale` / `web.lyricGC` | 手持ちの揺れの倍率、白飛びの倍率（`prefers-reduced-motion`: 0.25 / 0.3）、終わった歌詞カードの GPU テクスチャを返す（スマホの段）。未設定 = 1・1・off。 |
| `web.me` | 視聴者の位置と視線（塵が避ける）。**別のマテリアル `dustMatMe`**（vos が使う塵のシェーダは一字も変えていない）に切り替える。 |

既存の行がいくつか書き換わっている（M1: `W,H`、`const cs = …`、白い部屋の `whitePath(T)` 2 か所。M2: Esc の数値に `+ ed`、`drawMonitor(…)`、塵の時計、グレインの時計。差分は `review/m2/room.html.diff-vs-orig`）が、フックが未設定のとき値は同じ（`vos render` で全バイト一致、画素ハッシュで 432 フレーム一致を確認: `review/m3/mv-unchanged.txt`、`web/qa/mv-unchanged.sh` で再現）。M3 の追加（`__roomWebQ`、`handheld`、`flashScale`、`lyricGC`）も同じ規則。
`graphics/room.html`・`timeline.json`・`data/*.json`・`out/` の公開済みファイルは読むだけ（M1 での `room.html` の編集は上記のみ）。
