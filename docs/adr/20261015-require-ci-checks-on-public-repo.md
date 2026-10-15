# 2026/10/15 public の repo では、main への merge に CI の全ジョブの成功を要する

## Status
- accepted
- [`20260706-defer-server-side-branch-protection.md`](./20260706-defer-server-side-branch-protection.md) の「branch protection を見送る」を、public の repo について置き換える（同 ADR の再検討条件「repo を public にする」が成立した）。

## Situation
- JPaper は public の repo で、GitHub Actions を有効にしている（[Actions ADR](./20261014-enable-github-actions-on-public-repo.md)）。public の repo は無料プランでも branch protection を使える。
- merge は root orchestrator が `gh pr merge` で行い、「CI が green」は運用の規律（[merge 権限 ADR](./20260918-adopt-ai-merge-authority.md)）として確かめていた。GitHub 側の強制は無かった。

## Context
- 2026-10-15、merge の後の main への push で node-checks が 2 回落ちていたのに、気づかなかった（#395。原因は署名鍵を並行に作る競合で、PR の CI では当たらなかった）。利用者から「PR の merge は GitHub Actions がすべて緑であることを条件にすればよい」と指摘を受けた。
- 規律だけでは、CI の結果を見ずに merge する誤りを機械的に止められない。

## Material for decision
- 利用者の指示（2026-10-15）。
- `.github/workflows/` のジョブ: node-checks の `node`、pr-checks の `pr-check`、self-test の `test (ubuntu-latest)`・`test (macos-latest)`。どれもすべての PR で走る（パスの絞り込みが無い）。
- 検討した設定:
  - strict（base の最新を取り込んでいることも要する）: 連続して merge するたびに後続の PR の更新が要る。base とのずれは merge 前の `git merge-tree` で確かめているので、採らない。
  - レビューの承認を要する: 開発者は 1 人で、承認者がいない。採らない。

## Decision
- public の repo では、main の branch protection の required status checks に `node`・`pr-check`・`test (ubuntu-latest)`・`test (macos-latest)` を指定し、管理者にも適用する（`enforce_admins`）。strict とレビューの承認は要しない。
- 設定は `scripts/setup-github-repo.sh` が行う（public の repo のときだけ。private の repo は Actions を無効にしているので設定しない）。ジョブを足す・名前を変えるときは、同スクリプトの一覧と self-test を同時に直す。

## Consequences
- 良い面: CI の全ジョブが成功しない限り、`gh pr merge` も main への直接の push も GitHub が拒む。merge する側が CI の結果を見落としても止まる。
- 受け入れたトレードオフ:
  - CI が揺れて落ちると merge できない（揺れを放置しにくくなるので、むしろ望ましい）。
  - merge の後の main への push の CI（並行して走る別の実行）の失敗は、これでは止まらない。merge の後に main の実行の結果を確かめる運用は残す（failure-patterns）。
  - 管理者も含めて止まるので、緊急の修正も CI を通す必要がある。
  - チェックが来ないまま待ち続けるケースがある: head の commit message の `[skip ci]`、初めての外部の contributor の fork からの PR（実行の承認が要る）、issue 側だけを直した後の pr-check（PR のイベントが無いので手動で再実行する）。
  - 必須のチェックの名前は workflow のジョブ名と手で合わせる。ずれると全 PR が止まるので、self-test（`tests/run-tests.sh`）が workflow のジョブ名（matrix の展開を含む）との一致を検査する。
