# AGENTS.md

> このファイルが正本。`CLAUDE.md` は本ファイルへのシンボリックリンクで、ツール非依存の AGENTS.md 標準と Claude Code の両方に同じ規約を提供する。

## 目的

このリポジトリの開発における、AIコーディングエージェント／人間共通の運用ガイド。コード変更前の調査・探索・根拠収集の起点として使う。常時読まれる文書なので、各ルールの詳細は正本（スクリプト・docs・SKILL.md）に置き、ここはポインタに留める。

## リポジトリ構成

<!-- 論文和訳エージェント（agent-native / Flue 設計準拠）の構成。 -->
- `src/runtime/` — 薄い自作ランタイム（agent 定義子＋`run()`。Flue の Agent/Workflow 設計準拠）
- `src/agents/` — エージェント定義（`translator.ts` / `evaluator.ts` / `glossary-builder.ts`）
- `src/workflows/` — ワークフロー（素の TS 関数。`Promise.all` / `for` / `if` で配線）
- `src/tools/` — エージェントが使うツール（TS 関数）
- `src/index.ts` — エントリポイント（ワークフロー起動 CLI）
- `input/` — 用語集・スタイルガイド等の知識 SSOT（コミット対象）
- `output/` — 実行証跡（`runs/`）と作業領域（`workspace/`）。runtime 生成物で gitignore
- `docs/` — 設計ドキュメント・運用メモ（ビルド対象外）
- `docs/adr/` — アーキテクチャ決定記録。運用ルールは [`docs/adr/README.md`](./docs/adr/README.md)
- `scripts/` — 規約の検証（commit 件名・branch 名・PR body）と repo 初期設定
- `.github/` — PR / issue テンプレート、ラベル定義（`labels.yml` が正本）、PR 検査 CI
- `.agents/skills/` — 共有 skill（`git-commit` / `manage-adrs` / `sync-docs`）。`.claude` は `.agents` への symlink

## 検索ポリシー

- ファイル探索は `rg --files`、文字列探索は `rg` を優先する。`find` は深さ・種別条件が必要な時だけ使う。
- いきなりリポジトリ全体を走査せず、有力なディレクトリに範囲を絞る。
- ヒット後は対象を絞って読み、必要以上に大きいファイル全体を出力しない。

## 開発フロー

- 原則 **1 タスク = 1 topic branch = 1 PR**。scope が広がるなら branch を広げる前に issue 分割を優先する。
- branch 名は `<type>/<issue番号>-<slug>`（`chore/<slug>` のみ issue なし可）。pre-push フックで検証される。
- 検証（テスト・動作確認）前に PR を開かない。PR は issue と 1 対 1 を基本にする。
- 変更には**テストを伴わせる**。テスト・ビルドのコマンドは「## コマンド」を正本とする。
- issue 起点のタスクでは issue 本文を scope boundary として扱う。
- 決定の背景は [`docs/adr/20260706-adopt-issue-driven-pr-workflow.md`](./docs/adr/20260706-adopt-issue-driven-pr-workflow.md) を参照。

## コミット / PR 規約

- **日本語 Conventional Commits**。形式は `type(任意のscope): 日本語の説明`。許可 type の正本は `scripts/check-commit-msg.sh`。
- PR タイトルも同形式（CI で検査）。PR body に `Closes #<issue>` を書いて issue を閉じる（chore は免除、他の例外は `例外理由:` を明記）。
- commit message の生成手順は `git-commit` skill に従う。

## ADR ルール

- 実装方針に少しでも迷いがあれば、実装前に `docs/adr/README.md` と関連 ADR を確認する（手順は `manage-adrs` skill）。
- アーキテクチャ、外部 API、認証、永続化、セキュリティ、repo-wide なルールに触れる判断では ADR を省略しない。
- 過去 ADR は削除・本文変更しない。決定が変わったら新 ADR を追加し、旧 ADR は `Status` だけ更新する。

## 拡張の作法

- 同じ手順の説明が 3 回目になったら skill 化を検討する（`.agents/skills/`）。
- repo-wide に効く判断は ADR にする（`manage-adrs` skill 参照）。
- 機械的に検証できる規約は scripts に落とし、lefthook / CI に登録する。文書には正本へのポインタだけ残す。

## 編集ガードレール

- 調査タスクは read-only 前提。変更依頼がない限り編集しない。
- docs が不足・矛盾している場合は、修正案より先にギャップを示す。ドリフトの定期検査は `sync-docs` skill で行う。
- UI / UX・文言・操作感に関わる判断は、選択肢を短く説明してユーザーに確認してから固定する。

## コマンド

- `npm install` — 依存の導入（初回）
- `npm test` — vitest 単体テスト（決定的な検査。LLM を含めない）
- `npm run build` / `npm run typecheck` — tsc ビルド / 型チェック（emit なし）
- `npm run dev` — `src/index.ts` を tsx で実行
- `bash tests/run-tests.sh` — 規約検査スクリプト群の self-test（scripts/ を変更したら必ず実行）
- `lefthook install` — commit-msg / pre-push フックを有効化する（初回セットアップ必須）
- `scripts/setup-github-repo.sh [--prune] [--dry-run]` — ラベル同期と squash merge・commit title 固定（repo 作成直後に `--prune` 付きで 1 回。定義外ラベルの削除は `--prune` 時のみ）
- `sync-docs` skill — 文書と実ツリーのドリフトを定期的に検査する
