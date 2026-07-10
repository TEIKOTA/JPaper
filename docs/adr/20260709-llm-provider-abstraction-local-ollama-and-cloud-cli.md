# 2026/07/09 LLM プロバイダ抽象化: ローカル(Ollama) と cloud(公式 CLI subprocess) を使い分け

# Status
- accepted

# Situation
- JPaper は学術論文の和訳エージェント。基盤は [エージェント基盤 ADR](./20260708-adopt-deterministic-agent-architecture.md)（素の TS ワークフロー＋薄い自作ランタイム）で確定。同 ADR は cloud プロバイダとして OpenRouter を既定に置いていた。
- 翻訳を回すにあたり「ローカル LLM と cloud API を状況で使い分けたい」「cloud はサブスク契約のログインセッションを使って API キーを別立てせずに使いたい」という要求が出た。プロバイダ選択を実装前に確定する必要が生じた。

# Context
- 薄いランタイムは既に `LlmClient.complete({model, system, user}) => string` という**単一のプロバイダ境界**を持つ。ここに実装を差し替えれば、ワークフロー本体を無改造で local / cloud を切り替えられる。基盤 ADR の「OpenRouter 既定」を**プロバイダ非依存**へ一般化するのが自然。
- ローカル LLM の入手性: `llama` 系モデルを「簡単に」使う受け皿として **Ollama**（モデル管理内蔵・`localhost` HTTP）と node-llama-cpp（in-process）を比較。Ollama を選ぶが、常駐 daemon を避けたいという要求がある。
- cloud の「ログインセッション利用」には二通りある。①CLI 保存の OAuth トークンを抽出して自作アプリから直接 API を叩く方式は、サブスク認証を公式クライアント外で流用する行為で **Anthropic / OpenAI の利用規約に抵触**（アカウント停止リスク）。②公式 CLI 自体を subprocess として叩けば、ユーザーのログインセッションで**公式クライアントが実行**するため規約内。JPaper は既に poppler/nougat/python を外部ツールとして shell out する設計であり、cloud も同じプロセス境界に載せれば統一できる。

# Material for decision
- 基盤 ADR [エージェント基盤 ADR](./20260708-adopt-deterministic-agent-architecture.md)（薄いランタイム・`LlmClient` 境界・OpenRouter 既定）
- 設計メモ [`docs/design/translation-pipeline.md`](../design/translation-pipeline.md) §9（PDF 処理を外部ツールへ shell out する方針）
- Ollama のサーバー/クライアント分離（`ollama serve` は子プロセスで起動・停止でき、モデルは要求時ロード／`keep_alive` で自動アンロード）
- Codex CLI / Claude Code CLI の非対話実行（`codex exec` / `claude -p --output-format json`）がユーザーのログインセッションで動くこと

# Decision
- **プロバイダは `LlmClient` 境界で抽象化し、local / cloud を差し替え可能にする**。基盤 ADR の「cloud=OpenRouter 既定」を、本 ADR で**プロバイダ非依存**へ改める（OpenRouter は cloud の一実装として残す）。エージェント／ワークフロー本体はプロバイダを知らない。
- **ローカル LLM = Ollama（JPaper がオンデマンドで daemon 管理）**。翻訳実行時に `ollama serve` を子プロセスで起動し、終了時に停止する（またはモデルの `keep_alive` 自動アンロードに委ねる）。**ログイン時自動常駐は使わない**（`brew services` 無し）。未起動時の常駐コストをゼロにするのが要件。`LlamaClient` として `LlmClient` 境界に実装する。
- **cloud = 公式 CLI を subprocess として叩く**（`claude -p --output-format json` / `codex exec`）。ユーザーのログインセッションでそのまま動き、規約内。stdout を zod で検証する境界は従来どおり機能する。既存の shell out パターン（poppler/nougat/python）と統一。
- **OAuth トークン抽出方式は採用しない**。サブスク認証トークンを公式クライアント外へ流用するのは利用規約違反でありアカウント停止リスクがあるため、JPaper に組み込まない。OSS を参照するのは「どのサブコマンド・出力フォーマットで非対話実行するか」までに限る。
- **cloud の代替として公式 API キー / OpenRouter も `LlmClient` 実装として併存可**（従量課金・規約クリーン）。プロバイダ選択は設定で切り替える。

# Consequences
- 良い面
  - ワークフロー本体を触らず、ローカル（無料・オフライン・機微データを外に出さない）と cloud（高品質）を用途で使い分けられる。
  - cloud の「ログインセッション利用」を**規約を破らずに**実現（プロセス境界で利用、トークン境界を触らない）。
  - cloud も shell out で統一され、外部ツール委譲という一貫した設計に収まる。zod 検証境界も不変。
  - Ollama をオンデマンド管理することで、非使用時の常駐コストがゼロ（ディスク上のモデル重みを除く）。
- トレードオフ
  - 公式 CLI subprocess は各 CLI の入出力仕様（サブコマンド・JSON 形式）に依存し、CLI 側の更新で崩れうる（統合テストで検知する）。
  - subprocess 経由はプロセス起動オーバーヘッドと、構造化出力の取り回し（stdout パース）が API 直叩きより手間。
  - ローカルモデルは品質・速度が cloud に劣る場合があり、用途（下訳 vs 最終稿）でのモデル選択が要る。
  - Ollama は別ツールの導入が前提（未導入環境では cloud にフォールバックせず明示的に案内する）。
- 本 ADR は基盤 ADR の cloud プロバイダ前提のみを改める。薄いランタイム・TS ワークフロー・`LlmClient` 境界という基盤の決定は不変。
