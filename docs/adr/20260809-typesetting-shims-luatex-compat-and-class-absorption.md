# 2026/08/09 組版の堅牢化: LuaTeX 互換 shim の注入と、共通テンプレによる原前文の吸収

# Status
- accepted

# Situation
- [組版レイアウト ADR](./20260710-typesetting-layout-original-first-hybrid.md) 決定1 で、既定は原プリアンブル温存、組めない論文は共通テンプレへフォールバックし、共通テンプレを「保証されたベースライン」と位置づけた。
- 初の実論文（arXiv 2203.06060 / elsarticle・36 セグメント）で通し実行したところ、翻訳は 36/36 通過したのに**両経路とも組版に失敗**し PDF が出なかった（exit 5）。ベースラインの保証が実際には成立していないことが判明した。

# Context
- 失敗は 2 つとも「原論文が前提にしている実行環境・class を、こちらが再現していない」ことに起因する。
  - 原モード: 原前文 2 行目の `\pdfoutput=1` が LuaTeX に存在せず fatal。`\pdfoutput` 系は pdfTeX 専用プリミティブで、arXiv 投稿では頻出（PDF 出力を強制する定型句）。
  - テンプレモード: 本文が elsarticle の `\begin{frontmatter}` / `keyword` / `\sep` を含むが、テンプレは素の `article` のため `Environment frontmatter undefined` で fatal。さらに原前文の `\usepackage{threeparttable}` や `\biboptions` も欠落する。
- テンプレが「原前文を捨てて最小限を組み直す」設計である限り、原論文が使うパッケージ・ユーザー定義マクロ・class 固有コマンドの**すべて**を取りこぼす。取りこぼしは論文ごとに違うため、都度対応ではベースラインの保証にならない。
- 方針の選択肢は 3 つあった。
  1. class ごとに専用テンプレを用意する（elsarticle 用・IEEEtran 用…）
  2. 共通テンプレを 1 つに保ち、class 固有マークアップを shim（`\providecommand` / 未定義時のみ `\newenvironment`）で吸収する
  3. 本文から class 固有マークアップを除去する
- (1) は class の数だけテンプレが増え、版が変わるたび追随が要る。(3) は原文の情報を落とす不可逆な加工で、暗黙劣化を禁じた [品質ゲート ADR](./20260708-quality-gate-machine-vs-llm-and-explicit-failure.md) の趣旨に反する。shim は LaTeX マクロを数十行足すだけで、実行時コスト・LLM コストはゼロ。
- pdfTeX プリミティブ側は「該当行を削る」か「`luatex85` で LuaTeX 上に別名を復元する」の 2 案があり、両方とも実測でビルドが通った。削る案は `\pdfpagewidth` 等まで巻き添えにするとページ寸法が変わり、原レイアウト忠実という既定の目的を損なう。

# Material for decision
- [組版レイアウト ADR](./20260710-typesetting-layout-original-first-hybrid.md)（決定1 の「保証されたベースライン」、決定3 の実測による見直し余地）
- [2層化 ADR](./20260709-quality-gate-two-layer-and-build-error-triage.md) 決定4（ビルドエラー分類）
- [品質ゲート ADR](./20260708-quality-gate-machine-vs-llm-and-explicit-failure.md)（暗黙フォールバック禁止・劣化は surface）
- 契約付録 §7（(B) 組版レイヤのスコープ）
- 実測: arXiv 2203.06060 のキャッシュ済み訳文を使い、LLM を呼ばずに組版のみ再実行。`\pdfoutput=1` の除去でも `luatex85` 注入でも `layout=original` で 30 ページの PDF が生成されることを確認。テンプレ側は shim ＋原前文吸収で `buildOk=true` を確認。
- ユーザー要望: 「レイアウトに大差ないなら全ライブラリを共通テンプレに吸収する、もしくは全 class のパターンを用意しておく」

# Decision

## 決定 1: pdfTeX 専用プリミティブは `luatex85` の注入で吸収する（該当行は削らない）
- 原プリアンブル温存モードでは、前文の先頭（`\documentclass` より前）に `\RequirePackage{luatex85}` を注入する。既に読み込まれている場合は二重に入れない。
- 該当行の削除案は採らない。`\pdfpagewidth` / `\pdfpageheight` の削除はページ寸法を変え、原レイアウト忠実という既定モードの目的を静かに損なうため。

## 決定 2: 共通テンプレは「原前文を吸収し `\documentclass` だけを差し替える」ものとする
- テンプレモードは、原前文から `\documentclass` 行（と `inputenc` / `fontenc`）だけを取り除き、**残りのパッケージ・ユーザー定義マクロはすべて引き継ぐ**。その上で `article` と JPaper の共有部品（luatexja・引用フォールバック）を与える。
- 「原前文を捨てて最小限を組み直す」旧方式は廃する。フォールバックの目的は class 由来のビルド不能の回避であり、パッケージやマクロまで失う理由はない。

## 決定 3: class 固有マークアップは class 別テンプレではなく shim で吸収する
- 共通テンプレに class 非依存の shim ブロックを置き、主要 class（elsarticle / IEEEtran / acmart / revtex / llncs）の固有コマンド・環境を `\providecommand` と「未定義時のみ定義する」環境ヘルパで補う。
- class ごとの専用テンプレは作らない（選択肢1 を棄却）。テンプレ本体は 1 つに保ち、増えるのは shim の行だけにする。
- shim は原前文より**前**に置く。原前文中の class 固有コマンド呼び出し（`\journal{...}` `\biboptions{...}` など）が定義済みになる順序が必要なため。
- 本文から class 固有マークアップを除去する加工は行わない（選択肢3 を棄却）。

# Consequences
- 良い面
  - 2203.06060 が `layout=original` で PDF 化できるようになった。フォールバック側も `buildOk=true` で、ベースラインの保証が初めて実体を持つ。
  - 原前文吸収により、論文固有パッケージ（`threeparttable` 等）とユーザー定義マクロがフォールバック時も生き残る。取りこぼしが論文ごとに再発しない。
  - shim は LaTeX マクロのみで、実行時コスト・LLM コストはゼロ。未知の class に遭遇しても、増えるのは shim の数行で済む。
  - [組版レイアウト ADR](./20260710-typesetting-layout-original-first-hybrid.md) 決定1 の「原プリアンブル温存を既定」は維持する。本 ADR は既定を変更せず、両経路の成功率を上げるだけなので、同 ADR は `accepted` のまま。
- トレードオフ
  - 原前文を吸収する分、テンプレモードは原前文のバグをそのまま引き受ける。class 起因でない失敗はフォールバックでも直らない（従来は前文を捨てることで偶然回避できた可能性がある）。
  - shim は近似である。`\sep` を `; ` に、`keyword` 環境を太字見出しの段落に落とすなど、原 class の体裁とは異なる。テンプレモードは元々 best-effort であり、`RunSummary.layout=template` で surface される範囲に留める。
  - `luatex85` は TeX Live 標準に含まれる前提を置く。欠けている配布では原モードが読み込みに失敗する。
  - shim が定義するコマンド名（`\keywords` `\email` `\affiliation` 等）を後続パッケージが `\newcommand` で定義すると衝突し得る。`\providecommand` の性質上、先に定義された shim が残り、パッケージ側がエラーを出す可能性が残る。
