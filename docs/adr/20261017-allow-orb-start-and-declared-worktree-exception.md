# 2026/10/17 Docker の起動を AI に許し、Linux で動かない repo には宣言つきで worktree を許す

## Status
- accepted

[`20261008-adopt-container-isolated-agent-sessions.md`](./20261008-adopt-container-isolated-agent-sessions.md) の「新しく始める委譲・並行作業は子のコンテナで行う」と、[`20261014-remove-worktree-lifecycle-management.md`](./20261014-remove-worktree-lifecycle-management.md) の「新しい worktree を作らない」を、本 ADR の 3 つの場合に限って部分 supersede する。その他（コンテナの隔離、worktree の管理 script の撤去、一時領域に worktree を作らない規則）は存続する。

## Situation
- 2026-10-16、OrbStack が止まっていて `agent-box.sh list` が「failed to connect to the docker API」で止まった。エラー文にも docs にも起動の手順が無かった。`orb start` で数秒で起動し、auto mode にも止められなかった。
- iOS の repo（WordinCard）は Linux のコンテナでビルドできず、10/14〜15 に `~/worktrees/WordinCard/` へ worktree を 10 個作って作業していた。上の 2 つの ADR と食い違うが、例外の決定は記録されていなかった。
- `delegate-work` skill は read-only の調査でも子ごとのコンテナを求めるので、Docker が止まっていると規約どおりの委譲の手段が無かった。
- 2026-10-16〜17 の grill（#160 本文の「認識合わせの結論」）でユーザーが方針を決めた。

## Context
- `orb start` は止まっているエンジンを起こすだけで、データを消さない。`orb restart` / `orb reset` は固まったエンジンの復旧で、`orb reset` は全データを消す（`docs/process/agent-containers.md`）。前者と後者は性質が違う。
- worktree を広く許すと、撤去した worktree 管理（ADR 20261014）が戻る。例外は「その repo が自分で宣言したとき」だけに閉じる必要がある。
- repo を書かない調査は、親の checkout を共有しても壊さない。コンテナを求める理由（書き込み・実行の隔離）が当たらない。

## Material for decision
- #160 本文と grill の結論、2026-10-16 の `orb start` の実例、WordinCard の worktree 10 個の実績、`scripts/hooks/guard-bash.py` の `git worktree remove` / `move` / `prune` の確認。
- 剪定した案: 案内だけで起動は利用者／Docker が無いときは委譲しない／Linux で動かない repo は委譲しない／macOS の VM／headless の `claude -p` を worktree で起動／clean かつ push 済みなら worktree の後始末を確認なしにする／read-only でもコンテナ。

## Decision
1. **Docker の起動**: Docker（OrbStack）が止まっているとき、AI は `orb start` で起動してよい。`scripts/agent-box.sh`（`agent_box.py` の `run`）は、docker への接続エラー（`failed to connect to the docker API`・`Cannot connect to the Docker daemon` 等）のときに、`orb start` の案内をエラーへ添える。`orb restart` / `orb reset` は今までどおり利用者の判断（`docs/process/agent-containers.md` の「Docker が固まったとき」）。
2. **Linux のコンテナで動かない repo の worktree**: その repo の `AGENTS.md` に、節 `## 委譲の作業場所` と行 `- agent-box: 使えない（理由: <具体的な理由>）` を書いたときに限り、worktree を許す。宣言が無い repo、理由が空の宣言、テンプレート repo 自身には許さない。
   - owner が `~/worktrees/<repo>/<名前>` に作る（一時領域には作らない。ADR 20260729）。そこを作業 dir にして Agent tool の子に任せる。1 子 = 1 worktree、同時は `delegate-work` の並列上限に従う。
   - worktree の管理 script は戻さない。後始末の `git worktree remove` は今までどおり guard が確認（ask）する。
3. **repo を書かない調査**: web・docs の調査、読むだけの探索は、Agent tool の子（Explore・claude-code-guide 等）に任せてよい。書き込み・レビュー・実装は今までどおり子のコンテナで行う。Docker が止まっていても、調査はこの経路で委譲できる。

## Consequences
- Docker が止まっていても、起動の手順がエラー文に出るので、AI が自分で復旧して委譲を続けられる。`orb restart` / `orb reset` の判断は利用者に残る。
- iOS など Linux で動かない repo は、宣言という 1 行で worktree に進める。宣言は repo 側の変更として PR に現れ、広がり方が追える。
- 受け入れるトレードオフ: worktree の子は親の checkout の外にあるだけで、コンテナほどの隔離（ファイル・資源・トークンの制限）は無い。宣言のある repo では、この隔離の弱さを owner が負う。
- エラー文の判定は stderr の文面に頼るので、Docker / OrbStack の文面が変わると案内が出なくなる（エラー自体は今までどおり出る）。
