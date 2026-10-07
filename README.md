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

- Node.js（22.5 以上）と npm — 本体の実行・テスト
- LaTeX（`latexmk`・LuaLaTeX）— 組版
- `gh`（GitHub CLI）— issue / PR の確認・初期設定
- Python 3（`python3`）— hook 設定と一部の self-test
- Ruby（`ruby`）— skill frontmatter の検査
- lefthook — commit-msg / pre-push のローカル hook

```sh
npm install
lefthook install   # commit-msg / pre-push フック（未導入なら brew install lefthook）
```

## 使い方

```sh
npm run dev -- <arXiv ID|ファイル|ディレクトリ> --provider {ollama|claude|openrouter} [--out DIR] [--no-bilingual]
```

和訳 PDF（例 `article/2507.17845-ja/2507.17845_pathorob-ja.pdf`）と対訳 PDF（例 `article/2507.17845-ja/2507.17845_pathorob-bilingual.pdf`）のパスを標準出力に、`RunSummary` を JSON で出す。オプションの正本は [契約付録 §5](./docs/design/contract-appendix.md)。

## コマンド

| コマンド | 用途 |
|---|---|
| `npm run dev` | エントリ（`src/index.ts`）を tsx で実行 |
| `npm run build` | `tsc` で `dist/` へビルド |
| `npm run typecheck` | 型チェックのみ（emit しない） |
| `npm test` | vitest で単体テスト（決定的な検査＝LLM 非含有） |
| `bash tests/run-tests.sh` | 規約検査スクリプトの self-test（`scripts/` を変更したら実行） |
| `scripts/new-branch.sh <type> <issue番号> <slug>` | 規約検証付きで topic branch を作成 |
| `scripts/check-pr.sh [<PR番号>]` | PR タイトル・body・issue 連結のローカル検査（PR 作成・編集後） |

LLM プロバイダは `LlmClient` 境界で差し替え可能。v1 は **local=Ollama** と **cloud=公式 CLI subprocess（`claude -p`）** の2実装で、`--provider {ollama|claude}` は**必須（既定なし）**。OpenRouter / API キーは将来の実装オプション。LLM クライアントは薄い自作ランタイム内に閉じ込める（[プロバイダ ADR](./docs/adr/20260709-llm-provider-abstraction-local-ollama-and-cloud-cli.md)）。

## 開発ルール

運用ガイドは [`AGENTS.md`](./AGENTS.md)（`CLAUDE.md` は symlink）。issue 駆動・PR 必須・日本語 Conventional Commits・ADR による決定記録を最初から機械強制（lefthook + ローカル検査）している。
GitHub Actions は既定オフ（`.github/workflows-disabled/` に退避。[ADR](./docs/adr/20260901-disable-github-actions-by-default.md)）で、検証はローカル script が正本（`bash tests/run-tests.sh` と `scripts/check-pr.sh`）。CI を使う場合は `git mv .github/workflows-disabled .github/workflows` の上で `scripts/setup-github-repo.sh --enable-actions` を実行する（Actions 無効のまま required status checks を設定しない）。
Claude Code 用の権限既定と hook は `.claude/settings.json`（read-only コマンドの allowlist・secret ファイルの Read deny・`scripts/hooks/` の Bash ガード / scripts 編集後の自動 self-test / 未コミット差分の Stop 警告）。

## ライセンス

[MIT License](./LICENSE)
