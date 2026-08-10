# 綴りが実行時に決まる `\csname` は main.tex では拒否する

## Status

accepted

## Situation

JPaper を web アプリの裏側のロジックとして出すため、攻撃者が投稿した論文アーカイブだけを入力とする敵対的検査を継続している。組版はマルチテナントの同一ホストで走る。

## Context

[プリアンブル ADR](./20260811-preamble-is-untrusted-code-not-just-layout.md) 以降、危険な制御綴りの denylist は `^^` 記法と `\csname` による綴りの組み立てを展開してから照合していた。その照合は `\csname([^\\]*?)\endcsname` という正規表現で、**本体にバックスラッシュを許さない**。

敵対的検査で、本体に制御綴りを 1 つ挟むだけで照合が成立しなくなることが示された。

```tex
\def\x{directlua}
\csname\x\endcsname{local s=io.open("/etc/passwd","r") tex.print(s:read("*a"))}
```

`\def\x{directlua}` の `directlua` はバックスラッシュが前置されないので `\\([a-zA-Z]+)` 走査にも掛からない。結果として `\directlua` が静的検査を完全にすり抜け、実機の `latexmk -lualatex` を build-gate と同じフラグ（`-no-shell-escape` / `openout_any=p` / `shell_escape=f`）で走らせると exit 0 でホストのファイル内容が PDF に出た。LuaTeX の `io.open` は**読み取りに対しては shell escape の設定と無関係に有効**である。同じ手口は `\input` 系にも効く。

`\csname` の本体を静的に解決するには TeX の展開規則を再現するしかない。決定的検査で追える範囲を超えている。

一方で、配布クラス／パッケージは `\csname\@currenvir\endcsname` のような形を日常的に使う（実測: 18 件中 12 件）。同梱支援ファイルにこの規則を適用すると、会議テンプレを同梱した正規の論文が落ちる。

## Material for decision

- [プリアンブル ADR](./20260811-preamble-is-untrusted-code-not-just-layout.md)
- [読み込みコマンドの引数 ADR](./20260811-read-arguments-must-be-statically-verifiable.md)（「静的に検証できないなら拒否する」を main.tex に限って適用した先例）
- [支援ファイル ADR](./20260811-support-files-are-part-of-the-inspection-surface.md)（誤検知を実測して対象を絞る方針）
- 実測: 配布 18 件のうち 12 件が `\csname` の本体に制御綴りを含む。同梱支援ファイル扱いでの誤検知は 0 件（規則を適用しないため）。実論文（arXiv 2203.06060）も 0 件。

## Decision

`\csname` の本体に制御綴りが含まれる（＝綴りが実行時に決まる）場合、**main.tex では引数や中身に関わらず拒否する**。著者が書くプリアンブルで制御綴りをマクロ越しに組み立てる正規の理由が無く、何が発火するか静的に示せない以上「安全」とは言えない。

同梱支援ファイルにはこの規則を適用しない。配布クラス由来のコードが日常的に使う書き方であり、落とすと正規の論文が通らなくなる。

## Consequences

- 実機で流出を確認した `\csname\x\endcsname` 経由の `\directlua` / `\input` を、LLM を呼ぶ前に `kind="input"` で止められる。
- プリアンブルに TeX のマクロ技巧を書く正規の論文（`\csname` で綴りを組み立てるもの）は拒否される。誤検知が出た場合、利用者には「どの綴りが原因か」ではなく「動的な `\csname` を含む」という理由しか返せない。
- 検査面が main.tex と同梱支援ファイルで非対称という既存の割り切りが、さらに 1 項目増える。支援ファイル側に同じ手口を書く経路は残る。**組版を隔離環境で動かす前提は取り下げない**。
- 静的検査でこの種の回避を追い切るのは原理的に難しい。次の一手は denylist の拡張ではなく、LuaTeX の Lua `io` を build ツリーへ限定するパッチか、カーネル単位のサンドボックス（別 uid / コンテナ / seccomp）で、これは別 ADR で扱う。
