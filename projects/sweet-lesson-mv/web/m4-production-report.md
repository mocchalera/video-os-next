# Sweet Lesson — スクロールと部屋スナップの本番反映

公開先: https://sweet-lesson.mocchalera.app/ 。2026-10-02、ユーザーの明示承認「sweet lesson 本番反映しちゃおう」に基づき、既存Cloudflare Worker `sweet-lesson` へ反映した。

## 対象と識別子

- 実装: `a137a7c`（通常の縦スクロール＋連続再生）、`8cd9617`（弱い部屋スナップ）、`1a2f3a1`（公開検証で発見したTabフォーカスの修正）。`8c73fcb` は既存配信設定と前版参照の保存。
- 最終デプロイ対象コミット: `1a2f3a1`、ブランチ `feat/sweet-lesson-page-scroll`。
- 最終Worker Version: `64915163-4f49-453e-bc8e-41791e384f35`、100%配信。
- デプロイID: d0f17c30-d92e-40e9-8e1b-059abb4700f3。
- [配信中デプロイ記録](review/production-scroll/final-deployment.json)、[CLI成功記録](review/production-scroll/final-deploy.log)、[ビルド全89ファイルのハッシュ](review/production-scroll/dist-sha256.json)。

既存本番はGitブランチ連動ではなく、静的アセットの直接デプロイ。元リポジトリのmainへの統合・pushは不要だった。既存cf設定を保存したうえで、同じWorker・互換日・既存カスタムドメイン・workers.dev無効・プレビューURL無効・観測無効・静的アセットだけの構成をWrangler設定に表現した。bindingsは0。既存Wrangler OAuth認証を使用し、新規ログイン・認証設定・権限・契約・料金・別リソースの変更はない。

最初の反映では9ファイル、Tab修正の追加反映ではindex.htmlとwalk/walk.jsの2ファイルだけがアップロードされた。MVの描画・タイムライン・カメラ・歌詞・曲は原本とSHA-256一致（[原本照合](review/production-scroll/unchanged-mv.json)）。原本作業ツリーは変更せず、Lively・別VOS変更・ユーザーのブラウザタブ・KAZE確認には触れていない。

## 検証

公開前: ビルド成功（89ファイル、17.1 MB）、colliders/freecam/review-fixes成功、スナップ22項目・Tab5項目・入力4項目・LP15項目成功。構文チェック、git diff --check成功。

最終公開URL: [スナップ22項目](review/production-scroll/live-snap/results.json)、[Tab5項目](review/production-scroll/tab-final.json)、LP Interaction QA 15項目（`artifacts/sweet-production-interaction/interaction-report.json`）がすべてpass。通常・reduced-motion・JavaScript無効を含む。LP receiptのmanifest/report SHA-256も照合した。配信ファイル11点はローカルビルドと一致（[配信ハッシュ](review/production-scroll/live-hashes.json)）。

再生中のスクロール・本文から戻る・リサイズで音声、canvas、カメラは同一インスタンス、シークなし、再生継続。上下から部屋へ接近すると全体が下部バーの上に収まり、小さいホイール入力を続けても本文へ抜ける。本文からの強制再吸着なし。モバイル相当のスワイプ・バーの折り返し・縦横リサイズを確認。

最初の本番反映 `ab3728af-1560-49bd-bd5b-0a0f135e3be3` では、シークせず通常速度で214.8秒の全曲自然終了とその後の歩行まで確認した（[全曲再生の記録](review/production-scroll/live-snap/full-natural-first-deploy.json)）。最終版は音声の時計・終了処理を変えないTab修正だけなので、全曲の通常速度再生を繰り返さず、途中まで通常再生したあとplaybackRate=16で実際のaudio.endedと終了後探索を再確認した。最終版の全214.8秒を通常速度で再検証したとは扱わない。

最初のLP公開検査で、Tabフォーカスに伴うブラウザ自身のスクロールでもstageをblurしてしまうことが判明した。入室前・描画不可時はstageをTab列から除き、入室後のTab移動による自動スクロールだけフォーカスを維持するよう修正。ホイール・通常のページ入力では歩行を解除する。最終公開でTab入室・歩行・本文への脱出を再確認済み。

## 前版へ戻す

変更前の本番Version: `9f1b4a54-0b28-4cbc-bfd3-da72ff50806c`（Sweet Lesson web v1.1）。[前版参照](review/production-scroll/previous-version.json)、[前版詳細](review/production-scroll/previous-version-detail.json)、変更前の公開HTMLを保存。旧distの圧縮バックアップもローカル `web/review/production-scroll/previous-dist.tar.gz` に保持している（Git管理対象外）。

戻す場合は同じwebディレクトリで、明示的なロールバック承認を得たうえで次を実行する。今回は実行していない。

```sh
./node_modules/.bin/wrangler rollback 9f1b4a54-0b28-4cbc-bfd3-da72ff50806c --config wrangler.production.json --name sweet-lesson --message 'Rollback Sweet Lesson scroll release' --yes
```

## 未確認・既存の制限

専用ヘッドレスChrome/Metal、低解像度tier=4、一度に一つのWebGL部屋で確認。物理トラックパッドの慣性、Safari、実機iPhoneのアドレスバー・safe-area・音量ポリシー、耳で聴く音声出力は未確認。モバイルはChromeエミュレーション、慣性相当は減衰するホイール入力。負荷試験は行っていない。

本番の音声Range要求は今回もHTTP 200で全ファイル応答し、Chromeのseekableが[0,0]になる場合があった。既存の保護処理でシーク要求は待機するため、曲末へシークする10秒上限の初回QAはタイムアウトした。通常の連続再生・自然終了は別途成功。ホスティングのRange挙動は今回変更していない。API通信の一時失敗もあったが、未適用を読み取り確認して再試行し、最終版の100%配信を確認している。

## 参考画像

[最終本番の部屋と常設バー](review/production-scroll/live-snap/room-snapped.png) ／ [横画面](review/production-scroll/live-snap/mobile-landscape.png)
