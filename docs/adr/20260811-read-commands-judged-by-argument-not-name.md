# 読み込みコマンドは名前ではなく引数の形で判定する

## Status

accepted

## Situation

JPaper を web アプリの裏側のロジックとして出すため、攻撃者が投稿した論文アーカイブだけを入力とした敵対的検査を継続している。組版はマルチテナントの同一ホストで走る前提。

## Context

[プリアンブル ADR](./20260811-preamble-is-untrusted-code-not-just-layout.md) で導入した denylist は、正規の用途があることを理由に `\input` / `\include` / `\usepackage` を検査対象から外していた。読み込み経路は `expandInputs`（`src/ingest/main-tex.ts`）が `\input{...}` を build ツリー内で解決し、外を指すものは除去するので閉じている、という前提だった。

敵対的検査でこの前提が崩れた。`expandInputs` は正規表現に一致した綴りしか畳まない。`\csname input\endcsname{/absolute/path}` は一致せずプリアンブルに残り、denylist にも `input` が無いため素通りし、latexmk が実際にそのファイルを読んで PDF に組版する。実際の `latexmk -lualatex` を現行の `sandboxEnv` 相当（`openout_any=p` / `shell_escape=f` / `-no-shell-escape`）で走らせ、ホスト上の秘密文字列が PDF に出ることを確認した。Linux なら `/proc/self/environ` で全環境変数が流出する。同じ経路は同梱 `.sty` からも成立する。

kpathsea では塞げないことは既に測ってある（`openin_any=r` は絶対パスを制限せず、`p` は luaotfload ごと壊す）。組版の隔離（コンテナ／別ユーザ）は本番運用の前提として契約付録に書いてあるが、それが無い配備でも既知の綴りは止めておく必要がある。

## Material for decision

- [プリアンブル ADR](./20260811-preamble-is-untrusted-code-not-just-layout.md)（denylist の初版と、そこで `\input` を外した理由）
- [支援ファイル ADR](./20260811-support-files-are-part-of-the-inspection-surface.md)（誤検知を実測して対象を絞る方針）
- [組版サンドボックス ADR](./20260811-typesetting-sandbox-and-package-precedence.md)（kpathsea で代替できないことの実測）
- 実測: 配布クラス／パッケージ 14 件に対する新規則の誤検知は 0 件。実論文（arXiv 2203.06060）も 0 件。

## Decision

読み込みコマンドを検査面に含める。ただし**名前だけでは拒否せず、引数の形で判定する**。

1. 引数が絶対パス・`~` 始まり・パス区切りで分けた `..` を含むなら拒否する。括弧を書かない TeX 形式（`\input /abs`）も同様に見る。
2. `\csname` で綴りを組み立てた読み込みコマンドは、引数に関わらず拒否する。綴りを分解する正規の理由が無く、`expandInputs` をすり抜ける経路そのものだから。
3. `\csname` の照合は**本体全体**で行う。トークン分割で照合すると `\csname my-input\endcsname` のような配布 `.sty` を落とす。

`\usepackage` は引き続き対象外（引数がパスではなくパッケージ名であり、同梱 `.sty` 側の検査で見る）。

## Consequences

- `\csname input\endcsname` によるホストファイル読み取りと PDF への流出を、LLM を呼ぶ前に `kind="input"` で止められる。同梱 `.sty` 経由も同時に塞がる。
- 名前ではなく引数の形で判定するため、`\input{chapters/intro}` のような正規用途は落ちない。誤検知は実測 0 件。
- denylist である以上、未知の綴り（将来のパッケージが提供する読み込みマクロ、`\scantokens` を絡めた動的生成など）は依然すり抜けうる。**組版を隔離環境で動かす前提は取り下げない**。この決定はその前提が無い配備での被害を減らすための多層防御に留まる。
- 引数の形で判定する以上、TeX の完全な展開規則は再現していない。`\def\p{/etc}\input{\p/passwd}` のようにマクロ経由で組み立てられた絶対パスは検出できない（未再現・理論上の残存リスク）。
