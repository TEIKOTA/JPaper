# AI セッション運用ガード（重複確認・失敗ログ・worktree/待機規律）の採用

## Status

accepted

部分 supersede: 新規 worktree の home 配下の配置条項を [`20261002-adopt-worktree-lifecycle-management.md`](./20261002-adopt-worktree-lifecycle-management.md) の標準配置・例外規約で置換する。一時領域への配置禁止、待機規律、重複確認・失敗ログの条項は存続する。新方式の実装は後続 issue #105 で行う。

2026-10-14 部分 supersede: 置換された条項 = 新規 worktree の標準配置・例外規約（20261002 で置換済みの方式を含む）/ 存続する条項 = 一時領域への配置禁止、待機規律、重複確認・失敗ログ / 後継 ADR = [`20261014-remove-worktree-lifecycle-management.md`](./20261014-remove-worktree-lifecycle-management.md)。

## Situation

本 template は AI コーディングエージェントとの協働を前提にした汎用の土台であり、生成されたプロジェクトでは複数の AI セッション（および人間）が並行して issue 起票・実装・レビューを行う。母体プロジェクト（Nowflo）での数週間の運用から、環境やワークフローに起因する失敗クラスとその対策が実測付きで蓄積された。

## Context

template に予防線が無いままだと、生成されたどのプロジェクトでも同じ失敗を最初から踏み直すことになる。実測された失敗クラスは 3 つ:

1. **重複起票・重複実装**: 並行セッションが同一テーマを検索せずに起票・着手する。母体では起票から 50 分以内に別セッションが同じテーマの実装を始めた前例がある。
2. **失敗の揮発**: 想定外の失敗（環境の罠・ツールの誤用・誤診断）が会話ログにしか残らず、セッションを跨いで再発する。
3. **環境と待機の浪費**: macOS は `/tmp` / `/private/tmp` / `$TMPDIR`（`/var/folders/<...>/T/`）を掃除するため、そこに置いた git worktree が未 push commit ごと消える（実発生・復旧作業あり）。また長時間ジョブの完了を AI がフォアグラウンドの即興ポーリングで待ち、モデル往復と待機を浪費する（母体実測: poll 系呼び出し 341 回・約 118 分）。

## Material for decision

- 母体プロジェクトの採択記録: parallel-work coordination gates（2026-07-26）/ failure-patterns as log（2026-07-25）/ home-scoped worktree root（2026-07-26）
- 母体の `scripts/wait-for-marker.sh`（待機ループを script に閉じる対策の実装）とセッション log 実測
- [`20260706-adopt-issue-driven-pr-workflow.md`](./20260706-adopt-issue-driven-pr-workflow.md)（本 template の issue 駆動ワークフロー。ガード 1 はその起票手順の拡張）

## Decision

以下 3 つの運用ガードを template 標準として採用する。導入は issue #7 / #8 / #9 の 3 PR に分割する。

1. **起票前の重複確認ゲート**: issue テンプレート（feature-request / bug-report / sub-issue）に「重複確認」節を設け、起票前に `--state all` で既存 issue / PR を検索して記録する。空の記録はゲート未実施とみなす。着手前にも直近の merge と同一テーマの open PR を確認する。
2. **失敗の記録ログ**: `docs/process/failure-patterns.md` を「作業前に読むカタログ」ではなく append-only の記録ログとして置く。想定外の失敗はその場で 1 行追記（根拠必須）し、対策はログの精読ではなく昇華先（① scripts / 設定への自動化 ② 該当 skill / 手順文書 ③ `AGENTS.md`）が担う。
3. **worktree 配置と待機の規律**: git worktree を macOS が掃除する一時領域に作らず home 配下に置く。長時間ジョブの完了待ちは、バックグラウンド実行の完了通知か `scripts/wait-for-marker.sh` の 1 回呼び出しに集約し、フォアグラウンドのポーリング waiter を即興実装しない。

## Consequences

- 良い面: 母体で実害・実測に基づいて検証済みの対策を、生成直後のプロジェクトが最初から持てる。重複確認は空欄の有無で機械的に監査できる。
- トレードオフ: 起票の手間が 1 節分増える。失敗ログは記録が習慣化しないと空文書になる（AGENTS.md の規約行と `sync-docs` の存在検査で担保する）。`scripts/` の責務が「規約検証と初期設定」から運用ユーティリティ（waiter）へ 1 本広がる（README に役割を明記する）。
- ガードの文言・置き場所の詳細は各正本（issue テンプレート・`docs/process/failure-patterns.md`・`AGENTS.md`・`scripts/wait-for-marker.sh`）が持ち、本 ADR は採用判断のみを固定する。
