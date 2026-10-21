# 開発ブランチのローカル統合（2026-10-22）

統合前のmainは `657f31bbcc2dfb42bc27ce3375964b5ef4b48aa2`。
`backup/main-before-integration-20261022` に保存し、別worktreeの
`integration/development-20261022` で統合・検証した。
mainへの反映は履歴を維持するfast-forward方式。mainの作業場所は `../video-os-next-main`。

## 今回の取り込み

`feat/gen-audio-guide` のコミット済み先端
`4a713443432334faf0b9a0df3b06a998f3fdb75c` を統合した。mainに未収録だった12コミットが対象。

- H3長回しの予算付きパイロットと実験記録。
- FastH3 Omniの明示的モデル選択、固定版・来歴・キャッシュの分離。
- FastH3の取得制限対策、GPU事前確認、ComfyUI V1/V3互換確認。
- 航空機とアニメのベース演奏による比較記録、利用者の品質確認。
- 対応機能で要件を満たす場合にFastH3を第一候補にする運用方針。

競合はなかった。以前の統合で入った素材判定PoC、プリビズ・モーション、ControlNet順序修正、
段階制作ツール、Sweet Lesson Web等の変更もmainに保持する。
originをfetchし、今回の開始時点で `origin/main` にローカルmain未収録のコミットがないことを確認した。

## 引き続き保留・保全するもの

- `feat/stepwise-scene-skill` の後半4コミット
  （`8a69dea`、`ca7abe1`、`7b0f566`、`dfee29e`）は今回も保留。
  前回記録 `development-integration-20261014.md` の前腕と楽器の交差・NOT_ACCEPTEDの判断を維持する。
  現在の先端は前回と同じで、解決する追加コミットはない。今回、新しい描画評価は行っていない。
- 元の `feat/gen-audio-guide` worktreeには、音声ガイドの未コミット実装6ファイルと
  未追跡画像33件が残る。これらは統合対象にせず、元のHEAD・status・39ファイルのSHA-256一致を確認した。
- 元の作業場所でcheckout、stash、stage、commit、resetは行わない。
  gitignoredの作品・素材もその場所に保持する。
- 元の開発ブランチは残す。remoteへのpush、公開、デプロイは今回の対象外。

## 今回の検証

統合候補のソースで実施。機械設定は空の別ファイルを使い、既存のrepo-owned Pythonと
HyperFramesを環境変数で指定した。モデル取得・有料GPU起動は行っていない。

- 全Nodeテスト：126件中125成功、失敗0、skip 1。
  `node --no-warnings --test --test-concurrency=2 tests/*.test.ts`。
  skipはローカルfaster-whisperとmacOS sayを必要とする日本語ASRの実動作テスト。
- Python：既存の `python/.venv/bin/python3 -B -m unittest discover -s python -p 'test_*.py'`、43成功。
- Colab課金ガード：fake backendで16成功。
- A100確認用probe：mockで6成功。
- アニメ比較runnerの予算・再実行境界：ローカルで3成功。
  保存済みの参照画像をsource-lock.jsonのSHA-256と照合して使用した。
- 段階制作実行器：fake Blenderで11成功。
- 今回の統合差分と本記録の `git diff --check` は成功。

生成・remote・素材判定のproviderはテストのfake/mockを使用した。
今回の結果はローカル統合の証拠であり、追加の実provider比較、実機iPhone、聴感評価を実施した記録ではない。
Sweet Lesson Webのソースは今回変更せず、前回のブラウザ確認を今回の新規確認とは扱わない。

開始時状態、未コミット差分の保全コピー、テストログ、最終のrefsと保全確認は
作業用evidence directoryに保存した（Git管理対象外）。
統合前の状態はbackup refから参照でき、共有履歴の書き換えを必要としない。
