# Sweet Lesson — 部屋に収まるスクロール（未公開）

同じ `feat/sweet-lesson-page-scroll` ブランチ、同じローカルプレビュー http://127.0.0.1:8876/ に反映。公開サイトへの反映・push・PR・デプロイは行っていない。既存のユーザーのブラウザタブは操作していない。

## 挙動

部屋に近づくとCSSの `scroll-snap-type: y proximity` で部屋全体が収まる。部屋だけがスナップ点で、ヘッダーと本文は通常のスクロール。部屋に止まったあと新しい縦入力を始めるとスナップを一時解除する。続けて小さくスクロールしても本文へ抜けられる。

本文では解除したままにし、ユーザーの入力方向と実際の移動方向が一致して部屋へ近づいたときだけ再び有効にする。ブラウザのスナップ戻りの動きを新しい接近と解釈しない。ホイール・タッチのイベントをキャンセルせず、独自のスクロール移動・アニメーションも行わない。「部屋へ」の明示的なリンクは部屋に収める。

部屋は `100dvh` からResizeObserverで測った下部バーの高さと上部safe-areaを引く。操作バーの折り返しや画面サイズの変化にも追従する。reduced-motionではスナップを無効にする。

音声・canvas・カメラ・曲の時計・エピローグの実装は変更していない。今回の変更はページのスクロールと寸法に限定。

## 検証と証拠

- `node web/build.mjs`: 成功、89ファイル・17.1 MB。
- [スクロールスナップ22項目](review/snap/results.json): すべてpass。上下からの接近、減衰するホイール入力、小さい入力の継続での脱出、本文の再吸着なし、PageDown、アンカー、リサイズ、操作バーの折り返し、再生継続、終了後の歩行、reduced-motion、縦・横画面、スワイプを確認。
- [追加入力4項目](review/scroll/input-results.json): すべてpass。スクロール時のフォーカス解除、本文でのWASD無効化、フォーカス枠、二本指入力の解除を再確認。
- LP Interaction QA: 通常・reduced-motion・JavaScript無効の15項目pass。エラー・警告0。`artifacts/sweet-snap-interaction/interaction-report.json`。manifestとreportのSHA-256をreceiptと照合済み。
- 音声・canvas・カメラの同一インスタンスとシークなしを確認。今回の終了後の検証はQAで213秒へ移動後、実際のaudio.endedを待って歩行を確認したもの。全214.8秒の自然再生は前の変更で完了している（[前回報告](m4-scroll-report.md)）。
- 構文チェックと `git diff --check` 成功。

専用のヘッドレスChromeプロファイル、Metalバックエンド、低解像度tier=4、一度に一つの部屋で検証。重い負荷試験は行っていない。

## 未確認

物理トラックパッドの慣性、Safari、実機iPhoneのアドレスバー伸縮・safe-area・音量制約、耳で聴く音声出力は未確認。慣性相当は減衰するホイールイベント、可視領域の変化はChromeのviewportサイズ変更で確認した。実機同等の検証と混同しない。

## 画像

- [部屋全体と下部バー](review/snap/room-snapped.png)
- [横画面と下部バー](review/snap/mobile-landscape.png)
