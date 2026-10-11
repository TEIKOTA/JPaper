# 2026/10/11 前付け（タイトル・組む位置・原文のまま残す命令）を論文テンプレートの型の表で決める

# Status
- accepted

# Situation
- 論文の前付けの命令を、コードが `\title`・`\maketitle`・`\begin{frontmatter}`・`\author` の決め打ちで扱っていた。テンプレートが外れるたびに後追いで直していた（#330 の ICML `\icmltitle`、#331 の `\author`）。
- 約 35 のテンプレートと手元の論文 19 本を調べると、1 つの規則では扱えない違いがある（#337。調査表は [`docs/design/frontmatter-commands.md`](../design/frontmatter-commands.md)）。

# Context
- タイトルをその場で組む型がある。ICML の `\icmltitle` と AISTATS の `\aistatstitle` は `\twocolumn[…]` の中で、iopart は `\title` 自体で組む（iopart の `\maketitle` は改ページにすぎない）。MDPI は `\Title` を使い、ソースに `\maketitle` が無い。
- elsarticle の `\title` は後勝ちでなく連結される。AAAI のテンプレートは `\iffalse` の中にダミーの `\title` を残す。
- 著者を `\author` 以外で書く型がある（`\icmlauthor`・`icmlauthorlist`・`\affil`・`\institute`・`\affiliation`・`\IEEEauthorblockN` など）。`\author` だけを伏せると、所属や注記が訳される。
- 同じ名前で意味が違う命令がある。`\affiliations` は AAAI では 1 引数の命令、IJCAI では `\author` の中の切り替え。`\email` は jmlr2e・tmlr では引数を取らない切り替え。
- 利用者の決め（2026-10-08）: 著者・所属は原文のまま。キーワードと PNAS の significance statement は訳す。`\thanks`・`\fntext` などの注記は原文のまま。

# Material for decision
- [著者・所属を原文のまま残す ADR](./20261008-keep-author-block-untranslated.md): `\author` を keep と同じく 1 つの印で伏せ、伏せた区間の用語は節の用語に数えない。会議テンプレート固有の著者命令は扱っていなかった。
- 契約付録 §8（論文タイトルの翻訳・本文の `\title` の keep・対訳 PDF のタイトルブロック）。
- 案 A: 見つかるたびに決め打ちの命令名を足す。足した命令がほかの経路（対訳・用語の数え方）で漏れる。
- 案 B: 1 つの共通の表だけを持つ。同名異義と、組む位置の違い（即時・`\maketitle`・`\end{frontmatter}`）を表せない。
- 案 C: 共通の表と、クラス・パッケージごとの差分（型）を 1 つのデータで持ち、型を `\documentclass`・`\usepackage` の名前と特徴的な命令から選ぶ。

# Decision
- **案 C を採る**。正本は `src/tools/frontmatter.ts`（`FrontMatterProfile`・`detectProfile`・`keptSpans`）。
- 型は、タイトルの命令・その場で組む命令・`\maketitle` が組む位置か・`\title` を連結するか・原文のまま残す命令（必須引数の数つき）と環境を持つ。
- 型は `\documentclass`・`\usepackage` の名前に加え、特徴的な命令（`\icmltitle`・`\aistatstitle`）でも選ぶ（会議のスタイルは改名した派生で同梱されることが多い）。どれにも当たらなければ今の挙動と同じ既定の型を使う。
- タイトルの検出（前文・本文）・組む位置・前文のタイトルの差し替え・原文のまま残す区間（節の `frozen`）・対訳 PDF のタイトルの取り出しは、同じ型を引く。
- 原文のまま残す区間は、分割の段階で節ごとに決めて節に持たせる（`Segment.frozen`）。形式検査・evaluator・用語の数え方は節が持つ区間を使う。
- 連結する型（elsarticle）で `\title` が 2 つ以上あれば、どれか 1 つを訳すと題が欠けるので、訳すタイトルは見つからない扱いにする。
- 走行タイトル（`\icmltitlerunning`・`\titlerunning` など）は別の綴りなので、タイトルの命令に入れなければ数えない。表に別の一覧は持たない。
- ICML・AISTATS の `\twocolumn[…]` を対訳 PDF のタイトルブロックにする組み替えは、この表の上で #330 として扱う。

# Consequences
- 良い面
  - 新しいテンプレートは表に 1 行足せば、タイトルの検出・保護・対訳が揃って追従する。
  - ICML の著者一覧・所属、elsarticle の所属と注記、llncs の `\institute` などが訳されなくなる。
- トレードオフ
  - 原文のまま残す命令が増えるので、該当する節は印が増える。伏せた区間にだけ出る用語がある論文では、その節と初出の節の slice が変わり、再実行で訳し直す。
  - 型の誤判定で、今は動いている論文のタイトル検出が変わりうる。既定の型は今の挙動と同じにし、型ごとの差分を最小にする。
  - 要旨を `\maketitle` より前に置く型（acmart・revtex・PNAS）の対訳ブロックでの並べ替えや、`\input` 先のタイトルの探索は扱わない。
