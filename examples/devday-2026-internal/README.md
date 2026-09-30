# DevDay 2026 社内共有動画

編集の軸は **Workで1件 → Dotsで継続 → Spaceで共有**。後半でCodex、モデル、API、プラグイン、管理者向けの発表を紹介します。

| 項目 | 状態 |
|---|---|
| 構成・日本語台本 | 19シーン、2,308文字 |
| 画面素材 | Work / Spaceの実画面、OpenAIの公開デモ・画像 |
| 映像 | 1920×1080 / 30fps、約6分8秒の音声なしプレビュー |
| ナレーション | Gemini 3.8 Flash TTS指定。接続待ち、未生成 |
| 字幕 | プレビュー用の概算時刻。音声受領後に同期を確認 |
| 公開・社内配布 | 未実施 |

`out/devday-2026-visual-preview-v3.mp4` と同名のreceipt / inspectが試写の証拠です。納品用の音声入り完成動画はまだありません。

## 編集ファイル

- `timeline.json`：全編のVOS編集状態。`timeline.proof.json`は短い画面チェック用。
- `graphics/scene.html`：決定的なグラフィック。静止画はvosのアセットURL、動画は宣言したslotから表示。
- `design/`：書体と色。fontsは既存の`examples/videoos-pv/design/fonts`への相対シンボリックリンク。
- `data/film.json`：出典付きの画面文言、台本、字幕、プレビュー時刻。
- `data/narration.txt` / `narration-style.txt`：Geminiへの読み上げ原稿・演出指定。
- `data/tts-request.json`：公式Interactions API形式の音声リクエスト。未送信。
- `data/tts-status.json`：実際の音声生成状況。
- `guide.md`：視聴後に使う依頼文と公式リンク。
- `data/media-provenance.json`：実画面・公式素材の区別とハッシュ。

原素材、音声、アカウント名等を含む未加工スクリーンショット、取得ログは`media/` / `research/`内でGit対象外です。接続情報は含めません。素材の実パスはVOSのローカルレジストリが管理します。

## 続きの作業

1. 利用可能なGemini接続で、指定モデルの日本語ナレーションを生成する。APIキーや課金の設定は承認を得た範囲で行う。
2. 音声の先頭・途中・末尾、固有名詞、文章の省略や追加を確認し、VOSへ音声アセットとして登録する。
3. 音声から字幕とシーンの時刻を調整し、ナレーショントラックを追加する。プレビューバッジと「ナレーション予定」を完成用に変更する。
4. `vos render` → `vos inspect` → 印刷されたシートを目視。音声入り完成レンダーと現在のreceiptを確認する。

`tools/make_content.py`と`tools/make_edit.py`は音声待ちの編集用です。**実際の音声に合わせた後で再実行すると、調整済み字幕の時刻を上書きします。**
