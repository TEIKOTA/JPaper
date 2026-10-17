# 2026/10/14 worktree 管理の撤去と、残す guard の範囲

## Status
- accepted
- 「新しい worktree を作らない」を、Linux で動かない repo の宣言つき worktree について [`20261017-allow-orb-start-and-declared-worktree-exception.md`](./20261017-allow-orb-start-and-declared-worktree-exception.md) で部分 supersede

[`20261002-adopt-worktree-lifecycle-management.md`](./20261002-adopt-worktree-lifecycle-management.md) と [`20261008-allow-root-owned-worktree-reclaim-after-pr.md`](./20261008-allow-root-owned-worktree-reclaim-after-pr.md) を置き換える（両 ADR は `superseded`）。[`20260729-adopt-ai-session-operational-guards.md`](./20260729-adopt-ai-session-operational-guards.md) の一時領域への worktree 作成禁止は存続する。[`20261006-allow-agent-access-to-worktree-root.md`](./20261006-allow-agent-access-to-worktree-root.md) も存続する。

## Situation
- 2026-10-08 の [`20261008-adopt-container-isolated-agent-sessions.md`](./20261008-adopt-container-isolated-agent-sessions.md) で、新しい委譲・並行作業は子のコンテナで行うことにした。ホストは新しい worktree を作らない。
- 2026-10-13、ユーザーが #131 の振り分けで、worktree 管理を「休眠させて残す」ではなく「撤去する」と決めた（issue #139）。
- ホストの owner は既存の worktree（WordinCard の `~/worktrees/WordinCard/` 配下 3 件など）をまだ使っている。

## Context
- `scripts/worktree.sh`・`scripts/lib/worktree.py`・それらの test・仕様書・証跡は、コンテナへ移した後は使われない。保守の対象と、常時読まれる文書の量だけが残る。
- guard には 2 種類の守りが混ざっていた。(1) 一時領域に worktree を作ると、OS の掃除で未 push の commit ごと消える事故を防ぐ守り（ADR 20260729）。(2) worktree 管理の仕組みを成り立たせるための守りと例外（作成先を標準配置に限る拒否、`worktree.sh reclaim` を承認なしで通す例外）。(2) は管理の仕組みが無くなれば根拠を失う。(1) は管理とは別の防御で、根拠が残る。

## Material for decision
- issue #139 本文の「決定事項（2026-10-13 grill-me / grill-spec）」。
- `docs/process/failure-patterns.md` の、一時領域 worktree による消失の行（過去の事故。履歴として変えない）。

## Decision
- 撤去する: `scripts/worktree.sh`、`scripts/lib/worktree.py`、`tests/worktree-lifecycle.py`、`tests/run-worktree-validation.py`、`docs/process/worktree-lifecycle*`（仕様書・棚卸し・証跡）、`scripts/new-branch.sh --worktree` と管理 option、`session-start.sh` の worktree 使用状態の節、`fix-issue` skill の手順 8、`delegate-work` skill の worktree の手順。
- guard の例外を外す: 作成先を `~/worktrees/<repo>/` に限る拒否、`worktree.sh` 経由で承認なしに回収する例外（`managed_reclaim_authority`）と reclaim 文字列の ask。
- guard に残す: 一時領域（`/tmp` 等）への worktree 作成の拒否（Bash guard・Codex guard・git の post-checkout guard）、作成先を変数で書いたときの拒否、`git worktree remove` / `move` / `prune` の確認（破壊的な操作は提案のみ、という AGENTS.md の規則による）。
- 残す: `setup-user-hooks.sh --worktree-access`（既存の worktree で作業するのに要る。既存の worktree がなくなったら別の issue で外す）。
- 触らない: 既存の worktree の実体と `~/worktrees/.state/`。消すかどうかは、対象を列挙してユーザーが決める。
- 委譲・並行作業はコンテナ（agent-box）に一本化する。

- 一時領域の判定は、作成先を実効の cwd（`git -C`・先行する `cd` を反映）基準で正規化し、symlink を解決した実体でも照合する（`/tmp`・`/private/tmp`・`/var/folders`・`/private/var/folders`）。コマンド置換を含む `git worktree add` と、行き先の分からない `cd` の後の相対 path は拒否する。標準配置の限定が担っていた網の代わり（PR #145 の独立レビュー B1）。

## Consequences
- 良い面: 保守する script・test・常時読まれる文書が減る。guard から、管理の仕組みに依存する例外が消える。
- トレードオフ: 既存の worktree の終了記録・回収の自動判定は使えなくなる。後始末は `git worktree remove` で行い、guard が毎回確認する。標準配置の外にも worktree を作れるようになる（一時領域の外なら拒否しない）。
- 派生 repo: 次のテンプレート更新で上記のファイルが消え、guard の挙動が変わる。派生 repo が `worktree.sh` を呼ぶ自前の手順を持つ場合は、更新前に外す。`~/worktrees/.state/` に残る管理状態は参照されなくなる。
