# OpenAI DevDay 2026 — 今日、ひとつ仕事を任せよう

社内共有動画の付属ガイド。2026年9月29日の発表を、9月30日に公式情報と実画面で確認しました。ナレーションは指定のGemini 3.8 Flash TTS（Kore）で生成しています。

最初は **Workで1件の下書き → Dotsで繰り返す仕事 → Spaceで共有** の順に試します。以下の30分の進め方と依頼文は、この動画のために作成した活用例です。

## 今日の30分

| 時間 | やること | 確認すること |
|---|---|---|
| 5分 | 面倒な仕事を1つ選び、使ってよいメモを準備 | 元資料で答えを確認できる仕事か |
| 15分 | Workで下書きを頼む | 目的・材料・出力・任せる範囲を指定できたか |
| 10分 | 出典、未決事項、担当と期限を確認・修正 | 準備時間と修正回数を記録したか |

## Work：この依頼文から始める

ChatGPTのWorkを開き、モデル欄のGPT-6.1 Solを確認します。Solの提供先はWork、Codex、APIです。通常のChatのモデル選択とは入口が異なります。[公式モデル発表](https://openai.com/index/introducing-gpt-6-1-sol/)

利用してよい資料を添付し、下の例を自分の仕事に合わせて書き換えます。

```text
目的：次の定例会の準備です。
材料：添付したメモのみを根拠にしてください。
出力：要点3つ、未決事項、担当と期限の表。
各要点に、根拠となる資料名と該当箇所を付けてください。
資料にない事実や担当・期限は推測せず「不明」としてください。
任せる範囲：下書きの作成まで。送信・公開・他アプリの変更はしないでください。
```

読む観点は「元資料と一致するか」「未決を決定にしていないか」「担当と期限は正しいか」。これを確認して、人が共有します。

## Dots：成功した定型業務を継続へ

PCで初期設定し、必要なアプリを接続して、目的・頻度・確認時点を指定します。Dotsは対象のPro / Business Premiumで順次展開、Enterprise等は管理者が有効にするベータです。自発的なバックグラウンド調査は読み取り専用です。[Dotsの公式発表・利用条件](https://openai.com/index/introducing-dots/)

```text
目的：チームが毎週読む公開ニュースの下書き。
頻度：毎週月曜の朝。
対象：指定した3つの公式サイトのみ。
出力：重要な更新を最大5件。発表日、要点、出典リンクを付ける。
不明点は不明と書き、元記事の主張と自分の推測を分ける。
確認時点：下書きができた時点で私に見せる。
範囲：調査と下書きのみ。外部への送信・公開はしない。
```

## Space / Pages：チームの1テーマを置く

Spaceの「新規」からスペースやページを作り、テーマを1つ決めて資料・メモ・リンクを集めます。PagesでAIと下書きを直し、共有前に閲覧・編集権限を確認します。共有されたページに転記した内容は、そのページの閲覧者に見えます。[Space](https://chatgpt.com/features/space/)、[開始手順](https://learn.chatgpt.com/docs/space/getting-started)

```text
この資料をもとに、定例会で読む1ページを作成してください。
構成：今週の進捗 / 未決事項 / 次のアクション。
各事実に出典を付け、資料同士で矛盾する箇所は消さずに示してください。
担当や期限を推測で埋めず、確認が必要な項目を末尾にまとめてください。
```

Slack / TeamsはBusiness / Enterprise向けに@ChatGPTで呼び出せます。MeetingsはmacOSアプリのPro / Business向けベータで、参加者に説明し同意を得てから開始します。[Slack / Teams](https://chatgpt.com/features/chatgpt-in-slack-and-teams/)、[Meetingsの手順と条件](https://help.openai.com/en/articles/20001546-the-meetings-plugin-in-chatgpt)

## 開発者の最初の1件

Cloud Codexの入口は、新規タスクの **Work in → Cloud → Select environment**。新しい環境はリポジトリを選び、準備とテストを確認して公開します。既存環境なら選択してタスクを始めます。設定は再利用できますが、タスクごとの作業領域は分かれています。[Cloud Codexの公式手順](https://learn.chatgpt.com/docs/cloud)

```text
目的：次の再現手順で起きる不具合を、小さな変更で修正する。
再現手順：[手順を記入]
期待する動作：[期待する動作を記入]
範囲：[対象ファイルや機能を記入]
完了時：変更理由、差分、実行したテストと結果、未検証の点を報告する。
コミット・PR作成・公開は、差分を私が確認するまで行わない。
```

変更を作る機能と確認する機能を一組で試します。Code ReviewのGitLab対応はプレビューです。Security Cloudでは接続済みGitHubリポジトリを調べ、修正案の証拠をレビューできます。[Code Review](https://learn.chatgpt.com/docs/code-review?surface=app)、[Security Cloud](https://learn.chatgpt.com/docs/security/setup)

組み込みでは、画面操作に[Agents APIのComputer Use](https://developers.openai.com/api/docs/guides/agents-api/tools/computer-use)、有限の選択肢による判断に限定プレビューのDecisions APIを検討します。[DevDayのAPI発表](https://openai.com/index/devday-2026-recap/)

## 機能を広げるときに読むリンク

- [プラグインのUI拡張](https://developers.openai.com/plugins/build/extensions)：サイドバーや会話横の画面。
- [MCP Events](https://developers.openai.com/plugins/build/mcp-events)：アプリ内の出来事から自動処理を始める。
- [Sign in with ChatGPTの利用枠](https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites)：対象のPlus / Proと参加アプリ。アプリ独自の料金・権限も確認。
- [ZDR with Private Safety Processing](https://developers.openai.com/api/docs/guides/private-safety-processing)：企業向けのデータ保持と安全処理。対象プロジェクトで設定する仕組み。
- [Proの各プラン](https://help.openai.com/en/articles/9793128-about-chatgpt-pro-tiers)：Pro 500などの対象容量・速度。

## 画面の見方と出典番号

動画の「実画面」は2026-09-30に取得したWork / Spaceの画面です。Workへの依頼入力は未送信です。「OpenAI公式デモ」は公開動画、「OpenAI公式イメージ」は公開された製品画像です。実行済みの成果物・共同編集実績としては扱っていません。

原素材に含まれるアカウント名、会話一覧、既存ページ名は映像に入れていません。公開素材の取得元と内容ハッシュはassets.json / data/media-provenance.jsonに記録しています。字幕は実際の音声から取得した単語時刻に合わせて調整しています。

出典番号と公式リンクは[sources.md](sources.md)。最新の利用可否は、使用するアカウントのプラン・地域・管理者設定と公式ページで確認してください。
