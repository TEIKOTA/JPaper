# 2026/09/26 二段 PR backlog policy の採用

# Status

accepted

# Situation

未マージ PR の大量滞留を防ぐ単一閾値は、人間レビュー待ちと AUTO merge 可能な PR を同じ圧力で停止させていた。issue #78 の 2026-09-26 ユーザー決定により、暫定の warning / hard stop と見直し条件を採用する。

# Context

既定 3 本は測定で最適化した値ではなく、個人開発向けの調整可能な値だった。上限撤廃には滞留再発のリスクがあり、単一の停止閾値を上げるだけでは早期の注意喚起が失われるため二段に分ける。

# Material for decision

- [issue #78 の User Decision と比較材料](https://github.com/TEIKOTA/project-template/issues/78)
- [運用ガード第 2 弾](./20260901-adopt-session-audit-guards-v2.md)
- [merge authority](./20260918-adopt-ai-merge-authority.md)
- 実行契約の正本: [`check-pr-backlog.sh`](../../scripts/check-pr-backlog.sh)

# Decision

- author `@me` の open PR を draft を含めて数える。6 本以下は PASS、6 本超から 12 本以下は WARN で新規着手を許可、12 本超は exit 2 で新規着手を停止する。警告後は merge・review・一本化を優先する。
- 新規着手入口は `new-branch.sh`。既存 PR の検査・修正・review・merge 準備、`check-pr.sh --backlog` / `--report` は非遮断を維持する。offline / malformed 応答は WARN fail-open とし、PASS と偽らない。理由付き override は hard 超過にだけ適用し、理由を出力へ残す。
- `PR_WIP_WARNING_LIMIT` / `PR_WIP_HARD_LIMIT` でそれぞれを明示上書きできる。未設定側は既定値を使い、各値は 0〜999999 の最大 6 桁の非負整数、warning < hard を検証する。先頭ゼロは十進数として扱う。空値・不正値は拒否するが、report は設定エラーでも非遮断とする。
- 旧 `PR_WIP_LIMIT` だけが設定されている既存利用では、警告付きで従来の単一閾値を維持する（0 を含む、空値は従来同様 3）。新変数のいずれかを設定した場合は二段設定を優先し、旧変数は使わない。互換経路は既存 deployment の停止条件を暗黙に緩和しないために残す。
- 値は暫定値であり、導入後 30 件の PR merge、最古の open PR が 7 日超、導入後 hard stop が 2 回発生、のいずれかで再評価する。運用担当が確認する条件であり、自動監視・永続カウンタは追加しない。
- 旧 ADR は PR 滞留の単一閾値条項のみを部分 supersede する。stack 深さ・他の運用ガードと AUTO / HUMAN 境界は変更しない。この repo-wide policy の最終 PR review と squash merge は人間が行う。

# Consequences

- 短期的な並列処理を許容しつつ、停止前に滞留を可視化できる。閾値が高すぎる／低すぎる場合には運用上の再評価が必要になる。
- 環境変数は session / project deployment の明示 override であり、repo-wide default の永続更新にはならない。
- 同時着手の race、手動 branch / PR、他 author の PR は防げない。server-side の絶対上限ではない。
