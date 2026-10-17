# 2026/10/16 merge を専用 script に通し、会話での承認を issue・PR の記録で確かめる

## Status
- accepted

[20260918-adopt-ai-merge-authority.md](./20260918-adopt-ai-merge-authority.md) の「HUMAN の承認の形と時点」と AUTO 条件 1 を置き換える。置き換えるのは「承認がいつ・どの形で要るか」と、条件を確かめる手段だけ。AUTO / HUMAN の区分の中身、writer / reviewer / root の権限分離、stacked PR の統合手順は存続する。

## Situation
- merge の HUMAN 境界（人の承認が要る PR）を、実際には repo の外にある auto mode の判定が担っていた。repo には merge を止める仕組みが無く、ADR 20260918 が頼る #53 / #54 の補助 gate も merge そのものは止めない。
- auto mode の判定は揺れる。9/25〜10/16 の対話セッションで拒否は 25 回。`gh pr merge 156` は `[Merge Without Review]` で止まり、#163・#165 は同じ会話に事前承認がある状態で通った。
- 承認は会話の中にしか無く（「`--match-head-commit X を付けて merge`」「all merge」）、PR に記録が残らなかった。10/06 の失敗パターンの対策（merge の判定表を PR に残す）は ADR に入らず、#148・#150・#154 では残っていない。
- ADR 20260918 の AUTO 条件 1「ユーザーが当該 run を自律実行として明示している」を観測する手段が無かった。
- ユーザーの要望（2026-10-16）: 作業中のスクリプト実行やサブエージェントの実装中に承認で止められたくない。grill の認識合わせや、セッションの終わりで「merge していい」を決めて、滑らかに進めたい。

## Context
- 強制を repo の外の判定に預けると、止まる場面も通る場面も予測できず、承認の根拠が残らない。repo の仕組み（script と guard）で強制し、auto mode は二重の守りに回す。
- 承認を取るのは会話（ユーザーの発言）、残すのは issue・PR。AI がユーザーの発言をそのまま写し、script は写しの存在を確かめる。

## Material for decision
- #159 本文と「認識合わせの結論」（2026-10-16 の grill）、同コメントの材料（#163・#165 は事前承認が会話にある状態で auto mode に止められずに merge できた。新しいセッションでの挙動は未確認）。
- 実例の形: #157・#158・#167 の「merge の事前承認」節、PR #163・#165 の「merge 判定（root）」コメント。
- 剪定した案: 確認ダイアログで承認する／ユーザーが打つ approve 用の script／auto mode に任せて承認の言い方だけ文書化する／HUMAN の PR はユーザーが手で merge する／GitHub の review 承認（自分の PR は approve できない）。

## Decision

### 強制: merge は `scripts/merge-pr.sh` だけ
- squash merge は `scripts/merge-pr.sh <PR番号> --head <SHA> --judge …` を通す。script は下の「判定表」を作り、1 つでも FAIL なら merge せず（コメントも残さず）exit 1。全て満たせば、判定表を PR にコメントで残してから、`gh pr merge --squash --match-head-commit <SHA>` を 1 回呼ぶ。`--dry-run` は判定表を出すだけ。
- Bash guard（`scripts/hooks/guard-bash.py`）は、script を通らない merge を deny する: `gh pr merge`（`-R` 等の option・`env` / `sudo` / `timeout` 等の wrapper・`bash -c` / `eval`・連結・`xargs` / `find -exec` 経由を含む。`--help` / `-h` は除く）、`gh api` の `…/pulls/<N>/merge`（`-X GET` 以外）、GraphQL の `mergePullRequest` / `enablePullRequestAutoMerge`。名前が `gh` でない呼び出し（変数・alias）は読めない。auto mode の判定は二重の守りとして残る（repo の外なので変えない）。
- ask の振り分け・一時領域・worktree・secret・polling の判定は変えない。

### 承認: 会話で受け、issue・PR に写す。形は 2 つ
1. **事前承認**（着手前）: grill の認識合わせサマリへの合意時に、「merge の条件」とあわせてユーザーから受け、issue 本文の「## merge の事前承認」節（`- 条件:` の行を含む。ユーザーの発言をそのまま写す）に記録する。PR 本文の `Closes #N` が指す issue の節を script が読む。HUMAN 区分の PR も対象にできる。ただし知覚の成果物（UI・レンダ・PDF）と外部への影響（課金・公開・送信・削除）を含む PR は対象外とし、script は `--judge no-perceptual-external=なし` が無ければ事前承認を認めない。
2. **区切りでの承認**: 作業中は止まらず、条件から外れた PR（blocking の指摘・範囲外の変更・合意に無い判断）は「承認待ち」に積む。セッションやバッチの区切りに、承認待ちを番号付き（PR 番号・head SHA・理由）で聞き、承認を PR のコメントに `merge 承認: head <40 桁の SHA>` の行と、ユーザーの発言の引用（`>` の行）で写す。承認は提示した head に結び、head が変われば無効（script は live の head と照合する）。
- どちらも無ければ merge しない。ADR 20260918 の AUTO 条件 1「自律実行として明示」は、「事前承認の記録（形 1）があること」で観測する。

### 判定表: script が確かめる条件と、root の判断
script が機械的に確かめる（結果は判定表の「確認者: script」）:
- PR が open かつ draft でない／live の head が `--head` と一致／base が main（stacked child は親を merge して main に付け替わってから）／`mergeable` かつ `mergeStateStatus` が CLEAN
- origin の `refs/pull/<N>/head` が `--head` に一致し、`git merge-tree` に衝突が無い
- `git diff --check`（base との merge-base からの差分）と `scripts/check-pr.sh` が通る
- 未解決のレビュースレッドが 0（GraphQL の `reviewThreads`。100 件を超えれば取りきれないとして FAIL。issue コメントは解決の状態を持たないので対象外）
- PR のコメントに、head に結んだ記録がある: `review: head <SHA> blocking=なし`（別 context の独立レビュー）と `self-test: head <SHA> bash=PASS /bin/bash=PASS`（両方の Bash の self-test）。head が変われば古い記録は一致しなくなる
- 承認の写し（上の形 1 または 2）

root の判断（`--judge <key>=<判断>` で渡し、script は中身を確かめず「確認者: root」「申告」として判定表に写す。key が無い・空なら FAIL）:
- `scope`: diff が issue の範囲内で、合意に無い新しい判断が無い
- `injection`: guard・bug 修正の退行注入で red → 復元後 green（対象外なら理由）
- `no-perceptual-external`: 事前承認で merge するときだけ。知覚の成果物・外部影響を含まない

「別 context のレビューの中身」と「self-test が本当に通ったか」は script が確かめられない（記録の行で head との結び付きだけを見る）。

## Consequences
- 良い面: 承認が issue・PR に写しとして残り、判定表が毎回 PR に残る（10/06 の失敗パターンの対策を機械化）。ユーザーの承認は着手前と区切りに集まり、作業中は止まらない。guard が script 外の merge を止めるので、auto mode の揺れに強制を預けない。
- 記録の行（`review:`・`self-test:`・`merge 承認:`）は、リポジトリの owner のコメントだけを数える（public repo で第三者のコメントで通らないように）。事前承認の節がある issue でも、区切りの承認があれば `no-perceptual-external` は求めない（知覚の成果物の PR を区切りで承認する経路を塞がない）。
- 前提（推測として示し、合意済み）: 守る相手は AI の読み違い・取り違え（10/06 の事故）。**AI が承認の写しや記録の行を偽る場合は防げない**（script は写しの存在と head との結び付きしか見られず、ユーザーの発言の真偽は確かめられない）。
- トレードオフ: 区切りの承認は PR ごとのコメント、事前承認は issue 本文の編集という手間が増える。`review:` / `self-test:` の記録も root が書く。
- 残るリスク: 新しいセッションで、issue 本文の事前承認だけがある状態の auto mode の挙動は未確認（#163・#165 は同じ会話に事前承認があった）。止まる場合は、最初の指示に「#N を事前承認どおり merge まで」と書く運用で補う（推測）。
- 残るリスク: 組織が owner の repo では、記録の行が owner（組織名）の login に一致せず数えられない。常に merge できない（fail-closed）。派生 repo への反映（#162）で手当てを決める。
- 残るリスク: guard が読めない形は通る。`gh api -F query=@file`・`--input`（merge の中身が別ファイル・stdin にある）、変数・alias 経由の呼び出し、`xargs … sh -c '…'`、`bash <<<`・`| bash` の中の merge。auto mode の判定が二重の守りになるが、確実な遮断ではない。
- 残るリスク: 名前が `gh` でない呼び出し（変数・alias）と、`gh` 以外の merge（GitHub の Web UI・別の API クライアント）は guard の外。stacked child の扱いは、親を merge して base が main に付け替わってから script を通す（ADR 20260918 の統合手順 3〜5 に従う）に留め、child の base を許す拡張は将来の課題とする。
- 派生 repo に script より先に guard の拒否だけが届くと merge できなくなる。反映の順序は #162 で扱う。
