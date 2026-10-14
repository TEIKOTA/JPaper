---
name: translation-pitfalls
description: Use when the evaluator agent reviews a Japanese translation of an academic paper, to catch known high-frequency mistranslations — statistical terms, SI unit-notation rules, and discipline-dependent false friends — that fluency checks alone miss.
---

# Translation Pitfalls（evaluator 向けチェックリスト）

学術論文の和訳でよく起きる既知の誤訳を、evaluator が**レビューの観点**として使うためのチェックリスト。[翻訳一貫性 ADR](../../../docs/adr/20260710-translation-consistency-brief-style-and-annotations.md) 決定5 の正本。

- **使うのは evaluator だけ**。translator / glossary-builder には注入しない（訳を作る側に影響させず、誤りの検出に集中する）。
- **global 用語 DB には seed しない**（[契約付録](../../../docs/design/contract-appendix.md) §2「v1 は空で開始」を維持）。この一覧は用語の事実として登録する種ではなく、レビューの観点である。
- 段階的に読む: 該当が疑われるときだけ本文を参照する。列挙は網羅ではなく代表例で、随時追記する。

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
- `argument`（数学）＝偏角/引数、`degenerate`＝縮退、`kernel`＝核/カーネル、`domain`＝定義域/領域、`normal`＝法線/正規。いずれも文脈で訳を決め、日常語の訳にしない。
- 論文が定義した語（`paper-defined`）は、既定で原語のまま残すか併記する（`値(Value)` など）。安易な直訳は誤り。

## 使い方（evaluator）

1. 訳文を読み、上のカテゴリに当たる箇所を探す。
2. 誤りは `EvalIssue{ severity: "error" }`、機微な懸念は `warn`（warn は訳注に流れる）。
3. 単位・略語・表記の整合のうち決定的に判定できるものは、§7 (B) の言語整合 lint が別に機械で検査する。ここでは**意味の妥当性**を見る。
