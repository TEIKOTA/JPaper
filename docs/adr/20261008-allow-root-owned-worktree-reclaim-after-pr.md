# 2026/10/08 root 所有 worktree の PR 完了後の承認なし回収の採用

## Status
- superseded（後継 ADR = [`20261014-remove-worktree-lifecycle-management.md`](./20261014-remove-worktree-lifecycle-management.md)）

2026-10-14 supersede: 回収の対象だった worktree 管理の撤去に伴い、承認なし回収の条項を置き換える（#139）。

[`20261002-adopt-worktree-lifecycle-management.md`](./20261002-adopt-worktree-lifecycle-management.md) の「通常の worktree はユーザーが対象を承認した後に回収する」を、root が自分用に作った worktree について部分 supersede する。それ以外の worktree（人の作業場所・未管理・所有不明・他セッション）の対象承認と、同 ADR の安全条件は存続する。

## Situation
- 2026-10-08、ユーザーが「人間の明示的な承認なしで、自動で正確な worktree 管理ができるか」と問い、選択肢 A（root 自身の worktree に自動回収条件を足す）を選んで起票と実装・merge を依頼した（issue #124）。
- 同日の棚卸しでは、標準配置と標準外を合わせて 100 を超える worktree・clone が放置されていた。回収時に人が確かめた項目（merge 済み・HEAD が remote にある・clean・stash なし・使用プロセスなし）は全て機械的に判定できた。

## Context
- 子の worktree は root-open 1 回の合意で自動回収できる。一方、root が自分で作った worktree は回収のたびに対象固有のユーザー承認を要し、親だけで作業すると回収が滞る。
- 旧 ADR は「PR の merge/close、Git の clean 表示、子の自己申告だけでは、セッションの使用終了や成果物の保全を保証できない」として、merge 済み判定による回収を退けた。本 ADR はこの理由に、所有と一次記録で答える。
  - 使用終了: 回収するのは作成した root session 自身であり、終了記録は所有者本人の一次記録になる（他者の自己申告ではない）。
  - 保全: remote branch は merge 時に自動削除されるため、remote-tracking ref は使えない。GitHub が恒久保持する `refs/pull/<N>/head` が HEAD を指すことを `git ls-remote` で実確認する。
- repo 内に `.worktrees/` を置けば自由度が上がるかも検討した。承認の要否は配置ではなく回収ルールと guard の設計で決まる。Nowflo の `.claude/worktrees/` には repo 内配置のまま 22 個が放置されていた。

## Material for decision
- issue #124 の条件案と、2026-10-08 の棚卸し・回収の記録（`~/worktrees/.reclaim-evidence/2026-10-08b`）。
- [`docs/process/worktree-lifecycle.md`](../process/worktree-lifecycle.md) の回収検査と限界。

## Decision
- `worktree.sh create --own --capability <root-cap>` で、所有者 = root session の worktree を作れるようにする。
- この worktree は、作成した root session が回収し、かつ次を全て満たす場合に限り、対象固有のユーザー承認なしで回収できる（authority `root-owned`）。
  1. 既存の回収検査（明示 end・終了 head の維持・作業状態・保持 ref・登録 job と `lsof`・root の confirmation）を全て通る。
  2. 同じ branch の open PR が無く、`headRefOid` が HEAD と一致する merged / closed PR がある。PR 後の追加 commit は保護する。
  3. その PR の `refs/pull/<N>/head` が remote で HEAD を指す。
  4. `gh` 不在・通信失敗・timeout・解釈不能な出力は確認不能として保護する。PR は `remote.origin.url` から得た GitHub repo で引き（`GH_REPO`・`GH_HOST` に従わない）、GitHub でなければ保護する。PR を見る repo と保全を確かめる repo を揃えるためである。ただし `insteadOf` や複数 URL の設定下ではずれうる。その場合も保全は `ls-remote` が実際に読む先で確かめるため、commit は失われない。
- issue #124 の条件案からの読み替え: 「登録 PID が生存していない」は採らない。owner は回収する root 自身なので、原理的に生存しているため。使用終了は所有者本人の end と `lsof` で確かめる。stash は repo 共通で worktree の回収では消えないため、検査に加えない。「HEAD を contains する remote-tracking ref」は、merge 時の branch 自動削除と両立する `refs/pull/<N>/head` の実確認に置き換える。
- `--own` の作成結果は `owner_capability` を返さない。子へ渡す path の経路に root cap を載せないため。root 所有の worktree は委譲しない。
- 条件を欠けば停止する。ユーザーの対象承認を渡せば、従来どおり通常回収できる。
- guard の回収例外は、clean な正本コマンドの literal 呼び出しを `verify-reclaim` で検査し、`delegated-child` か `root-owned` を確認できた場合だけ通す。

## Consequences
- 良い面: 親だけで作業しても、PR の完了後に人の承認なしで回収できる。回収の根拠（PR 番号・状態）は回収記録に残る。
- トレードオフ: 回収時に GitHub への通信が要る。通信できないときは保護側に倒れ、回収は進まない。
- 同一 OS ユーザーの別プロセスによる session の詐称や、`lsof` に映らない利用（エディタの未保存バッファ等）は検出できない。所有と一次の終了記録で範囲を限る。
- root session を開き直すと、旧 session が作った worktree は所有者が一致しないため、対象承認へ戻る。
- 独立 clone を管理経路に通すこと（`git clone` の配置制限）は本 ADR の対象外。
