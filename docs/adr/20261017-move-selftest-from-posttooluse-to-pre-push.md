# 2026/10/17 self-test の自動実行を PostToolUse から pre-push へ移す

## Status

accepted

部分 supersede（2026-10-17、#177）: 「push の前には必ず通る」の条項は [`20261017-run-prepush-checks-for-non-current-branch.md`](./20261017-run-prepush-checks-for-non-current-branch.md) により「push する commit が作業ツリーのとき」に置換（checkout 中でない branch の push では流さず、その旨を表示する）。pre-push で流す・test の見つけ方・入れ子の拒否の条項は存続。

## Situation

「`scripts/` を変更したら必ず self-test を実行する」（`AGENTS.md`）の機械強制は、9/5 の是正（[`20260905-adopt-session-audit-guards-round2.md`](./20260905-adopt-session-audit-guards-round2.md) の #50）で、Claude Code の PostToolUse(Edit / Write / Bash) hook（`scripts/hooks/post-edit-selftest.sh`）が担っていた。self-test は 925 件あり、書き込みごとに同期で全件を流す。

## Context

9/25〜10/16 の対話セッションのログで、この hook は 25 回走り、待ちは中央値で約 60 秒、最長 369 秒だった。同じ script を続けて直すと毎回 1 分以上止まる（#161）。ask の振り分け（#158）や merge の承認（#159）で止まる回数を減らしても、ここの待ちは残っていた。

## Material for decision

- 2026-10-17 の grill（#161 本文「認識合わせの結論」）。
- 却下した案:
  - バックグラウンドで回して失敗を後で知らせる: 失敗の通知が作業の途中に割り込み、どの編集が原因か分からなくなる。
  - 関係する test だけを同期で流す（`run-tests.sh` の分割）: script 間のつながりで起きる退行を見逃す。分割の保守も増える。
  - pre-push で両方の Bash（macOS の 3.2 を含む）を流す: 待ちが倍になる。3.2 での全件は、今どおり merge の条件（PR の前に owner が流す）に残す。

## Decision

- PostToolUse の self-test hook（`post-edit-selftest.sh`・`.py`）をやめて削除する。
- lefthook の pre-push で `scripts/run-selftest.sh` を実行し、既定の bash の self-test を全件流す。push の前には必ず通る。
- test の見つけ方（`SELFTEST_CMD`、`tests/run-tests.sh`、`scripts/tests/*.test.sh`、pytest）は `run-selftest.sh` が持ち、派生 repo でも同じく効く。
- `run-selftest.sh` は `-h` で usage を出し、self-test の中（`PROJECT_TEMPLATE_SELFTEST_RUNNING=1`）から呼ばれたら exit 2 で止まる。self-test は `scripts/` の全 script を `-h` で呼ぶため、`-h` を受けずに全件を始めると無限に再帰する（実際に起きた。`failure-patterns.md`）。

## Consequences

- 編集中の待ちが無くなる（Done When の測定は #161）。
- 退行の検出が編集の直後から push の前に遅れる。commit までは壊れたまま進めるが、push は通らない。壊れた状態で積んだ commit は push の前にまとめて直す。
- `LEFTHOOK_EXCLUDE=selftest` で外せる。常用しない。
- `scripts/` の外の書き込みに依らず、Bash 経由の書き込み判定（`post-edit-selftest.py`、625 行）の保守が無くなる。
- 旧版が user 側に配った PostToolUse の配線は、`setup-user-hooks.sh` の再実行で外れる（配線の正本が `.claude/settings.json` のため）。複製ディレクトリの古い `post-edit-selftest.*` は残るが、配線が無いので実行されない。
