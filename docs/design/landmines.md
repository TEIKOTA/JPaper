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
- **なぜ意図的か**: vitest/vite は新しい組み込み `node:sqlite` を内蔵リストに持たず、`node:` 接頭辞を剥がして `sqlite` を解決しようとして `Failed to load url sqlite` で落ちる（`test.server.deps.external` でも解決前に失敗）。`process.getBuiltinModule` はバンドラを迂回して Node の組み込みを直接得るため、prod・test の双方で安定する。型は `import type` と `typeof import("node:sqlite")`（いずれも erase される）で保つ。素直な import に戻すと `pnpm test` が db 系で全滅する。
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

## `src/tools/bilingual-latex.ts` — `dropLabels` が訳文側の `\label` を消す

- **おかしく見える点**: 右（和訳）の列だけ `\label{…}` を消している。ラベルだけの行は行ごと消す。
- **なぜ意図的か**: 同じ `\label` が左右の両方の列で実行される。番号の無い `align*` の中の `\label` は amsmath が消費せずに持ち越すため、右の列で 2 回目が来ると `Multiple \label's: label '…' will be lost` の致命エラーになる（実測: PathoROB 2507.17845 の `eq:dann`）。左右の番号は paracol で一致するので、右の `\ref` は左のラベルで正しく解決する。`\label` だけを消すと行が空白だけになり、`align*` の中で段落区切りになって `Paragraph ended before \align* was complete` で落ちるので、行ごと消す。
- **正本ポインタ**: [対訳 PDF ADR](../adr/20261006-bilingual-side-by-side-pdf.md)（「マクロ定義の重複」。`\label` の二重定義）。

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
- **なぜ意図的か**: 学会クラス（neurips 等）の `\maketitle` は全幅で、脚注（`\thanks`・学会表記）の挿入物が後続の paracol と衝突して空白ページが出る（PoC で実測）。タイトルと著者を左右の半分にそれぞれ置く仕様なので、`\thanks` を潰した著者とタイトルだけのブロックを各列に置く。タイトルは paracol の中に入れるので、本文先頭がタイトルでも空の paracol は作らない。本文に `\title` を書く論文（article・llncs・revtex で一般的）で前文だけを見ると左右とも空のタイトルになり、`\maketitle` が段落の先頭に単独で無いと左の列で `\maketitle` が実行される。article の `\maketitle` は実行後に `\title` / `\author` を `\relax` にするので、右の列ではタイトルが素の文字列で出る（いずれも実測）。前の部分を残すのは、`\author` が `\@author` を大域に定義してタイトルブロックがそれを使うため（`\title` / `\author` は何も出力しない）。環境の中の `\maketitle` は置き換えず、`titleUnplaced` で警告する。frontmatter 環境（elsarticle）のペアは `\maketitle` を探さずにタイトルとして扱う（下の `replaceFrontmatter`）。
- **正本ポインタ**: [対訳 PDF ADR](../adr/20261006-bilingual-side-by-side-pdf.md)（Decision「タイトルと著者」）。

## `src/tools/bilingual-latex.ts` — `replaceFrontmatter` が elsarticle の `frontmatter` 環境を `jpFrontmatter` に差し替える

- **おかしく見える点**: 原文と訳文をそのまま並べる組み立てなのに、左右の `\begin{frontmatter}` / `\end{frontmatter}` だけを、前文（`SETUP`）で定義した `jpFrontmatter` に名前ごと置き換えている。`jpFrontmatter` は列の中で `\title` / `\author` を集めてタイトルブロックを組み、`\corref` / `\cortext` / `\fnref` / `\fntext` / `\tnoteref` / `\tnotetext` / `\ead` / `\affiliation` / `\address` を潰し、`abstract` / `keyword` / `highlights` / `graphicalabstract` をその場に組む。所属と責任著者・資金などの注は対訳 PDF に出ない。`abstract` / `keyword` の見出しは左が `Abstract` / `Keywords`、右が `概要` / `キーワード`。
- **なぜ意図的か**: elsarticle の `frontmatter` を paracol の左右でそのまま実行すると、`\author` が大域に積み増されて右の列の著者が左右 2 回分になり、題も左右が連結され、`abstract` は保存した箱を全幅で出すので折り目をまたぎ、1 ページ目が白紙になる（実測: 2410.16038）。frontmatter は空行を含んでも `balanceParagraphs` で 1 ペアにまとまるので、ペア単位で差し替えられる。所属・注を出さないのは `\jpTitleBlock` が `\thanks` を潰すのと同じ扱い（タイトルと著者だけを左右に置く）。
- **正本ポインタ**: 契約付録 §8（対訳 PDF）、[対訳 PDF ADR](../adr/20261006-bilingual-side-by-side-pdf.md)（Decision「タイトルと著者」）。

## `src/tools/bilingual-latex.ts` — `paracolBody` が `\begin{paracol}{2}` の直後で `\jpRobustNotes` を実行する

- **おかしく見える点**: paracol を開いた直後に `\MakeRobust\footnote`（`\footnotemark` / `\footnotetext` も）を入れている。和訳 PDF では不要な命令に見える。
- **なぜ意図的か**: paracol は `\begin{paracol}` の中で `\footnote` を頑丈でない自前の定義（`\@ifstar` で分岐）に差し替える。見出しの引数の中の脚注（訳注の初出脚注は `\subsection{…(Consistency Assessment Scenario)\footnote{訳注: …}}` のように見出しに入る）は目次・しおりへ書き出す途中で展開され、`Argument of \pcol@iadjustfnctr has an extra }` の致命エラーになる（実測: 2410.16038。paracol なしの和訳 PDF は同じ見出しで組める）。差し替えは `\begin{paracol}` の中で行われるので、前文やフックでは間に合わず、開いた直後に頑丈にする。
- **正本ポインタ**: 契約付録 §8（対訳 PDF）。

## `src/tools/bilingual-latex.ts` — `muteBibliography` が右の列の `\bibliography` / `\bibliographystyle` を `\jpNoAux` で包む

- **おかしく見える点**: 右（和訳）の列だけ `\bibliography{…}` / `\bibliographystyle{…}` を `\jpNoAux{…}`（`\@fileswfalse` の群）で包んでいる。左は原文のまま。
- **なぜ意図的か**: 両方の列で実行すると `.aux` に `\bibdata` / `\bibstyle` が 2 回書かれ、bibtex が `Illegal, another \bibdata command` で異常終了し、latexmk が再実行を止めるので引用・参照が全部未解決のまま残る（実測: 2410.16038 で未解決 72 件、build gate が失敗）。`.aux` へ書かないだけで、右の列でも `.bbl` を読んで参考文献一覧は出る。
- **正本ポインタ**: 契約付録 §8（対訳 PDF）。

## `src/tools/tex-spans.ts` — `commandSpans` は文書全体の波括弧の対応を 1 回で求め、任意引数は 1000 文字までしか読まない

- **おかしく見える点**: `\author{` の閉じを探すたびにその場から数えれば済みそうなのに、最初に文書全体の `{` と `}` の対応表をスタックで作って引いている。`[..]` は 1000 文字で読むのをやめる。
- **なぜ意図的か**: 出現ごとに末尾まで数えると、閉じない `\author{` の羅列で二次になる（実測: 256KB で 9.3 秒、640KB で 175 秒。節は空行の無い段落なら 8MiB まで膨らみ、LLM の前に同期で走る）。対応表なら 256KB でも 2ms。
- **正本ポインタ**: 契約付録 §3・§8、issue #331。回帰テストは `src/tools/tex-spans.test.ts`（走査コストは入力長に対して線形）。

## `src/providers/claude.ts` — `--max-turns` が 1 でなく 3

- **おかしく見える点**: `--tools none` で 1 回しか答えさせないはずなのに、`--max-turns` が `1` ではなく `3`。「1 回きり」なら 1 に締めたくなる。
- **なぜ意図的か**: claude CLI 2.1.291 は、用語集構築のような長い入力で内部的に 2 ターンを使う（実測: `num_turns: 2`）。`--max-turns 1` だと `subtype: error_max_turns`（「Reached maximum number of turns (1)」）で exit 1 になり、応答が正常でも run が `claude exited 1` で失敗する。`--tools none` でツールは使えないので、ターン上限は安全境界ではない（安全は `--tools none` が担う）。1 に戻すと該当呼び出しが全て落ちる。
- **正本ポインタ**: [LLM プロバイダ抽象化 ADR](../adr/20260709-llm-provider-abstraction-local-ollama-and-cloud-cli.md)。回帰テストは `src/providers/claude.test.ts`。

## `src/ingest/main-tex.ts` — `stripComments` がコメントだけの行を改行ごと消す

- **おかしく見える点**: `%` から行末を消すだけでなく、空白と `%` だけで始まる行は行そのもの（改行を含む）を消している。行番号が原文とずれる。
- **なぜ意図的か**: TeX では `%` が行末の改行まで食うので、コメントだけの行は何も生まない。`%` 以降だけ消して改行を残すと、空白だけの行＝段落区切りになり、`\author{…}` のような段落を許さない引数の中で `Paragraph ended before \author was complete` で組版が落ちる（実測: AAAI 2026 テンプレートの 2510.17897）。
- **正本ポインタ**: issue #303。

## `src/providers/claude.ts` — プロンプト本文を `-p` の引数でなく stdin で渡し、stdin のエラーを捨てる

- **おかしく見える点**: `claude -p` は位置引数でプロンプトを受け取れるのに、本文（`req.user`）を stdin へ書いている。さらに `child.stdin` の `error` を空のハンドラで捨てている。
- **なぜ意図的か**: 本文を引数で渡すと、論文によっては引数長の上限を超えて起動できない（実測: PATH 上の `claude` が cmux のシムで `cmux: argument too large (maximum 122880 bytes)` → exit 2、UNI 2308.15474 の用語集構築）。stdin なら上限は無い（80KB で確認）。stdin へ書く以上、子プロセスが本文を読まずに終了すると書き込みが `EPIPE` になり、`error` を聞いていないと未処理例外で JPaper のプロセスごと落ちる（実測: 読まずに `exit 3` する子へ 5MB を書くと Node が `write EPIPE` で終了）。失敗は `close` の終了コードで provider エラーとして返るので、stdin 側のエラーは捨ててよい。ハンドラを外すと、claude が起動直後に失敗しただけで run 全体がクラッシュする。
- **正本ポインタ**: 契約付録 §5（claude CLI の呼び出し）。回帰テストは `src/providers/claude.test.ts`（既定の run の節）。

## `src/providers/codex.ts` — codex を利用者の設定を読まずに一時ディレクトリで起動する

- **おかしく見える点**: 1 回答えさせるだけの呼び出しに `--ignore-user-config --ignore-rules --skip-git-repo-check` と十数個の `-c features.<名前>=false` を付け、環境変数 `CMUX_*` を落とし、呼び出しごとに一時ディレクトリを作って `-C` で移り、応答を標準出力ではなく `-o` のファイルから読んでいる。stdin に空の error ハンドラがある。
- **なぜ意図的か**: 既定の codex CLI は利用者の `~/.codex` の設定・指示書・hook と作業ディレクトリの AGENTS.md を毎回の文脈に載せる（実測: 1 文の翻訳で 11,458 トークン。設定を読まなければ 2,003 トークンで、訳文とモデルは同じ）。repo の外は git repo ではないので `--skip-git-repo-check` が要る。`-o` のファイルには最終メッセージだけが入り、標準出力の形式の変化に左右されない。`--sandbox read-only` だけではシェルなどのツールが残り、論文の本文に誘導されてホームディレクトリを読める（実測: `ls ~` を実行した）ので機能ごと切る。`--disable` ではなく `-c features.…=false` なのは、知らない名前でも起動が壊れないから。`CMUX_*` を残すと、cmux の端末から起動したとき codex のラッパーが hook と computer use の引数を差し込む。stdin の error ハンドラを外すと、codex が入力を読まずに終わったとき（引数エラー・認証エラー）に約 64KB を超えるプロンプトの書き込みが EPIPE の未処理例外になり、run 全体がクラッシュする（一時ディレクトリも残る）。
- **正本ポインタ**: [codex プロバイダ ADR](../adr/20261008-add-codex-provider-isolated-from-user-config.md)、契約付録 §5。回帰テストは `src/providers/codex.test.ts`。

## `src/providers/claude.ts` — claude を `--safe-mode` 付き・作業ディレクトリ `os.tmpdir()` で起動する

- **おかしく見える点**: 1 回答えさせるだけの呼び出しに `--safe-mode` を付け、作業ディレクトリを JPaper の実行場所でなく一時ディレクトリにしている。
- **なぜ意図的か**: 既定の claude CLI は、利用者の `~/.claude/CLAUDE.md`、作業ディレクトリのプロジェクト `CLAUDE.md`、SessionStart hook の出力、git status を毎回の文脈に載せる（実測: repo の中で約 15,400 入力トークン、「読み込んでいる指示」を尋ねるとそれらの見出しを答える）。訳文が repo の運用ルールや作業状況に引きずられ、呼び出しごとに約 13,000 トークンが無駄になる。`--safe-mode` で CLAUDE.md・hook などを止め、repo の外で起動して git status などを消す（実測: 約 2,100 トークン、「なし」）。`--bare` は OAuth を読まずサブスクリプション認証で使えないので採らない。
- **正本ポインタ**: issue #306、契約付録 §5。

## `src/terminology/term-coverage.ts` — 節に効く用語を、単語境界・複数形・最長一致で絞る

- **おかしく見える点**: 節の用語を `latex.includes(src)` で拾わず、(1) ラテン文字端の語は前後が英数字の位置を数えない（末尾の `s` / `es` だけは同じ語とみなす）、(2) 同じ扱いの語の複数形（`Deep Ensembles` に対する `Deep Ensemble`）は用語ごと外す、(3) 節での出現がすべてより長い用語の中に収まる語は外す。
- **なぜ意図的か**: 部分一致のままだと形式検査が満たせない要求を出す。(1) keep-original の `lymph` が `lymphocytes` の中でも数えられ、訳文に `lymph` が 2 回要る（実測: 1902.06543 seg-0010 が改稿 5/6 で失敗）。(2) 併記の `ディープアンサンブル(Deep Ensemble)` と `ディープアンサンブル(Deep Ensembles)` の両方を初出として要求する（実測: 2605.18329 seg-0000）。(3) `crc` と `crc-rumc` のように長い語の一部としてしか出ない語にも別の制約がかかる。
- **正本ポインタ**: 契約付録 §1（節に効く用語）、issue #315。回帰テストは `src/terminology/term-coverage.test.ts`。

## `src/segment/macro-only.ts` — マクロ定義だけの節を LLM へ送らない

- **おかしく見える点**: `\def` / `\newcommand` などの定義命令だけでできた節は、翻訳もせず原文のまま通す。
- **なぜ意図的か**: 訳す地の文が無い節を LLM に渡すと、そのまま返した出力が「未翻訳」として形式検査に落ちる（実測: 2011.03395 seg-0061、`\def` だけの節）。
- **正本ポインタ**: 契約付録 §1、issue #315。回帰テストは `src/segment/macro-only.test.ts`。

## `src/terminology/collect.ts` — `add` が大文字句の先頭の機能語を外し、参照語だけの句を捨てる

- **おかしく見える点**: 候補をそのまま渡さず、`The` / `While` / `In` などの文頭の語を外し、`Figure` / `Sec` などの参照語だけの句を捨てている。
- **なぜ意図的か**: 大文字始まりの連語パターンは文頭の語も拾う（`The PanNuke`、`While DCAN`、`In Figure`）。用語集の LLM がこれを keep-original に分類すると、形式検査が訳文にその句が原文どおり現れることを要求し、ほぼ全節が落ちる（実測: CellViT 2306.15350 を claude sonnet / effort medium で 27/29 節が keep-original で失敗、128 呼び出し）。
- **正本ポインタ**: issue #314。回帰テストは `src/terminology/collect.test.ts`。

## `src/segment/segmenter.ts` — 節の予算を 0.30×CW に加えて 8,000 トークンで頭打ちにする

- **おかしく見える点**: 契約付録 §4 の予算は文脈長から逆算するのに、claude（CW 20 万）でも 8,000 で止めている。
- **なぜ意図的か**: `\section` を使わない論文は全文が 1 節になり、訳文の生成が呼び出し期限 300 秒を超えて run ごと落ちる（実測: UNI 2308.15474、1 節 59,825 トークン）。完了した論文の最大節は 7,442 トークン・最長 180 秒なので、8,000 なら既存の分割は変わらない。
- **正本ポインタ**: [節の予算の上限 ADR](../adr/20261007-cap-segment-budget-by-output-time.md)、契約付録 §4。回帰テストは `src/segment/segmenter.test.ts`。

## `src/ingest/disabled-blocks.ts` — 無効ブロックの対応を、ブロックごとの読み飛ばしでなくスタックの 1 回の走査で決める

- **おかしく見える点**: `\iffalse` を見つけたら対応する `\fi` まで読み飛ばせば済みそうなのに、本文全体の条件分岐をスタックに積んで 1 回で対応づけ、閉じたブロックを後からまとめて置き換えている。走査も verbatim を空白で伏せた写しの上で行う。
- **なぜ意図的か**: ブロックごとに読み飛ばすと、閉じない `\iffalse` の羅列で候補ごとに末尾まで走り二次になる（実測: 64KiB で 4.5 秒、256KiB で 128 秒。8MiB では数十時間の同期停止）。verbatim を伏せないと、`\verb|\iffalse|` のような説明文を本物の条件分岐と読み、組版に出る本文を消す。
- **おかしく見える点（続き）**: 偽の枝の波括弧の釣り合いと `\end{document}` をまたぐかを、ブロックの区間を切り出して数え直さず、同じ走査の中で深さと `\end{document}` の数を持ち回って判定している。深さが開いた時点より浅くなったブロックは、開いた時点の深さで単調に積んだ別のスタックから降ろして印を付ける。
- **なぜ意図的か（続き）**: 区間ごとに数え直すと、外側のブロックが検査で落ちたとき内側の入れ子ブロックがすべて検査に回り、ブロックごとに長さ分走って二次になる（実測: `\iffalse { ` を k 個入れ子にした入力で 0.25MiB 6.7 秒、0.5MiB 27.4 秒）。
- **正本ポインタ**: 契約付録 §4、issue #332。回帰テストは `src/ingest/disabled-blocks.test.ts`（線形時間・入れ子・verbatim）。

## `src/tools/tex-spans.ts` — `verbatimSpans` は前の `\verb` 系の区間と読んだ引数の内側の候補を読まず、次の `]` / `}` の位置を使い回す。`maskChars` は伏せ終えた位置へ戻らない

- **おかしく見える点**: 候補ごとに `indexOf` すれば済みそうなのに、直前の区間（`[..]`・言語引数を読んだならその後ろの空白まで）の終わりより前の候補を飛ばし、`[..]` と言語引数の閉じの位置を前の探索結果から引いている。`maskChars` も区間を並べ替えてから、伏せ終えた位置より後ろだけを伏せる。
- **なぜ意図的か**: 無効ブロックの除去（`src/ingest/disabled-blocks.ts`）が文書全体（上限 8MiB）に掛けるため。`\lstinline{` や `\lstinline[` の羅列の後ろに閉じが 1 つだけある入力では、候補ごとに遠くの同じ閉じまで探して重なった区間を積み、伏せ直しも候補数×長さになって二次になる（実測: 1MiB で 18.7 秒、2MiB で 89 秒）。引数の閉じの後ろが長い空白だと、候補ごとに同じ空白をなめ直して二次になる（実測: 0.25MiB で 14.7 秒）。内側の候補は verbatim の中身か引数で命令ではないので読まない。以前は読んでいたため、内側の候補が外へはみ出す区間を作り、本文の数式まで伏せていた（例: `\verb|\lstinline{| $a$` で以降の数式を拾えなかった）。読まないので伏せる範囲は変わる（ほとんどは狭くなり、TeX の解釈に近づく。引数が文書末尾まで閉じない壊れた入力では広くなることもある）。
- **正本ポインタ**: 契約付録 §4、issue #332。回帰テストは `src/tools/tex-spans.test.ts`・`src/ingest/disabled-blocks.test.ts`（線形時間）。

## `src/tools/tex-spans.ts` — `maskChars` は `[...tex]` でなく `tex.split("")` で 1 文字ずつに分ける

- **おかしく見える点**: 文字列を文字に分けるのに、コードポイント単位の `[...tex]` でなく UTF-16 単位の `split("")` を使っている。
- **なぜ意図的か**: 伏せる区間の添字は UTF-16 単位（正規表現の `index`・`indexOf`）。コードポイント単位で分けると、4 バイト文字（`𝑥`・絵文字）があるところから後ろの添字がずれ、伏せる位置も、伏せた写しの添字を元の文字列に当てる処理（無効ブロックの除去）もずれる（実測: verbatim の中に `𝑥𝑦𝑧` があると `\iffalse old \fi` の手前の本文が消え、`\fi` が残って組版が落ちる）。
- **正本ポインタ**: 契約付録 §4、issue #332。回帰テストは `src/tools/tex-spans.test.ts`・`src/ingest/disabled-blocks.test.ts`（4 バイト文字）。

## `src/tools/assemble-latex.ts` — luatexja を前文の末尾でなく `\documentclass` の直後で読む

- **おかしく見える点**: 日本語組版のパッケージだけを共有部品の注入（前文の末尾）から外し、原論文のパッケージより前に差し込んでいる。
- **なぜ意図的か**: 前文の末尾で読むと、原論文の独自スタイルが先に済ませたフォント設定とかみ合わず、和文フォントが `Missing font identifier` で落ちる（実測: CellViT 2306.15350 の `preprint.sty`、`\twocolumn[…]` の閉じ括弧で致命的エラー。原文のままでも同じ）。`\documentclass` の直後に移すと組版が通る。
- **正本ポインタ**: 契約付録 §7、issue #320。回帰テストは `src/tools/assemble-latex.test.ts`。
- **共通テンプレも同じ**: `templatePreamble` も luatexja を `\documentclass[a4paper]{article}` の直後で読む。共有部品の注入の位置に置いたままだと、引き継いだ原前文（ICML の `icml2023.sty`）の後で読むことになり、対訳 PDF の共通テンプレでの組み直しが `Missing font identifier` で落ちた（実測: 2302.03519。issue #330）。

## `src/tools/assemble-latex.ts` — `\caption` の引数の中の空行を `%` だけの行に置き換える

- **おかしく見える点**: 訳文を組み立てるとき、`\caption{…}` の中の空行に `%` を入れている。原文にも訳文にも無い文字を足している。
- **なぜ意図的か**: `\caption` の引数は段落区切りを許さず、空行があると `Paragraph ended before \caption@prepareanchor was complete` で組版が落ちる。原文にこの空行がある論文は、現在の TeX Live では原文のままでも組めない（実測: 2011.03395 seg-0042 の表キャプション）。`%` 行にすれば段落区切りでなくなり、行数は変わらないのでエラー行から節への逆引きもずれない。
- **正本ポインタ**: 契約付録 §7、issue #320。回帰テストは `src/tools/assemble-latex.test.ts`。

## `src/tools/assemble-latex.ts` — 論文の `\newcommand{\mc}` / `\newcommand{\gt}` を `\DeclareRobustCommand` に替える

- **おかしく見える点**: 原文の `\newcommand` を、名前が `\mc` / `\gt` のときだけ書き換えている。
- **なぜ意図的か**: luatexja はこの 2 つを和文書体の切り替えとして定義済みなので、論文が同じ名前を `\newcommand` すると `Command \mc already defined` で組版が落ちる（実測: 2011.03395 seg-0059 の `\newcommand{\mc}[1]{\mathcal{#1}}`）。`\DeclareRobustCommand` は定義済みでも上書きでき、論文の意味が勝つ。
- **正本ポインタ**: 契約付録 §7、issue #320。回帰テストは `src/tools/assemble-latex.test.ts`。

## `src/tools/build-gate.ts` — サブディレクトリの支援ファイルを `srcpkg/` と main からの相対位置の両方に置く

- **おかしく見える点**: 同梱の `.cls` / `.sty` などは `srcpkg/` へ基底名で置くのに、サブディレクトリにあるものだけ組版ディレクトリの同じ相対位置にも複製している。
- **なぜ意図的か**: `\documentclass{style/naturep}` のようにディレクトリ付きで読む論文は、`srcpkg/naturep.cls` では解決できず `Emergency stop` で落ちる（実測: UNI 2308.15474）。ディレクトリ付きの名前は配布パッケージと衝突しないので、相対位置に置いても配布版を上書きしない。
- **正本ポインタ**: 契約付録 §7、issue #322。

## `src/tools/assemble-latex.ts` — 命令語の直後の和文字の前に `{}` を挟む

- **おかしく見える点**: 訳文の `\oursの` を `\ours{}の` に書き換えている。
- **なぜ意図的か**: luatexja の下では和文字も英字と同じ扱いなので、`\oursの能力を評価する` 全体が 1 つの命令名として読まれ `Undefined control sequence` で落ちる（実測: UNI 2308.15474 seg-0001）。translator は英文の `\ours's` を自然に `\oursの` と訳す。
- **正本ポインタ**: 契約付録 §7、issue #322。回帰テストは `src/tools/assemble-latex.test.ts`。

## `src/tools/bilingual-latex.ts` — 対訳のタイトルブロックで `\and` / `\And` / `\AND` を区切りの空白にする

- **おかしく見える点**: タイトルブロックの著者欄でだけ、クラスが定義した `\and` を `\unskip\quad` に置き換えている。
- **なぜ意図的か**: `\and` はタイトルの表組み（`\maketitle` の中の tabular）で使う前提の命令で、`\end{tabular}…\begin{tabular}` に展開される。対訳のタイトルブロックは著者を表の外で組むので、そのままだと `Misplaced \crcr` で対訳 PDF が落ちる（実測: llncs の 2606.22649・2605.18329 ほか 4 本）。
- **正本ポインタ**: 契約付録 §8（対訳 PDF）、issue #324。回帰テストは `src/tools/bilingual-latex.test.ts`。

## `src/tools/bilingual-latex.ts` — 対訳 PDF ではリンクを作らない（hyperref の draft）

- **おかしく見える点**: 対訳の main.tex の先頭で `\PassOptionsToPackage{draft}{hyperref}` を渡し、引用・参照・URL をクリックできないようにしている。和訳 PDF はリンクがある。
- **なぜ意図的か**: paracol は段の中身をページ境界で分割するので、ページをまたぐリンクの開始と終了が別の箱に入り、LuaTeX が `'endlink' ended up in different nesting level than 'startlink'` で組版を止める。原プリアンブルで組めず共通テンプレへ落ち、elsarticle が読んでいた natbib が無くなって引用が生のラベル（`[Tellez et al.(2018)Tellez, Balkenhol, …]`）のまま 1 行に伸び、隣の段へはみ出した（実測: 1902.06543）。どのリンクがページをまたぐかは組版するまで分からないので、リンク自体を作らない。
- **正本ポインタ**: 契約付録 §8（対訳 PDF）、issue #326。回帰テストは `src/tools/bilingual-latex.test.ts`。

## `src/tools/bilingual-latex.ts` — paracol の段の中で `\textwidth` を段の幅にする

- **おかしく見える点**: `\begin{paracol}{2}` の直後で `\setlength{\textwidth}{\columnwidth}` している。
- **なぜ意図的か**: paracol の段の中でも `\textwidth` は紙面全体の幅のままなので、原文の `\includegraphics[width=\textwidth]` が隣の段まで伸びる（実測: 1902.06543 の Figure 1）。段は左右同じ幅なので、段の幅に揃えれば原文の比率どおりに収まる。
- **正本ポインタ**: 契約付録 §8（対訳 PDF）、issue #326。

## `src/tools/bilingual-latex.ts` — `unwrapTitleBlock` がタイトルを含む `\twocolumn[…]` を外す

- **おかしく見える点**: 対訳でだけ、原文にも訳文にもある `\twocolumn[` と対応する `]` を改行に置き換え、中身だけを残している。
- **なぜ意図的か**: 対訳は段落ペアごとに `\switchcolumn` を挟むが、段落のつなぎ直し（`balanceParagraphs`）は角括弧を数えないので、空行を含む `\twocolumn[…]` がペアの途中で割れ、オプション引数の中に `\switchcolumn` が入って `Argument of \@topnewpage has an extra }` で落ちる（実測: ICML 2302.03519）。paracol の段の中ではもともと全幅の二段組の見出しは組めないので、外して段の中で組む。外すのは型の表でその場でタイトルを組む命令を含むものだけ。空文字でなく改行に置き換えるのは、`\par]abc` のような前後の綴りが 1 つの命令名につながらないようにするため。
- **正本ポインタ**: 契約付録 §8（対訳 PDF）、issue #330。回帰テストは `src/tools/bilingual-latex.test.ts`。

## `src/tools/bilingual-latex.ts` — `icmlSetup` が ICML のスタイルの命令を対訳用に包み直す

- **おかしく見える点**: ICML の型の論文でだけ、前文の末尾でスタイルの `\begin{document}` のフックを外し、`\thispagestyle` を何もしない命令にし、`@affiliationcounter` を paracol の共有の番号にし、`\printAffiliationsAndNotice` と `\icmlcorrespondingauthor` を包み直している。`\icmlcorrespondingauthor` は paracol の内部の段番号 `\pcol@currcol` を見る。
- **なぜ意図的か**: (1) フックは版面の検査だけで、対訳は紙面を変えるので 1 頁目に「The page layout violates the ICML style」が組まれる（フックの名前はパッケージ名なので、`icml\d{4}` のときだけ外せる）。(1') `\icmltitle` は `\thispagestyle{plain}` を呼び、対訳の 1 頁目にだけ頁番号が組まれる（対訳の頁番号は `BEGIN` が左右に組む）。(2) paracol は番号を段ごとに持つので、右の段では所属の番号が 0 のままで、所属が空の脚注になる（実測: 2302.03519）。(3) 共有にすると `\printAffiliationsAndNotice` が呼ぶたびに番号を 1 つ進めるので、右の段で存在しない所属番号を引き `AUTHORERR: Missing \icmlaffiliation` を組む。(4) `\icmlcorrespondingauthor` は呼ぶたびに連絡先を足すので、両方の段で呼ぶと 2 回並ぶ。重複を名前で判定する `\csname` は組版前の安全検査で拒まれるので、左の段（段番号 0。paracol の外も 0）でだけ登録する。
- **正本ポインタ**: 契約付録 §8（対訳 PDF）、issue #330。回帰テストは `src/tools/bilingual-latex.test.ts`。

## `src/tools/assemble-latex.ts` — 共通テンプレで、elsarticle が内部で読む natbib を読み直す

- **おかしく見える点**: 共通テンプレ（article）の前文に、原文に無い `\usepackage[…]{natbib}` を足している。オプションは原 class のオプションと本文中の `\biboptions` から組み立てる。
- **なぜ意図的か**: elsarticle は `nonatbib` が無ければ natbib を自分で読み、`\biboptions` は本文末尾に書かれることもある（.spl 経由で効く）。class を article に差し替えると natbib が消え、`.bbl` の著者年ラベルが生のまま出る（実測: 1902.06543 の対訳）。
- **正本ポインタ**: 契約付録 §7（共通テンプレ）、issue #326。回帰テストは `src/tools/assemble-latex.test.ts`。

## `src/tools/frontmatter.ts` — 型の判定の正規表現は任意引数・名前の長さに上限を置き、コメントは自前の 1 回の走査で落とす

- **おかしく見える点**: `\documentclass[..]{..}`・`\usepackage[..]{..}` を読む正規表現が `[^\]]{0,1000}` のように長さを区切っている。行コメントの除去も正規表現でなく文字を 1 つずつ見るループで書いている。
- **なぜ意図的か**: 型の判定は取り込んだ文書全体（上限 8MiB）に同期で掛かる。区切らないと、閉じない `\usepackage[` の羅列で候補ごとに末尾まで探して二次になる。`\{\s*([^}]*?)\s*\}` のように名前の前後の空白を正規表現で落とすと、空白を取れる部分が 3 つ並び、`\documentclass{` の後の長い空白で組み合わせを総当たりして二次になる（実測: 空白 32KiB で 80 秒）。名前は取ってから `trim` する。`(?:\\\\)*%` のような正規表現でコメントを落とすと、`\` の長い連なりで開始位置ごとに後戻りして二次になる。
- **正本ポインタ**: 契約付録 §8、issue #337。回帰テストは `src/tools/frontmatter.test.ts`（線形時間）。

## `src/workflows/quality-gate.ts` — `FORMAL_CHECK_VERSION` を手で上げる

- **おかしく見える点**: 検査の中身から自動で導かず、手で上げる版の定数がある。
- **なぜ意図的か**: 種別の一覧は `FORMAL_GATE` に自動で入るが、閾値・対象コマンドの一覧・判定の規則を変えただけでは一覧は変わらない。上げないと、新しい検査なら落ちる訳が以前の checkpoint からそのまま採用される（issue #254）。上げても訳し直しは起きず、印のままの訳文を今の検査にかけ直すだけなので、迷ったら上げる。
- **正本ポインタ**: 契約付録 §8（形式検査の版）。回帰テストは `src/workflows/formal-gate-recheck.test.ts`。
