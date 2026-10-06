# 2026/10/06 worktree 標準配置へのエージェント作業許可の採用

## Status
- accepted

[`20261002-adopt-worktree-lifecycle-management.md`](./20261002-adopt-worktree-lifecycle-management.md) の標準配置 `~/worktrees/<repo>/` は変えない。その配置先へのアクセス許可だけを追加する。

## Situation
- 2026-10-06、ユーザーが「worktree 外での commit などで毎回選択を求められる」と指摘し、`grill-me` の認識合わせサマリに「合意」と回答した（issue #110）。
- 同日、派生 repo で Codex が一時領域に worktree を作り、成果物が散逸した事故への対処（#108 / PR #109）を進めていた。

## Context
- Claude Code は、セッションの作業ディレクトリと `additionalDirectories` の外にあるパスの編集で承認を求める。標準配置の worktree は、親 checkout から見て常に外にある。
- Codex の sandbox（workspace-write）が書けるのは、作業中の repo・`/tmp`・`$TMPDIR` と `writable_roots` だけ。`~/worktrees` に書けないことが、一時領域を選ばせた誘因と推測している。
- Codex は `.git` を書き込み禁止にしていると推測している。根拠は、sandbox 内で branch 作成が ref lock の書き込み失敗で止まった記録（failure-patterns 2026-09-20）と、sandbox ポリシーに除外 subpath の指定があること。そうだとすると、commit や branch 作成は、どの配置でも承認が要る。

## Material for decision
- Claude Code docs（permissions）: "However you add a directory, Claude can read and edit files in it"。`additionalDirectories` で追加した場合、CLAUDE.md・rules・skills は読み込まれない。
- Codex 0.160.0 の `config.toml` の `[sandbox_workspace_write]`（`writable_roots`、`exclude_slash_tmp = false`、`exclude_tmpdir_env_var = false`）。
- 比較した案は次の4つ。
  1. 設定で許可する（本決定）
  2. repo 内の `.worktrees/` へ移す（gitignore）
  3. 両方
  4. 現状維持
  - 案 2 は、両ツールとも作業ディレクトリ内になる点が優れる。一方で、ADR 20261002 の部分 supersede が必要になる。repo 本体を削除すると worktree も消え、`git clean -ffdx` でも消える（`-fdx` は「repository なのでスキップ」で残ることを実測）。

## Decision
- 配置は `~/worktrees/<repo>/` のまま維持する。
- `scripts/setup-user-hooks.sh --worktree-access` で、次の2つに `~/worktrees`（`PROJECT_TEMPLATE_WORKTREES_DIR` で変更可）を冪等に追加する。`--uninstall` で、この path だけを外す。
  - Claude: `permissions.additionalDirectories`
  - Codex: `[sandbox_workspace_write].writable_roots`
- 設定の正本は setup script とする。手動編集や repo 側の settings にはしない。`config.toml` は行単位の最小編集とし、書き込み前に他の設定が変わらないことを `tomllib` で確かめる。
- 理由: ADR の変更なしで、すぐに元に戻せる。まず承認プロンプトが減るかを観測し、不十分なら案 2 を改めて判断する。

## Consequences
- 良い面:
  - `~/worktrees` 配下の Edit/Write が、Claude では作業ディレクトリ内と同等になる。
  - Codex の sandbox は `~/worktrees` 配下を編集でき、一時領域を選ぶ必要がなくなる。
  - 設定は再現でき、元にも戻せる。
- 受け入れたトレードオフ:
  - Codex の sandbox が、`~/worktrees` 配下のすべての repo の worktree（現在の作業と別の repo を含む）に書けるようになる。sandbox の権限を広げる変更なので、適用はユーザーが setup を実行して行い、PR は HUMAN merge とする。
  - auto mode の分類器は `additionalDirectories` とは独立に判定するため、プロンプトが 0 になる保証はない。
  - Codex の `.git` 書き込み禁止による commit 等の承認は残る。
- 観測方法: 適用後のセッションで `~/worktrees/...` 配下の編集に承認が出ないこと。Codex で `~/worktrees` 配下の編集が sandbox 内で通ること。
