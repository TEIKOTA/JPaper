# 2026/10/14 branch を持たない子の HEAD を commit の検索で merge 済みと判定する

## Status
- accepted

[`20261014-prune-merged-agent-refs.md`](./20261014-prune-merged-agent-refs.md) の `HEAD` の判定の条項に、判定の経路を 1 つ足す。他の条項（消してよい条件・残す側に倒す原則・transaction）は存続する。

## Situation
- 2026-10-14、`agent-box.sh prune` を実機で初めて実行した。実装の子（`impl-139`）の ref は消えたが、レビューの子 6 件（`review-142` 等）はすべて「HEAD が merge 済みと確かめられません」で残った（#149）。
- レビューの子は `--branch` を付けずに始めるので、取り込まれる ref は detached の `HEAD`（レビューした SHA）だけになる。

## Context
- 元の判定は、`HEAD` を `origin/main` と、同じ session の branch の merge 済み PR の head からしか辿らない。squash merge された PR のレビューでは常に残り、レビューのたびに `refs/agents/review-*` が溜まる。

## Material for decision
- `gh pr list --state merged --base main --search <sha>` は、その commit を含む PR を返す。実機で `review-142` の `HEAD`（`b614a0a`）から PR #142（head `1b381dc`、レビュー後に commit を足して merge）を見つけた。
- GitHub の検索の索引は反映が遅れうる。見つからなければ残る側に倒れる。

## Decision
- `HEAD` が `origin/main`・確かめた branch・PR の head から辿れないときは、その SHA で main へ merge 済みの PR を検索し、`baseRefName` が `main` の PR の head から辿れれば merge 済みとする。
- 検索の失敗・見つからない・辿れない場合は、今までどおり残す。

## Consequences
- 良い面: merge 済み PR をレビューした子の session も `prune` で消える。
- トレードオフ: `HEAD` 1 つにつき `gh` の検索が 1 回増える。
- 残る弱さ: 検索の索引の遅れで、merge 直後は残ることがある（再実行で消える）。
