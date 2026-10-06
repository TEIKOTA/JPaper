---
name: translation-pitfalls
description: Use when the evaluator agent reviews a Japanese translation of an academic paper, to catch known high-frequency mistranslations — statistical terms, SI unit-notation rules, and discipline-dependent false friends — that fluency checks alone miss.
---

# Translation Pitfalls（evaluator 向けチェックリスト）

学術和訳で頻出する既知の誤訳を、evaluator が**レビュー観点**として使うためのチェックリスト。[翻訳一貫性 ADR](../../../docs/adr/20260710-translation-consistency-brief-style-and-annotations.md) 決定5 の正本。

- **適用先は evaluator のみ**。translator / glossary-builder には注入しない（生成側を汚さず検出に集中）。
- **global 用語 DB には seed しない**（[契約付録](../../../docs/design/contract-appendix.md) §2「v1 は空で開始」を維持）。これは「事実の種」ではなく「レビュー観点」。
- 段階開示: 該当が疑われるときだけ本文を参照する。列挙は網羅ではなく代表例で、随時追記する。

## 1. 統計語（意味の取り違い）

- `significantly` は程度副詞ではなく**統計的有意**（`有意に`）。p 値・信頼区間・検定名が近くにあれば「大幅に」等の程度訳は誤り。
- `significant` / `non-significant`、`correlation`（相関 ≠ 因果）、`power`（検出力）、`sample`（標本）、`bias`（偏り/バイアス）を日常語に流さない。

## 2. SI 単位・記法（規則違反）

- 単位記号は**立体（upright）**。斜体にしない。
- `°K` は誤り → **`K`**（ケルビンに度記号は付けない）。
- 単位記号にピリオド・複数形 s を付けない（`kgs`・`sec.` は不可、`kg`・`s`）。
- 数値と単位の間に**半角スペース**（`293 K`、例外は `%`・`°`・`′`・`″` など規約準拠）。
- 変数は斜体、演算子・関数名（`sin`・`log`）は立体。SI 単位記号は言語非依存（和訳しない）。

## 3. 分野依存の false friend（直訳の罠）

- `agency`（社会科学）＝**行為主体性**であって「代理権」ではない。
- `mole fraction`＝**モル分率**（「分子比」ではない）。
- `argument`（数学）＝偏角/引数、`degenerate`＝縮退、`kernel`＝核/カーネル、`domain`＝定義域/領域、`normal`＝法線/正規 — いずれも文脈で確定し、日常語に落とさない。
- 論文が定義した語（`paper-defined`）は既定で preserve/併記（`値(Value)` 等）。安易な直訳は誤り。

## 使い方（evaluator）

1. 訳文を読み、上記カテゴリに触れる箇所を洗う。
2. 誤りは `EvalIssue{ severity: "error" }`、機微な懸念は `warn`（warn は訳注に流れる）。
3. 決定的に落とせる単位/略語/表記の整合は §7 (B) の言語整合 lint が別途機械検査する。ここは**意味の妥当性**を見る。
