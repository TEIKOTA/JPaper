# AGENTS.md

> このファイルが正本。`CLAUDE.md` は本ファイルへのシンボリックリンクで、ツール非依存の AGENTS.md 標準と Claude Code の両方に同じ規約を提供する。

## 目的

このリポジトリの開発における、AIコーディングエージェント／人間共通の運用ガイド。コード変更前の調査・探索・根拠収集の起点として使う。常時読まれる文書なので、各ルールの詳細は正本（スクリプト・docs・SKILL.md）に置き、ここはポインタに留める。

## リポジトリ構成

<!-- 論文和訳エージェント（agent-native / Flue 設計準拠）の構成。 -->
- `src/runtime/` — 薄い自作のランタイム（LLM を呼ぶ `runAgent()`、並列の上限、中断、実行の記録など。Flue の Agent/Workflow の設計に沿う）
- `src/agents/` — エージェント定義（`translator.ts` / `evaluator.ts` / `glossary-builder.ts`）
- `src/workflows/` — ワークフロー（素の TS の関数。`Promise.all` / `for` / `if` でつなぐ）
- `src/tools/` — エージェントが使うツール（TS の関数）
- `src/cli.ts` — jpaper CLI（`pnpm dev` の実体）。`src/index.ts` は `translatePaper`・`runCli` などを export する
- `apps/web/` — Web アプリ（論文の検索・翻訳ジョブ・用語集の編集）。`server/` は core と CLI を呼ぶ Hono の API、`src/` は Vite と React の画面。pnpm workspace のパッケージ
- `input/` — 用語集・スタイルガイドなどの知識の正本（commit する）
- `output/` — 実行の記録（`runs/`）と作業領域（`workspace/`）。実行時に作られるもので、gitignore している
- `docs/` — 設計ドキュメント・運用メモ（ビルド対象外）。実装契約の正本は [`docs/design/contract-appendix.md`](./docs/design/contract-appendix.md)
- `docs/adr/` — アーキテクチャ決定記録。運用ルールは [`docs/adr/README.md`](./docs/adr/README.md)
- `scripts/` — 規約の検証（commit 件名・branch 名・PR body・PR 全体）と repo 初期設定
- `tests/` — ローカル検査 script の self-test
- `.github/` — PR / issue テンプレート、ラベル定義（`labels.yml` が正本）、CI 定義（`workflows/` の node-checks・pr-checks・self-test）
- `.claude/` — Claude Code 設定（`settings.json`: 権限・hook 配線）と共有 skill（`skills/`。開発運用: 一覧は各ディレクトリの `SKILL.md` を参照。翻訳の運用: `translation-pitfalls` は evaluator 向けの誤訳チェックリスト。利用者向け: `jpaper` は `/jpaper`・`$jpaper` で呼んだときだけ動くセットアップと和訳の入口）。`.agents` は `.claude` への symlink（agents.md / Codex 互換パス。`.claude` を symlink にすると Claude Code の worktree 機能が拒否するため実ディレクトリが正本）
- `.codex/` — Codex 用の project-local hook 設定（trust 後に有効）
- `docker/agent/` — 子セッション用コンテナの共通 image（運用は [`docs/process/agent-containers.md`](./docs/process/agent-containers.md)）
- `docker/jpaper/` — JPaper の子のコンテナの image（共通 image に pnpm・TeX Live を足す。[`docker/jpaper/README.md`](./docker/jpaper/README.md)）

## 検索ポリシー

- ファイル探索は `rg --files`、文字列探索は `rg` を優先する。`find` は深さ・種別条件が必要な時だけ使う。
- いきなりリポジトリ全体を走査せず、有力なディレクトリに範囲を絞る。
- ヒット後は対象を絞って読み、必要以上に大きいファイル全体を出力しない。

## 開発フロー

- 原則 **1 タスク = 1 topic branch = 1 PR**。scope が広がるなら branch を広げる前に issue 分割を優先する。
- 未マージの自分の PR は warning / hard stop の二段 gate で新規着手を制御する（正本: `scripts/check-pr-backlog.sh`、[二段 backlog policy ADR](./docs/adr/20260926-adopt-two-stage-pr-backlog.md)）。警告時は merge・レビュー依頼・一本化を優先する。既存 PR の検査・修正・review・merge 準備は止めない。
- topic branch からのさらなる分岐（積み上げ）は 1 段まで。「A が正しければ B、誤っていれば C」のような代替案は積まず、兄弟 branch として切る。
- branch 名は `<type>/<issue番号>-<slug>`（`chore/<slug>` のみ issue なし可）。pre-push フックで検証される（checkout 中でない branch の push でも走る）。
- 編集を始める前に現在の branch を確認し、main・無関係 branch にいるなら `scripts/new-branch.sh` で topic branch を作ってから作業する（命名検証を作成時点で行う）。
- 検証（テスト・動作確認）前に PR を開かない。PR は issue と 1 対 1 を基本にする。PR を作成・編集したら `scripts/check-pr.sh` でタイトル・body 規約を自己検査する（ローカル script が正本。GitHub Actions は同じ検査をもう一度走らせる確認。[`docs/adr/20261014-enable-github-actions-on-public-repo.md`](./docs/adr/20261014-enable-github-actions-on-public-repo.md)）。
- 変更には**テストを伴わせる**。バグ修正・ガード追加では、守る対象を一度外して red になることを実証（退行注入）してから green を確認する。テスト・ビルドのコマンドは「## コマンド」を正本とする。
- issue 起点のタスクでは issue 本文を scope boundary として扱う。着手は `fix-issue` skill の手順（読解 → 着手前ゲート → branch → 実装 → commit → PR 自己検査）で入り、認識合わせの結論は issue 本文へ固定して大きな実装は fresh session で始める。
- issue を起票する前に `gh issue list --state all` / `gh pr list --state all` で同一テーマを検索し、結果を issue テンプレートの「重複確認」節へ記録する（空の記録はゲート未実施とみなす）。着手前にも、起票からの時間差で同じテーマが実装・merge されていないかを確認する（[`docs/adr/20260729-adopt-ai-session-operational-guards.md`](./docs/adr/20260729-adopt-ai-session-operational-guards.md)）。
- 着手前に前提の曖昧さが大きい依頼は `grill-me` skill、仕様・設計文書の曖昧さ解消は `grill-spec` skill で認識を揃えてから実装に入る。自律作業中の「止まるか進むか」は `decide-or-proceed` skill の 4 条件に従う（既定は止まらず進む）。
- 決定の背景は [`docs/adr/20260706-adopt-issue-driven-pr-workflow.md`](./docs/adr/20260706-adopt-issue-driven-pr-workflow.md) を参照。

## コミット / PR 規約

- **日本語 Conventional Commits**。形式は `type(任意のscope): 日本語の説明`。許可 type の正本は `scripts/check-commit-msg.sh`。
- PR タイトルも同形式（`scripts/check-pr.sh` で検査）。PR body に `Closes #<issue>` を書いて issue を閉じる（chore は免除、他の例外は `例外理由:` を明記）。
- commit message の生成手順は `git-commit` skill に従う。
- merge の条件判定と実行は root orchestrator だけが担い、writer / reviewer は merge しない。merge は `scripts/merge-pr.sh` だけを通し（`gh pr merge` 等は guard が拒否）、承認は会話で受けて issue 本文の「merge の事前承認」節か PR のコメント（head に結んだ区切りでの承認）へ写す。判定表は script が PR に残す（正本: [`docs/adr/20261016-gate-merge-behind-script-and-recorded-approval.md`](./docs/adr/20261016-gate-merge-behind-script-and-recorded-approval.md)）。AUTO / HUMAN 境界と stacked PR の再検証手順は [`docs/adr/20260918-adopt-ai-merge-authority.md`](./docs/adr/20260918-adopt-ai-merge-authority.md) を正本とする。

## ADR ルール

- 実装方針に少しでも迷いがあれば、実装前に `docs/adr/README.md` と関連 ADR を確認する（手順は `manage-adrs` skill）。
- アーキテクチャ、外部 API、認証、永続化、セキュリティ、repo-wide なルールに触れる判断では ADR を省略しない。
- 過去 ADR は削除・本文変更しない。決定が変わったら新 ADR を追加し、旧 ADR は `Status` だけ更新する。
- ADR 未満の軽量な決定・確定済み嗜好・理由付きで却下された案は、訂正を受けたその場で [`docs/process/decisions.md`](./docs/process/decisions.md) へ 1 行追記する（却下済み案の再導入を防ぐ）。着手前・compact 後の再開時に関連行を確認する。
- 今後の判断に効く決定の記録先は ADR か `decisions.md`。ツール付属の memory は個人の振る舞いメモに留める。

## 拡張の作法

- 同じ手順の説明が 3 回目になったら skill 化を検討する（`.claude/skills/`）。
- repo-wide に効く判断は ADR にする（`manage-adrs` skill 参照）。
- 機械的に検証できる規約は scripts に落とし、lefthook / CI に登録する。文書には正本へのポインタだけ残す。
- skill を書くときは、frontmatter の description に「いつ起動するか」を含め、本文には正本（scripts・docs）の複製ではなくポインタを置く。複製が必要な場合は転記契約（正本と同時更新する旨）を明記する。
- ディレクトリ固有の規約は本ファイルに足さず、そのディレクトリ直下のネスト `AGENTS.md` に置く（エージェントは最も近いファイルを優先する）。Claude Code 互換のため、各 `AGENTS.md` と同じディレクトリに `CLAUDE.md -> AGENTS.md` symlink を置く（検査は `scripts/check-agent-instruction-links.sh`）。本ファイルは行数予算（目安 200 行）内に保つ（検査は `sync-docs` skill）。

## 編集ガードレール

- 調査タスクは read-only 前提。変更依頼がない限り編集しない。
- `.env` 等の secret ファイルは読まない・表示しない・値を argv やログに出さない（`.env.example` の整備のみ可）。read-only コマンドの許可と機械強制は [`.claude/settings.json`](./.claude/settings.json) と `scripts/hooks/guard-bash.sh` が持つ。
- git worktree を `/tmp`・`/private/tmp`・`$TMPDIR`（`/var/folders/<...>/T/`）配下に作らない。macOS の一時領域掃除で未 push commit ごと消える（Bash guard に加え、`setup-user-hooks.sh --git` の post-checkout guard が全ツール共通で取り消す）。worktree の管理 script は持たない（撤去: [ADR](./docs/adr/20261014-remove-worktree-lifecycle-management.md)）。`git worktree remove` / `move` / `prune` は Bash guard が確認（ask）に回す。新しく始める委譲・並行作業は worktree ではなく、セッションごとのコンテナ（[`docs/process/agent-containers.md`](./docs/process/agent-containers.md)）で行い、ホストの owner は repo ごとに 1 セッションとする。例外は 2 つ: Linux のコンテナで動かない repo は、その repo の AGENTS.md が `## 委譲の作業場所` で宣言したときに限り `~/worktrees/<repo>/<名前>` の worktree を許す。repo を書かない調査は Agent tool の子に任せてよい（[ADR](./docs/adr/20261017-allow-orb-start-and-declared-worktree-exception.md)）。Docker が止まっているときは AI が `orb start` で起動してよい（`orb restart` / `orb reset` は利用者の判断）。
- 破壊的・不可逆な操作（データ削除・退避・履歴書き換え・リモート資源の変更）は既定で「提案のみ」。対象と件数の列挙・前提の検証結果（書込可否・参照元・容量）を添えて提示し、実行判断はユーザーに委ねる。例外は ADR で条件を定めた自動回収（`agent-box.sh clean`・`agent-box.sh prune`・`~/.trashable` の定期掃除 `scripts/trashable-cleanup.py`。条件は [ADR](./docs/adr/20261014-add-trashable-workspace.md)）に限る。
- 作業・test 用の一時物は `~/.trashable/<repo>/` に作る（Claude の scratchpad も可。子のコンテナでは `/tmp`）。消し忘れは定期実行（`setup-user-hooks.sh --trashable`）が掃除する。自分で消す `rm -rf` は、対象がすべて `~/.trashable`・`/tmp`・`$TMPDIR` 等の一時領域の「中」の実 path なら確認なしで通り、ルート自身・変数や glob・`..`・一時領域の外は確認になる（2026-10-16 に 10/07 の決定を改めた。正本: [ADR](./docs/adr/20261016-narrow-ask-to-human-judgement.md)、[`decisions.md`](./docs/process/decisions.md)）。
- リモートホストへ任意の ssh コマンドを送らない。リモート操作は許可操作を列挙したラッパスクリプト経由に限定し、`rm -rf` 等はデモ・検証目的でも提案しない。
- 長時間ジョブ（ビルド・テスト・レビュー）は、投入前に `scripts/wait-for-marker.sh` ヘッダの投入チェックリスト（計装・資源取得失敗で即死・肯定的な完了 marker・デタッチ・監視分離）を満たす。完了待ちはバックグラウンド実行の完了通知か同スクリプトの 1 回呼び出しに集約し、フォアグラウンドのポーリング waiter を即興実装しない。
- docs が不足・矛盾している場合は、修正案より先にギャップを示す。ドリフトの定期検査は `sync-docs` skill で行う。
- UI / UX・文言・操作感に関わる判断は、選択肢を短く説明してユーザーに確認してから固定する。人間の知覚で判定される成果物（レンダ画像・UI・PDF 等）は、フェーズ完了宣言や最終 merge の前に必ず実レンダ（スクショ・プレビュー）を提示して承認を得る。AI が定めた数値閾値やターミナル上の文字表現は人間評価の代替にならない。
- 測定値・数値は集計の正本（JSON / CSV 等）を読んでから報告する。ログ末尾・進捗表示・記憶からの一般化は禁止。見積り・引用には出典（どの実行・どの文書か）を添える。
- 「開いた・送った・公開した・完了した」は実体（プロセス・URL・出力）を確認してからのみ報告する。自分の行為が原因の外部事象は、原因を明記する。タスク完了・区切りの宣言前に `gh issue list` / `gh pr list` で残作業を機械列挙して報告に添える（未コミット差分の残置は Stop hook `scripts/hooks/guard-stop.sh` が 1 回警告する）。
- ユーザーに見せる成果物（レポート・HTML 等）は `/tmp` や scratchpad でなく repo 内か home 配下の永続位置に置き、応答の末尾で所在と開き方を必ず示す。
- 検証の証跡（実行ログ・レビュー結果・棚卸しの JSON 等。ユーザーに見せる成果物とは別）は repo にコミットせず、PR・issue のコメントに残す。repo の `docs/` はテンプレート更新で派生 repo へ写る（#138。`docs/` 配下の `*evidence*` dir は self-test が拒否する）。
- 想定外の失敗が起きたら [`docs/process/failure-patterns.md`](./docs/process/failure-patterns.md) へその場で 1 行追記する（根拠必須）。対策はログの精読ではなく昇華先（scripts・skill・本ファイル）に置く。
- compact・セッション切替の直後は、求められなくても現状報告（直近の作業・実行中ジョブ・未コミット差分・次の一手）を先に出す。セッションを跨ぐ引き継ぎは [`docs/templates/handoff.md`](./docs/templates/handoff.md) の雛形で書く。
- **ソースは事実のみ**。理由（why）は正本（ADR・契約付録・設計メモ）に置き、コード内のコメントは正本への参照（`// 契約付録 §N`）と、中身を持たない地雷の目印（`// ⚠ landmines.md`）だけにする。規約の正本は [ソースコメント ADR](./docs/adr/20260710-source-comments-facts-only-rationale-to-docs.md)。
- コードが不自然に見えても、**直す前に [`docs/design/landmines.md`](./docs/design/landmines.md) を確認する**。載っていれば意図的な書き方なので、そのまま残す。

## 委譲の作業場所
- agent-box: 使える。`start` に `--image agent-box-jpaper:latest`（pnpm と TeX Live 入り）を付ける。image の作り方は [`docker/jpaper/README.md`](./docker/jpaper/README.md)

## コマンド

- `pnpm install` — 依存を入れる（初回。パッケージ管理は pnpm。[pnpm ADR](./docs/adr/20261007-adopt-pnpm-for-package-management.md)）
- `pnpm test` — vitest の単体テスト（決定的な検査。LLM を含めない）
- `pnpm build` / `pnpm typecheck` — tsc のビルド / 型チェック（typecheck は emit しない）
- `pnpm dev` — `src/cli.ts`（jpaper CLI）を tsx で実行（`pnpm link --global` の後は、任意のディレクトリで `jpaper` として同じ CLI を使える。`bin/jpaper.mjs`）
- `pnpm dev:web` — Web アプリ（API と画面）を立ち上げる（`jpaper web` も同じ。依存が無ければ先に `pnpm install`。仕様の正本は契約付録 §9）
- `bash tests/run-tests.sh` — 規約検査スクリプト群の self-test（scripts/ を変更したら必ず実行。push の前に lefthook の pre-push が `scripts/run-selftest.sh` で全件を流す（push する commit が作業ツリーと違う、owner が `collect` した branch を push する流れでは流さず、その旨を表示する。検証は PR の前のホストでの全件と `merge-pr.sh` の記録）。編集中は自動実行しない。macOS の Bash 3.2 での全件は PR の前に owner が流す）
- `scripts/run-selftest.sh` — self-test を 1 回流す正本（pre-push から呼ばれる。派生 repo の `SELFTEST_CMD` 等の見つけ方もここ。ヘッダ参照）
- `scripts/new-branch.sh <type> <issue番号> <slug>` — 規約検証付きで topic branch を作成する（既定は fetch 後の `origin/main`。取得失敗時は local main へ fallback。`--from` で変更可）
- `scripts/agent-box.sh -h` — セッションごとのコンテナの起動・一覧・取り込み・片付け（準備・条件・owner の流れは [`docs/process/agent-containers.md`](./docs/process/agent-containers.md)）
- `lefthook install` — commit-msg / pre-push フックを有効化する（初回セットアップ必須）
- `scripts/setup-user-hooks.sh [--claude] [--codex] [--git] [--trashable] [--worktree-access] [--dry-run] [--uninstall]` — hook をユーザーレベル（`~/.claude`・`~/.codex`・グローバル git の post-checkout）にも配線し、古い branch・未 pull の checkout や Bash guard を通らない経路でもガードを効かせる。`--worktree-access` は `~/worktrees` を Claude / Codex の作業許可範囲に加える（初回セットアップ時と hook 追加・変更後に実行）。複製はテンプレート repo からだけ配る（派生 repo では理由を出して止まる）。複製が `scripts/hooks` とずれると、テンプレート repo の SessionStart が再実行コマンド付きで警告する。`--trashable` は `~/.trashable` を作り、定期掃除（`scripts/trashable-cleanup.py`）を macOS の launchd に登録する
- `scripts/check-codex-hooks.sh [--repo <dir>]` — Codex hook の trust 状態を検査する（未 trust の hook は Codex で実行されない。SessionStart も警告する）
- `scripts/setup-github-repo.sh [--prune] [--dry-run] [--enable-actions]` — ラベル同期・squash merge / commit title 固定・private repo での Actions 無効化（repo 作成直後に `--prune` 付きで 1 回。定義外ラベルの削除は `--prune` 時のみ）
- `scripts/check-pr.sh [<PR番号>]` — PR タイトル・body・issue 連結のローカル検査（PR 作成・編集後に実行する）
- `scripts/merge-pr.sh <PR番号> --head <SHA> --judge scope=… --judge injection=…` — PR を squash merge する唯一の経路（承認の写し・head・条件を確かめ、判定表を PR にコメントしてから merge。`--dry-run` で判定表だけ出す。merge 後は main の CI を待って結果を出し、`--no-wait` で省く）
- `scripts/check-pr.sh --backlog` — 自分の open PR を作成日順・base・draft 状態で一覧する（棚卸しは上限超過時も止めない）
- `pnpm exec tsx scripts/check-skill-frontmatter.ts [<skills-dir>]` — 全 `SKILL.md` の frontmatter を Agent Skills 共通契約と repo の起動条件規約で検査する
- `scripts/check-agent-instruction-links.sh [<root>]` — root / ネストの `AGENTS.md` に対応する sibling `CLAUDE.md` symlink を検査する
- `scripts/wait-for-marker.sh --log <log> --marker <ERE> [--timeout <sec>]` — detached ジョブの完了 marker を待つ正本 waiter（待機ループを script 内に閉じる）
- `sync-docs` skill — 文書と実ツリーのドリフトを定期的に検査する
