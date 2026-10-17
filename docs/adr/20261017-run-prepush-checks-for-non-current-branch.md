# 2026/10/17 checkout 中でない branch の push でも pre-push の検査を走らせ、self-test は流さない旨を表示する

## Status

accepted

## Situation

owner は main を checkout したまま、子のコンテナから `collect` した branch を `git push origin <branch>` する（[`docs/process/agent-containers.md`](../process/agent-containers.md)）。pre-push の検査は lefthook（v2.1.9）が呼ぶ。

## Context

lefthook は pre-push で、push するファイル（HEAD と push 先の差）を数える。差が空だと、ファイルの置換（`{files}` 等）を使わない command を「no matching push files」で skip する。main が push 先と同じ commit のまま別の branch を push すると差が空になり、branch 名の検査・topology の検査・self-test の 3 つが一度も走っていなかった（#177。2026-10-17 に bare repo への push と本物の origin への push で確認）。[`20261017-move-selftest-from-posttooluse-to-pre-push.md`](./20261017-move-selftest-from-posttooluse-to-pre-push.md) の「push の前には必ず通る」は、checkout 中の branch を push する場合にしか成り立っていなかった。

## Material for decision

- #177 本文「認識合わせの結論」（2026-10-17、利用者の選択: 「明示して流さない」）。
- 実物の lefthook での切り分け（bare repo、HEAD が上流と同じ commit）:
  - command が `{files}` も `{all_files}` も使わない: skip。
  - hook 全体の `files:` が無く `{files}` だけ: 「no files for inspection」で skip。
  - hook 全体の `files:` で実在する 1 件を返し、各 command の run に `{files}` を置く: 全 command が実行される。
  - run の末尾に `# {files}` と書く（shell のコメント）: lefthook が置換と見なさず skip。
- 却下した案:
  - push する commit を一時的に checkout して self-test を流す: 時間と容量が増え、`/tmp` 等に worktree を作る制約（guard）に当たる。
  - 素の git hook（`.git/hooks/pre-push`）への置き換え: 設定で直せるうえ、lefthook を外す判断は合意に無い。

## Decision

- `lefthook.yml` の pre-push に hook 全体の `files: echo lefthook.yml`（常に実在する 1 件）を置き、各 command の run の先頭に `PREPUSH_FILES={files}`（script は読まない）を付ける。push の中身によらず 3 つとも必ず実行される。
- branch 名・topology の検査は、これまでどおり stdin の ref（push する ref）を読む。checkout 中でなくても push する ref について走る。
- self-test は `scripts/run-selftest.sh --stdin` が push する commit を HEAD と比べる。push する commit がどれも HEAD と違うときは、作業ツリーの全件が push する中身の検査にならないので、流さない旨を表示して通す。HEAD と同じ commit を push する ref が 1 つでもあれば、今どおり全件を流す。
- そのときの検証は、PR の前にホストで流す両方の Bash の全件と、`scripts/merge-pr.sh` の `self-test:` の記録（merge の条件）に任せる。
- 20261017 の「push の前には必ず通る」は、「push する commit が作業ツリーのとき」に改める。

## Consequences

- owner の流れでも、不正な branch 名の push は止まる。topology の検査も走る。
- owner の流れの self-test は、push の時点では誰も流さない。退行は PR の前の全件と merge の条件で受ける。「流していない」ことは出力に残る。
- lefthook の skip の条件に依存する設定になる。lefthook の更新で挙動が変わりうるため、実物の lefthook と bare repo の test（`tests/run-tests.sh`）で守り、設定を外すと red になる。
- 新しい command を pre-push に足すときは、run に `PREPUSH_FILES={files}` を付けないと同じ skip が起きる。
