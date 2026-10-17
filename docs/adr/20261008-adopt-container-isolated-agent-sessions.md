# 2026/10/08 セッションごとのコンテナ隔離の採用

## Status
- accepted
- 片付けで残すもの（成果物 `~/.agent-box/artifacts/`・`skipped.txt`）を [`20261012-keep-agent-artifacts-on-clean.md`](./20261012-keep-agent-artifacts-on-clean.md) で補足
- 既存の worktree 管理の撤去（試作の評価で決めるとした項目）を [`20261014-remove-worktree-lifecycle-management.md`](./20261014-remove-worktree-lifecycle-management.md) で決定
- コンテナの書き込み層・資源・権限の制限を [`20261012-restrict-agent-container-writes-and-resources.md`](./20261012-restrict-agent-container-writes-and-resources.md) で補足
- 「新しく始める委譲・並行作業は子のコンテナで行う」を、Linux で動かない repo の宣言つき worktree と repo を書かない調査について [`20261017-allow-orb-start-and-declared-worktree-exception.md`](./20261017-allow-orb-start-and-declared-worktree-exception.md) で部分 supersede

[`20261002-adopt-worktree-lifecycle-management.md`](./20261002-adopt-worktree-lifecycle-management.md) のうち、「委譲・並行作業の作業場所を worktree で分け、capability と承認 JSON で回収する」を、新しく始める作業について部分 supersede する。既存の worktree の管理・回収、一時領域に worktree を作らない規則（ADR 20260729）、[`20261008-allow-root-owned-worktree-reclaim-after-pr.md`](./20261008-allow-root-owned-worktree-reclaim-after-pr.md) は、残っている worktree に対して存続する。試作（issue #126 の Done When）の評価で、撤去するか休眠させて残すかを別途決める。

## Situation
- 2026-10-08、#124 の対応後にユーザーが「運用が煩雑になった。Docker（OrbStack）のコンテナで隔離して AI に任せたい」と提起し、grill-me で認識を合わせた（決定 D1〜D17。正本は issue #126 本文）。
- 煩雑さの中心は worktree の回収だった。guard が `git worktree remove` を承認待ちにし、それを避けるために capability・承認 JSON・guard の例外を重ねてきた。

## Context
- 目的は煩雑さの削減で、条件は安全性を今より下げないこと（D1）。
- コンテナで守れるのは、mount しない手元のファイルだけ。GitHub への操作は、渡したトークンの権限で決まる。この repo は private かつ無料プランなので branch 保護（ruleset）を使えず（API が 403）、書き込み権限のあるトークンを渡すと main への force push と branch の削除を防げない。
- 外への通信は制限しない（D3。検索の精度を落とさないため）。そのため、GitHub への書き込みを防ぐのはトークンの権限だけになる。
- 子の clone は子が自由に書き換えられる。ホストがその中で git を実行すると、子が `.git/config` に仕込んだ `core.fsmonitor`・filter 等がホストで（強いトークンを持つ環境で）実行されうる。

## Material for decision
- issue #126 の認識合わせサマリ（D1〜D17）と、確認済みの事実（OrbStack 2.2.3、branch 保護の 403、gh トークンの scope、両 CLI のログイン手段）。
- GitHub Docs「Permissions required for fine-grained personal access tokens」（2026-10-08 確認）: PR の merge・branch 同士の merge・ref の削除は Contents の書き込み権限を要する。Pull requests の書き込み権限だけで、PR の作成・編集・close、レビュー、update-branch ができ、Issues / Pull requests の書き込み権限でコメントを削除できる。
- 2026-10-08 の実測: 子用トークンで読み取りは通り、管理系（deploy key・webhook・secret・environment）は 403、他 repo は拒否、push は「Write access to repository not granted」で拒否された。

## Decision
- 1 セッション＝1 コンテナとし、専用 clone をホストの `~/agents/<repo>/<session>/` に置いて mount する（D2・D9）。入口は `scripts/agent-box.sh` の 1 本で、ユーザーの対話と owner からの headless の委譲の両方に使う（D8）。同時に動かす子は 3 個までとし、明示すれば超えられる（D17）。
- 子に渡す GitHub トークンは repo を限定した fine-grained PAT（Contents 読み取り、Issues・Pull requests の書き込み）とする（D5）。キーチェーンの `agent-gh-token-<repo>` から読み、値を argv に載せない。`delete_repo` を含むホストのトークン、Docker socket、SSH agent、ホストの `~/.config/gh` は渡さない。
- owner はホストの 1 セッション（repo ごと）とし、子の成果を取り込んで push・PR・merge を行う（D6・D12）。ホストでは新しい worktree を作らない。merge の判断は [`20260918-adopt-ai-merge-authority.md`](./20260918-adopt-ai-merge-authority.md) に従う。
- ホストは子の clone の中で git を実行しない。取り込みと片付けの検査は、子の clone を読み取り専用で mount し、ネットワークと認証を持たない検査コンテナで行い、ホストは結果の JSON と bundle だけを受け取る。
- 片付けは、次をすべて満たす場合に限り、ユーザーの承認なしで行う（D10）。AGENTS.md の「破壊的操作は既定で提案のみ」の例外とする。
  1. その session のコンテナが動いていない（検査の前後で確認する）。
  2. 未コミットの変更が無い（tracked の変更と、ignore されていない未追跡ファイル）。
  3. 子の全 ref（branch・tag・stash・detached HEAD）の commit を、ホストの `refs/agents/<session>/` に取り込み、SHA の一致を確かめた。
  4. clone と session の path に symlink が含まれず、agent-box が作った state と一致する。
  5. headless の結果（依頼・出力・終了コード）が通常のファイルで、session の外（`~/agents/<repo>/.results/`）へ写せた。
- `refs/agents/<session>/` が残っている session 名では `start` しない（取り込みは強制更新なので、片付け済みの成果の唯一の写しを上書きしないため）。
- コンテナの中は権限確認を外したモードで動かす。安全用の guard（`guard-bash.sh`・`guard-codex.sh`）は、環境変数 `AGENT_BOX=1` と `/.dockerenv` が両方ある場合だけ外す。ホストの macOS ではルートが読み取り専用で `/.dockerenv` を作れない。品質用の hook（self-test・PR 検査・Stop の確認）は残す（D16）。
- ユーザーの設定は、CLAUDE.md と skill だけをコンテナ側の home に写し、ログイン情報・会話記録・memory・ユーザーレベルの hook は写さない（D15）。コンテナに入れる秘密情報は開発用に限る（D7）。

## Consequences
- 良い面: 子の作業場所の回収に、ユーザーの承認・capability・承認 JSON が要らなくなる。子が手元で何を壊しても、ホストと他のセッションには及ばない。子は GitHub のコードと main を変更できない。
- トレードオフ: 子は push できないので、owner が取り込み（`collect`）と push を担う。取り込んだ ref は `refs/agents/<session>/` に残り続けるので、merge 後に owner が整理する。
- 限界: ignore されたファイル（build 成果物・依存の cache・開発用の `.env` の写し）と、どの ref からも辿れない commit（reflog だけにあるもの）は、片付けで消える。子は PR・issue の表示上の状態を書き換えられ（取り返せる）、コメントを削除できる（取り返せない）。外への通信を制限しないので、コンテナに入れたログイン用トークンと開発用の秘密情報は持ち出されうる。
- 運用上の注意: 子の clone をホストのエディタや shell で開くと、git 連携（`git status` 等）が子の `.git/config` を読んで実行する。中身の確認はファイルの閲覧に留めるか、`collect` 後のホスト側の ref で行う。
- 試作（issue #126 の Done When）の評価後に、既存の worktree 管理を撤去するか、外への通信を制限するか、派生 repo へ展開するかを決める。
