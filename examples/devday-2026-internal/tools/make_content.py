"""Editorial source of truth. No provider calls or account data."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

scenes = [
    dict(id="opening", chapter="START HERE", layout="hero", title="今日、ひとつ\n仕事を任せよう。", subtitle="OpenAI DevDay 2026｜社内共有", narration="毎週の会議準備。調べて、まとめて、みんなで直す。この流れを、エーアイと一緒に進められるようになりました。今回のデブデイで何が変わったのか。今日、どこから試せばいいのか。実際の画面を見ながら紹介します。", sources=["recap"], cards=["1件の下書きから始める", "2026.09.29 発表 / 09.30 確認"]),
    dict(id="priorities", chapter="THREE FIRST STEPS", layout="three", title="最初は、この3つ。", subtitle="すべてを覚えるより、1件の仕事で試す", narration="優先順位は三つです。個人なら、ワークで一件の仕事を頼む。繰り返す仕事なら、ドッツに継続して任せる。チームなら、スペースに材料と成果物を集める。開発者向けのコーデックスとエーピーアイは、その後に見ていきます。", sources=["recap", "sol", "dots", "space"], cards=[{"label":"01 / 個人", "head":"Work", "body":"1件の下書きを作る"}, {"label":"02 / 継続", "head":"Dots", "body":"繰り返す仕事を任せる"}, {"label":"03 / チーム", "head":"Space", "body":"材料と成果物を共有する"}]),
    dict(id="work", chapter="01 / WORK", layout="screen", title="まず、Workを開く。", subtitle="GPT-6.1 Solを選んで、小さな実務を1件", image="work_home", badge="実画面 / 2026.09.30", narration="最初の入口は、チャットジーピーティーのワークです。画面下に、ジーピーティー、ろくてんいち、ソルが見えます。ソルは、ワーク、コーデックス、エーピーアイに提供されています。まずは公開メモの整理や、会議の準備など、答えを確認しやすい仕事を選びましょう。", sources=["sol"], cards=["入口：ChatGPT → Work", "実務向けモデル：GPT-6.1 Sol"]),
    dict(id="request", chapter="01 / REQUEST", layout="screen", title="依頼は、4点セット。", subtitle="目的・材料・出力・任せる範囲", image="work_prompt", badge="実画面 / 入力例・未送信", narration="依頼は、目的、材料、欲しい出力、任せる範囲の四点セット。例えば、定例会の準備。公開メモから、要点三つ、未決事項、担当と期限を整理。不明点は不明と書く。送信や公開はしない。この画面は入力例です。実行前に、使ってよい資料を添付します。", sources=["sol"], cards=["目的：定例会の準備", "材料：利用してよいメモ", "出力：要点・未決・担当と期限", "範囲：下書きまで"]),
    dict(id="review", chapter="01 / REVIEW", layout="check", title="下書きを、仕事に変える。", subtitle="出典・未決事項・担当と期限を、人が確認", narration="できた下書きは、そのまま配布せず、元資料と照合します。要点に抜けはないか。決まっていないことを、決定事項にしていないか。担当と期限は正しいか。この三つを確認すれば、便利そう、で終わらず、実際に使える成果物に近づきます。", sources=["recap"], cards=[{"head":"要点", "body":"元資料に戻って確認"}, {"head":"未決事項", "body":"推測と決定を分ける"}, {"head":"担当・期限", "body":"人が確定して共有"}]),
    dict(id="dots", chapter="02 / DOTS", layout="demo", title="継続する仕事は、Dotsへ。", subtitle="専用のクラウドPCとブラウザで、進捗を確認", image="dots_official", badge="OpenAI公式デモ / クラウドPC", narration="次の目玉は、常時稼働するエージェント、ドッツ。自分用のクラウドピーシーとブラウザを持ち、連携したアプリを使って、依頼された仕事を進めます。これは公式デモです。作業中の画面を開き、何をしているかを確認できることも、大事なポイントです。", sources=["dots"], cards=["常時稼働するエージェント", "クラウドPC / ブラウザ / アプリ連携"]),
    dict(id="dots-start", chapter="02 / FIRST TASK", layout="steps", title="Dotsには、定型の1件から。", subtitle="例：毎週の公開ニュースを、出典付きで下書き", narration="最初は、毎週の公開ニュースを、出典付きで下書きする、といった定型業務がおすすめです。パソコンで初期設定し、必要なアプリだけを接続。目的、頻度、確認のタイミングを決めます。自発的なバックグラウンド調査は読み取り専用。送信や変更を伴う依頼は、実行範囲と承認ルールを確認しましょう。", sources=["dots"], cards=[{"head":"設定", "body":"PCで初期設定・必要なアプリを接続"}, {"head":"依頼", "body":"目的・頻度・出力・確認時点を指定"}, {"head":"確認", "body":"活動ログ・出典・承認ルールを見る"}], note="Pro / Business Premium：順次展開｜Enterprise等：管理者が有効化するベータ"),
    dict(id="space", chapter="03 / SPACE", layout="menu", title="チームの入口は、Space。", subtitle="「新規」からスペースやページを作る", image="space_menu", badge="実画面 / 新規メニュー", narration="チームで使うなら、スペースです。実際の新規メニューには、ページとスペースがあります。まずは一つのテーマでスペースを作り、メモ、ファイル、リンクを集めましょう。会話の中に埋もれがちな材料と成果物を、チームで見つけられる場所に置けます。", sources=["space", "space-start"], cards=["新規 → スペース", "テーマを1つ決める", "資料・ページを集める"]),
    dict(id="pages", chapter="03 / PAGES", layout="picture", title="人とAIで、同じ文書を直す。", subtitle="Pages：下書き → 共同編集 → 確認して共有", image="pages_official", badge="OpenAI公式イメージ / Pages", narration="ページズでは、人とエーアイが同じ文書を編集できます。資料を根拠に下書きを作り、人が内容を直し、エーアイに構成や表現を整えてもらう。共有する前に、閲覧と編集の権限を確認します。ページに転記された内容は、共有相手にも見えるので、資料の扱いも意識しましょう。", sources=["space", "space-start"], cards=["資料を置く", "AIと下書きを直す", "権限を確認して共有"]),
    dict(id="meetings", chapter="TEAM WORKFLOW", layout="flow", title="会議と会話も、成果物につなぐ。", subtitle="入口を増やすのは、Spaceで1件試した後", narration="スラックとチームズでは、アット、チャットジーピーティーで呼び出せます。対象はビジネスとエンタープライズ。ミーティングズは、録音から議事録とアクション項目を作ります。こちらはマックのベータで、プロとビジネス向け。まず、社内の管理者設定と利用条件を確認してください。", sources=["slack", "recap"], cards=[{"head":"Slack / Teams", "body":"@ChatGPTで会話から依頼", "label":"Business / Enterprise"}, {"head":"Meetings", "body":"録音 → 議事録・アクション項目", "label":"macOSベータ / Pro・Business"}, {"head":"Space", "body":"チームが使う成果物を集約", "label":"確認して共有"}]),
    dict(id="codex", chapter="DEVELOPERS / CODEX", layout="steps", title="Codexは、クラウドで続けられる。", subtitle="環境を選ぶ → 依頼する → 差分とテストを確認", narration="開発者は、クラウドのコーデックスから。環境の設定を再利用し、パソコンを閉じても、長いタスクを続けられます。入口は、ワークイン、クラウド、環境を選択。最初は小さな修正を一件。終わったら、差分、テスト結果、残っている問題を確認してから取り込みます。", sources=["cloud", "recap"], cards=[{"head":"1 / 環境", "body":"Work in → Cloud → Select environment"}, {"head":"2 / 依頼", "body":"再現手順と期待する動作を渡す"}, {"head":"3 / 確認", "body":"差分・テスト・残課題を確認"}], note="環境設定は再利用。タスクごとの作業領域は分離。"),
    dict(id="codex-more", chapter="DEVELOPERS / REVIEW", layout="three", title="書く・レビューする・守る。", subtitle="Codexの入口が増えた", narration="コーデックスは、音声に対応したシーエルアイ、ギットハブとギットラボのコードレビューも強化されました。セキュリティークラウドは、リポジトリを調べ、修正案を用意します。開発チームは、変更を作る機能と、変更を確認する機能を、一組で試すのがおすすめです。", sources=["recap"], cards=[{"label":"実装", "head":"Cloud / CLI", "body":"長いタスク・音声での依頼"}, {"label":"確認", "head":"Code review", "body":"GitHub / GitLabのレビュー"}, {"label":"保守", "head":"Security Cloud", "body":"スキャン・修正案 / Pro以上"}]),
    dict(id="models", chapter="MODELS & SPEED", layout="numbers", title="速さとコストは、仕事で測る。", subtitle="GPT-6.1 Sol / Ultrafast", narration="ソルの標準エーピーアイ価格は、百万トークンあたり、入力二ドル、出力十ドル。アストラ標準の、およそ五分の一です。ウルトラファストは、コーデックスで最大八倍のトークン生成速度。ただし、仕事全体が八倍速になるとは限りません。実際の所要時間と、修正の回数で比べましょう。", sources=["sol", "recap"], cards=[{"label":"Sol / API標準価格", "head":"$2 / $10", "body":"入力 / 出力｜100万tokensあたり"}, {"label":"Ultrafast / Codex", "head":"最大8×", "body":"トークン生成速度の上限値"}], note="Astra Ultrafast：API / Work・CodexはPro 500・Enterprise｜Sol Ultrafast：近日"),
    dict(id="apis", chapter="DEVELOPERS / API", layout="two", title="APIは、目的で選ぶ。", subtitle="操作を任せるか、決まった選択肢から選ぶか", narration="自社システムへの組み込みは、目的で分けます。画面操作が必要なら、コンピューターユースが加わった、エージェンツ、エーピーアイ。問い合わせを、決まった部署へ振り分けるような判断には、限定プレビューの、ディシジョンズ、エーピーアイ。エーダブリューエス内での運用という選択肢も発表されました。", sources=["recap"], cards=[{"label":"画面操作", "head":"Agents API", "body":"Computer Useでソフトウェアを操作"}, {"label":"分類・振り分け", "head":"Decisions API", "body":"有限の選択肢から判断 / 限定プレビュー"}], note="AWS Bedrock Managed AgentsによるAgents API運用も発表"),
    dict(id="plugins", chapter="ECOSYSTEM", layout="three", title="いつものアプリと、つながる。", subtitle="プラグイン・MCPイベント・Sign in with ChatGPT", narration="プラグインは、会話の横に操作画面を置けるようになります。エムシーピーのイベント対応は、アプリの出来事をきっかけにエーアイを起動する仕組み。サインイン、ウィズ、チャットジーピーティーでは、対応アプリが、自分の利用枠で動きます。連携する前に、権限と利用量の扱いを確認しましょう。", sources=["recap"], cards=[{"label":"画面", "head":"Plugins", "body":"会話横のUI / Sitesへの埋め込み"}, {"label":"きっかけ", "head":"MCP events", "body":"アプリのイベントから起動 / 提案仕様"}, {"label":"利用枠", "head":"Sign in", "body":"対応アプリでChatGPTの枠を利用"}]),
    dict(id="security", chapter="ADMIN & SECURITY", layout="two", title="管理者が整える、2つの条件。", subtitle="使ってよいデータと、実行してよい操作", narration="管理者は、データの扱いと、操作の範囲を整えます。プライベートインテリジェンスは、ゼロデータ保持と、担当者が内容を見ない安全処理を組み合わせた企業向けの選択肢。すべてのアカウントに自動で適用されるものではありません。導入する契約の条件と、アプリの権限を確認します。", sources=["recap"], cards=[{"label":"情報", "head":"データの扱い", "body":"Private Intelligence\nZDR + Private Safety Processing"}, {"label":"操作", "head":"実行・承認の範囲", "body":"接続するアプリ / 共有権限\n外部送信や変更の確認ルール"}], note="Private Inferenceは秋にプレビュー予定。導入条件は契約ごとに確認。"),
    dict(id="availability", chapter="AVAILABILITY", layout="availability", title="今使えるものから、始める。", subtitle="プラン・地域・管理者設定で利用可否が変わる", narration="発表された機能には、すぐ使えるもの、順次展開のもの、近日公開のものがあります。ソルはワークとコーデックスから。ドッツは対象プランで順次。共同編集スライドと、ソルのウルトラファストは近日です。新しいプロ、五百ドルのプランもありますが、まずは今のプランで、小さな一件を試しましょう。", sources=["recap", "sol", "dots", "space"], cards=[{"label":"提供開始", "head":"GPT-6.1 Sol", "body":"Work / Codex / API"}, {"label":"順次・ベータ", "head":"Dots", "body":"対象プラン / 地域 / 管理者設定"}, {"label":"近日", "head":"Slides / Sol Ultrafast", "body":"発表と利用開始を分けて確認"}], note="Pro 500：月$500 / 約25×Plus容量｜2026.09.30確認"),
    dict(id="action", chapter="YOUR FIRST 30 MINUTES", layout="action", title="今日の30分で、1件。", subtitle="準備時間と修正回数を、前後で比べる", narration="今日の三十分で、まず一件。最初の五分で、面倒な仕事と、使ってよい資料を選ぶ。次の十五分で、ワークに下書きを頼む。最後の十分で、人が確認して直す。準備に何分かかったか、何回直したかを記録します。うまくいった仕事だけ、ドッツやスペースへ広げましょう。", sources=["recap"], cards=[{"label":"5分", "head":"選ぶ", "body":"仕事1つ / 利用できる資料"}, {"label":"15分", "head":"頼む", "body":"目的・材料・出力・範囲"}, {"label":"10分", "head":"確認する", "body":"出典・内容・担当と期限"}]),
    dict(id="closing", chapter="LET'S START", layout="closing", title="まず1件。\nうまくいったら、チームへ。", subtitle="コピーして使える依頼文・公式リンクは、付属ガイドへ", narration="大切なのは、新機能を全部覚えることより、自分の仕事を一つ、実際に楽にすることです。依頼文と公式リンクは、付属ガイドにまとめました。まず一件、今日から始めてみましょう。", sources=["recap"], cards=["OpenAI DevDay 2026 / 2026.09.29", "公式情報・実画面：2026.09.30確認", "Narration: Gemini 3.8 Flash TTS"]),
]

sources = {
    "recap": {"title":"OpenAI DevDay 2026 recap", "url":"https://openai.com/index/devday-2026-recap/"},
    "dots": {"title":"Introducing dots", "url":"https://openai.com/index/introducing-dots/"},
    "sol": {"title":"Introducing GPT-6.1 Sol", "url":"https://openai.com/index/introducing-gpt-6-1-sol/"},
    "space": {"title":"ChatGPT Space", "url":"https://chatgpt.com/features/space/"},
    "space-start": {"title":"Space: getting started", "url":"https://learn.chatgpt.com/docs/space/getting-started"},
    "cloud": {"title":"Cloud Codex", "url":"https://learn.chatgpt.com/docs/cloud"},
    "slack": {"title":"ChatGPT in Slack and Teams", "url":"https://chatgpt.com/features/chatgpt-in-slack-and-teams/"},
    "tts": {"title":"Gemini 3.8 Flash TTS", "url":"https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash-tts"},
    "review": {"title":"Code review", "url":"https://learn.chatgpt.com/docs/code-review?surface=app"},
    "security-cloud": {"title":"Codex Security Cloud setup", "url":"https://learn.chatgpt.com/docs/security/setup"},
    "psp": {"title":"ZDR with Private Safety Processing", "url":"https://developers.openai.com/api/docs/guides/private-safety-processing"},
    "extensions": {"title":"Plugin Extensions", "url":"https://developers.openai.com/plugins/build/extensions"},
    "mcp": {"title":"MCP Events", "url":"https://developers.openai.com/plugins/build/mcp-events"},
    "signin": {"title":"Using your ChatGPT plan in other apps and sites", "url":"https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites"},
    "meetings": {"title":"The Meetings plugin in ChatGPT", "url":"https://help.openai.com/en/articles/20001546-the-meetings-plugin-in-chatgpt"},
    "pro": {"title":"About ChatGPT Pro tiers", "url":"https://help.openai.com/en/articles/9793128-about-chatgpt-pro-tiers"},
    "computer-use": {"title":"Agents API: Computer use", "url":"https://developers.openai.com/api/docs/guides/agents-api/tools/computer-use"},
    "bedrock": {"title":"Amazon Bedrock Managed Agents", "url":"https://aws.amazon.com/bedrock/managed-agents-openai/"},
}
for s in scenes:
    if s["id"]=="models": s["note"]="Astra Ultrafast：APIで提供 / Work・Codex：Pro 500・Enterprise｜Sol Ultrafast：近日"
    if s["id"]=="closing": s["cards"][-1]="ナレーション予定：Gemini 3.8 Flash TTS"
    if s["id"]=="meetings":
        s["sources"]=["slack","meetings"]
        s["note"]="Meetingsは参加者に説明して同意を得てから開始。"
    if s["id"]=="codex-more":
        s["sources"]=["review","security-cloud","recap"]
        s["note"]="GitLabのCode Reviewはプレビュー。利用範囲・権限を確認。"
        s["cards"][1]["body"]="GitHub / GitLab（プレビュー）"
        s["cards"][2]["body"]="スキャン・修正案\nPro / Business / Enterprise / Edu"
    if s["id"]=="apis": s["sources"]=["computer-use","recap","bedrock"]
    if s["id"]=="plugins": s["sources"]=["extensions","mcp","signin"]
    if s["id"]=="security": s["sources"]=["psp","recap"]
    if s["id"]=="availability": s["sources"]=["sol","dots","space","pro"]
for key, val in sources.items():
    val["checked"] = "2026-09-30"
    val["number"] = list(sources).index(key) + 1

ROOT.joinpath("data").mkdir(exist_ok=True)
ROOT.joinpath("data/film.json").write_text(json.dumps({"title":"今日、ひとつ仕事を任せよう。", "date":"2026.09.30", "scenes":scenes, "sources":sources}, ensure_ascii=False, indent=2)+"\n")
ROOT.joinpath("data/narration.txt").write_text("\n\n".join(s["narration"] for s in scenes)+"\n")
ROOT.joinpath("data/narration-style.txt").write_text("日本語の社内共有動画のナレーション。落ち着いた親しみやすい声で、明瞭に、少し前向きなテンポで話してください。自然な日本語で、1分あたりおよそ400文字。段落間は短い間を取り、列挙する箇所は項目を聞き分けやすくしてください。台本の文章だけをそのまま読み、挨拶、説明、効果音、音楽を追加しないでください。最後まで声の調子と速さを保ってください。\n")
ROOT.joinpath("data/sources.json").write_text(json.dumps(sources,ensure_ascii=False,indent=2)+"\n")
print(json.dumps({"scenes":len(scenes), "characters":sum(len(s["narration"]) for s in scenes)}, ensure_ascii=False))
