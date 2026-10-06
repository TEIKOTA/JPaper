# 運用ガード第 2 弾の是正（第 2 ラウンド監査の反映）

## Status

accepted

## Situation

第 2 弾（[`20260901-adopt-session-audit-guards-v2.md`](./20260901-adopt-session-audit-guards-v2.md)、PR #29〜#45）を 2026-09-01〜03 にテンプレへ導入し派生 6 repo へ展開した後、2026-09-05 に展開後のセッション 11 本・派生 6 repo・テンプレ自身・Claude Code / agents.md / GitHub の 8〜9 月の変化を再監査した（採掘 5・監査 3・Web 1 の一次所見 52 件。統合・審査エージェントは使用上限で停止したため、審査は同じ 3 レンズで手動で行った）。

## Context

GitHub Actions 既定オフは効いていた（無効化以降の run 0 件）。一方で第 2 弾ガードの多くは「入っているが効いていない」ことが実測で判明した。原因は 4 系統:

1. **ロールアウトの構造**: hook と settings は tracked ファイルで branch / checkout に依存し、既存 branch・長期統合 branch・未 pull の checkout には届かない（Katagamii 43 時間、Nowflo 4 時間、postmarket 全期間がガード無し）。
2. **ガードのすり抜け**: 変数経由の一時領域 path、`git -C`、コマンド置換経由の secret 読み取り、Bash heredoc による書き込み（Edit/Write hook が見えない）、破壊的コマンド（`rm -rf`・`git reset --hard`・force push・`gh repo delete`）と即興ポーリングの無ガード。別セッションの `git reset --hard` で 4 日分の未コミット作業が消失した実例。
3. **散文ゲートの崩壊**: PR 滞留 3 本ゲートは展開翌日に open PR 60 本・積み上げ 39 段で破られ、知覚判定が要る PR が承認なしで即 merge され、決定レジスタは全 repo で空のまま。
4. **仕様との不整合**: `.claude` が symlink だと Claude Code の worktree 機能（EnterWorktree / isolation: worktree / --worktree）が拒否する。Stop hook は subagent でも走る。auto mode が既定化し `permissions.ask` は auto mode でも必ず止まる。

## Material for decision

- 第 2 ラウンド監査の一次所見（各セッション transcript の hook 発火記録・PR・git 状態・派生 repo の fork 差分）
- Claude Code 公式 docs（hooks / permissions / worktree / skills、2026-09 時点）、agents.md 標準、GitHub Actions billing
- ユーザー決定（2026-09-05）: hook 配線はグローバル + プロジェクト両方 / AI の merge は条件付き許可

## Decision

以下の設計方針で是正し、issue #46〜#63 の 18 PR に分割する。

1. **ガードは branch に依存させない**: hook 本体はテンプレに置き、配線を `~/.claude/settings.json` にも入れる（`scripts/setup-user-hooks.sh`。プロジェクト側 hook があればそれを、無ければグローバル複製を実行）。
2. **散文ゲートは exit 2 / `permissions.ask` に落とす**: 破壊的コマンド・即興ポーリング・PR 滞留数・積み上げ段数・check-pr 実行を script / hook で判定し、裁量は明示フラグで残す。
3. **派生 repo の fork を吸収する**: hook・検査スクリプトに環境変数の拡張点、ツール非依存のパス解決、テンプレ由来シードの別ファイル化。
4. **usage limit 前提の委譲**: 子は専用 worktree + WIP commit、Workflow は小分割、SessionStart hook で再開時に全 worktree の未コミット差分を列挙。
5. **仕様追随**: `.claude` を実ディレクトリ・`.agents` を symlink に反転、guard-stop の subagent 判定、deny の整理、skills frontmatter の活用。

| issue | 内容 |
|---|---|
| #46 | `.claude` 実ディレクトリ化と本 ADR |
| #47 | ユーザーレベル hook 配線 `setup-user-hooks.sh` |
| #48 | guard-bash 強化（変数 path・`-C`・コマンド置換 secret・破壊的コマンド ask・即興ポーリング拒否） |
| #49 | settings.json の穴（`git branch:*`・deny 整理・ask・静的検査） |
| #50 | post-edit-selftest を Bash 書き込みにも適用・設定可能化 |
| #51 | guard-stop の是正とツール非依存化 |
| #52 | PR 滞留ゲート `check-pr-backlog.sh` |
| #53 | 積み上げ段数ゲート `check-branch-topology.sh` |
| #54 | check-pr の自動実行・`--head`・chore 実在検証・上書き点 |
| #55 | new-branch の `--worktree` と `origin/main` 既定 |
| #56 | AI の merge 条件（ユーザー決定） |
| #57 | delegate-work 改訂 |
| #58 | SessionStart hook |
| #59 | UserPromptSubmit hook（決定レジスタへの誘導） |
| #60 | decide-or-proceed / 報告規律の補強 |
| #61 | 記録形式の改訂とシード分離、未記録の追記 |
| #62 | 仕様追随とドリフト解消の束 |
| #63 | headless-run skill |

## Consequences

- 良い面: ガードが branch・checkout・派生 repo の fork に依存せず効く。散文だけだった規律が機械強制に変わり、autopilot 下でも崩れにくい。
- トレードオフ: `permissions.ask` の増加で自律走行が止まる場面が増える（破壊的操作に限定）。グローバル設定に hook が入るため、テンプレを使わない repo でもガードが働く（意図どおりだが、他プロジェクトの規約と衝突したら `--uninstall` で外す）。派生 repo は再同期時に `.claude` の反転が要る。
- 見送り（引き続き将来候補）: bridge-session / 遠隔運転の報告規約、外部 LLM 併用の受け渡し規約、Agent Plugins 形式への配布パッケージ化（派生 repo が 2 つ以上同じ hook を要求した時点で判断）。
- 未検証: Grep/Glob ツール経由の `.env` 内容取得の実挙動、tkota-blog の Cloudflare Pages が Actions 無効後も正常か。
