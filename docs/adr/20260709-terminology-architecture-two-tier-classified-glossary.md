# 2026/07/09 用語アーキテクチャ: 2層辞書・4クラス分類・表記方針・proposed 書き戻し

# Status
- accepted
- 2026-10-13 に部分 supersede: 置換された条項＝決定 4「ネット検索は defer（v1 では持たない）。入れるときも LLM にツールを持たせない」（→ 承認済みの訳が無い用語は、翻訳の前に CLI 自身の Web 検索で用例を確かめる）／存続する条項＝2 層辞書・4 クラス分類・表記方針・proposed 書き戻し・事前注入／後継 ADR＝[20261013-verify-unconfirmed-terms-with-cli-web-search](./20261013-verify-unconfirmed-terms-with-cli-web-search.md)

# Situation
- JPaper は学術論文の和訳エージェント。[翻訳パイプライン ADR](./20260708-translation-pipeline-ingestion-and-figures.md) で「横断 用語 DB（confirmed/proposed・`node:sqlite`・新出語は proposed 自動追記）を最優先機能・実装の第一歩」と決めていた。その用語 DB を実装する前に、データモデルと処理フローを確定する必要が生じた。
- 追加の要求: ①1 語に複数訳を許し、分野・文脈で訳し分けたい（attention→アテンション/注意）。②description で追加情報を持ちたい。③**論文内で定義・造語された語**（例: "Attention is All You Need" の Query/Key/Value）を安易に訳したくない（value→値 は不適切）。初出・定義語は原文保持や併記で原文互換を保ちたい。

# Context
- [プロバイダ ADR](./20260709-llm-provider-abstraction-local-ollama-and-cloud-cli.md) の帰結（cloud=公式 CLI subprocess）により、翻訳時に LLM へツールを持たせる制御は難しい。用語は **retrieval-then-inject（事前注入）** が local/cloud 両対応で素直。エージェントを「入力→zod 出力」の純変換器に保てる。
- 一律翻訳は危険。**訳す語（既存定訳あり）と、訳してはいけない語（論文が定義した語・固有名）を分ける**必要がある。分類と表記方針はどこに定義が現れるか分からないため、**全文を1回見て決めてロック**すべき（節ごとの translator に委ねると訳語が揺れる）。
- 1 論文内では訳語を統一したい（within-paper 一貫性）が、論文をまたぐと訳し分けたい（cross-paper 多義）。この2要求は1つのテーブルでは両立しないため層を分ける。

# Material for decision
- [翻訳パイプライン ADR](./20260708-translation-pipeline-ingestion-and-figures.md)（用語 DB を最優先・confirmed/proposed・proposed 自動追記）
- [品質ゲート ADR](./20260708-quality-gate-machine-vs-llm-and-explicit-failure.md)（機械化=事実の有無 / 品質・選択=LLM）
- [プロバイダ ADR](./20260709-llm-provider-abstraction-local-ollama-and-cloud-cli.md)（cloud=subprocess → 事前注入が有利）
- 現行 `資料/` の論文ごと `translation_glossary.md`（per-paper 確定辞書の実運用先行例）

# Decision

## 決定 1: 辞書は2層
- **global 用語 DB**（cross-paper・`node:sqlite`）: 候補の蓄積。**`src` に UNIQUE を張らず 1 語=複数行を許す**（複数訳・分野別）。
- **per-paper 確定辞書**（resolved glossary）: その論文用に **1 語=1 確定・ロック**。translator の一貫性の源（`資料/` の `translation_glossary.md` に相当）。

## 決定 2: 用語を4クラスに分類し、クラスごとに表記方針を決める
- クラス: `established`（既存定訳あり）/ `paper-defined`（論文が定義・造語）/ `proper-noun`（Transformer, BERT 等の固有名・手法名）/ `do-not-translate`（記号・API 名）。
- 表記方針(rendering): `translate`（日本語）/ `bilingual`（`値(Value)`・初出のみ `日本語(English)`）/ `keep-original`（原文保持）。
- 既定の安全側: **`paper-defined` は安易に訳さず preserve か併記**。分類が曖昧なときは **preserve に倒す**（誤訳より原文保持が安全）。

## 決定 3: 処理は4ステップ（収集=決定的 / 確定=LLM 全文1回 / 翻訳=LLM 節ごと / 書き戻し=決定的）
1. **収集[決定的]**: 全語スキャンで global 辞典ヒット（established 候補）＋定義パターン検出（"we call/define/denote", `\newcommand`, 強調初出＝paper-defined 候補）＋固有名/記法。辞典を専門語に限定することで一般語を自然に除外し、複合語は最長一致で拾う。
2. **確定[glossary-builder=LLM・全文を1回]**: 各 term を `{class, rendering, 1つの訳/表記}` に確定してロック → per-paper 確定辞書。入力に global 候補＋description を retrieval して渡す。paper-defined の preserve/併記はここで決める。
3. **翻訳[translator=LLM・節ごと]**: per-paper 確定辞書を**事前注入**。established=ソフト（文脈で逸脱可）/ paper-defined・keep-original=厳守（一貫性）。本文のみ訳す。
4. **書き戻し[決定的]**: 新出・確定語を global へ `status=proposed`＋`source`＋`class`＋`description` で追記（dedup）。人間が `confirmed` に昇格。ソフト逸脱をそのまま confirmed に入れない。

## 決定 4: ネット検索は defer（v1 では持たない）
- 「established か新語か曖昧」な語の補助として有効だが、v1 では実装しない。将来入れるときも **LLM にツールを持たせず、ワークフローが決定的に検索して候補を注入**する（事前注入と整合）。v1 の既定は「曖昧なら preserve」。

## スキーマ（実装指針・詳細は実装時に確定）
```
global:    term     { src, ja?, class, rendering, domain?, description?, aliases[], status(confirmed|proposed), source }
per-paper: resolved { src, form(確定訳/表記), class, rendering }   ← ロック
```

# Consequences
- 良い面
  - 「訳す語 / 訳さない語」を class で分離し、`paper-defined`（Query/Key/Value 等）の誤訳を構造的に防ぐ。原文互換は `bilingual`（`値(Value)`）で担保。
  - per-paper 確定辞書で within-paper 一貫性、global 複数行で cross-paper 訳し分けを同時に満たす。
  - 分類・表記・訳語選択という品質判断を glossary-builder（LLM）が全文1回で確定・ロックするため、節ごとの揺れが出ない（[品質ゲート ADR](./20260708-quality-gate-machine-vs-llm-and-explicit-failure.md) の「品質=LLM・1回決めてロック」と整合）。
  - 事前注入によりエージェントはツール無しの純変換器に保て、local(Ollama)/cloud(subprocess) 両対応で同一インターフェース。
  - 「Value が全文で `値(Value)` に統一されているか」は rendering 適用＝事実の有無として決定的にテスト可能。
- トレードオフ
  - 定義パターン検出（"we define" 等・`\newcommand`）はヒューリスティックで漏れ・誤検出があり、glossary-builder の全文パスで補正する前提。
  - 収集の全語スキャン品質は global 辞典の衛生（一般語を入れない）に依存する。
  - per-paper と global の2層を同期する実装コスト（書き戻し・dedup・昇格フロー）。
  - ネット検索を defer するため、真に新しい定訳未確立語は preserve に倒れがち（意図した安全側の挙動だが、後で net search で改善余地）。
- 本 ADR は [翻訳パイプライン ADR](./20260708-translation-pipeline-ingestion-and-figures.md) の「横断用語 DB / proposed 自動追記」を具体化・拡張する（旧 ADR の本文は改変しない）。
