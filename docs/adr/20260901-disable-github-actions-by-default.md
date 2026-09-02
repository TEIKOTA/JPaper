# GitHub Actions を既定オフにしローカル検証を正とする

## Status

accepted

## Situation

- 本 template から生成されるプロジェクトは無料プラン・private repo・個人＋AI 協働が前提で、GitHub Actions の included minutes（private 2,000 分/月）は**アカウント単位**で全リポジトリが共有する。
- 複数プロジェクトを AI セッションで並行運用すると枠が枯渇し、全プロジェクトの全セッションに「billing 復活後に CI を確認」という待ちとノイズが波及する。実害は 5 プロジェクトで確認された（JPaper: CI 無検証の PR が 7 本滞留、Katagamii: billing 障害時のローカル代替手順を AGENTS.md へ手書き、my-blog:「GitHub actionsは当てにしないようにしましょう」と運用転換）。

## Context

- template の CI（pr-checks / self-test）は元々 `scripts/` の検査スクリプトを呼ぶ薄いラッパーで、検査ロジックの正本はローカルにある。CI が止まっても失われるのは実行の場だけだが、「CI が green になるまで待つ」運用が残っていると billing 枯渇のたびに全セッションが滞る。
- template repository の Actions 設定（enabled/disabled）は生成先 repo に**引き継がれない**（GitHub 公式仕様。コピーされるのはファイルのみ）。生成先では既定で Actions 有効のため、`.github/workflows/` に workflow がある限り、セットアップ前の初回 push で必ず実行され billing を消費する。
- 各プロジェクトが「CI を当てにしない」運用を個別に即興発明しており、template 既定（CI 前提）と実運用が乖離していた。

## Material for decision

- GitHub Docs / community: `PUT /repos/{owner}/{repo}/actions/permissions`（enabled: boolean。gh では `-F enabled=false` が必要で `-f` は文字列になり不可）、About billing for GitHub Actions（無料枠超過は課金されず job が止まるだけ。90%/100% でメール通知）、Troubleshooting required status checks（Actions 無効中に required checks を残すと Expected のまま永久ブロック）、Dependabot on Actions runners（repo の Actions 無効化をバイパスして動き続ける・課金なし）
- workflow ファイルは `.github/workflows/` 直下のみ認識される（`workflows-disabled/` へ退避すれば schedule / workflow_dispatch 含め一切トリガーされない。`act -W` で任意パスのローカル実行は可能）
- セッション横断監査（2026-09-01）の採掘結果とユーザーの明示要求
- [`20260706-adopt-commit-and-pr-message-convention.md`](./20260706-adopt-commit-and-pr-message-convention.md) / [`20260706-defer-server-side-branch-protection.md`](./20260706-defer-server-side-branch-protection.md)

## Decision

1. **workflow ファイルを `.github/workflows-disabled/` に置く（既定オフ）**。生成経路（template 生成 / clone）やセットアップ実行の有無によらず、構造的に Actions は 1 分も消費しない。
2. **`scripts/setup-github-repo.sh` が repo 設定でも Actions を無効化する（既定）**。誤って workflow を追加しても走らない保険。CI を使う場合は `--enable-actions` でスキップし、workflow を `.github/workflows/` へ戻す（opt-in。手順は README）。
3. **merge gate はローカル検証の green とする**: `bash tests/run-tests.sh` と、CI が担っていた PR タイトル/body/issue 連結検査の代替 `scripts/check-pr.sh`（既存の check-commit-msg.sh / check-pr-body-close.sh を再利用）。PR を作成・編集したら check-pr.sh で自己検査する。
4. 旧 2 ADR の CI 条項を部分 supersede する: commit/PR 規約 ADR の「リモート: pr-checks で PR タイトルを検査」条項、branch protection 見送り ADR の「強制手段は …pr-checks / self-test CI…」条項。両 ADR の他の条項（規約自体・見送り判断）は存続。

## Consequences

- 良い面: billing 枯渇による待ち・ノイズが構造的に消える。検査は生成直後からローカルで完結し、ネットワークや残枠に依存しない。
- トレードオフ: self-test の Linux（ubuntu）カバレッジを失う（bash 3.2 互換はローカル macOS `/bin/bash` で実証を継続）。PR 検査の実行はエージェント／人間の運用規律に依存する（`--no-verify` 同様の既知の弱さ）。
- 注意（README に記載）: Actions 無効中は branch protection の required status checks を設定しない（Expected のまま永久ブロックされる）。Dependabot は止まらない。無料枠を超過しても課金は発生しない。
- 将来 CI を再有効化する場合、required checks の指定には対象 check の実行実績（直近 7 日）が必要なため、workflow を戻して一度実行してから必須化する。
