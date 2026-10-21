# FastH3 Omni と既存 H3 の比較準備

状態: ローカル実装済み。**GPU 起動・重み取得・有料生成は未実施、予算は未承認。**

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
| 予算案 | 合計上限 6 CU（旧・新各セッション 3 CU）。人間の承認後に限り開始 |

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
