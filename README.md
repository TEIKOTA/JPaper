# JPaper

学術論文の**和訳に最適化した決定的専門エージェント**。agent-native な設計原則（**配線はコード・内容判断は LLM**）を土台に、配線は YAML ではなく**素の TypeScript ワークフロー**として書く（Flue の Agent/Workflow 分離を参考に、薄い自作ランタイムで実装）。

採用したアーキテクチャ方針は [`docs/adr/`](./docs/adr/) を参照。

## 何をするか

- **入力**: 学術論文の **LaTeX ソース**（arXiv / zip・tar.gz）を最優先。ソースが無い PDF-only 論文は Phase2（Nougat 等の抽出）で対応
- **出力**: **日本語 PDF**（LuaLaTeX 組版）と、横長（A4 縦 2 枚分）で左=原文／右=和訳の**対訳 PDF**（出力先の直下に `<ID>_<短い英語名>-ja.pdf`・`<ID>_<短い英語名>-bilingual.pdf`。例 `2507.17845_pathorob-ja.pdf`。短い英語名はタイトルの翻訳と同時に LLM が決め、決まらなければ `2507.17845-ja.pdf`。[成果物 PDF の名前 ADR](./docs/adr/20261007-name-deliverable-pdfs-by-id-and-slug.md)。対訳は `--no-bilingual` で作らない。対訳の組版だけが失敗しても run は成功し、`RunSummary.bilingual` とエラー出力に理由が出る。[対訳 PDF ADR](./docs/adr/20261006-bilingual-side-by-side-pdf.md)）。per-paper 用語集（`glossary.md`）・実行証跡を併産
- **品質**: 訳出（`translator`）と品質判定（`evaluator`）を分離。**節ごとの軽い形式検査＋evaluator** と、組み上げてからの **全文組版ゲート** の2層。合格でループを抜け、上限（`MAX_REVISIONS`）超過は明示的失敗（[品質ゲート ADR](./docs/adr/20260708-quality-gate-machine-vs-llm-and-explicit-failure.md) / [2層化 ADR](./docs/adr/20260709-quality-gate-two-layer-and-build-error-triage.md)）

## アーキテクチャ（agent-native / Flue 設計準拠）

- **Agent**（誰が）: `translator`・`evaluator`・`glossary-builder` など。`src/agents/<id>.ts` に定義。薄い自作ランタイムは `src/runtime/`（Flue 設計準拠）
- **Tool**（何ができる）: エージェントが使う TS 関数。実装は `src/tools/`
- **Skill**（何を知っている）: 用語・スタイル規約などの知識は段階開示。`.agents/skills/`
- **Workflow**（配線）: `src/workflows/*.ts` の素の TS 関数で複数エージェントを配線（`Promise.all` / `for` / `if`）。順序・並列・上限は TS が固定し、品質判定は LLM
- **知識 SSOT**: 用語集・スタイルガイド等は `input/` に置く（コミット対象）
- **ファイル配置**: グローバル状態は `~/.jpaper/`（cross-paper 共有の `glossary.db`・設定）、論文ごとの成果物と実行証跡は可視フォルダ `./article/<paper>-ja/`（`source/`・`figures/`・`glossary.md`・`translation/`・`<ID>_<短い英語名>-ja.pdf`・`<ID>_<短い英語名>-bilingual.pdf`・`.run/`）。`--out` で変更可（[UI/配置 ADR](./docs/adr/20260709-user-interface-file-layout-and-cli.md)）

決定性の方針: ループ上限・並列・分岐は素の TS（`for`/`Promise.all`/`if`）、契約検査は zod。品質判定・stuck・介入は LLM。ランタイムは Flue の Agent/Workflow 設計を借りた薄い自作で、将来 durable/観測/多環境デプロイが要れば Flue へ移行できるよう形を寄せる。詳細は [ADR](./docs/adr/20260708-adopt-deterministic-agent-architecture.md) を参照。

## セットアップ

### 前提ツール

- Node.js（22.5 以上）と pnpm（10 以上。`brew install pnpm` か `corepack enable`）— 本体の実行・テスト
- LaTeX（`latexmk`・LuaLaTeX）— 組版
- `gh`（GitHub CLI）— issue / PR の確認・初期設定
- Python 3（`python3`）— hook 設定と一部の self-test
- Ruby（`ruby`）— skill frontmatter の検査
- lefthook — commit-msg / pre-push のローカル hook

```sh
pnpm install
lefthook install   # commit-msg / pre-push フック（未導入なら brew install lefthook）
```

OpenRouter の API キーなどは `.env.example` を `.env` に写して書ける（CLI は作業ディレクトリの、Web は repo 直下の `.env` を読む。シェルの環境変数が優先。詳細は [契約付録 §8](./docs/design/contract-appendix.md)）。

## 使い方

```sh
pnpm dev <arXiv ID|ファイル|ディレクトリ> --provider {ollama|claude|codex|openrouter} [--out DIR] [--no-bilingual] [--no-verify-terms]
```

和訳 PDF（例 `article/2507.17845-ja/2507.17845_pathorob-ja.pdf`）と対訳 PDF（例 `article/2507.17845-ja/2507.17845_pathorob-bilingual.pdf`）のパスを標準出力に、`RunSummary` を JSON で出す。claude・codex では、翻訳の前に用語集の訳を CLI の Web 検索で既存の日本語の用例と照らし、出典の取れた表記に差し替える（取れない語は「未確認」の訳注になる。`--no-verify-terms` で止める。[用語の検証 ADR](./docs/adr/20261013-verify-unconfirmed-terms-with-cli-web-search.md)）。オプションの正本は [契約付録 §5](./docs/design/contract-appendix.md)。

### Web アプリ（検索・翻訳・用語集）

```sh
pnpm dev:web
```

ブラウザで `http://127.0.0.1:5173` を開くと、`article/` の論文と用語集、全体の用語 DB を見られる。用語の行から訳語を直すと、訳文での出現箇所（原文の対応箇所つき）を確かめてから置換し、和訳 PDF と対訳 PDF を組み直す（LLM は使わない。直前の 1 回は元に戻せる）。データの場所は CLI と同じ既定（CWD の `article/` と `~/.jpaper/glossary.db`）で、`JPAPER_ARTICLE_DIR`・`JPAPER_GLOSSARY_DB` で変えられる。`127.0.0.1` だけで待ち受け、認証は持たない。仕様の正本は [契約付録 §9](./docs/design/contract-appendix.md)。

「探す」では手元の論文と arXiv の論文を 1 つの検索欄で探し、未訳の論文は「翻訳する」から翻訳の画面へ送れる（arXiv ID を直接入れてもよい）。「翻訳」では provider・model・effort を毎回指定してジョブのキューに加え、段階・節 n/m・費用・経過時間・ログの末尾を見ながら、待機中・実行中のジョブを取り消せる。翻訳は CLI を子プロセスで動かすので、訳し終えた論文はそのまま一覧と用語集の編集の対象になる。「設定」ではフォームの初期値（未指定なら claude は最新の Sonnet、GPT は最新の Sol を effort medium で使う）と同時に走らせる本数（既定 1 本ずつ、4 本まで）を決め、`~/.jpaper/web-settings.json`（`JPAPER_HOME`）に保存する。ジョブは API のメモリだけに持つので、API を止めると実行中の翻訳も止まる（同じ ID で始め直せば checkpoint から再開する）。翻訳が使う全体の用語 DB は CLI と同じ `JPAPER_HOME/glossary.db`（`JPAPER_GLOSSARY_DB` は翻訳には効かない）。

## コマンド

| コマンド | 用途 |
|---|---|
| `pnpm dev` | エントリ（`src/index.ts`）を tsx で実行 |
| `pnpm dev:web` | Web アプリ（検索・翻訳・用語集の API と画面）を立ち上げる |
| `pnpm build` | `tsc` で `dist/` へビルドし、Web アプリの画面を `apps/web/dist/` へビルド |
| `pnpm typecheck` | 型チェックのみ（emit しない。Web アプリも含む） |
| `pnpm test` | vitest で単体テスト（決定的な検査＝LLM 非含有） |
| `bash tests/run-tests.sh` | 規約検査スクリプトの self-test（`scripts/` を変更したら実行） |
| `scripts/new-branch.sh <type> <issue番号> <slug>` | 規約検証付きで topic branch を作成 |
| `scripts/check-pr.sh [<PR番号>]` | PR タイトル・body・issue 連結のローカル検査（PR 作成・編集後） |

LLM プロバイダは `LlmClient` 境界で差し替え可能。**local=Ollama**、**cloud=公式 CLI subprocess（`claude -p` / `codex exec`）**、**OpenRouter（OpenAI 互換 API）** の 4 実装で、`--provider {ollama|claude|codex|openrouter}` は**必須（既定なし）**。claude と codex は `--model` / `--effort` を CLI に渡し、未指定なら最新の中位モデル（claude は Sonnet、codex は Sol）と effort medium を使う。LLM クライアントは薄い自作ランタイム内に閉じ込める（[プロバイダ ADR](./docs/adr/20260709-llm-provider-abstraction-local-ollama-and-cloud-cli.md)）。

## 開発ルール

運用ガイドは [`AGENTS.md`](./AGENTS.md)（`CLAUDE.md` は symlink）。issue 駆動・PR 必須・日本語 Conventional Commits・ADR による決定記録を最初から機械強制（lefthook + ローカル検査）している。
GitHub Actions は既定オフ（`.github/workflows-disabled/` に退避。[ADR](./docs/adr/20260901-disable-github-actions-by-default.md)）で、検証はローカル script が正本（`bash tests/run-tests.sh` と `scripts/check-pr.sh`）。CI を使う場合は `git mv .github/workflows-disabled .github/workflows` の上で `scripts/setup-github-repo.sh --enable-actions` を実行する（Actions 無効のまま required status checks を設定しない）。
Claude Code 用の権限既定と hook は `.claude/settings.json`（read-only コマンドの allowlist・secret ファイルの Read deny・`scripts/hooks/` の Bash ガード / scripts 編集後の自動 self-test / 未コミット差分の Stop 警告）。

## ライセンス

[MIT License](./LICENSE)
