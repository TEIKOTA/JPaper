# 2026/07/22 LLM 呼び出しトレースは local-first JSONL・メタのみ（Langfuse は将来の opt-in exporter）

# Status
- accepted

# Situation
- コスト調査で費用が想定超だった。「資料スキャフォールド vs JPaper のどこで無駄が出るか」を後から解析したいが、恒常的な計測が無い。
- JPaper は `jpaper <id>` で走って終了コードで終わる短命 CLI／ライブラリ（`translatePaper()`）。常駐サービスではない。
- 対象論文は未公開・機微を含み得る（外部送信は慎重を要する）。

# Context
- `claude` プロバイダの `complete()` は応答 JSON の `total_cost_usd`・`usage`（input/output/cache_read/cache_creation tokens）・`num_turns` を**捨てて** `result` 文字列だけ返している。計測に必要なデータは既に境界を通過している。
- 実験ハーネスの `eval-calls.jsonl`（role/segment/tokens/cost/verdict の JSONL）で、①retry バグと「評価者=コストの約40%」を後から解析できた＝**構造化ログを貯めれば無駄解析ができる**と実証済み。
- ユーザー提案は「Langfuse もしくは**それに匹敵するログ**が貯められれば後から無駄を解析できるはず」。手段（Langfuse）ではなく**構造化ログの能力**が要件。
- 設計上の分離: コスト/usage はプロバイダ（最下層）にしか無く、文脈（role/segmentId/pass/phase）は呼び出し側（section-loop・agents）が持つ。トレース1行は両方を要する。

# Material for decision
- 対照実験レポート（15run）と `eval-calls.jsonl`／`analyze-eval.mts`（構造化ログでの無駄解析の実例）。
- Langfuse の配備形態: クラウド SaaS（無料枠が小さい・第三者送信）／セルフホスト（Postgres+Clickhouse+web の Docker 常駐）。
- 既存の DI 流儀: `makeClaudeClient({ run })` に副作用境界を注入する形（実験ハーネスもこれで計測した）。

# Decision
- **Phase 1（本 ADR で採用）**: local-first の構造化 **JSONL トレース**を実装する。
  - `LlmRequest` に `meta?: { role, phase?, segmentId?, pass? }` を追加（§8 契約拡張）。文脈を呼び出し側からプロバイダへ降ろす。
  - プロバイダに `trace?: TraceSink` を DI。応答から usage/cost/latency/num_turns を読み、`meta` を添えて `LlmCallEvent` を emit する。`LlmClient.complete: Promise<string>` は不変（純変換器を保つ・トレースは副作用チャネル）。
  - run 層（`translatePaper`）が runId を採番し、`LlmCallEvent` に runId を stamp して `<outDir>/.run/llm-trace.jsonl` へ 1 行 1 レコードで追記する（runtime 生成物＝gitignore）。
  - **メタのみ**（本文・訳文は記録しない）。プライバシー安全・容量小。
- **Langfuse は入れない**（クラウドもセルフホストも今は不採用）。短命 CLI に常駐サーバは過大、外部送信はプライバシー懸念。
- **door を残す**: `LlmCallRecord` の schema を安定させ、将来ダッシュボードが要る時だけ `LANGFUSE_*` env がある場合に同レコードを **self-host Langfuse** へ push する薄い exporter を Phase 2 として足せるようにする（外部送信のオプトイン契約は別 ADR）。

# Consequences
- 良い面: 常駐物ゼロ・オフライン・決定的で「終了コードで終わる」設計を壊さない。全 LLM 呼び出しのコスト内訳を毎 run 蓄積し、後から無駄（不要 call・再訳過多・キャッシュ再生成）を解析できる。`complete` の純変換器契約は不変。
- トレードオフ:
  - ダッシュボード UI は無い（JSONL を `jq`/`duckdb`/小スクリプトで解析）。UI が要れば Phase 2。
  - メタのみのためプロンプト/応答の内容デバッグはトレース単体では不可（本文は `.run/` に別途ある）。
  - プロバイダ throw で終わった試行（CLI 非 JSON など）は usage が無く記録しない。schema 検証失敗による再試行は各試行が別レコードとして残る（＝その無駄は捕捉できる）。
  - `LlmRequest` の契約が広がり、契約付録 §8 を更新した。
