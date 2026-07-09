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
