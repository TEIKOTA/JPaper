# 2026/10/07 パッケージ管理を npm から pnpm に移す

# Status
- accepted

# Situation
- 用語集の Web アプリ（Vite＋React の画面と、core を直接呼ぶ小さな Node API）を同じ repo に置くことになった（2026-10-07 のユーザー判断）。repo を落とした人が `pnpm dev` でローカルに立ち上げ、自分で改造できることが要件。
- それまでの repo は npm 前提（`package-lock.json`、AGENTS.md・README のコマンド、CI、`.claude/settings.json` の許可ルール）で、workspace も無かった。

# Context
- [UI・ファイル配置 ADR](./20260709-user-interface-file-layout-and-cli.md) の決定 4 は「GUI は core の薄い皮。技術は実装フェーズで選ぶ」。画面と API を core と同じ repo の別パッケージに分けるには workspace が要る。
- npm にも workspaces はあるが、ユーザーは pnpm での運用を選んだ。

# Material for decision
- ユーザー判断（2026-10-07）: パッケージ管理は pnpm に移る（npm のままとする案は採らない）。
- 移行の実測: `pnpm import` で `package-lock.json` から `pnpm-lock.yaml` を作り、直接の依存（typescript 5.9.3・vitest 2.1.9・tsx 4.23.0・zod 3.25.76・@types/node 22.20.1）と esbuild・vite の版が移行前と一致した。`pnpm install --frozen-lockfile` → test・typecheck・build が通った。

# Decision
- パッケージ管理を pnpm にする。`package.json` の `packageManager` に版を固定し（`pnpm@10.30.3`）、ロックファイルは `pnpm-lock.yaml` だけを持つ（`package-lock.json` は削除）。
- コマンドの正本は `pnpm install` / `pnpm test` / `pnpm typecheck` / `pnpm build` / `pnpm dev`（AGENTS.md「## コマンド」）。CI は `corepack enable` で `packageManager` の版の pnpm を使う。
- pnpm 10 は依存の install script を既定で実行しないので、実行してよいものを `pnpm.onlyBuiltDependencies` に明示する（esbuild）。
- workspace の構成（`pnpm-workspace.yaml`・`apps/web`）は Web アプリの実装で決める。

# Consequences
- 良い面: Web アプリを workspace の別パッケージとして足せる。`pnpm dev` で画面と API を一緒に立ち上げられる。
- トレードオフ:
  - 開発者は pnpm（または corepack）を入れる必要がある。
  - 既存の worktree の `node_modules`（npm で入れたもの）は使い回せないので、各 worktree で `pnpm install` が要る。
  - 過去の ADR の本文に残る npm のコマンド表記は変えない（ADR は本文を変更しない規則）。
