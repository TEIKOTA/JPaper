# 2026/07/06 issue 駆動・PR 必須の開発ワークフローの採用

# Status
- accepted

# Situation
- 本プロジェクトは個人＋AI エージェント協働での開発を前提とし、開発の初期段階から履歴の透明性と変更境界の明確さを確保したい。
- AI にタスクを渡す際、scope が曖昧だと過剰な再設計や文脈逸脱が起きやすく、変更単位・レビュー単位・rollback 単位を揃える仕組みが必要である。

# Context
- タスク管理・変更管理の単位が定まっていないと、main へ直接 push した変更や複数論点が混ざった大きな差分が生まれ、後からの追跡と巻き戻しが難しくなる。
- issue → branch → PR → merge の対応関係を最初に固定しておくことで、人間と AI のどちらが作業しても同じ管理単位で進められる。

# Material for decision
- 先行プロジェクト Nowflo の運用実績（issue-driven backlog 管理と PR 必須 workflow の 2 ADR を汎用化）
- GitHub Flow（topic branch + PR + squash merge）の一般的な運用
- `docs/adr/20260706-adopt-commit-and-pr-message-convention.md`

# Decision
- タスクは原則 GitHub issue を起点にし、**1 task = 1 topic branch = 1 PR** で進める。scope が広がる場合は branch を広げる前に issue 分割を優先する。
- issue は 1 つの振る舞い・1 つの決定・1 つの bounded change に絞り、`Scope` / `Out of Scope` / `Done When` を持たせる（`.github/ISSUE_TEMPLATE/` 参照）。
- `main` への direct push は行わず、すべての変更は PR を経由する。GitHub plan が許すなら branch protection を設定し、許さない場合も process-enforced として運用する。
- merge は squash merge のみとする（設定は `scripts/setup-github-repo.sh` で適用）。
- branch 名は commit type と完全に統一し、`<type>/<issue番号>-<slug>` とする（許可 type の正本は `scripts/check-commit-msg.sh`）。
  - 例: `feat/12-login-screen`、`fix/34-timeout`
  - 例外として `chore/<slug>` のみ issue 番号なしを公認する（typo 修正・依存更新などの定常メンテ用レーン）。
  - 命名は lefthook pre-push の `scripts/check-branch-name.sh` で検証する。
- PR body には `Closes #<issue>` 等の close keyword を必須とする。chore PR は免除、それ以外で issue を閉じない場合は `例外理由:` を明記する（CI の `scripts/check-pr-body-close.sh` で検証）。
- Nowflo が採っていた `feature/` `hotfix/` 等の独自 branch taxonomy は採用しない。commit type と branch prefix の二重分類を避け、語彙を 1 系統に保つためである。緊急修正は `fix/` で扱う。

# Consequences
- issue / branch / PR / merge の対応関係が揃い、AI へタスクを渡す単位と rollback 単位が安定する。
- branch prefix と commit type が同一語彙になり、規約の学習・検証コストが下がる。
- 小さな修正でも issue または chore レーンの判断が必要になり、直接 push に比べ手数は増える。そのトレードオフとして履歴の透明性を得る。
- chore レーンは issue 追跡を免除する抜け道でもあるため、機能変更を chore に紛れ込ませない規律が必要である。
