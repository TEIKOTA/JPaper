# 2026/10/14 merge 済みの子の ref を agent-box.sh prune で消す

## Status
- accepted
- 部分 supersede（2026-10-14）: `HEAD` の判定の条項に commit の検索による経路を追加 / 他の条項は存続 / 後継 [`20261014-prune-review-sessions-by-commit-search.md`](./20261014-prune-review-sessions-by-commit-search.md)

[`20261008-adopt-container-isolated-agent-sessions.md`](./20261008-adopt-container-isolated-agent-sessions.md) の「子の全 ref を `refs/agents/<session>/` に取り込んで残す」はそのまま存続する。この ADR は、残した ref を承認なしで消してよい条件を足す（AGENTS.md の「破壊的な操作は提案のみ」の例外）。

## Situation
- agent-box の `collect` は、子の全 ref を `refs/agents/<session>/` に取り込む。merge が済んでも残り続け、owner が `git update-ref -d` で 1 本ずつ手で消していた（#131 から #136 へ分割）。
- 残った名前は `start` の再利用も拒む（#127）。委譲の回数に比例して溜まり、手で消すと消し間違いが起こりうる。
- 2026-10-13 の grill（#136 本文の「決定事項」）で、ユーザーが消す場所と判定の条件を決めた。2026-10-14、実装の前に `HEAD`・`remotes/*` の扱いを安全側へ絞った（同じ節の補足）。

## Context
- この repo の既定は squash merge なので、子の commit は `origin/main` の祖先にならない。祖先の判定だけでは、ほとんど消せない。
- `clean` は merge 前にも使う（レビューした子の片付け等）。`clean` の中で判定しても、消せない場合が多い。
- `collect` は `+refs/*` と detached の `HEAD` を取り込むので、`heads/*` のほかに `remotes/*`・`tags/*`・`HEAD` 等が入る。子が detached のまま commit すると、その commit は `HEAD` にしか無い。

## Material for decision
- #136 本文と決定事項、#124 / ADR [`20261008-allow-root-owned-worktree-reclaim-after-pr.md`](./20261008-allow-root-owned-worktree-reclaim-after-pr.md)（PR の head と照合して承認なしで回収する、同型の判定）。
- `gh pr list --state merged --base main --head <branch> --json headRefOid,baseRefName` は、`main` へ merge 済みの PR の head の SHA を返す（squash でも元の head が分かる）。
- `git update-ref --stdin` の `start` / `delete <ref> <旧値>` / `commit` は、1 つでも旧値と違えば全体を取り消す。

## Decision
- 新しいコマンド `agent-box.sh prune` を設ける。片付け済み（state が無い）session の `refs/agents/<session>/` を session ごとに判定し、次をすべて満たす session の ref だけを承認なしで消す。
  - 各 `heads/<branch>` が、`origin/main` の祖先であるか、`<branch>` から `main` へ merge 済みの PR の head の祖先（同じ commit を含む）である。base が `main` 以外の PR（stacked PR を親の branch へ merge しただけのもの）は数えない。
  - `HEAD` が、`origin/main` か、merge 済みと確かめた branch・PR の head から辿れる。
  - `remotes/*` が、ホストの `refs/remotes/origin/*` から辿れる。
  - `heads/*`・`remotes/*`・`HEAD` 以外の ref（`tags/*` 等）が無い。
- 判定できないもの（`gh` の失敗、PR の head の commit がホストに無い、session 名が agent-box の形でない等）は、理由を出して残す。1 つでも残す ref があれば、その session の ref は全部残す。
- 消すときは、判定した時点の SHA を旧値にした delete を 1 つの transaction で行う（途中で取り込み直された ref は消さない）。
- `clean` には入れない。AGENTS.md の自動回収の例外に `agent-box.sh prune` を加える。

## Consequences
- 良い面: merge 後の ref の整理が 1 回のコマンドで済み、消し間違いが無くなる。同じ session 名を再び使えるようになる。
- トレードオフ: 判定は `gh` とホストの `origin/*` に依存する。fetch が古い、GitHub に届かない等では残る側に倒れ、手での整理（提案のみ）が残る。
- 残る弱さ: PR の branch 名を子の branch 名から変えた場合は判定できず残る。`--head` は branch 名だけで絞るので、同じ名前の別の PR（過去の再利用や fork）の head も候補になる。消すのは子の commit がその head の祖先、つまり実際に `main` へ merge された場合に限られる。merge 済み PR の head を後から force push で書き換えられた場合、`gh` が返す head は最終のもので、それより前の commit は祖先でなければ残る（消す側には倒れない）。
