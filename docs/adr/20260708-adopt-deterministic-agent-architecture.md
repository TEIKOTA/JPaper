# 2026/07/08 エージェント基盤: 素の TS ワークフロー＋薄い自作ランタイム（Flue 設計準拠・YAML 不採用）

# Status
- accepted

# Situation
- JPaper は学術論文の和訳に最適化したエージェントを構築するプロジェクトである。
- 翻訳は「訳出」と「品質判定（訳語・体裁・専門用語の一貫性）」の反復を伴い、同じ入力に対して再現性のある配線と終了判定が求められる。
- 一方で、訳文の良し悪しや「行き詰まり（stuck）」の判断は自然言語の理解を要し、コードの固定閾値では誤判定が出やすい。
- 開発者はソロで TypeScript を書ける。方針として「不要な層を足さず、単体で理解できる最小構成」を強く志向している。

# Context
- 設計思想は **agent-native 原則**（Flue が明示する「配線はコード・判断は LLM」の分離）を土台にする。すなわち「順序・並列・上限・終了判定などの**配線はコードで固定**し、訳出・品質評価などの**内容判断は LLM に委ねる**」。
- 配線の**表現手段**として、汎用エージェント基盤にありがちな「Supervisor + YAML プラン + 状態機械」方式を採るか、素の TypeScript でワークフローを書くかを検討した。
  - YAML は「dispatch/parallel/repeat/if」だけの弱いミニ言語で、それを解釈する状態機械を別途要する。本来コードなら言語機能でタダで持てる determinism（順序・分岐・上限）を、YAML に後付けの拡張で取り戻し続けることになる。
  - YAML 方式を残す一般的な最大の根拠は「YAML の運用資産が既にある／非プログラマがプランを書く」ことだが、**新規の JPaper には当てはまらない**。プランは当面 1 本、作者は TS が書ける単独開発者である。
- 参考に Flue（Astro チーム, github.com/withastro/flue, Apache-2.0, 1.0 Beta）を調査した。Flue は「自律する Agent」と「手順を固定する Workflow（素の TS 関数）」を一級プリミティブとして分離し、"LLM にルーティング判断をさせるべきでない場面がある" と明言している。ワークフローは `defineWorkflow({ run })`、サブエージェント委譲は `session.task(text, { agent, result: schema })` で構造化出力を検証して返す。durable execution・観測・複数デプロイ先を標準搭載。これは JPaper が選んだ方向（素の TS でワークフロー）の製品化版に相当する。

# Material for decision
- **agent-native 原則**（配線=コード/判断=LLM）を思想の由来として参照。決定的な専門エージェント＝入力契約・出力契約・成功条件を明文化し、同じ入力に同じ配線・同じ終了判定で動くワークフロー内ロール。
- Flue 調査: [flueframework.com](https://flueframework.com/) / [github.com/withastro/flue](https://github.com/withastro/flue)（1.0 Beta, Apache-2.0, 約 7.2k stars, `@flue/runtime`）。Agent/Workflow 分離、`session.task(text,{agent,result})`、Durable Execution（task 境界で checkpoint／task 間の任意コードは非 checkpoint）、OpenRouter 対応（`openrouter/...` model id）。

# Decision
- **配線 = 素の TypeScript ワークフロー**。`src/workflows/*.ts` に普通の async 関数として書く。ループ=`for`、並列=`Promise.all`、分岐=`if`、契約検査=zod の `parse()`。YAML プラン・状態機械・独自 DSL は**採用しない**。
- **ランタイム = 薄い自作**。Flue の設計（Agent/Workflow 分離、`run(agentId, input, Schema)` で zod 検証済み結果を返す `session.task` 相当）だけを借り、`src/runtime/` に最小限で自作する。全 machinery が見え、完全に所有する。
- **Flue 本体は現時点では採用しない**が、API の「形」を Flue に寄せておく。将来 durable execution・観測（OTel）・複数環境デプロイが本当に必要になったら Flue への移行を低コストにするため。Flue は 1.0 Beta で API 変動があり、独立実装のまま追随義務を負わない。
- **決定性の線引き**: 実行順序・並列・ループ上限・分岐・契約検査（存在・スキーマ適合）はコードが固定。訳語選定・訳出・evaluator の品質判定・stuck 解釈・介入要否は LLM。品質・stuck をコードで固定しない（固定閾値は品質の誤判定を招くため）。
- **durable/resume**: v1 は「出力ファイルが既に存在し検査を通る run は飛ばす」冪等スキップで代替する。自動 checkpoint は持たない（必要時に Flue 移行で獲得）。論文 1 本の翻訳は短時間で終わるため、自動 resume の価値は当面小さい。
- **実装スタック**: TypeScript / Node、スキーマ検証は zod、テストは vitest。LLM プロバイダは OpenRouter を前提（Flue も対応）。※後続の[プロバイダ ADR](./20260709-llm-provider-abstraction-local-ollama-and-cloud-cli.md)で `LlmClient` 境界によるプロバイダ非依存へ一般化した。

# Consequences
- 良い面
  - 配線が全て言語機能（`for`/`Promise.all`/`if`/`parse`）になり、型安全・デバッグ可能・IDE 補完が効く。YAML の `${alias}` 文字列のような型なし表現が消える。
  - ワークフローが**単体で読める**（1 ファイルの async 関数）。開発者の「理解できる最小構成」志向に合致。
  - 依存が薄く完全所有。機械判定はコードでタダ。
- トレードオフ
  - 自動 durable/resume・観測・複数環境デプロイは持たない（v1 は冪等スキップで代替、必要時に Flue へ移行）。
  - 薄いとはいえ、LLM 呼び出し・リトライ・エラー処理・トレース出力は自作する必要がある。
  - Flue は 1.0 Beta。移行先として形を寄せるが、Flue の破壊的変更には自動追随しない。
- 参考資料（Flue）は静的調査に基づく。記載の API・model id は実装時に再確認する。
- 本 ADR は同日付の初版（Supervisor + YAML を土台とする案）を、未コミットのまま上記の決定に差し替えたものである。以降この方針変更は新 ADR で行う。
