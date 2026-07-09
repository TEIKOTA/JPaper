# 2026/07/06 日本語 Conventional Commits を commit と PR タイトルに適用

# Status
- accepted

# Situation
- 個人＋AI 協働開発では commit が高頻度に生成されるため、後から履歴を検索・監査できる一貫した形式が最初から必要である。
- 説明文は母語である日本語の方が情報密度が高く、type は tooling 互換のため英語を保ちたい。

# Context
- 規約は文書に書くだけでは AI・人間ともに守られない。機械検証をローカルフックと CI の両方に置くことで、規約と実態の乖離を防ぐ。
- type 一覧を複数箇所に書くと必ずドリフトするため、検証スクリプトを正本とし文書はポインタに留める。

# Material for decision
- Conventional Commits v1.0.0（https://www.conventionalcommits.org/）
- 先行プロジェクト Nowflo の日本語 Conventional Commits 運用と semantic PR title guard の実績
- `docs/adr/20260706-adopt-issue-driven-pr-workflow.md`

# Decision
- commit 件名と PR タイトルの両方に **日本語 Conventional Commits** を適用する。
  - 形式: `<type>(任意のscope): 日本語の説明`（type は英語、説明は日本語）
  - 例: `feat: ログイン画面を追加` / `fix(api): タイムアウトを修正`
- 許可 type の一覧は `scripts/check-commit-msg.sh` を**唯一の正本**とし、他の文書には列挙を複製しない。
- 強制は二重にする。
  - ローカル: lefthook の commit-msg フック（`lefthook.yml`）。ただし `--no-verify` で回避可能。
  - リモート: GitHub Actions の `pr-checks`（`.github/workflows/pr-checks.yml`）で PR タイトルを検査。squash merge 運用では PR タイトルが履歴に残る commit 件名になるため、ここを守れば履歴全体の規約が守られる。
- PR body は既定で日本語とし、`Closes #<issue>` の記載規約は issue 駆動 workflow ADR に従う。

# Consequences
- 履歴が `type` で機械的に分類でき、変更種別の検索・リリースノート化が容易になる。
- lefthook 未インストール環境ではローカル強制が働かないため、`lefthook install` をセットアップ手順に含める必要がある（README 参照）。
- 検証スクリプトが正本であるため、type を増減する場合は `scripts/check-commit-msg.sh` の変更＋この ADR の背景に照らした判断が必要になる。
