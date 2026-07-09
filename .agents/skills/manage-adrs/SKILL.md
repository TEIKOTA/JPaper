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

- 新しい ADR を作る前に、必ず `docs/adr/` の adopt-adr-format ADR
  （`*-adopt-adr-format.md`）を読む。
- あわせて `docs/adr/README.md` を読み、その論点を ADR に書くべきか確認する。
- 以下に当てはまる場合に ADR を作る。
  - システム全体のアーキテクチャ方針
  - 永続化、外部 API、認証、セキュリティなどの基盤方針
  - AI / 外部サービスとの責務分担、安全策
  - repo 全体に効く運用ルール
  - 複数案を比較した重要な採択
- 仕様詳細、受け入れ条件、未決定事項、局所的な実装都合は ADR に書かない。
- ファイル名は `YYYYMMDD-slug.md` とし、slug は英語の短い要約にする。
- 章立ては `docs/adr/template.md` の順序に合わせる。
  - `Status`
  - `Situation`
  - `Context`
  - `Material for decision`
  - `Decision`
  - `Consequences`
- ADR は仕様書ではなく決定ログとして書く。背景、比較材料、決定、影響を残す。
- 関連する既存 ADR や docs があれば `Material for decision` に含める。
- 作成後は `docs/adr/README.md` の索引に 1 行追加する。

## Updating Existing ADRs

- 新しい ADR によって過去の ADR を `superseded` または `deprecated` にすべき
  場合でも、過去 ADR の本文は書き換えない。
- 過去 ADR に対して変更してよいのは `Status` セクションだけとする。
- `Status` の値は `proposed`、`accepted`、`rejected`、`deprecated`、
  `superseded` の範囲で扱う。
- `Status` 以外の `Situation`、`Context`、`Material for decision`、
  `Decision`、`Consequences` は変更しない。
- 過去 ADR を削除しない。
- 過去 ADR の内容を現在の理解で書き換えない。判断の変遷自体を資産として扱う。

## Decision Rule

- 実装前に判断が必要で、その判断が長く効くなら ADR を作る方向で考える。
- その場のローカル実装だけに閉じるなら ADR ではなくコードや仕様に寄せる。
- 「今後この判断理由を誰かが知りたくなるか」を基準に ADR 化を判定する。

## Output Contract

- ADR 参照時は、関連 ADR、そこから読める制約、未解決点を短く整理して返す。
- ADR 作成時は、作成理由、関連 ADR、必要なら `Status` 更新対象を明示する。
- 過去 ADR の `Status` 更新が必要な場合でも、本文変更提案はしない。
