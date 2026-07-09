---
name: sync-docs
description: Use when periodically reviewing the repository to detect drift between docs (AGENTS.md, README, ADR index, skills) and the actual file tree, scripts, and rules, keeping each rule aligned with its single source of truth.
---

# Sync Docs

リポジトリの文書と実装のドリフトを検出し、正本規律に沿って揃えるメンテナンス skill。

## 検査項目

1. **ADR 索引**: `docs/adr/README.md` の索引 vs `rg --files docs/adr` の実ファイル一覧。各 ADR の `Status` セクションと索引の Status 列の一致。
2. **AGENTS.md**: 「リポジトリ構成」に記載のディレクトリ・「コマンド」に記載のスクリプトが実在するか。実ツリー側に未記載の主要ディレクトリが増えていないか。
3. **README.md**: 参照しているファイル・スクリプト・手順が実在・実行可能か。
4. **skills**: `.agents/skills/*/SKILL.md` が参照するパス・スクリプトが実在するか。
5. **正本整合**: 許可 type 一覧の正本は `scripts/check-commit-msg.sh`。ラベル定義の正本は `.github/labels.yml`。ADR 運用ルールの正本は `docs/adr/README.md`。他の文書がこれらを重複列挙してズレていないか。

## 動作規律

- 各ズレについて、まず **code drift**（文書が正しく実装が古い）か **docs drift**（実装が正しく文書が古い）かを、根拠ファイルを添えて判定してから報告する。
- 自動で修正してよいのは機械的なズレのみ: ADR 索引の欠落・Status 不一致、実在しないパス参照の追随。
- 意味的なズレ（ルール自体の変更、構成の再設計を要するもの）は修正案の提示に留め、ユーザーの判断を仰ぐ。
- repo-wide ルールの変更が必要だと判明した場合は `manage-adrs` skill に従い ADR 化を検討する。
- この skill は自走しない。定期実行したい場合のスケジューリング（/loop 等）は各プロジェクトで別途選ぶ。

## Output Contract

- ドリフト一覧を表で報告する: 項目 / drift 種別（code / docs）/ 根拠ファイル / 対応（自動修正済み・提案・要判断）。
- ドリフトが無い場合は「ドリフトなし」と明示して閉じる。
