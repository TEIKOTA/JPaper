# 2026/08/11 組版サンドボックス: shell escape 明示禁止と、同梱パッケージを配布版より後に探索する

# Status
- accepted

# Situation
- JPaper は arXiv から**第三者が投稿したアーカイブ**を取り込み、その中の `.tex` / `.sty` / `.cls` をそのまま `latexmk -lualatex` に渡して組版する。TeX は事実上のプログラミング言語であり、攻撃者は「論文を投稿する」だけで JPaper 利用者の環境でコードを走らせられる。
- 敵対的セキュリティ演習（自リポジトリに対する攻撃演習）で、この経路の悪用が実証された。web アプリのロジックとして動かす前提では、投稿者＝攻撃者を想定した信頼境界の設定が必須になる。

# Context
- 実証された攻撃: ソース同梱の `graphicx.sty` が TeX Live 標準版を乗っ取った。`stageBuild` は同梱の `.sty/.cls/.bst/.bib/.bbl` を **basename で build dir 直下へフラットにコピー**しており、latexmk は `cwd=buildDir` で走るため、TeX が cwd を最優先に探索して悪意版を読む。`\usepackage{graphicx}` は本文が普通に書く行なので発火は確実だった。
- 影響: `openin_any=a`（TeX Live 既定）の環境で `\openin` によりローカルの秘密ファイルを読み、**その内容を成果物 PDF 本文へ埋め込むことに成功**した。成果物そのものが持ち出し経路になる。
- 任意コマンド実行（`\write18` / `os.execute`）と build ツリー外への書き込みは、監査機の texmf 既定（`shell_escape=p`, `openout_any=p`）で止まった。ただし **JPaper 側は `-shell-escape` の可否も `openout_any` も明示していなかった**。防御が完全に外部設定依存で、ユーザーの `texmf.cnf` や `~/.latexmkrc` が緩ければ RCE に昇格する。実際、監査中に `~/.latexmkrc` が読まれてコマンド行が上書きされることも観測された。
- 読み取りの遮断は、当初 `openin_any=p`（paranoid）で行おうとしたが、**LuaTeX のフォントローダ（luaotfload）が絶対パスで Lua モジュールを読むため正常な組版まで壊れた**（`Failed to load "luaotfload" module "multiscript"`）。実測で不採用と判断した。
- パッケージ乗っ取りの塞ぎ方は 2 案あった。(1) 標準パッケージ名の denylist で拒否する、(2) 同梱ファイルを別ディレクトリへ隔離し、**探索順で配布版を先に**する。(1) は TeX Live のパッケージ集合を JPaper 側で持つことになり、版が変わるたび追随が要る。(2) は kpathsea の探索パスの先頭に既定パスを置くだけで、名前を列挙せずに「配布版が常に勝つ」を保証できる。

# Material for decision
- 敵対的監査の PoC と観測結果（同梱 `.sty` の読み込み、PDF への秘密埋め込み、`\write18`/`\openout` が既定設定で止まったこと）
- [品質ゲート ADR](./20260708-quality-gate-machine-vs-llm-and-explicit-failure.md)（暗黙の劣化を禁じ、surface する）
- [組版 shim ADR](./20260809-typesetting-shims-luatex-compat-and-class-absorption.md)（原前文をそのまま引き継ぐ設計＝攻撃面が広いことの前提）
- kpathsea の探索パス仕様（空要素が既定値へ展開される）と、環境変数による `texmf.cnf` 変数の上書き
- 実測: `openin_any=p` は luaotfload を壊す。`shell_escape=f` + `openout_any=p` + 探索順変更では arXiv 2203.06060 が従来どおり `buildOk=true`

# Decision

## 決定 1: shell escape と build ツリー外への書き出しは JPaper 側で明示的に禁止する
- `latexmk` に `-no-shell-escape` を渡し、加えて環境変数で `shell_escape=f` と `openout_any=p` を強制する。外部の `texmf.cnf` 設定に防御を委ねない。
- externally-configurable な緩和（ユーザーが `-shell-escape` を有効にする等）は受け付けない。信頼できない TeX を実行する以上、既定を最も厳しい側に固定する。

## 決定 2: 同梱パッケージは隔離ディレクトリへ置き、配布版より後に探索させる
- 同梱の `.sty/.cls/.bst/.bib/.bbl` は build dir 直下ではなく `srcpkg/` へ置く。`TEXINPUTS` / `BIBINPUTS` / `BSTINPUTS` を「**既定パス → `srcpkg/`**」の順に設定し、同名なら配布版が勝つようにする。
- 標準パッケージ名の denylist は持たない（決定 1 と同じ理由で、外部の集合に追随したくない）。
- 論文独自の `.sty` は従来どおり使える。失われるのは「標準パッケージを差し替える」能力だけである。

## 決定 3: 無効化した同梱パッケージは surface する
- 配布版と同名の同梱ファイルは `RunSummary` 経路の警告として名前を出す（`BuildGateResult.shadowedPackages`）。論文が意図的に patch 版を同梱していた場合、体裁が変わり得るため、暗黙に劣化させない（[品質ゲート ADR](./20260708-quality-gate-machine-vs-llm-and-explicit-failure.md)）。
- 同名判定は `kpsewhich` に問う。解決できない環境では検出なしとするが、**防御そのものは探索順で既に効いている**ため、検出の失敗は安全性を損なわない。

## 決定 4: 読み取りの遮断は OS レベルのサンドボックスで行う（TeX の設定では行わない）
- `openin_any=p` は LuaTeX のフォントローダを壊すため採らない。したがって**本 ADR の範囲では「任意ローカルファイルの読み取り→PDF への混入」は塞がらない**。
- この残存リスクは、latexmk をコンテナ / `sandbox-exec` 等の OS サンドボックス内で実行することで塞ぐ。web アプリとして公開する前の必須要件として別途扱う。

# Consequences
- 良い面
  - 同梱 `.sty` による標準パッケージ乗っ取りが、名前の列挙なしに構造的に塞がれた（PoC で悪意版が読まれなくなり、配布版が読まれることを確認）。
  - shell escape と build ツリー外書き込みの禁止が JPaper 側に固定され、ユーザー環境の設定に依存しなくなった。
  - 実在論文（2203.06060）の組版は従来どおり通り、レイアウト忠実性は損なわれていない。
- トレードオフ
  - 論文が標準パッケージの patch 版を同梱していた場合、その patch は効かなくなる。警告で surface するに留める。
  - `kpsewhich` を 1 ファイルにつき 1 回起動するため、支援ファイルが多い論文でわずかに遅くなる。
  - **読み取りの遮断は未達**（決定 4）。OS サンドボックスを入れるまで、悪意ある TeX はローカルファイルを読んで PDF に混ぜられる。この残存リスクを承知の上で段階的に進める。
