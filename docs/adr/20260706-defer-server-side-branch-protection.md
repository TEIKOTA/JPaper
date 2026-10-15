# 2026/07/06 server-side branch protection の導入を見送る

# Status
- accepted
- 部分 supersede（2026-10-15）: public の repo では「branch protection を見送る」を [`20261015-require-ci-checks-on-public-repo.md`](./20261015-require-ci-checks-on-public-repo.md) で置換（再検討条件の「repo を public にする」が成立）。
- 部分 supersede（2026-09-01）: 強制手段のうち「pr-checks / self-test CI」の条項は [`20260901-disable-github-actions-by-default.md`](./20260901-disable-github-actions-by-default.md) により置換（CI は既定オフとなり、強制手段は lefthook・`scripts/check-pr.sh`・`tests/run-tests.sh`・AGENTS.md の規約）。branch protection を見送る判断・再検討条件の条項は存続。

# Situation
- issue 駆動 PR workflow は「main への direct push 禁止・PR 必須・CI 検査」を宣言しているが、GitHub の branch protection / ruleset は private repo では有料プラン（Pro / Team）を要する。
- 本テンプレートから生まれるプロジェクトは当面 private・個人＋AI 協働・無料プランを前提とする。

# Context
- サーバー側強制が無い場合、main 直 push や required checks の未達 merge は技術的には可能なままになる。
- 一方で、テンプレートの検査は lefthook（commit-msg / pre-push）と GitHub Actions（pr-checks / self-test）で多層化されており、単独開発＋AI 協働の運用では process-enforced でも実効性がある。

# Material for decision
- GitHub Docs: About protected branches / About rulesets（private repo での提供プラン条件）
- `docs/adr/20260706-adopt-issue-driven-pr-workflow.md`
- レビュー指摘: 「main 直 push・PR 必須・required checks はサーバー側で未強制」

# Decision
- branch protection / ruleset の設定は**見送る（defer）**。
- main 直 push 禁止・PR 必須・検査必須は、当面 **process-enforced** として運用する。強制手段は lefthook・pr-checks / self-test CI・AGENTS.md の規約とする。
- 次のいずれかが成立した時点で再検討し、導入する場合は `scripts/setup-github-repo.sh` への組み込みを含めて新しい ADR で決定する。
  - repo を public にする（無料プランでも branch protection が使える）
  - 有料プランへ移行する

# Consequences
- 無料プラン・private repo のまま、追加コストなしで運用を開始できる。
- 規約違反を技術的に完全遮断はできず、意図的な `--no-verify` や main 直 push は運用規律に依存する。この弱さは既知のトレードオフとして受け入れる。
- 再検討条件を明文化したことで、「いつか設定する」が宙に浮かない。
