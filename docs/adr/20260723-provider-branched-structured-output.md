# 2026/07/23 構造化出力をプロバイダ能力で分岐（Ollama はネイティブ JSON モード・claude はプロンプト維持）

# Status
- superseded
- Ollama 側の決定は [Ollama へ format:"json" を送らない ADR](./20260815-drop-ollama-json-mode.md) が置き換える（claude 側の決定は据え置き）。
- [LLM プロバイダ抽象化 ADR](./20260709-llm-provider-abstraction-local-ollama-and-cloud-cli.md) を出力形式の観点で補強する。

# Situation
- 「コストを抑えつつ性能を保つ」が最優先。加えてユーザーから「AI がプロンプト指示に従う前提の設計に過度依存するのは良くない」との指摘。

# Context
- 全エージェント（translator/evaluator/glossary-builder）が JSON 出力を**プロンプトで懇願**している（例: `本文のみ訳し {"segmentId":"…","ja":"…"} の JSON だけを返す`）。応答は `extractJson`→zod で検証。
- これはモデルが指示に従う前提＝**AI 指示依存**。従わないと「JSON が見つからない」parse 失敗になり、以前はこれが run 全体を落とす①バグの原因だった（#34 で retry 内に閉じ込め済みだが、根本は毎回モデル任せ）。
- プロバイダ能力に差がある: **Ollama** は `/api/chat` の `format` でネイティブ構造化出力（JSON モード＝制約デコード）を持つ。**claude CLI**（subprocess）は `--output-format json` が応答エンベロープを包むだけで、モデル内容のスキーマ強制口が無い。

# Material for decision
- Ollama API の `format: "json"`（構文的に妥当な JSON を保証）／`format: <json schema>`（形状も制約）。
- claude CLI のフラグ（`--output-format`/`--append-system-prompt`/`--tools none`）にモデル内容強制は無い。
- zod は現状 v3.23（`z.toJSONSchema` 無し）。zod→JSON Schema 変換は依存追加か v4 移行が必要。

# Decision
- 出力形式の**強制をプロバイダ能力で分岐**する。共有ベースラインとしてプロンプトの JSON 指示は全プロバイダで残す（belt-and-suspenders・無害）。
  - **claude CLI**: ネイティブ機能が無いので `jsonMode` を無視し、プロンプト指定を唯一のレバーとして維持。
  - **Ollama（将来の API プロバイダも同様）**: `LlmRequest.jsonMode` の時に `/api/chat` へ `format: "json"` を付与し、構文的に妥当な JSON を保証する。
- 配線: `LlmRequest` に `jsonMode?: boolean` を追加。`runAgent`（JSON を必ず parse する境界）が呼び出し時に `jsonMode: true` を立てる。プロバイダは能力に応じて honor/ignore する。
- schema レベルの制約（`format: <json schema>` で形状も強制）は zod v4 の `toJSONSchema` 導入時の**将来拡張**とし、本 ADR では JSON モード（構文保証）に留める。

# Consequences
- 良い面:
  - Ollama（と将来 API）で「JSON が見つからない」構文 parse 失敗を**構造的に撲滅**。モデルが指示に従う前提＝AI 指示依存を減らす（ユーザー方針と整合）。
  - claude の挙動は不変（プロンプト指定のまま）＝回帰リスクなし。
  - 純変換器契約・`complete: Promise<string>` は不変（`jsonMode` は入力ヒント）。
- トレードオフ:
  - `format: "json"` は**構文**を保証するが**形状**は保証しない（zod.parse が引き続き検証し、形状不一致は withRetry）。完全な形状強制は schema 版の将来拡張。
  - プロンプトの JSON 指示が Ollama では冗長になる（native format と二重）。害は無いが、将来プロバイダ別にプロンプトを分けるなら整理余地。
  - `LlmRequest` 契約が広がり、契約付録 §8 を更新した。Ollama の実モデル検証は依然後回し（契約どおり）で、本変更はリクエスト body の決定的ユニットテストで検収する。
