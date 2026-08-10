# Architecture Decision Records (ADR)

このディレクトリには、本プロジェクトのアーキテクチャやチーム運用に関する重要な意思決定を「決定のログ」として記録する。

## なぜ ADR を書くのか

- 過去の意思決定の背景・動機が暗黙知になるのを防ぐ
- 非同期コミュニケーションでの前提・背景の認識合わせを速くする
- 「なぜそうしたか」を誰でも後から振り返れるようにする

採用の経緯そのものは [`20260701-adopt-adr-format.md`](./20260701-adopt-adr-format.md) を参照。

## 運用ルール

- 重要な意思決定を行ったら、このディレクトリに Markdown で 1 ファイル 1 決定として記録する。
- ファイル名は **`YYYYMMDD-title.md`**（例: `20260701-adopt-adr-format.md`）。`title` は内容がわかる kebab-case。
- 仕様書ではなく「決定のログ」として、小さくモジュール化して書く。
- フォーマットは [`template.md`](./template.md) に従う。
- 一度 accepted にした ADR は原則として書き換えない。決定が変わった場合は新しい ADR を追加し、古い方の Status を `deprecated` または `superseded`（後継 ADR を明記）に更新する。

## セクション構成

| セクション | 内容 |
|---|---|
| Status | `proposed` / `accepted` / `rejected` / `deprecated` / `superseded` |
| Situation | 決定時のビジネス上の制約や、会社・チームの状況 |
| Context | 決定が必要になった背後の動機・理由 |
| Material for decision | 決定時に参照した材料（記事・比較資料など） |
| Decision | 最終的な決定内容とその理由 |
| Consequences | 決定によって生じる結果（良い面・トレードオフ） |

## 索引

| 日付 | タイトル | Status |
|---|---|---|
| 2026-07-01 | [ADRフォーマットの採用](./20260701-adopt-adr-format.md) | accepted |
| 2026-07-06 | [issue 駆動・PR 必須の開発ワークフローの採用](./20260706-adopt-issue-driven-pr-workflow.md) | accepted |
| 2026-07-06 | [日本語 Conventional Commits を commit と PR タイトルに適用](./20260706-adopt-commit-and-pr-message-convention.md) | accepted |
| 2026-07-06 | [GitHub デフォルトラベルを廃止しカスタムラベル体系を採用](./20260706-adopt-custom-github-labels.md) | accepted |
| 2026-07-06 | [server-side branch protection の導入を見送る](./20260706-defer-server-side-branch-protection.md) | accepted |
| 2026-07-06 | [テンプレート版数の記録と手動更新戦略の採用](./20260706-adopt-template-versioning-and-update-strategy.md) | accepted |
| 2026-07-06 | [ラベル同期の削除を --prune オプトインに限定する](./20260706-clarify-label-sync-prune-behavior.md) | accepted |
| 2026-07-08 | [エージェント基盤: 素の TS ワークフロー＋薄い自作ランタイム（Flue 設計準拠）](./20260708-adopt-deterministic-agent-architecture.md) | accepted |
| 2026-07-08 | [翻訳パイプライン: ソース優先取り込み・図はベクタ優先・決定的処理のツール化](./20260708-translation-pipeline-ingestion-and-figures.md) | accepted |
| 2026-07-08 | [品質ゲートの二層分離（形式=機械判定 / 品質=LLM）と明示的失敗](./20260708-quality-gate-machine-vs-llm-and-explicit-failure.md) | accepted |
| 2026-07-09 | [品質ゲートの2層化・再訳契約・組版エラー分類](./20260709-quality-gate-two-layer-and-build-error-triage.md) | accepted |
| 2026-07-09 | [LLM プロバイダ抽象化: ローカル(Ollama) と cloud(公式 CLI subprocess) を使い分け](./20260709-llm-provider-abstraction-local-ollama-and-cloud-cli.md) | accepted |
| 2026-07-09 | [用語アーキテクチャ: 2層辞書・4クラス分類・表記方針・proposed 書き戻し](./20260709-terminology-architecture-two-tier-classified-glossary.md) | accepted |
| 2026-07-09 | [ユーザーインターフェース: ファイル配置・jpaper CLI・GUI は core の薄い皮](./20260709-user-interface-file-layout-and-cli.md) | accepted |
| 2026-07-10 | [翻訳一貫性: 文書ブリーフ＋文体契約・evaluator 軸の明文化・訳注 surface](./20260710-translation-consistency-brief-style-and-annotations.md) | accepted |
| 2026-07-10 | [組版レイアウト方針: 原プリアンブル温存を既定・共通テンプレへ明示的フォールバック](./20260710-typesetting-layout-original-first-hybrid.md) | accepted |
| 2026-07-10 | [ソースコメント方針: コードは事実のみ・why は正本・地雷は登録簿＋標識](./20260710-source-comments-facts-only-rationale-to-docs.md) | accepted |
| 2026-07-21 | [見出し未訳検査は非ブロッキングの訳注に留める（第4の trigger 追加）](./20260721-heading-untranslated-nonblocking-note.md) | accepted |
| 2026-07-22 | [LLM 呼び出しトレースは local-first JSONL・メタのみ（Langfuse は将来の opt-in exporter）](./20260722-llm-call-trace-local-jsonl.md) | accepted |
| 2026-07-22 | [プロンプトキャッシュ再利用: system prompt を role ごとに安定化し用語スライスを user へ移す](./20260722-prompt-cache-reuse-stable-system-prompt.md) | accepted |
| 2026-07-23 | [構造化出力をプロバイダ能力で分岐（Ollama ネイティブ JSON モード・claude プロンプト維持）](./20260723-provider-branched-structured-output.md) | accepted |
| 2026-08-09 | [組版の堅牢化: LuaTeX 互換 shim の注入と共通テンプレによる原前文の吸収](./20260809-typesetting-shims-luatex-compat-and-class-absorption.md) | accepted |
| 2026-08-11 | [組版サンドボックス: shell escape 明示禁止と同梱パッケージの探索順後置](./20260811-typesetting-sandbox-and-package-precedence.md) | accepted |
| 2026-08-11 | [プロンプト注入対策: 論文・LLM 由来のテキストを指示面へ載せない](./20260811-untrusted-text-never-becomes-instructions.md) | accepted |
| 2026-08-11 | [プリアンブルを「レイアウト設定」ではなく「攻撃者が書いた実行コード」として扱う](./20260811-preamble-is-untrusted-code-not-just-layout.md) | accepted |
| 2026-08-11 | [検査面に同梱支援ファイルを含める（狭い denylist を分ける）](./20260811-support-files-are-part-of-the-inspection-surface.md) | accepted |
| 2026-08-11 | [読み込みコマンドは名前ではなく引数の形で判定する](./20260811-read-commands-judged-by-argument-not-name.md) | accepted |
| 2026-08-11 | [読み込みコマンドの引数は静的に検証できなければ拒否する（main.tex のみ）](./20260811-read-arguments-must-be-statically-verifiable.md) | accepted |
| 2026-08-11 | [綴りが実行時に決まる \csname は main.tex では拒否する](./20260811-dynamic-csname-is-unsafe-in-main-tex.md) | accepted |
| 2026-08-11 | [出力先を決める paperId は単射でなければならない](./20260811-paper-id-must-be-injective.md) | accepted |
