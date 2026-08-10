# 2026/08/11 検査面に同梱支援ファイルを含める（狭い denylist を分ける）

# Status
- accepted

# Situation
- [プリアンブル ADR](./20260811-preamble-is-untrusted-code-not-just-layout.md) 決定1 は「検査面を『LLM が触ったもの』から『ビルドへ渡すもの全体』へ広げる」とした。しかし実装が走査していたのは展開後の main.tex だけで、`\usepackage` は展開されないため**論文が同梱する `.sty` / `.cls` は検査されないままビルドへ渡っていた**。
- 敵対的演習ラウンド4で、`main.tex` を `\usepackage{jphack}` の 1 行だけにし、`jphack.sty` に素の `\directlua{io.open(...)}` を置くだけで任意ファイルを読み出せることが実証された。難読化すら要らない。
- 同じ演習で、`\lowercase{\csname OPENIN\endcsname}` が denylist を素通りすることも実証された。同 ADR 決定2 の「`\csname` による綴りの組み立ても拾う」は、大小文字を畳んでいなかったため成立していなかった。

# Context
- 同梱支援ファイルが検査面から漏れた理由は、[組版サンドボックス ADR](./20260811-typesetting-sandbox-and-package-precedence.md) の shadowing 防御を「支援ファイル対策は済んでいる」と読んでしまったこと。shadowing は**配布パッケージと同名のとき**にしか効かない。配布に存在しない新規名（`jphack.sty`）は shadow されず、そのまま読み込まれる。防御の適用範囲を、防御の目的と取り違えていた。
- 単純に既存の `READ_EXEC_COMMANDS` を支援ファイルへ流用すると、正規の論文が翻訳できなくなる。実測: `elsarticle.cls` / `IEEEtran.cls` / `revtex4-2.cls` / `llncs.cls` / `acmart.cls` / `hyperref.sty` / `natbib.sty` / `amsmath.sty` の **12 件中 8 件が検出に掛かる**（大半は `\write` / `\openout`）。論文がジャーナルのクラスファイルを同梱するのは普通の運用なので、この誤検知は許容できない。
- 支援ファイルにとって `\write` / `\openout` は日常的な道具であり、かつ書き込み先は `openout_any=p` で build ツリーに閉じ込め済み。危険度が本質的に違うのは**任意読み出し**（`\openin` / `\read`）と **Lua 実行**（`\directlua` 系）で、これらは kpathsea でも `shell_escape=f` でも止まらない。
- 検査対象を「実際に読み込まれる支援ファイル」＝配布版に shadow されないものへ絞れば、正規のクラスファイルを独自名で同梱した場合でも誤検知は出ない（実測で 0 件）。

# Material for decision
- ラウンド4-A の PoC 2 本（同梱 `.sty` 経由・大文字 `\csname` 経由。いずれも実 lualatex で秘密文字列を PDF へ持ち出すところまで確認）
- 配布クラス・パッケージ 12 件への denylist 適用結果（8 件が誤検知）と、狭い denylist での再測定（0 件）
- [プリアンブル ADR](./20260811-preamble-is-untrusted-code-not-just-layout.md)（本 ADR が実装範囲を補正する対象）
- [組版サンドボックス ADR](./20260811-typesetting-sandbox-and-package-precedence.md)（shadowing の適用範囲）

# Decision

## 決定 1: 同梱支援ファイルを検査面に含める
- `.sty` / `.cls` / `.bst` / `.bib` / `.bbl` のうち**配布版に shadow されないもの**を検査する。shadow されるものは探索順で無効化され実行されないため対象外とする（対象にすると正規のクラス同梱で落ちる）。
- 検査は取り込み直後（LLM を呼ぶ前）と組版前の 2 箇所で行う。プリアンブル ADR 決定1 と同じ方針を、漏れていた入力面へ適用する。

## 決定 2: 支援ファイル用の denylist は本文用と分け、任意読み出しと Lua 実行に絞る
- 支援ファイル用は `\directlua` 系・`\openin` / `\read` / `\readline` のみとし、`\write` / `\openout` を含めない。書き込みは `openout_any=p` で閉じ込め済みで、正規のクラスファイルが日常的に使うため。正本は `src/tools/tex-safety.ts`。
- 誤検知が出ないことを、配布クラス・パッケージと実論文の同梱物で実測して確認することを条件とする。

## 決定 3: `\csname` 本文は大小文字を畳んで照合する
- 制御綴りそのもの（`\OPENIN`）は TeX の意味論どおり大小文字を区別する。畳むと正規のマクロ名を誤検知するため。
- 一方 `\csname` の本文は文字トークンであり、`\lowercase` / `\uppercase` で実行時に変換されうる。本文は畳んで照合する。

# Consequences
- 良い面
  - 実証された 2 経路が塞がり、検査面が実際に「ビルドへ渡るもの全体」に揃った。
  - 支援ファイル用 denylist を分けたことで、正規のジャーナルクラスを同梱した論文が落ちない（実測 0 件）。
- トレードオフ
  - denylist が 2 本になり、どちらに何を入れるかの判断が増えた。追加時は両方の誤検知を実ファイルで測ることが必要。
  - 支援ファイル側では `\write` / `\openout` を見逃す。`openout_any=p` が破られた場合は防御が無い。
  - 綴りをバックスラッシュを挟んで組み立てる回避（`\csname\string o...\endcsname`）は依然として検出できない。[プリアンブル ADR](./20260811-preamble-is-untrusted-code-not-just-layout.md) 決定4 のとおり、本質解は OS レベルの隔離であり、本 ADR はその前段の層を厚くしたに過ぎない。
