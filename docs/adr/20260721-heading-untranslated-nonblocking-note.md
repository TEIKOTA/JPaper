# 2026/07/21 見出し未訳検査は非ブロッキングの訳注に留める（第4の trigger を追加）

# Status
- accepted
- [翻訳一貫性 ADR](./20260710-translation-consistency-brief-style-and-annotations.md) 決定3（訳注 trigger は3種）を拡張する（旧 ADR 本文は不変・trigger を4種に増やす判断のみ本 ADR で記録）。

# Situation
- クラウド LLM（Opus/Sonnet）は本文の訳し漏れはほぼ無いが、`\section{...}` 等の見出しは英語のまま残す挙動が観測された（実験 J-latex）。読者向け PDF で目立つ欠陥になる。
- 見出し訳は JPaper の「見せられる品質」を支える差別化要素であり、決定的に捕捉したい。

# Context
- 当初、未訳見出しを形式検査（`formalCheck`）＝**再訳をブロックするゲート**に載せた。だが「見出しの可視テキストが日本語ゼロか」を任意 LaTeX から決定的に判定するのは不可能に近い（`$p$`・`\textsc`・`\ref` 引数・`\url`・`\includegraphics` のオプション引数・中黒・全大文字略語など、偽陽性の源が青天井）。
- codex レビュー3周でその都度新しい偽陽性クラスが見つかり、**偽陽性1件でも再訳が MAX 回数に達し exit3（論文全体が失敗）になり得る**という設計欠陥が確定した。ブロッキングゲートは「決定的に真」と言い切れる検査にしか使えない。

# Material for decision
- 実験 15run（`report.md`）: JPaper は 3/3 で 16–17 頁の実訳 PDF を生成。見出し未訳は品質上の残課題として観測。
- codex レビュー（PR #36）: 見出し検査を formalCheck に載せる限り偽陽性面を閉じられないとの指摘。
- 既存の訳注アーキテクチャ（[翻訳一貫性 ADR](./20260710-translation-consistency-brief-style-and-annotations.md) 決定3）: 採否=trigger は決定的、文面=LLM、非決定的な文面はテスト対象外。

# Decision
- 見出し未訳検査を `untranslatedHeadings`（`quality-gate.ts`）として切り出し、**再訳ゲートには載せない**。結果は第4の訳注 trigger `heading-untranslated` として PDF に surface するに留める（非ブロッキング）。
- 併せて翻訳者プロンプトに見出しの扱いを nudge（`\section` 等の引数は地の文として和訳・keep-original 語は原表記）。
- 本 trigger は決定3の「文面=LLM」の例外とし、**文面は決定的テンプレ**（`見出しが未訳の可能性: 「…」`）とする。採否・文面ともに決定的なのでテスト可能。
- 偽陽性は安全側に寄せる: 可視テキストで判定（数式・参照系・URL・パス・図の引数を除去）、keep-original 語は語境界で除去、全大文字略語（小文字 Latin 無し）は見逃す。任意 LaTeX への完全対応は諦め、残余の偽陽性は「無害な訳注1件」に留める。

# Consequences
- 良い面: 見出し訳し忘れが決定的に可視化され、かつ偽陽性で論文全体を落とさない。差別化要素を安全に強化できる。formalCheck は「決定的に真の構造検査」だけを持つ原則が保たれる。
- トレードオフ:
  - 全大文字の実語見出し（`INTRODUCTION` 等）は意図的に見逃す（略語の偽陽性回避との引き換え）。既知制約として `landmines.md` に登録。
  - 残余の偽陽性は読者向け巻末「訳注一覧」に載り得る（診断専用チャネルは持たない）。非ブロッキングなので害は「余分な訳注1件」に限定。
  - 訳注 trigger が3→4に増え、契約付録・`RunSummary.byTrigger` を更新した。
