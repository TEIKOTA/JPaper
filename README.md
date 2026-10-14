# JPaper

> English summary: JPaper translates academic papers into Japanese. It takes the LaTeX source of a paper (an arXiv ID, a zip or tar.gz archive, or a directory) and produces a typeset Japanese PDF and a landscape side-by-side PDF (original on the left, Japanese on the right), along with a per-paper glossary. Translation and quality review are done by an LLM (Claude Code CLI, Codex CLI, Ollama or OpenRouter), while the control flow, retry limits and formal checks are plain TypeScript. Japanese is the only target language, and the rest of this README and the documentation are written in Japanese. Requirements: Node.js 22.5+, pnpm 10+, LaTeX (LuaLaTeX and latexmk) and one of the LLM providers above. Licensed under the MIT License.

学術論文の和訳に最適化した、決定的に動く専用のエージェント。agent-native な設計の原則（配線はコード、内容の判断は LLM）に従い、配線は YAML ではなく素の TypeScript のワークフローとして書く。Flue の Agent と Workflow の分け方を参考に、薄い自作のランタイムで実装している。

採用したアーキテクチャの方針は [`docs/adr/`](./docs/adr/) を参照。

## 何をするか

- **入力**: 学術論文の LaTeX ソース（arXiv、zip・tar.gz）を最優先で扱う。ソースが無く PDF しか無い論文は Phase2（Nougat などによる抽出）で対応する。
- **出力**: 日本語 PDF（LuaLaTeX で組版）と、横長（A4 縦 2 枚分）で左に原文、右に和訳を並べた対訳 PDF。
  - ファイル名は `<ID>_<短い英語名>-ja.pdf`・`<ID>_<短い英語名>-bilingual.pdf` で、出力先の直下に置く（例 `2507.17845_pathorob-ja.pdf`）。短い英語名はタイトルを訳すときに LLM が決め、決まらなければ `2507.17845-ja.pdf` になる（[成果物 PDF の名前 ADR](./docs/adr/20261007-name-deliverable-pdfs-by-id-and-slug.md)）。
  - 対訳 PDF は `--no-bilingual` を付けると作らない。対訳の組版だけが失敗しても run は成功し、`RunSummary.bilingual` とエラー出力に理由が出る（[対訳 PDF ADR](./docs/adr/20261006-bilingual-side-by-side-pdf.md)）。
  - あわせて、論文ごとの用語集（`glossary.md`）と実行の記録を残す。
- **品質**: 訳す役（`translator`）と品質を判定する役（`evaluator`）を分けている。検査は、節ごとの軽い形式検査と evaluator、組み上げた後の全文の組版ゲートの 2 層からなる。合格したらループを抜け、上限（`MAX_REVISIONS`）を超えたら明示的に失敗する（[品質ゲート ADR](./docs/adr/20260708-quality-gate-machine-vs-llm-and-explicit-failure.md) / [2 層化 ADR](./docs/adr/20260709-quality-gate-two-layer-and-build-error-triage.md)）。

## アーキテクチャ

agent-native の考え方と Flue の設計に沿って、次のように分けている。

- Agent（誰が）: `translator`・`evaluator`・`glossary-builder` など。`src/agents/<id>.ts` に定義する。薄い自作のランタイムは `src/runtime/` にある。
- Tool（何ができるか）: エージェントが使う TS の関数。実装は `src/tools/`。
- Skill（何を知っているか）: 用語やスタイルの規約などの知識。必要になった分だけ段階的に読み込む（`.agents/skills/`）。
- Workflow（配線）: `src/workflows/*.ts` の素の TS の関数で、複数のエージェントをつなぐ（`Promise.all` / `for` / `if`）。順序・並列・上限は TS が固定し、品質の判定は LLM が行う。
- 知識の正本: 用語集・スタイルガイドなどは `input/` に置き、commit する。
- ファイルの配置: 全体の状態は `~/.jpaper/` に置く（論文をまたいで共有する `glossary.db` と設定）。論文ごとの成果物と実行の記録は、隠しフォルダではない `./article/<paper>-ja/` に置く（`source/`・`figures/`・`glossary.md`・`translation/`・`<ID>_<短い英語名>-ja.pdf`・`<ID>_<短い英語名>-bilingual.pdf`・`.run/`）。`--out` で変えられる（[UI/配置 ADR](./docs/adr/20260709-user-interface-file-layout-and-cli.md)）。

決定性の方針として、ループの上限・並列・分岐は素の TS（`for` / `Promise.all` / `if`）で書き、契約の検査は zod で行う。品質の判定・行き詰まりの判断・介入は LLM に任せる。ランタイムは Flue の Agent/Workflow の設計を借りた薄い自作のもので、将来 durable な実行・観測・複数環境へのデプロイが必要になれば Flue へ移れるよう、形を寄せている。詳細は [ADR](./docs/adr/20260708-adopt-deterministic-agent-architecture.md) を参照。

## セットアップ

### 前提ツール

- Node.js（22.5 以上）と pnpm（10 以上。`brew install pnpm` か `corepack enable`）: 本体の実行とテスト
- LaTeX（`latexmk`・LuaLaTeX）: 組版
- `gh`（GitHub CLI）: issue / PR の確認と初期設定
- Python 3（`python3`）: hook の設定と一部の self-test
- Ruby（`ruby`）: skill の frontmatter の検査
- lefthook（commit-msg / pre-push のローカル hook）

```sh
pnpm install
lefthook install   # commit-msg / pre-push フック（未導入なら brew install lefthook）
```

OpenRouter の API キーなどは、`.env.example` を `.env` に写して書ける。CLI は作業ディレクトリの `.env` を、Web は repo 直下の `.env` を読み、シェルの環境変数のほうが優先される（詳細は [契約付録 §8](./docs/design/contract-appendix.md)）。

## 使い方

```sh
pnpm dev <arXiv ID|ファイル|ディレクトリ> --provider {ollama|claude|codex|openrouter} [--out DIR] [--no-bilingual] [--no-verify-terms]
```

和訳 PDF（例 `article/2507.17845-ja/2507.17845_pathorob-ja.pdf`）と対訳 PDF（例 `article/2507.17845-ja/2507.17845_pathorob-bilingual.pdf`）のパスを標準出力に出し、`RunSummary` を JSON で出す。

claude・codex では、翻訳の前に用語集の訳を CLI の Web 検索で既存の日本語の用例と照らし、出典の取れた表記に差し替える。用例を確かめられない語は「未確認」の訳注になる。`--no-verify-terms` で止められる（[用語の検証 ADR](./docs/adr/20261013-verify-unconfirmed-terms-with-cli-web-search.md)）。オプションの正本は [契約付録 §5](./docs/design/contract-appendix.md)。

### LLM プロバイダ

LLM プロバイダは `LlmClient` の境界で差し替えられる。ローカルの Ollama、公式 CLI を子プロセスで動かすクラウド（`claude -p` / `codex exec`）、OpenRouter（OpenAI 互換 API）の 4 つの実装があり、`--provider {ollama|claude|codex|openrouter}` は必須で既定は無い。claude と codex には `--model` / `--effort` を渡せて、指定しなければ最新の中位モデル（claude は Sonnet、codex は Sol）と effort medium を使う。LLM クライアントは薄い自作のランタイムの中に閉じ込めている（[プロバイダ ADR](./docs/adr/20260709-llm-provider-abstraction-local-ollama-and-cloud-cli.md)）。

### Web アプリ（検索・翻訳・用語集）

```sh
pnpm dev:web
```

ブラウザで `http://127.0.0.1:5173` を開くと、`article/` の論文と用語集、全体の用語 DB を見られる。用語の行から訳語を直すと、訳文での出現箇所を原文の対応箇所と並べて確かめてから置換し、和訳 PDF と対訳 PDF を組み直す。この置換に LLM は使わず、直前の 1 回は元に戻せる。データの場所は CLI と同じ既定（CWD の `article/` と `~/.jpaper/glossary.db`）で、`JPAPER_ARTICLE_DIR`・`JPAPER_GLOSSARY_DB` で変えられる。`127.0.0.1` だけで待ち受け、認証は持たない。仕様の正本は [契約付録 §9](./docs/design/contract-appendix.md)。

画面は次の 3 つ。

- 探す: 手元の論文と arXiv の論文を 1 つの検索欄で探す。未訳の論文は「翻訳する」から翻訳の画面へ送れる（arXiv ID を直接入れてもよい）。
- 翻訳: provider・model・effort を毎回指定して、ジョブをキューに加える。段階・節 n/m・費用・経過時間・ログの末尾を見ながら、待機中・実行中のジョブを取り消せる。翻訳は CLI を子プロセスで動かすので、訳し終えた論文はそのまま一覧と用語集の編集の対象になる。
- 設定: フォームの初期値と、同時に走らせる本数（既定は 1 本ずつ、4 本まで）を決め、`~/.jpaper/web-settings.json`（`JPAPER_HOME`）に保存する。初期値を指定しなければ、claude は最新の Sonnet、GPT は最新の Sol を effort medium で使う。

ジョブは API のメモリにだけ持つので、API を止めると実行中の翻訳も止まる（同じ ID で始め直せば checkpoint から再開する）。翻訳が使う全体の用語 DB は CLI と同じ `JPAPER_HOME/glossary.db` で、`JPAPER_GLOSSARY_DB` は翻訳には効かない。

## コマンド

| コマンド | 用途 |
|---|---|
| `pnpm dev` | jpaper CLI（`src/cli.ts`）を tsx で実行 |
| `pnpm dev:web` | Web アプリ（検索・翻訳・用語集の API と画面）を立ち上げる |
| `pnpm build` | `tsc` で `dist/` へビルドし、Web アプリの画面を `apps/web/dist/` へビルド |
| `pnpm typecheck` | 型チェックのみ（emit しない。Web アプリも含む） |
| `pnpm test` | vitest で単体テスト（決定的な検査で、LLM を含めない） |
| `bash tests/run-tests.sh` | 規約検査スクリプトの self-test（`scripts/` を変更したら実行） |
| `scripts/new-branch.sh <type> <issue番号> <slug>` | 規約を検証しながら topic branch を作成 |
| `scripts/check-pr.sh [<PR番号>]` | PR のタイトル・body・issue との連結をローカルで検査（PR の作成・編集後） |

## 開発ルール

運用ガイドは [`AGENTS.md`](./AGENTS.md)（`CLAUDE.md` は symlink）。issue 駆動・PR 必須・日本語 Conventional Commits・ADR による決定の記録を、最初から lefthook とローカルの検査で機械的に強制している。

検証はローカル script が正本（`bash tests/run-tests.sh` と `scripts/check-pr.sh`）。GitHub Actions（`.github/workflows/` の node-checks・pr-checks・self-test）は、同じ検査を Linux と macOS でもう一度走らせる（[ADR](./docs/adr/20261014-enable-github-actions-on-public-repo.md)）。

Claude Code 用の権限の既定と hook は `.claude/settings.json` にある。read-only コマンドの allowlist、secret ファイルの Read の拒否、`scripts/hooks/` の Bash ガード、scripts を編集した後の自動 self-test、未コミットの差分に対する Stop 時の警告を設定している。

## ライセンス

[MIT License](./LICENSE)
