# 2026/07/06 GitHub デフォルトラベルを廃止しカスタムラベル体系を採用

# Status
- accepted

# Situation
- issue 駆動で開発を進める以上、triage の軸が最初から定まっていないと issue が分類不能なまま積み上がる。
- GitHub デフォルトラベル（`enhancement`、`wontfix` 等）は軸が混在しており、AI へタスクを渡す際の指示境界としても機能が弱い。

# Context
- ラベルは「何の問題か」「どれだけ重いか」「どこまで変更してよいか」を直交する軸として分けると、1 軸だけの運用（例: 優先度のみ）より AI 協働時の scope 制御に効く。
- ラベル定義をファイルとして repo に置き、適用をスクリプト化することで、新規 repo でも同じ体系を再現できる。

# Material for decision
- 先行プロジェクト Nowflo の 4 軸ラベル運用（kind / priority / target / authority）の実績
- `docs/adr/20260706-adopt-issue-driven-pr-workflow.md`

# Decision
- GitHub デフォルトラベルは削除し、次の 3 軸のカスタムラベル体系を採用する。
  - `kind:*` — 何の問題か（feature / bug / docs / tech-debt / ux）
  - `priority:*` — どれだけ重いか（p1 / p2 / p3）
  - `authority:*` — どこまで変更してよいか（code / spec / adr）
- ラベル定義の正本は `.github/labels.yml` とし、適用は `scripts/setup-github-repo.sh` で行う（labels.yml に無い既存ラベルを削除し、定義どおり作成・更新する）。
- Nowflo の `target:*` 軸（pre-build / pre-launch / post-launch）は launch という工程概念に依存するため、汎用テンプレートでは採用しない。必要なプロジェクトが labels.yml に軸を追加する。

# Consequences
- どの新規 repo でも同一のラベル体系が 1 コマンドで再現され、issue テンプレートの `Recommended Labels` 節と整合する。
- 軸が 3 つあるため、1 軸運用に比べ triage の初期コストは少し上がる。
- ラベルを変更する場合は GitHub UI ではなく labels.yml を先に変更して再適用する規律が必要になる（UI 直編集はドリフトの元）。
