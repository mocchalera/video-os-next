# Sweet Lesson — 通常の縦スクロール（未公開）

ブランチ: `feat/sweet-lesson-page-scroll`。作業ツリー: `/Users/mocchalera/Documents/Codex/2026-10-02/task/sweet-lesson-scroll-worktree`。
初期状態は `3975a45`。親リポジトリの `projects/` がGit管理対象外だったため、既存Webと必要な素材だけを隔離ブランチに保存した。原本 `/Users/mocchalera/Dev/video-os-next` の作業ツリーは変更していない。LivelyとVOS修正の作業ツリーも変更していない。push・PR・公開・デプロイなし。

## 結果

短い作品ヘッダー → ほぼ一画面の部屋 → 歌詞・制作背景・クレジットの通常の縦スクロール。入口の明示的なクリックから再生し、ヘッダーのアンカーは音を開始しない。再生／一時停止・最初から再生・ミュート・音量・部屋へ戻る操作を下部に常設した。

bodyのスクロールを解放し、映像と既存のUIを部屋内に限定。スクロールではシーク・再生停止・カメラリセットをしない。WASD等はstageのフォーカス中だけで、フォーカス離脱・blur・スクロール・Escで入力を解除。スマホの既定は縦スワイプのスクロールで、視点と二本指歩行は明示的な部屋操作モードへ分離。

自然終了は音声のendedを待つ。214.8秒前に打ち切らず、既存のエピローグを保持する。再再生は同じsong・canvas・FreeCam・Foley・Sfx / AudioContextを使い、エピローグで追加したオブジェクトだけを片付ける。新しい再生ループを作らない。

歌詞は確認済みの `data/lyrics.json` の57行からHTMLへビルド。本文の制作背景・クレジットは既存 `youtube-metadata.json` にある掲載用情報のみ。note原稿は開かず、転載していない。WebGL失敗でも本文が残り、JavaScriptなしでも歌詞を読める。

## 検証

- `node web/build.mjs`: 成功（88ファイル、17.1 MB）。生成物の既存CSPチェックも通過。
- 既存のserve / colliders / freecam / review-fixesテスト: すべて成功。serveはlocalhost待受のため権限のある実行環境で確認。
- [ブラウザ検証18項目](review/scroll/browser-results.json): すべてpass。インストール済みChromeのMetalバックエンド、専用ヘッドレスプロファイル、低解像度tier=4、一度に部屋は一つ。
- [追加入力検証4項目](review/scroll/input-results.json): すべてpass。
- LP Interaction QA: normal / reduced-motion / JavaScript-disabledの15項目pass、エラー・警告0。`artifacts/sweet-scroll-interaction/interaction-report.json`。manifestとreportのSHA-256をreceiptと照合済み。
- 元のgraphics/room.html・timeline.json・camera.json・lyrics.json・曲のSHA-256は原本と一致。MVの描画実装・タイムライン・曲は変更していない。映像再レンダーや負荷試験は行っていない。

実測: 再生中に歌詞へ移動して20秒読み、戻ると音声位置が約20.1秒進行。シークイベント0、再生継続、同一インスタンス。自然終了はtime=duration=214.8秒、壁時計約215.4秒。終了後の自動スクロール・ループなし、歩行可能。明示的再再生後も同一音源とcanvas、追加のAudioContextなし。ページ／ランタイムエラー0。

リサイズ・音量（曲／フォーリー／足音）・フォーカス離脱・blur・Esc・スクロール後のWASD無効化・部屋内に見えるキーボードフォーカス・reduced-motion・モバイル縦スワイプ・明示的操作モード・二本指歩行／touchcancel・横はみ出しなし・WebGL失敗・JavaScriptなしを確認。

## ローカルプレビューと残る範囲

http://127.0.0.1:8876/ （隔離作業ツリーのビルド済み静的サイトを配信中）。

実機iPhone / Safari、端末の音声出力を耳で聴いた確認、通常の自動画質選択での長時間実機再生は未検証。モバイルは390×844のChromeタッチエミュレーション。iOSのHTMLMediaElement.volumeには端末側の制限があるため、音量調整は実機で別途確認が必要。ミュート操作も用意している。公開サイトには反映していない。

## 参考画像

- [ヘッダーと入口](review/scroll/page-top.png)
- [再生中](review/scroll/playing.png)
- [自然終了後](review/scroll/epilogue.png)
- [スマホ相当で歌詞を読む](review/scroll/mobile-reading.png)
