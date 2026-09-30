# DevDay 2026 社内共有動画

編集の軸は **Workで1件 → Dotsで継続 → Spaceで共有**。後半でCodex、モデル、API、プラグイン、管理者向けの発表を紹介します。

| 項目 | 状態 |
|---|---|
| 構成・日本語台本 | 19シーン、2,308文字 |
| 画面素材 | Work / Spaceの実画面、OpenAIの公開デモ・画像 |
| 映像 | 1920×1080 / 30fps、6分37.53秒、音声付きMP4 |
| ナレーション | Gemini 3.8 Flash TTS / Kore。公式APIの返却モデルを確認 |
| 字幕 | 71本。実音声のASR単語時刻に同期、画面内の収まりを確認 |
| 公開・社内配布 | 未実施 |

完成動画は `out/devday-2026-internal-final.mp4`（約33 MB）。同名のreceipt / inspectが書き出しと検査の記録です。視聴後は `guide.md` の依頼文をコピーして使えます。外付け字幕は `data/captions.srt` です。

## 編集ファイル

- `timeline.json`：全編のVOS編集状態。`timeline.proof.json`は短い画面チェック用。
- `graphics/scene.html`：決定的なグラフィック。静止画はvosのアセットURL、動画は宣言したslotから表示。
- `design/`：書体と色。fontsは既存の`examples/videoos-pv/design/fonts`への相対シンボリックリンク。
- `data/film.json`：出典付きの画面文言、台本、実音声に合わせた字幕とシーン時刻。
- `data/narration.txt` / `narration-style.txt`：Geminiへの読み上げ原稿・演出指定。
- `data/tts-request.json`：実際に送信した公式Interactions API形式の音声リクエスト。
- `data/tts-status.json`：実際の音声生成状況。
- `data/narration-alignment.json`：ASRの照合率、字幕とシーンの時刻、補間の有無。
- `data/verification.json`：完成ファイルの検査結果と確認できていない点。
- `guide.md`：視聴後に使う依頼文と公式リンク。
- `data/media-provenance.json`：実画面・公式素材の区別とハッシュ。

原素材、音声、アカウント名等を含む未加工スクリーンショット、取得ログは`media/` / `research/`内でGit対象外です。APIキーはリポジトリ直下のGit対象外 `.env.local` から読み込み、編集データには含めません。素材の実パスはVOSのローカルレジストリが管理します。

## 制作と確認

GeminiへのAPI呼び出しは1回。使用量と標準料金からの概算は **0.114488米ドル**、許可済み上限は1米ドルです。請求画面の実額は確認していません。料金の根拠は[公式価格表](https://ai.google.dev/gemini-api/docs/pricing)（2026-09-30）です。

ローカルのfaster-whisperで全編を文字起こしし、台本と照合しました。19シーンと71字幕の時刻に補間はありません。ASRの誤表記は字幕へ転記せず、執筆済みの台本を表示します。全シーンのDOMで収まりを確認し、完成動画のフレームを目視しています。音量は -16 LUFS に設定しています。

**人による全編試聴は未実施です。** 音声の内容と時刻の確認はASRによるもので、主観的な声の自然さ・発音の試聴とは区別しています。アプリの画面は入力例・公開デモで、実行や共有の完了実績ではありません。

`tools/generate_narration.mjs` はNodeの `--env-file=.env.local` でキーを読み込みます。モデルを固定し、1回の最大標準料金を予約して予算を守り、自動再試行を行いません。`tools/align_narration.mjs` はローカルASRから照合記録を作成し、`--apply` でVOSの編集とSRTを更新します。

`tools/make_content.py`と`tools/make_edit.py`は音声待ちの編集用です。**実際の音声に合わせた後で再実行すると、調整済み字幕の時刻を上書きします。**
