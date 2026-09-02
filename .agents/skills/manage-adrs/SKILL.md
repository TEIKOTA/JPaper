---
name: manage-adrs
description: Use when implementation direction feels even slightly uncertain, when architecture or repo-wide rules need to be checked against past decisions, or when a new long-lived architectural or process decision should be recorded in docs/adr.
---

# Manage ADRs

Use this skill to consult existing ADRs before architecture-sensitive work and
to create new ADRs when a decision should become part of the project's
decision log.

This skill assumes the ADR workflow under `docs/adr/`.

## ADR Reference Workflow

- 実装方針に少しでも疑問があるなら、先に ADR を確認する。
- まず `docs/adr/README.md` を読み、その論点が本当に ADR の対象かを判定する。
- 次に `rg --files docs/adr` で ADR 一覧を確認し、`rg` で関連キーワードを探す。
- 関連 ADR が見つかったら、決定内容だけでなく `Situation`、`Context`、
  `Consequences` まで読む。
- ADR だけで足りないときは、必要に応じて `docs/` 配下の他文書へ広げる。
- 結論を返すときは、事実と推測を分け、根拠にした ADR を明示する。
- 関連 ADR が見つからない場合は、「未記録であること」を明示する。

## ADR Creation Workflow

- 新しい ADR を作る前に、必ず `docs/adr/README.md`(対象判定=「なぜ ADR を
  書くのか」「運用ルール」、命名、`Status` 語彙=「セクション構成」表の正本)と
  `docs/adr/template.md`(章立ての正本)を読む。対象判定・命名・章構成は
  そこに従い、本 skill には複製しない。
- ADR は仕様書ではなく決定ログとして書く。背景、比較材料、決定、影響を残す。
- 関連する既存 ADR や docs があれば `Material for decision` に含める。
- 作成後は `docs/adr/README.md` の索引に 1 行追加する。

## Updating Existing ADRs

- 過去 ADR の扱い(本文不変・`Status` セクションのみ更新・削除禁止・部分
  supersede の記法)は `docs/adr/README.md`「運用ルール」を正本とし、本 skill
  には複製しない。

## Decision Rule

- 実装前に判断が必要で、その判断が長く効くなら ADR を作る方向で考える。
- その場のローカル実装だけに閉じるなら ADR ではなくコードや仕様に寄せる。
- 「今後この判断理由を誰かが知りたくなるか」を基準に ADR 化を判定する。

## Output Contract

- ADR 参照時は、関連 ADR、そこから読める制約、未解決点を短く整理して返す。
- ADR 作成時は、作成理由、関連 ADR、必要なら `Status` 更新対象を明示する。
- 過去 ADR の `Status` 更新が必要な場合でも、本文変更提案はしない。
