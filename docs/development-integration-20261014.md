# 開発ブランチのローカル統合（2026-10-14）

統合前の main は `5bc9575`（完全な SHA は Git の backup ref で確認）。
`backup/main-before-integration-20261014` に元の main を保存し、別 worktree で統合・検証した。
検証済みの候補 `d7e046e` を、履歴を維持してローカル main へ fast-forward した。
元の開発ブランチと worktree は残す。

## 取り込み対象

| 内容 | 取り込み先端 | 方法 |
| --- | --- | --- |
| ControlNet の適用順修正 | `39c46fe` | 共通履歴を取り込み |
| 人物の演技仕様・Kimodo モーション | `11c1b30` | 共通履歴を取り込み |
| 抑制付き seek でも onFrame を更新 | `40d5250` | 共通履歴を取り込み |
| d1 素材判定 CLI（PoC）とレビュー修正 | `d1f32de` | merge `004725a` |
| 段階制作スキル・安全な実行器・静的ドラムセット例 | `9fab612` | merge `5cbdcf6` |
| Sweet Lesson Web のページスクロール・Tab・Esc 修正 | `e86f038` | merge `d7e046e` |

`docs/shionaki-learnings`、`feat/colab-gen`、`fix/colab-keepalive`、
`fix/render-passthrough-heap-errors` は統合前から main に含まれていた。
`feat/previz-performance-motion`、`fix/vos-onframe-suppressed-seek`、
`feat/gen-audio-guide` のコミット済み先端は同じ `40d5250`。
この先端に音声ガイドの未コミット実装は含まれない。

## 保留・保全

- `feat/stepwise-scene-skill` の後半4コミット（`8a69dea`、`ca7abe1`、`7b0f566`、`dfee29e`）は保留。
  演奏例の前腕と楽器の交差が残る。関連タスク `68e434ce` と独立確認 `f0aa7801` の最新報告で
  元の納品版でも全48フレームの交差が確認され、追加試作は NOT_ACCEPTED とされている。
  段階制作ツールを取り込むために、この例を採用済みにしない。
- 元の作業場所は `feat/gen-audio-guide` のまま。未コミット変更6ファイルと未追跡画像33件を
  移動・stage・commit せず、39件の SHA-256 と status・HEAD の一致を確認した。
- d1 は明示的に呼び出す PoC として取り込む。最新 SHA の独立レビューでは新しい P1/P2 はないが、
  人のラベル付き baseline 比較、選定効果、本人へのモデルライセンスの適用判断は未完了。
  この統合でモデル取得・実モデル推論・素材解析は行わない。
- ローカル main の作業場所は `../video-os-next-main`。元の作業場所にある gitignored の作品・素材も
  main への checkout で上書きしないため、作業場所を分けて維持する。

## 今回実行した検証

- 全 Node テスト：121件中120成功、失敗0、skip 1。実行は `node --no-warnings --test --test-concurrency=2 tests/*.test.ts`。
  既存の repo-owned Python と HyperFrames を環境変数で指定し、機械設定は空の別パスを使用。
  ASR の実動作テストはローカル faster-whisper / macOS say の環境条件で skip。
  生成・remote・d1 サーバーはテストの mock/fake を使用。Blender の人物・モーション描画テストは実行済み。
- Python：既存 `python/.venv/bin/python3` による `unittest discover -s python -p 'test_*.py'`、34件成功。
  最初のシステム Python では numpy がなく import に失敗したため、既存のプロジェクト環境で再検証した。
- 段階制作実行器：`python3 -B skills/stepwise-scene-production/scripts/test_render_stages.py`、11件成功。
  Blender は fake。中断、timeout、他 checkout への出力拒否などを確認。
- Sweet Lesson：`node web/build.mjs` 成功（89ファイル、17.1 MB）。
  `bash web/qa/run-node-tests.sh` の4グループ（serve / colliders / freecam / review-fixes）成功。
- Cockpit のローカル実ブラウザ：入室、WebGL 描画、歌詞へのスクロール中の再生継続、
  133.62秒での実キー Esc 演出と focus・操作モード維持、区間外 Esc での操作退出を確認。runtime errors は空。
  最初の Esc 確認では滑らかなスクロールの完了前に入力し focus 条件が崩れたため、
  スクロール完了後の focus を明示的に確認して再実行し成功。ソース修正は不要だった。
  タブはミュート。確認用タブとローカルサーバーは終了。
- 統合対象の `git diff --check` は既存の QA スクリプト4ファイルと BVH fixture の末尾空白を報告。
  動作変更ではなく、今回の統合で無関係な整形は行わない。追加した本記録は diff check を通す。

ログ・元状態・ブラウザ結果は作業用の evidence directory に保存した（Git 管理対象外）。
今回の確認はローカル統合の証拠であり、本番更新・実 provider 比較・実機 Safari/iPhone・聴感確認ではない。
push・公開・デプロイ・元ブランチ削除・タスクの完了扱いは行わない。

## 元の main を確認する方法

`git show backup/main-before-integration-20261014` で統合前を参照できる。
必要なら、この ref から新しい復旧ブランチを作れる。共有履歴の書き換えや元の dirty worktree の reset は不要。
