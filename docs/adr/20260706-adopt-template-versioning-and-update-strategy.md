# 2026/07/06 テンプレート版数の記録と手動更新戦略の採用

# Status
- accepted

# Situation
- 本テンプレートから生成されたプロジェクトは fetch 時点のコピーであり、テンプレート側の修正（検査スクリプトの欠陥修正・CI 強化など）を後から配布する手段が無かった。
- 生成プロジェクトが「どの時点のテンプレート」から作られたかを記録していないため、差分の起点すら特定できない。

# Context
- テンプレートは規約の検査スクリプトや CI を含むため、修正が生成側へ届かないと同じ欠陥が全プロジェクトに残り続ける。
- 一方で、生成プロジェクトはテンプレートを起点に**分岐して育つ**ことが前提であり（AGENTS.md やスクリプトのプロジェクト固有化は正常な進化）、全ファイルの機械的な追従はむしろ衝突を生む。

# Material for decision
- copier / cruft（テンプレート再レンダリング型の更新ツール）の運用コスト: プレースホルダ構文の侵食、answers ファイルの管理、再レンダリング衝突
- `~/.claude/scaffold/new-project.sh` の取得実装（git archive / clone で取得元 SHA を解決済み）
- レビュー指摘: 「生成済みプロジェクトへテンプレート修正を配布する version / migration / sync 手段がない」

# Decision
- 生成プロジェクトは fetch 時に **`.template-version`** ファイルを repo 直下へ記録する。内容は `source`（取得元 path / URL）、`revision`（解決済み commit SHA。非 git working tree からの生成は `unversioned-working-tree`）、`fetched_at`（ISO 8601）。書き出しは `new-project.sh` が行う。
- テンプレート更新の取り込みは **opt-in・手動**とする。手順:
  1. テンプレート repo 側で `git diff <revision>..HEAD` を確認する
  2. 生成プロジェクトに関係する hunk だけを選んで適用する
  3. `.template-version` の `revision` / `fetched_at` を更新する
- copier / cruft 型の自動再レンダリングは**不採用**。全ファイルにプレースホルダ構文が侵食し、分岐して育った生成プロジェクトとの再レンダリング衝突の解消コストが、この規模のテンプレートの利得を上回るためである。
- テンプレート repo 側は main を常に配布可能な状態に保つ（PR workflow ADR に従う）。tag 付けは必須としない。`revision` の SHA が起点として十分機能する。

# Consequences
- どの生成プロジェクトも「どの時点のテンプレか」を機械可読に持ち、更新差分の起点を即座に特定できる。
- 更新は pull 型（生成側が取りに行く）なので、テンプレ側は配布先を追跡しなくてよい。
- 取り込みは手動なので、テンプレの重要な修正が自動では届かない。重要度の高い修正はテンプレ側の commit message（`fix:`）と README で目立たせる運用に依存する。
- `.template-version` を削除したプロジェクトは更新起点を失う。削除しない前提を fetch 後チェックリストには含めず、ファイル自体のコメントで示す。
