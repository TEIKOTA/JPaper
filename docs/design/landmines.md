# 地雷登録簿（意図的な非自明箇所）

> 「一見おかしいが意図的」なコードの唯一の正本。コードが不自然に見えても、**直す前にここを確認する**。該当があれば意図的なので、そのまま維持する。
>
> 方針は [ソースコメント ADR](../adr/20260710-source-comments-facts-only-rationale-to-docs.md)。該当箇所にはソース側に中身ゼロの標識 `⚠ landmines.md` だけを置き、理由はここに書く。

## 記入ルール

- 1 エントリ 1 箇所。**行番号でなくシンボル名（path＋関数/定数名）で anchor** する（行移動で腐らせない）。
- 各エントリに書く: 「何がおかしく見えるか」「なぜ意図的か」「関連する正本ポインタ」。
- 該当コードを消す／意図が失効したら、このエントリも消す。

---

## `scripts/check-commit-msg.sh` — 日本語判定の `LC_ALL=C grep '[^ -~]'`

- **おかしく見える点**: 日本語を判定するのに、ひらがな/カタカナ等の文字クラス（`[ぁ-ん]` 等）ではなく「ASCII 印字可能文字 `0x20-0x7E` 以外のバイト」を見ている。一見すると日本語専用の判定に見えない。
- **なぜ意図的か**: 文字クラスの範囲指定は一部 locale で `Invalid collation character` になり、CI で誤判定して commit/PR タイトル検査を壊す。`LC_ALL=C` のバイト単位で非 ASCII の有無を見ることで、「英語のみの件名を拒否する」意図を保ちつつ macOS(BSD)/Linux/CI の移植性を確保している。素直に文字クラスへ戻すと CI が再び落ちる。
- **正本ポインタ**: [日本語 Conventional Commits ADR](../adr/20260706-adopt-commit-and-pr-message-convention.md)。self-test は `tests/run-tests.sh`。

## `src/terminology/db.ts` — `process.getBuiltinModule("node:sqlite")` で読み込む

- **おかしく見える点**: 他の組み込みは `import { X } from "node:..."` なのに、ここだけ `process.getBuiltinModule("node:sqlite")` で取得している。素直に `import { DatabaseSync } from "node:sqlite"` に直したくなる。
- **なぜ意図的か**: vitest/vite は新しい組み込み `node:sqlite` を内蔵リストに持たず、`node:` 接頭辞を剥がして `sqlite` を解決しようとして `Failed to load url sqlite` で落ちる（`test.server.deps.external` でも解決前に失敗）。`process.getBuiltinModule` はバンドラを迂回して Node の組み込みを直接得るため、prod・test の双方で安定する。型は `import type` と `typeof import("node:sqlite")`（いずれも erase される）で保つ。素直な import に戻すと `npm test` が db 系で全滅する。
- **正本ポインタ**: 契約付録 §2（node:sqlite・engines>=22.5）。`process.getBuiltinModule` は Node 22.3+。

## `src/workflows/quality-gate.ts` — `untranslatedHeadings` は全大文字語を見逃し・偽陽性は訳注に留める

- **おかしく見える点**: 未訳見出しの判定が `/[a-z]/`（小文字 Latin の有無）なので、`\section{INTRODUCTION}` や `\section{RELATED WORK}` のような全大文字の実語見出しを未訳として検出しない。素直に「Latin 文字があれば未訳」に広げたくなる。また可視テキスト抽出（`visibleText`）は既知コマンドの引数しか除去せず、未知コマンドの不可視引数は残す。
- **なぜ意図的か**: 全大文字を拾うと `BLEU`/`GPU`/`WMT` 等の略語が軒並み偽陽性になる。学術見出しは略語が多く、略語の偽陽性回避を優先して「全大文字の実語見出しは意図的に見逃す」を選んだ（偽陰性 < 偽陽性の害）。可視テキスト抽出も、任意 LaTeX から不可視テキストを決定的に判別しきるのは不可能なため完全網羅は狙わない。本検査は**非ブロッキング**（結果は `heading-untranslated` 訳注に流すだけで再訳ゲートには載せない）なので、残余の偽陽性は「無害な訳注1件」に、偽陰性は「見逃し」に留まり、いずれも論文全体を失敗させない。
- **正本ポインタ**: [見出し未訳検査 ADR](../adr/20260721-heading-untranslated-nonblocking-note.md)、契約付録 §1（`NoteTrigger`）・§8（訳注生成契約 ④）。

## `src/runtime/trace.ts` — `makeJsonlTrace` の空 catch（I/O エラーを握り潰す）

- **おかしく見える点**: append/mkdir を囲む `catch {}` が空でエラーを完全に無視する。ログも再送も無く、素直に「握り潰しはバグ」と直したくなる。
- **なぜ意図的か**: これはコスト観測用の**副作用チャネル**であり、翻訳本体の成否とは独立。トレース書き込みが失敗（書込不可 CWD・パス衝突・容量不足）しても run の主成果物（PDF）を落としてはならない。throw を伝播させると `complete` の純変換器契約を壊し、観測の都合で翻訳が失敗するという本末転倒になる。ゆえにベストエフォートで黙って捨てる。mkdir を初回 emit まで遅延するのも、構築時 throw が `translatePaper` の try/catch を素通りして終了コードを誤分類するのを防ぐため。
- **正本ポインタ**: [LLM トレース ADR](../adr/20260722-llm-call-trace-local-jsonl.md)、契約付録 §8（トレースは副作用チャネル・`complete` 契約は不変）。

## `src/workflows/translate-paper.ts` — `translateTitle` の catch が中断以外の例外を握り潰す

- **おかしく見える点**: タイトルの節ループが投げた例外（プロバイダ障害・呼び出し上限など）を、`signal` が中断済みのとき以外は警告だけ出して捨て、run を続ける。本文セグメントの例外は run を落とすのに、ここだけ扱いが違う。
- **なぜ意図的か**: タイトルだけの失敗は原題のまま組版して run を落とさない契約（タイトルは成果物の一部ではあるが、訳せなくても論文本体の和訳は成立する）。プロバイダ障害が本物なら同じ例外が本文セグメントから出て run は従来どおり落ちるので、ここで捨てても失敗は隠れない。中断だけは run 全体の取り消しなので rethrow する（捨てると `exitCode 6` にならず組版まで進む）。素直に rethrow すると、タイトル 1 行の失敗で論文全体が exit 2 になる。
- **正本ポインタ**: 契約付録 §8（論文タイトルの翻訳「失敗の扱い」）、issue #294。

## `src/tools/bilingual-latex.ts` — `balanceParagraphs` が空行で割った段落をつなぎ直す

- **おかしく見える点**: 段落は空行で割れば済むように見えるのに、割ったあとで `\begin{` と `\end{` の数、およびエスケープしていない `{` と `}` の数（どちらも `%` コメントを除く）が揃うまで隣の段落とつなぎ直している。素直に空行の分割だけにしたくなる。
- **なぜ意図的か**: 表・図の環境の中に空行がある論文は普通にある。空行だけで割ると、`tabular` の途中で `\switchcolumn` が入って左右の列が切り替わり、組版エラーで落ちる（PoC で実測）。波括弧の中の空行（複数段落の `\footnote{..}`・`{\color{blue} ..}` など）で割ると、組版エラーにはならずに引数の途中で列が切り替わり、左右の中身が入れ替わった PDF が成功扱いで出る（実測）。つなぎ直しても、1810.11953 では原文と訳文の段落数が全セグメントで一致した。
- **正本ポインタ**: [対訳 PDF ADR](../adr/20261006-bilingual-side-by-side-pdf.md)（Material for decision「段落の切り方」）。

## `src/tools/bilingual-latex.ts` — `provideCommands` が訳文側の `\newcommand` を `\providecommand` に置き換える

- **おかしく見える点**: 訳文を改変しないはずの組み立てで、右（和訳）の列だけ `\newcommand` を `\providecommand` に書き換えている。
- **なぜ意図的か**: 本文中の `\newcommand` は左（原文）と右（和訳）の両方の列で実行されるので、そのままだと右で「定義済み」エラーになって落ちる（PoC で実測）。訳文は原文の定義をそのまま持ち越しているので、右では再定義を省いてよい。左は原文のまま残す。
- **正本ポインタ**: [対訳 PDF ADR](../adr/20261006-bilingual-side-by-side-pdf.md)（「マクロ定義の重複」）。

## `src/tools/bilingual-latex.ts` — `SETUP` が `figure` / `table`（`*` 付き含む）を非フロートの環境に差し替える

- **おかしく見える点**: 対訳の前文で、標準のフロート環境を `\def\@captype{...}` を設定しただけの `center` ブロックに `\renewenvironment` で置き換えている。位置指定（`[t]` 等）も捨てる。
- **なぜ意図的か**: paracol の中のフロートはページ全幅に出て、左右 2 枚が縦に積まれて使えない（PoC で実測）。`\@captype` を設定した非フロートにすると `\caption` が効いたまま左右の半分にそれぞれ置け、図表番号も左右で一致する（paracol はカウンタを列ごとに持つ）。
- **正本ポインタ**: [対訳 PDF ADR](../adr/20261006-bilingual-side-by-side-pdf.md)（「図・表」）。

## `src/tools/bilingual-latex.ts` — `PAPER`（geometry のオプション）に `onecolumn` を入れている

- **おかしく見える点**: 紙面の寸法を指定するだけの文字列に、段組みの指定 `onecolumn` が混ざっている。前文の `\geometry` と本文先頭の `\newgeometry` の両方に効く。外したくなる、あるいは本文先頭に `\onecolumn` を書けば済むように見える。
- **なぜ意図的か**: 原プリアンブルが二段組（`\documentclass[twocolumn]{article}`・IEEEtran conference 等）だと、paracol が `Environment paracol cannot work with ordinary two-column typesetting` で落ちる（実測）。本文先頭で `\onecolumn` を入れても、後の `\newgeometry` が二段組の設定に戻すので効かない（実測）。geometry 自身に一段組を指定すると組める（実測）。revtex の reprint のように出力ルーチンごと差し替えるクラスはこれでも組めないので、原プリアンブルで組めなければ共通テンプレで組み直す（`typesetBilingual`）。
- **正本ポインタ**: 契約付録 §8（対訳 PDF）。

## `src/tools/bilingual-latex.ts` — `BEGIN` のページ番号は星なしの `\AddToShipoutPictureFG`

- **おかしく見える点**: eso-pic の `\AddToShipoutPictureFG*`（星付き）に直したくなる、あるいは星の有無に意味が無いように見える。
- **なぜ意図的か**: 星付きは現在のページ（1 ページ目）にしか出ない。全ページに左右別のページ番号（原文 p.N／和訳 p.N）と中央の罫線を出すには星なしでなければならない。`\pagestyle{empty}` で通常のページ番号は消している。
- **正本ポインタ**: [対訳 PDF ADR](../adr/20261006-bilingual-side-by-side-pdf.md)（Decision「ページ番号」）。

## `src/tools/bilingual-latex.ts` — `renderPairs` が `\maketitle` を `\jpTitleBlock` の左右ペアに置き換える

- **おかしく見える点**: 原文と訳文の段落をそのまま並べる関数なのに、最初の `\maketitle`（コメント外・環境や波括弧の外）だけは消して、その位置にタイトルブロック（左=原文の前文と `\maketitle` までの本文にある最後の `\title`／右=和訳 main.tex の前文と本文の同じ範囲の `\title`）を差し込んでいる。`\maketitle` と同じ段落の前の部分（本文の `\title` / `\author`）は 1 行として残す。
- **なぜ意図的か**: 学会クラス（neurips 等）の `\maketitle` は全幅で、脚注（`\thanks`・学会表記）の挿入物が後続の paracol と衝突して空白ページが出る（PoC で実測）。タイトルと著者を左右の半分にそれぞれ置く仕様なので、`\thanks` を潰した著者とタイトルだけのブロックを各列に置く。タイトルは paracol の中に入れるので、本文先頭がタイトルでも空の paracol は作らない。本文に `\title` を書く論文（article・llncs・revtex で一般的）で前文だけを見ると左右とも空のタイトルになり、`\maketitle` が段落の先頭に単独で無いと左の列で `\maketitle` が実行される。article の `\maketitle` は実行後に `\title` / `\author` を `\relax` にするので、右の列ではタイトルが素の文字列で出る（いずれも実測）。前の部分を残すのは、`\author` が `\@author` を大域に定義してタイトルブロックがそれを使うため（`\title` / `\author` は何も出力しない）。frontmatter 環境（elsarticle）や環境の中の `\maketitle` は置き換えず、`titleUnplaced` で警告する。
- **正本ポインタ**: [対訳 PDF ADR](../adr/20261006-bilingual-side-by-side-pdf.md)（Decision「タイトルと著者」）。
