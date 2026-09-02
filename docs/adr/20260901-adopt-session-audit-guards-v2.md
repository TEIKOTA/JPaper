# セッション横断監査に基づく運用ガード第 2 弾の採用

## Status

accepted

## Situation

本 template から生成・派生した 9 プロジェクト（約 750MB のセッション記録、2026-07〜09）に対し、ユーザー発話・中断シグナル・手書きローカルルールを横断採掘する監査を 2026-09-01 に実施した（16 エージェントのワークフロー: 採掘 9 + Web 調査 2 + 統合 1 + 3 レンズ審査 3 + 欠落批評 1。代表引用 10 件は transcript 原文と突合済み）。発見は 22 クラスタに統合され、汎用性・致命度・費用対効果の審査で 18 クラスタが採用された。

## Context

第 1 弾（[`20260729-adopt-ai-session-operational-guards.md`](./20260729-adopt-ai-session-operational-guards.md)）は母体 1 プロジェクトの実測に基づいた。今回は複数プロジェクトで**同型の失敗が独立に再発**し、各プロジェクトが個別に対策を即興発明している状態が確認された。template に予防線が無い限り、生成されるどのプロジェクトでも同じ失敗を最初から踏み直す。主な実測: 未検証の完了報告（5 プロジェクト）、却下済み案の再導入、未マージ PR 70 本滞留、リモート削除事故（復旧数日）、read-only コマンドの許可拒否往復 48 件超、secrets の口頭釘刺し反復、自律運転契約の毎回口頭交渉。

あわせて Web 定石として「常時ロード文書は約 200 行が実用上限で、肥大化はルール無視を招く」「毎回例外なく守るべきルールは文書でなく permissions / hooks へ」が確認され、追記の設計原則とした。

## Material for decision

- 監査ワークフローの統合結果（22 クラスタ・3 レンズ審査・採用 18。証拠は各プロジェクトのセッション記録と手書き AGENTS.md / skill / failure-patterns）
- 派生プロジェクトで結晶化済みの対策実物: decide-or-proceed skill・delegate-work skill・引き継ぎプロンプト形式・read-only allowlist（31 項目）
- Web 定石: agents.md 標準（ネスト AGENTS.md の closest-file-wins）、Anthropic 公式ベストプラクティス（hooks は deterministic / 文書は advisory、検証チェックを与える）、CLAUDE.md 行数予算 ~200 行
- 第 1 弾 ADR: [`20260729-adopt-ai-session-operational-guards.md`](./20260729-adopt-ai-session-operational-guards.md)

## Decision

採用クラスタを以下の設計原則で template 標準へ導入する。導入は issue #17〜#28 の 12 PR に分割する。

**設計原則**: ① 機械強制（scripts / settings / hooks）> skill（オンデマンド）> 散文追記、の優先順で実装先を選ぶ。② `AGENTS.md` への追記はポインタ・圧縮行のみとし、行数予算（目安 200 行）を `sync-docs` で検査する。③ 数値閾値（PR 滞留 3 本・並列 2 等）は「既定」と明示し、プロジェクト側の調整を許す。

| issue | ガード | 由来クラスタ |
|---|---|---|
| #17 | AGENTS.md 行数予算検査・ネスト AGENTS.md 降ろし先ルール・本 ADR | 肥大化ガード |
| #18 | read-only allowlist / secrets deny / /tmp worktree 禁止 hook の settings 同梱 | 権限摩擦・secrets |
| #19 | `scripts/new-branch.sh`（命名検証の作成時点前倒し）+ git-commit skill のファイル経由規律 | git/gh 実行衛生 |
| #20 | 未マージ PR 滞留ゲート（既定 3 本）・branch 積み上げ 1 段まで | PR 滞留 |
| #21 | decide-or-proceed skill（既定は進む・止まる 4 条件）+ grill 系へ契約・質問規律統合 | 自律運転契約・質問設計 |
| #22 | 報告・完了の検証規律（数値は正本・残作業列挙・知覚品質ゲート・成果物所在） | 未検証報告 |
| #23 | 破壊的・不可逆操作は提案のみ既定 + 長時間ジョブ投入側チェックリスト | 削除事故・ジョブ黙走 |
| #24 | `docs/process/decisions.md`（ADR 未満の軽量決定レジスタ） | 決定の揮発 |
| #25 | `docs/templates/handoff.md`（セッション引き継ぎ雛形）+ 再開直後の現状報告 | セッション継続性 |
| #26 | failure-patterns の既知失敗シード・昇華トリガー・read 導線 | 失敗ログの空文書化 |
| #27 | delegate-work skill（並列既定 2・委譲プロンプト必須 5 要素） | 委譲事故 |
| #28 | fix-issue skill（issue 起点の順序強制入口） | 手順の踏み忘れ |

GitHub Actions の既定オフ化は別 ADR（issue #16）で扱う。

## Consequences

- 良い面: 複数プロジェクトで独立に再発した失敗クラスへの対策を、生成直後のプロジェクトが最初から持てる。派生プロジェクトで実証済みの対策の逆輸入が中心のため、机上の規律ではない。
- トレードオフ: skill・docs・settings の資産が増え、`sync-docs` の検査対象が広がる。数値閾値はハーネスやチーム構成の変化で見直しが必要になりうる（「既定」明示で緩和）。
- 見送り（将来の issue 候補）: bridge-session / モバイル遠隔運転時のチェックポイント報告規約、headless（`claude -p`）運用規約、外部 LLM 併用時の受け渡し規約、音声入力誤変換の解釈明示・成果物フォーマット嗜好のグローバル設定側への追記。
- 各ガードの文言・実装の正本は各 issue の成果物（scripts・settings・skill・docs）が持ち、本 ADR は採用判断と分割のみを固定する。
