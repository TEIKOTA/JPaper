# パス引数はコマンド名によらず危険として扱う

## Status

accepted

## Situation

[read-commands-judged-by-argument-not-name](./20260811-read-commands-judged-by-argument-not-name.md) で「読み込みコマンドは名前では落とせないので引数の形で判定する」と決め、`READ_PATH_COMMANDS` に列挙した綴りへその判定を掛けてきた。第 15 ラウンドの敵対的レビューで、**列挙そのものが漏れていた**ことが実測で判明した。

`findUnsafeTexCommands` / `findUnsafeSupportCommands` がいずれも `[]`（検査通過）を返した実在コマンド:

```
\lstinputlisting{/etc/passwd}      \@input{/etc/passwd}
\verbatiminput{/etc/passwd}        \VerbatimInput{/etc/passwd}
\inputminted{text}{/etc/passwd}    \CatchFileDef{\x}{/etc/passwd}{}
\includegraphics{/tmp/secret.png}  \addbibresource{/etc/passwd}
\bibliography{/etc/passwd}         \includegraphics[width=\textwidth]{/tmp/other/main.pdf}
```

end-to-end（実 latexmk / lualatex）で、プリアンブルに `\usepackage{listings}` と `\AtBeginDocument{\lstinputlisting{<host>/host-secret.txt}}` を置いた論文が `status=ok` / `exitCode=0` / `buildOk=true` で完了し、`pdftotext` にホストの秘密の中身が出た。`\makeatletter\AtBeginDocument{\@input{<abs>}}\makeatother` はパッケージすら要らない（LaTeX カーネルの `\@input` が漏れていた。denylist には `\@@input` だけがあった）。

`\includegraphics` の絶対パスでは別テナントの成果 PDF をそのまま自分の PDF に埋め込める。出力先は `<cwd>/<paperId>-ja` で `paperId` は arXiv ID なので推測可能。

## Context

穴の本体は個々の綴りではなく、**防御が「危険なコマンドの名前を列挙し続けること」に依存している**点にある。LaTeX のファイル読み出し綴りは新しいパッケージが増えるたびに増え、論文は自前の `.sty` を同梱できる。列挙は必ず遅れる。

一方で、コマンド名を一切見ない一般規則（「制御綴りの引数がビルドツリーの外を指していたら落とす」）を素朴に入れると誤検知が実務的でない量になった。TeX Live 配布 6,570 件での実測:

- 素の `/` 始まりまで対象にする: 支援モードで **660 件（10%）** の誤検知。主因は pgf/tikz の key path（`\pgfkeysvalueof{/tikz/unit ext}`、`\pgfkeys{/GRAPH35/KEY, #1}`）。これはファイルパスではないが静的には区別できない。
- `~` の直後を問わない: `~` は TeX の結合子なので `{~\ref{TotPages}}` のような正規の綴りが当たる。
- 図・文献リソースの引数を strict（マクロ引数を拒否）にする: main モードで 145 件の増分。`\includegraphics{\figpath}` / `\addbibresource{\jobname.bib}` は正規の書き方。

## Material for decision

- [プリアンブルは未検証コード](./20260811-preamble-is-untrusted-code-not-just-layout.md)（決定 4 = OS 隔離が本筋であること）
- [読み込みコマンドは名前ではなく引数で判定する](./20260811-read-commands-judged-by-argument-not-name.md)
- [引数は静的に検証できなければならない](./20260811-read-arguments-must-be-statically-verifiable.md)
- [同梱支援ファイルも検査面](./20260811-support-files-are-part-of-the-inspection-surface.md)
- 契約付録 §8、`src/tools/tex-safety.ts`
- 実測: TeX Live 配布 `.sty`/`.cls` 6,570 件での誤検知増分、arXiv 2203.06060 の回帰

## Decision

1. **親参照（`../`・`/../`）と `~/`・Windows のドライブ指定は、コマンド名によらず落とす。** 論文が本文でパスを見せるための表示系（`\texttt` / `\url` / `\path` / `\verb` / 見出し等）だけを allowlist にする。列挙の向きを「危険なもの」から「無害なもの」へ反転させ、未知のパッケージが持つ読み出し綴りを既定で捕まえる。
2. **素の絶対パス（`/` 始まり）は、この一般規則の対象にしない。** pgf/tikz の key path と静的に区別できず、誤検知が 10% に達する。絶対パスは従来どおり `READ_PATH_COMMANDS` に列挙した綴りで見る。
3. **列挙は維持し、今回見つかった実在の読み出し綴りを追加する**（`@input` / `lstinputlisting` / `verbatiminput` / `VerbatimInput` / `inputminted` / `CatchFileDef` / `CatchFileEdef` / `subfile` / `subfileinclude` / `includegraphics` / `includepdf` / `addbibresource` / `bibliography`）。
4. **図・文献リソースの引数はマクロでもよい**（`DYNAMIC_ARG_OK`）。絶対パス・親参照の判定は残す。
5. **一般規則の走査コストは件数ではなく実走査量で抑える。** 件数で数えると、正規の文章に並ぶ `\texttt{/usr/...}` だけで上限に達し、正しい論文を `too-large` で落とす（実測 2MiB の地の文で 2 万件超）。

## Consequences

- 未知の綴りでも親参照によるビルドツリー脱出は捕まる。今回の流出 10 種はすべて落ちる。
- **残存リスク（意図的）**: 列挙していないコマンドに素の絶対パスを渡す形（`\somepkgread{/etc/passwd}`）は通る。これは決定 2 のトレードオフであり、埋めるには pgf key path と絶対パスを静的に区別する必要があるが、その手段は無い。**この経路の本質的な防御は [プリアンブル ADR](./20260811-preamble-is-untrusted-code-not-just-layout.md) 決定 4 の OS 隔離**であり、本 ADR はそれまでの緩和にすぎない。本番運用で組版を隔離しない選択肢は無い。
- 誤検知の実測（TeX Live 6,570 件、本 ADR 実装前後の差分）: 支援モード **+10 件**、main モード **+15 件**。いずれも `..` を実際に読む配布クラス（`europecv.cls` / `pgf-go.sty` 等）で、判定としては正しい。arXiv 2203.06060 の回帰は `buildOk: true` / 構造エラー 0 / 図の欠落 0。
- 走査コストは線形を保つ（8MiB の地の文 48ms、回避専用入力 112ms）。
