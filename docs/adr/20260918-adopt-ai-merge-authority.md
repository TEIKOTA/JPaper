# AI の merge authority と human review boundary の採用

## Status

accepted

## Situation

小さい PR を並行しても、すべてを人間が同じ深さでレビューすると人間の merge 待ちが直列化要因になる。一方、別 context の AI reviewer は機械検査や独立した異論の提示には使えても、仕様・製品意図・知覚品質・security / trust boundary に対する人間の意味判断を代替しない。

2026-09-17、ユーザーは stacked PR を使い、ユーザー判断が不要な PR に限って root orchestrator が squash merge する方針を決定した。writer / reviewer / root orchestrator の権限境界と、親を squash merge した後の child の再検証手順を repo-wide に固定する必要がある。

## Context

- PR #68 までの運用では、実装・独立レビュー・検証を終えた機械的変更も人間の merge 待ちになった。
- GitHub Actions は既定オフであり、merge gate の正本はローカル検証である（[`20260901-disable-github-actions-by-default.md`](./20260901-disable-github-actions-by-default.md)）。
- 運用ガード第 2 ラウンドは AI の merge を条件付きで許可するユーザー決定と、stack 深さ・post-PR gate の機械化方針を記録したが、AUTO / HUMAN の境界と権限主体は未定義だった（[`20260905-adopt-session-audit-guards-round2.md`](./20260905-adopt-session-audit-guards-round2.md)）。
- open PR 3 本は、#20 で Claude が提案し、PR #33 / commit `047e496` で採用された個人開発向けの調整可能な default であり、今回の明示的なユーザー決定ではない。2026-09-20 の PR #73 review comment を受け、閾値の再評価は本 issue / PR から切り離し、HUMAN issue [#78](https://github.com/TEIKOTA/project-template/issues/78) で扱う。
- issue #56 は当初 #61 を parent とする stack を予定した。#61 / PR #70 が先に main へ squash merge されたため、本決定はその schema を含む main を直接 base とする。

## Material for decision

- [issue #56](https://github.com/TEIKOTA/project-template/issues/56) の 2026-09-17 ユーザー決定と確定済み scope
- [issue #20](https://github.com/TEIKOTA/project-template/issues/20)、[PR #33](https://github.com/TEIKOTA/project-template/pull/33)、[commit `047e496`](https://github.com/TEIKOTA/project-template/commit/047e496e83f22565cd5b1239e69b2b41cb2f7479) の open PR default 導入経緯
- 二段 backlog policy の判断を分離した HUMAN issue [#78](https://github.com/TEIKOTA/project-template/issues/78)
- open PR 件数の backlog policy の正本である [`scripts/check-pr-backlog.sh`](../../scripts/check-pr-backlog.sh)
- 動画「AIの出力をレビューするのがしんどい問題」の次の要旨（local ASR で該当時刻を照合）
  - 23:08–25:20: 機械で再現できる検査と、仕様・顧客ニーズ・テストの妥当性・製品意図など人間が見る意味判断を分ける
  - 31:03–32:31: 機械検査を hook 等の自動 gate にし、通過しない変更を main に入れない
  - 46:59–48:53: 別モデルのレビューは参考にはなるが、人間 reviewer の代替にはならない
  - 53:51–54:52: 全自動化の可否は agent への trust に依存し、security は失敗後では遅い境界である
- [`20260901-adopt-session-audit-guards-v2.md`](./20260901-adopt-session-audit-guards-v2.md)
- [`20260905-adopt-session-audit-guards-round2.md`](./20260905-adopt-session-audit-guards-round2.md)
- [`20260901-disable-github-actions-by-default.md`](./20260901-disable-github-actions-by-default.md)

## Decision

### 判定主体と原則

- writer と reviewer は merge しない。root orchestrator だけが AUTO / HUMAN を判定し、条件を満たす PR を merge できる。
- AI reviewer は fixed head SHA を別 context から検証し、blocking finding の有無を root orchestrator へ返す。HUMAN 判断の代替にはしない。
- 迷う場合は HUMAN とする。HUMAN 判断は可能なら issue / ADR の scope 確定時に前倒しし、判断済み scope に閉じた機械的な実装 PR を毎回 HUMAN へ戻さない。

### AUTO squash merge の必要条件

root orchestrator は、次を**すべて満たす** PR だけを、人間の都度承認なしで squash merge してよい。

1. ユーザーが当該 run を自律実行として明示している。
2. issue 本文で仕様・非目標・成功条件が確定し、PR に未解決の意味判断が残っていない。
3. 変更が機械的に再現可能な領域（test / lint / type / dependency / 既知 pattern / deterministic guard / docs pointer）に閉じる。
4. issue scope、関連 ADR、実 diff が一致する。
5. fixed head SHA を writer と別 context の reviewer が確認し、blocking finding がない。
6. `bash tests/run-tests.sh` と `/bin/bash tests/run-tests.sh` が green である。
7. bug / guard 変更では、守る対象を外した退行注入の red と復元後の green がある。
8. `scripts/check-pr.sh <PR番号>`、`git diff --check`、merge-tree が green である。
9. merge 直前に head SHA 不変、base、open issue / PR、未解決 comment を live 確認する。
10. 知覚成果物、外部副作用、課金、secret / permission / security trust boundary、破壊的データ変更を含まない。

### HUMAN decision が必要な条件

次の**いずれか**を含む場合、AI review は参考に留め、人間の判断を merge 条件にする。

1. 仕様・ユーザーニーズ・非目標・製品意図と実世界の意味的整合が未確定である。
2. テストが正しい invariant を表すか自体が新しい判断で、承認済み issue scope から決まらない。
3. UI / UX / 文言 / レンダ / PDF などの知覚品質を扱う。
4. authentication / authorization / secret / permission / security posture を扱う。
5. 外部 API / provider / 課金 / quota / 公開・送信・削除などの外部影響を伴う。
6. repo-wide の authority / governance / retention / canonical history を変更する。
7. 手動確認しかなく、結果を独立再現できない。

### Stacked PR の統合手順

1. open PR 件数は [`scripts/check-pr-backlog.sh`](../../scripts/check-pr-backlog.sh) の backlog policy に従い、stack は parent + child の深さ 1 までにする。
2. child PR の base は直接の parent branch とする。review は immediate-base の fixed parent head SHA と fixed child head SHA の差分だけを対象にし、両 SHA を記録する。
3. parent を先に squash merge する。
4. parent merge 後は新しい `main` を child branch へ通常 mergeし、履歴書換えをしない。child-only diff を保持できない場合は、新しい branch / PR を作り直す。
5. main 統合後の child は、更新後の fixed SHA review、両 Bash の tests、issue 固有検証、`scripts/check-pr.sh`、merge-tree、live base / head 確認を再実行する。
6. force push / force-with-lease は使わない。

完全な機械強制は #53 / #54 の補助 gate に委ねる。個別 issue へ恒久的な AUTO / HUMAN label を付けず、着手時の live scope で判定する。GitHub Actions / branch protection の再導入と、[#78](https://github.com/TEIKOTA/project-template/issues/78) が扱う backlog の default 閾値の再設計は本決定に含めない。

## Consequences

- 良い面: 人間は実世界との意味的整合や trust boundary に判断時間を使い、再現可能な検査に閉じた PR は root orchestrator が詰まりを解消できる。
- 良い面: writer / reviewer / merger を分離し、AI reviewer の所見を権限付与と混同しない。
- トレードオフ: AUTO の全条件を満たす証拠収集と merge 直前の live 再確認が必要になる。条件が一つでも欠ければ HUMAN へ倒れる。
- トレードオフ: parent の squash merge 後は child の SHA が変わるため、通常 merge 後の child を新しい対象として再レビュー・再検証する必要がある。
- 本 ADR 自身は repo-wide authority / governance を変更するため HUMAN に分類する。issue #56 の初回 PR は root orchestrator も自動 merge せず、人間の判断を待つ。
