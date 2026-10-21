# FastH3 Omni と既存 H3 の比較

状態: **新旧各2本の音声付き動画を生成・照合済み。FastH3の参照画像経路はA100 40GBで動作した。全VM解除済み。**
当初の合計上限6 CUを維持。表示残高差4.44 CU、料金率と稼働時間等からの概算5.09 CU（課金確定額とは区別）。
2本目のVMジョブは旧242.4秒→新98.4秒。取得を含む全体時間の差は小さい。詳細は [RESULTS.md](RESULTS.md)。
失敗原因と修正は [RECOVERY.md](RECOVERY.md)。新形式の互換チェックを修正した成功版は `ce1c69b`。

参照画像を使う経路の限定比較。テキストのみ、開始・終了フレーム固定、音声ガイド、ControlNet、
人物の口の動きと声の同期は対象外。結果を見る前に既定モデルを変更しない。

## 条件

| 条件 | 共通 / 比較対象 |
| --- | --- |
| 入力 | 公式 ComfyUI サンプル yellow_plane_ref.png（source-lock.json に URL と SHA-256） |
| プロンプト | prompt.txt。参照画像 1 枚、音声はプロンプトから生成 |
| 長さ・出力 | nominal 5 秒、1344×768、24 fps、124 フレーム |
| 参照画像処理 | --refs reference --ref-size match |
| seed | 1 と 2（各モデル 2 本、計 4 本） |
| 旧経路 | minimax-h3、参照生成 full 20 steps、既存 sol-attn 設定 |
| 新経路 | fasth3-omni、INT8 ConvRot、Euler 8 steps、VSA keep 10%、shift 12/3 |
| GPU | Colab A100 40GB。異なる GPU なら比較条件を変えずに停止して報告 |
| 承認予算 | 合計上限 6 CU（旧・新各セッション 3 CU）。今回の比較 1 回のみ |

## 実行時の扱い

- 既存 vos-gen セッションが使用中なら変更・停止せず、衝突を報告する。
- 旧・新を別のセッション割り当てで順に実行し、各セッションを finally 相当の処理で停止・解除確認する。
  起動・ダウンロードも予算内。未使用分を別の実験や再起動へ自動で回さない。
- 各セッションの壁時計上限は 30 分。失敗時に別 GPU、別モデル、別精度へ自動で切り替えない。
- 実行前にソース版、送信する worker の SHA-256、参照 PNG の SHA-256、両モデルの request を保存する。
  入力 PNG は source-lock.json のハッシュが一致することを確認する。
- コールド起動（取得・ロード・初回 encode を含む）と 2 本目の時間を分ける。
  別 seed の 2 本目も encode 等を含むので、純粋な denoise ベンチマークとは呼ばない。
- 元 MP4 と .gen.json、guard の CU・停止状態を保存し、ffprobe で寸法・fps・フレーム数・音声を確認する。
  vos look のフレームシートで形状・動き・ちらつきを確認し、実際の動画を音付きで確認する。
- 結果はこの入力と条件に限定する。形状保持、動き、エンジン音との対応、時間、実支出を記録し、
  標準採用の判断と、他の入力・人物・長尺で未検証の点を分ける。

入力の復元（画像のみ。モデル取得や GPU 起動は行わない）:

```sh
mkdir -p experiments/fasth3-omni-20261021/inputs
curl -fL https://raw.githubusercontent.com/Comfy-Org/workflow_templates/1524172f454aff9c87b7e5ebc143af95542bf8f0/input/yellow_plane_ref.png -o experiments/fasth3-omni-20261021/inputs/reference.png
shasum -a 256 experiments/fasth3-omni-20261021/inputs/reference.png
```

実行コードは `run.ts`。`--execute --budget-cu 6` がない場合はローカルの計画作成のみ。
今回の生成実装は `fab6ba2d0d6a5cf6cce02c5935e30f0458ee23c9` を別フォルダへ展開して固定し、
`run.ts` をコピーした。`outputs/execution-source.json` に実装・worker のハッシュ、
`outputs/run.json` に実行結果と停止確認を保存する。実行前にこれらのハッシュを照合し、
`outputs/execution.started` が存在する場合は再度レンタルしない。

承認後の再試行は `retry.ts`。実装を `f18585f` の分離版に固定し、旧動画・元の実行記録・
同じ新側2本のrequestを照合して、新側だけを実行した。`outputs/retry-execution.started` があれば
再度レンタルしない。記録は初回と別の `outputs/retry-*.json` に保存する。
`python3 experiments/fasth3-omni-20261021/analyze.py --include-retry` は両実行の成功した動画だけを再測定し、
元の測定を保持して `outputs/measurements-comparison.json` に出力する。

続行後の成功した実行は `recover.ts --run-label schema`。`outputs/schema-*.json` に来歴・設定・停止確認を保存した。
`analyze.py --include-schema` は過去の実行記録を保持して全4本を `outputs/measurements-schema.json` に再測定する。
現在の `schema-execution.started` は保持しており、この記録で再度レンタルしない。
