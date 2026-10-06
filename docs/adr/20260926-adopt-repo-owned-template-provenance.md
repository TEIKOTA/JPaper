# 2026/09/26 repo 内 producer による template provenance の採用

## Status

accepted

## Situation

README と旧 ADR は `.template-version` の生成を約束していたが、repo 内に producer が無く、
GitHub template 作成でも記録されるように読めた。2026-09-26、ユーザーは #94 で契約の維持、
対応作成経路、local read-only 比較、失敗時の扱いを明示承認した。

## Context

由来を推測すると誤った起点の差分を示す。派生 repo は独自に育つため、upstream の差分を
確認することと適用状態を判定することは別である。offline、移動した取得元、shallow /
partial clone でも、不足を隠さず説明できる必要がある。

## Material for decision

- [issue #94 の User Decision と失敗時の扱い](https://github.com/TEIKOTA/project-template/issues/94)
- [旧 provenance / 手動更新 ADR](./20260706-adopt-template-versioning-and-update-strategy.md)
- [README の作成・比較手順](../../README.md)
- [sync-docs](../../.claude/skills/sync-docs/SKILL.md)

## Decision

- `.template-version` を維持し、producer を repo 内の `scripts/new-project.sh` とする。
  利用者が指定した local Git repo または明示 URL の commit を完全 SHA に解決し、その
  同一 commit の追跡済み snapshot から新規 directory を生成する。dirty / untracked と
  `.git` は含めず、実行属性と symlink は保持する。submodule は未対応として拒否する。
  URL 経路の fetch は明示操作であり、local 経路では fetch しない。
- producer と validator の正本を `scripts/lib/template-provenance.py` に置く。
  metadata は JSON schema v1 の `schema_version`、`source`、`revision`、`fetched_at`。
  `revision` は完全 SHA、日時は timezone 付き ISO 8601 とする。shell として評価せず、
  旧・未知の形式は推測変換しない。snapshot 内の古い metadata（symlink / directory を含む）
  は引き継がず、producer 自身が新しい通常ファイルを記録する。
- GitHub template 作成・手動コピーは由来不明とする。repo 名、remote、ファイルの類似性で
  派生と判定しない。有効な metadata は由来の申告であり、作成経路の署名・真正性の証明ではない。
- `scripts/template-diff.sh` は、利用者が明示した local source repo だけを読む。
  記録の `source` から取得しない。記録 SHA → 指定 commit（既定: local HEAD）の upstream
  差分を示し、派生先の一致・全適用済みを断定しない。取得元が移動しても commit があれば比較可能。
  fetch / lazy fetch、更新適用、metadata 更新は行わない。
- 既存出力先は種類を問わず上書きせず拒否する。生成失敗は理由を表示する。出力作成後の
  I/O 失敗では部分出力が残る可能性があり、自動削除・既存先への再試行を行わない。
  比較時は metadata 欠落・不正・未対応形式や必要 commit / object 不在を理由付き
  「比較不能」（exit 2）にし、sync-docs の他項目は継続する。
- 旧 ADR の生成経路・記録形式・全生成 project への保証・metadata 内コメントによる注意を
  本決定と README の説明へ置き換える。opt-in・必要 hunk の手動適用・`revision` /
  `fetched_at` の手動更新・自動再レンダリング不採用・main 配布可能性は存続する。

## Consequences

対応 producer の生成 snapshot と記録 SHA が一致し、比較が network に依存しなくなる。
一方、由来不明の既存 project は自動復元できず、必要 commit は利用者が用意する。
metadata の手動更新後も、その SHA は比較起点であって全 hunk 適用済みを証明しない。
契約を README・skill・実装・fixtures と同じ PR で更新し、最終の文言・表示確認と merge は
HUMAN review を待つ。
