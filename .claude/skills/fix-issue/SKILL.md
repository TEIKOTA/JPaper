---
name: fix-issue
description: 'Use when starting work on a GitHub issue (e.g. "issue #12 をやって", "#12 に着手") - walks the issue-driven flow in order without skipping steps: read the issue, pre-start duplicate check, branch via new-branch.sh, implement with tests, commit via git-commit skill, open PR and self-check with check-pr.sh.'
arguments: [issue]
argument-hint: "[issue-number]"
---

# Fix Issue

issue 起点タスクの入口。テンプレの既存部品を**順番どおり**踏ませるための手順書。
各手順の正本は括弧内にあり、ここへ複製しない。手順の踏み忘れ（branch 命名破り・
着手前確認の省略・未検証 PR）がエージェント任せになっている問題への対策。

## 手順

1. **issue を読む**: `gh issue view <番号>` で本文・ラベル・コメントを読む。
   issue 本文が scope boundary（AGENTS.md 開発フロー）。
2. **着手前ゲート**: `gh issue list --state all` / `gh pr list --state all` で
   同一テーマが起票後に実装・merge されていないかを確認する（AGENTS.md 開発フロー）。
   実装済み・進行中なら着手せず、その事実を報告して止まる。続けて
   `scripts/check-pr-backlog.sh` を実行し、上限超過なら新規実装でなく merge・review・
   一本化計画を優先する。例外は理由を明記して `--allow-backlog <理由>` を使う。
3. **曖昧さ判定**: 前提の曖昧さが大きければ `grill-me`（仕様文書があるなら
   `grill-spec`）で認識を揃え、結論を issue 本文へ固定してから続行する。
   大きな実装は結論固定後に fresh session で始めるのがよい。
4. **branch 作成**: `scripts/new-branch.sh <type> <issue番号> <slug>`
   （配置・終了・回収の正本は [`worktree lifecycle`](../../../docs/process/worktree-lifecycle.md)。
   既定は fetch 後の `origin/main` から分岐・命名検証込み。並列作業では
   `--worktree <home配下のdir>` を指定できる）。
5. **実装＋テスト**: issue の Done When を満たす変更とテストを書く。
   `scripts/` を変更したら `bash tests/run-tests.sh`（AGENTS.md コマンド）。
6. **commit**: `git-commit` skill で message を生成し、ファイル経由（`-F`）で commit する。
7. **PR**: 検証が終わってから `gh pr create`（body はファイル経由・`Closes #<番号>`）。
   作成後に `scripts/check-pr.sh` で自己検査する。

8. **使用終了**: 修正ラウンド終端で結果・対象 SHA・根拠を worktree 外へ保存し、
   `scripts/worktree.sh end` の明示終了記録と `candidates` の保護理由を報告する。
   使用終了と回収は別。child は root の現物・session/job 終了確認へ返し、自分で回収しない。

## 途中判断

- 止まるか進むかの判定は `decide-or-proceed` skill の 4 条件に従う。
- scope が issue 本文を超えそうになったら、branch を広げずに issue 分割を提案する
  （AGENTS.md 開発フロー）。
