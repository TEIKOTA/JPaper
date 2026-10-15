---
name: jpaper
description: Use when the user explicitly runs /jpaper (Claude Code) or $jpaper (Codex) to set up JPaper or to translate a paper into Japanese with it, e.g. "/jpaper セットアップして" or "/jpaper 2606.22649 を和訳して". Never start it on your own.
disable-model-invocation: true
argument-hint: "セットアップして | <arXiv ID・URL・タイトル・ファイル> を和訳して"
---

# jpaper

JPaper を使いたい利用者のための入口。依頼は、Claude Code では `$ARGUMENTS` に、Codex では `$jpaper` の後ろの文に入っている。利用者は開発者ではないので、この repo の開発の規約（`AGENTS.md` の issue・branch・PR・ADR）は適用しない。issue や branch を作らず、repo のファイルも書き換えない。

依頼は次のどちらかとして読む。

- **セットアップ**（「セットアップして」、または空）: 「1. 前提を確かめる」と「2. 足りないものを入れる」を行って終わる。
- **和訳**（「〇〇を和訳して」「〇〇を訳して」）: 「1. 前提を確かめる」を行い、足りないものがあれば「2. 足りないものを入れる」を済ませてから、「3. 和訳する」を行う。

どちらとも読めなければ、どちらをしたいかを利用者に尋ねる。

コマンドはすべて repo の直下（`bin/jpaper.mjs` と `pnpm-lock.yaml` があるディレクトリ。`git rev-parse --show-toplevel`）で実行する。`.env` は読まない・表示しない。

## 1. 前提を確かめる

次を 1 つずつ確かめ、そろっているものと足りないものを利用者に短く伝える。

| 確かめるもの | 確かめ方 | そろっている条件 |
|---|---|---|
| Node.js | `node -v` | 22.5 以上 |
| pnpm | `pnpm -v` | 10 以上 |
| 依存 | `cmp -s node_modules/.pnpm/lock.yaml pnpm-lock.yaml` | 終了コード 0 |
| LaTeX | `command -v latexmk`・`command -v lualatex`・`kpsewhich luatexja-preset.sty` を 1 つずつ | 3 つとも見つかる |
| LLM の CLI | 使う provider（「3. 和訳する」の表）が claude なら `claude --version`、codex なら `codex --version` | 動く |

PDF を訳す依頼のときだけ、poppler（`command -v pdftocairo`・`pdfinfo`・`pdftotext` を 1 つずつ）も確かめる。

LaTeX が見つからなくても `/Library/TeX/texbin/latexmk` があれば、MacTeX を入れた後でシェルの PATH が古いだけなので、以後のコマンドの先頭で `export PATH="/Library/TeX/texbin:$PATH"` してから確かめ直す。

ollama・openrouter を使う場合、サーバの起動や API キーはここでは確かめない（`.env` を読まないため）。和訳が終了コード 2 で止まったら、README の「LLM プロバイダ」を見せる。

## 2. 足りないものを入れる

足りないものだけを入れる。macOS で Homebrew（`brew`）がある前提で、それ以外の環境では README の「セットアップ」を見せて、利用者に入れてもらう。

- Node.js: `brew install node`
- pnpm: `brew install pnpm`
- 依存: repo の直下で `pnpm install --frozen-lockfile`
- poppler（PDF を訳すときだけ）: `brew install poppler`
- LaTeX: 論文ごとに使うパッケージが違うので、フルの TeX Live（MacTeX）を入れる。管理者のパスワードの入力が要り、数 GB ある。**自分では実行しない。** 利用者に、別のターミナルを開いて `brew install --cask mactex-no-gui` を実行するよう頼み、終わったと言われてから確かめ直す。
- LLM の CLI: 利用者が今使っている Claude Code・Codex は入っている。ほかの provider を指定されて CLI が無ければ、README の「LLM プロバイダ」を見せて、入れてもらう。

`pnpm link --global` は要らない（`jpaper` コマンドを使いたいと言われたときだけ、README の「セットアップ」の手順を案内する）。

入れ終わったら「1. 前提を確かめる」をもう一度行い、そろったことを伝える。

## 3. 和訳する

### 入力を決める

- arXiv ID（`2606.22649` など）、`.tex`・zip・tar.gz・ディレクトリ・PDF のパスは、そのまま入力にする。URL（`arxiv.org/abs/…`）は ID だけにする。
- タイトルや語句なら、英語のタイトルで arXiv を探す。`curl -sG --data-urlencode 'search_query=ti:"<語句>"' -d max_results=5 https://export.arxiv.org/api/query`（`<語句>` に `'` や `"` が含まれるなら取り除く）。返る ID の末尾の版（`v7` など）は付けたままでよい。候補が 1 つに決まらなければ、タイトルと ID を並べて利用者に選んでもらう。
- PDF は claude・codex でしか訳せない。`pdfinfo` でページ数を数え、100 を超えるなら全部か範囲（`--pages 1-72` など）かを利用者に決めてもらう。読むページ（範囲を選んだならその数）が 100 を超えるなら `--yes` を付ける。

### provider を決める

| 依頼 | `--provider` |
|---|---|
| provider の指定がなく、Claude Code で動いている | `claude` |
| provider の指定がなく、Codex で動いている | `codex` |
| 「ollama で」「openrouter で」など指定がある | その provider |

### 実行する

repo の直下で次を実行する。

```sh
node bin/jpaper.mjs <入力> --provider <provider>
```

- 利用者がほかのオプション（`--model`・`--effort`・`--no-bilingual` など）を言っていれば付ける。一覧は `node bin/jpaper.mjs --help`。
- 翻訳には長い時間がかかる。Claude Code ではバックグラウンドで実行し、終わるのを待つ。Codex では、コマンドの時間切れが短いなら長くする。
- Codex の sandbox がネットワークを止めていると、arXiv からの取得と LLM の呼び出しが失敗する。そのときは権限の昇格を求めて実行し直す。
- 途中で止まっても、同じ入力・同じ provider・同じ `--out` でもう一度実行すれば続きから再開する。前の実行がまだ動いていると、出力先が使用中として終了コード 2 で止まる。

### 結果を伝える

- 成功（終了コード 0）なら、標準出力の `PDF:` と `対訳 PDF:` のパスを伝える。既定の出力先は repo の直下の `article/<論文 ID>-ja/`。
- 失敗なら、終了コードの意味（`node bin/jpaper.mjs --help` の末尾）と標準エラーの最後の数行を伝える。標準出力に `PDF:` があれば、出来た PDF のパスも伝える。そのうえで「4. 失敗したとき」を行う。
- 終了コードが 0 でも、`対訳 PDF:` が無ければ（`--no-bilingual` を付けていないのに）対訳 PDF の組版が失敗している。標準エラーの `対訳 PDF の組版に失敗しました` の行（JSON の `bilingual.message` と同じ）を伝え、「4. 失敗したとき」を行う。

## 4. 失敗したとき

repo のファイルは書き換えない。調べるだけにする。

### 原因を調べる

失敗した組版のログ（`.log`）は、失敗したときに消えるので残らない。`translation/build/` にあるのは前に成功した実行のものなので、原因として読まない。手がかりは次の 3 つ。

- 標準エラーの `組版失敗(翻訳起因・要再訳): …`・`組版失敗(テンプレでも不可): …`・`対訳 PDF の組版に失敗しました…`・`失敗[…]: …` の行。組版の失敗には `構造: <ファイル>:<行>: <LaTeX のエラー>`・`翻訳起因: <箇所>(<行>)`・`欠図: …` などが付く。
- 標準出力の JSON（`RunSummary`）の `error` と `bilingual`。
- 翻訳が原因の組版の失敗なら、出力先の `.run/failed-segments.json`。

原因が JPaper のコード（`src/`）にあると思えば、該当する箇所を読んで確かめる。

### 原因で分ける

| 原因 | すること |
|---|---|
| 利用者の環境や入力（LaTeX のパッケージが無い、ネットワーク、provider のログインや利用上限、テキスト層の無い PDF など） | 対処を伝える。起票しない |
| LLM の訳の品質（終了コード 3・4、`組版失敗(翻訳起因・要再訳)`） | もう一度実行するか、`--model` を変えるよう勧める。起票しない |
| JPaper のバグか未対応（論文の書き方に組み立てが追いついていないなど）で、原因の箇所と直し方の見込みが言える | 次の「issue に起票する」を行う |
| 原因が分からない | 分かったことと、分からないことを伝える。推測で起票しない |

### issue に起票する

1. `gh auth status` で、`gh` が使えてログインしているかと、そのアカウント名を確かめる。使えなければ、下書きだけを作って 5. に進む。
2. 同じものが無いか探す。`gh issue list --repo TEIKOTA/JPaper --state all --search "<エラーの要の語>"` と `gh pr list --repo TEIKOTA/JPaper --state all --search "<エラーの要の語>"`。同じものがあれば、その issue か PR を伝えて終わる。
3. 下書きを作る。`.github/ISSUE_TEMPLATE/bug-report.md` の見出しに沿って書く。タイトルは `fix(<対象>): <何が起きるか>`（日本語）。次を入れる。
   - 入力（arXiv の論文なら ID。手元のファイルなら種類だけ）、provider、終了コード
   - エラーの要の行と、原因の箇所（`src/…:行`）、直し方の見込み
   - 「重複確認」の節に、2. で探した語と結果
4. 下書きに次を入れない: 手元のファイルや PDF の中身、論文本文の長い引用、`.env` の値、利用者の名前（パスの `/Users/<名前>` は `~` にする）。手元のファイルを訳したときは、エラーの行も種類（`Undefined control sequence` など）と JPaper 側の箇所だけにして、本文やマクロの断片を入れない。`--redact-file` を使ったときは、下書きにそのファイルの語が無いことを確かめる。
5. 下書きを利用者に見せ、「<アカウント名> の名前で公開の issue になる」と添えて、起票してよいかを尋ねる。了承を得たときだけ、`gh issue create --repo TEIKOTA/JPaper --title "<タイトル>" --body-file -` に下書きを標準入力で渡して実行し、出来た issue の URL を伝える（ラベルは付けない。repo の権限が無いと失敗する。下書きのファイルを repo に残さない）。`gh` が使えなければ、下書きを見せ、`https://github.com/TEIKOTA/JPaper/issues/new` から利用者に出してもらう。
