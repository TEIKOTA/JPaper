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
6. **宣言なき複製**: skill / 文書が正本（scripts・docs）の本文を宣言なく複製していないか。複製を残す箇所には転記契約（どの正本と同時更新するか）が明記され、正本と同期しているか。ポインタで足りる複製は解消候補として報告する。
7. **AGENTS.md 行数予算**: `wc -l AGENTS.md` が予算（目安 200 行）内か。超過・接近時は各行に「この行を消したら防いでいた失敗が再発するか」を問い、否の行を削除・降ろし候補（ネスト AGENTS.md / skill / scripts）として報告する。予算は機械削除の根拠ではなく、報告と提案に留める（採用背景は [`docs/adr/20260901-adopt-session-audit-guards-v2.md`](../../../docs/adr/20260901-adopt-session-audit-guards-v2.md)）。

## 動作規律

- 各ズレについて、まず **code drift**（文書が正しく実装が古い）か **docs drift**（実装が正しく文書が古い）かを、根拠ファイルを添えて判定してから報告する。
- 自動で修正してよいのは機械的なズレのみ: ADR 索引の欠落・Status 不一致、実在しないパス参照の追随。
- 意味的なズレ（ルール自体の変更、構成の再設計を要するもの）は修正案の提示に留め、ユーザーの判断を仰ぐ。
- 複製を正本化・統一する際、複数の転記が互いに食い違っていたら、安全側（強い方の制約）を正本に採り、どの記述を弱い側として捨てたかを記録する。正本化のつもりで契約を変えない。
- 監査のたびに `docs/process/failure-patterns.md`（と `docs/process/decisions.md` があればそれも）を読み、①各行の昇華先が実在するか ②昇華トリガー（同型 2 回目）に達したのに昇華されていない行が無いか ③直近の作業に想定外の失敗の痕跡（PR・issue・会話）があるのに行が増えていない不整合が無いか、を確認して報告する。
- 資産の退役（DEPRECATED）注記は、後継が同等性（検査の厳密さ・カバレッジ）を満たすことを実測で確認してから書く。未達なら「移行中」と残ギャップの行き先を書く。
- repo-wide ルールの変更が必要だと判明した場合は `manage-adrs` skill に従い ADR 化を検討する。
- この skill は自走しない。定期実行したい場合のスケジューリング（/loop 等）は各プロジェクトで別途選ぶ。

## Output Contract

- ドリフト一覧を表で報告する: 項目 / drift 種別（code / docs）/ 根拠ファイル / 対応（自動修正済み・提案・要判断）。
- ドリフトが無い場合は「ドリフトなし」と明示して閉じる。
