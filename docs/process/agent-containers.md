# セッションごとのコンテナ隔離（agent-box）

子のセッション（実装・レビューの委譲、並行作業）を、セッションごとの Docker コンテナ（OrbStack）で動かす運用の正本。決定の根拠は [ADR 20261008 コンテナ隔離](../adr/20261008-adopt-container-isolated-agent-sessions.md)、合意の経緯は [#126](https://github.com/TEIKOTA/project-template/issues/126)。本体は `scripts/agent-box.sh`（`scripts/lib/agent_box.py`）、image は `docker/agent/`。

## 守りの分担

| 守るもの | 手段 |
|---|---|
| ホストのファイル・他のセッション | コンテナには専用 clone（`~/agents/<repo>/<session>/`）と session の home だけを mount する。Docker socket・SSH agent・ホストの `~/.config/gh` は渡さない |
| GitHub のコードと main | 子のトークンは repo 限定の fine-grained PAT（Contents 読み取り、Issues・Pull requests の書き込み）。push・merge・branch 削除は GitHub が拒否する |
| ホストの owner | 子の clone の中でホストが git を実行しない。検査はネットワーク・認証なしの検査コンテナで行い、JSON と bundle だけを受け取る |
| 子の成果 | 片付けの前に、全 ref の commit をホストの `refs/agents/<session>/` に取り込み、SHA の一致を確かめる |

コンテナの中では権限確認を外したモードで動かし、安全用の guard は外れる（`AGENT_BOX=1` と `/.dockerenv` が両方ある場合だけ）。品質用の hook（self-test・PR 検査・Stop の確認）と lefthook は動く。外への通信は制限しない（試作の段階）。

## 書き込める場所と制限

決定の背景は [ADR 20261012](../adr/20261012-restrict-agent-container-writes-and-resources.md) と [ADR 20261014](../adr/20261014-separate-agent-cache-per-repo-and-check-capacity.md)。値の正本は `scripts/lib/agent_box.py` の `HARDENING`・`LOG_LIMITS`・`CHILD_LIMITS`・`INSPECT_LIMITS`（子と検査の `docker run` で共有）と `MIN_FREE_BYTES`。

| 場所 | 扱い |
|---|---|
| `/work`（子の clone）・`/home/node`（session の home） | ホストの dir を mount。書ける。ホストに残り、コンテナを消しても消えない |
| `/cache`（volume `agent-box-cache-<repo>`） | 書ける。npm・pip の cache。repo ごとに分け、同じ repo のセッション同士で共有する。上限は無い（大きさは `list` の `cache` で見る） |
| `/tmp` | tmpfs（子 1 GiB・検査 256 MiB、`exec` 可、inode 20 万）。**コンテナの終了で消える**。残したいものは `~/.agent-box/artifacts/` へ置く |
| それ以外（`/usr`・`/etc`・`/var/tmp` 等） | 読み取り専用（`--read-only`）。ツールは image に入れる（子は元から非 root で、`apt install` は以前から使えない） |

| 制限 | 子 | 検査 | 理由 |
|---|---|---|---|
| `--memory`（swap なし） | 3g | 1g | 子 3 個＋検査 1 個で最大 10 GiB。OrbStack の VM は約 11.7 GiB。tmpfs もこの中に数える |
| `--pids-limit` | 1024 | 256 | fork の暴走を止める |
| `--cap-drop ALL`・`no-new-privileges` | 付ける | 付ける | 子は非 root で動く。Claude Code・codex・npm・git・gh・lefthook の通常の使い方は capability を要らない。`CAP_*` を要る経路（`ping`、1024 未満の port の bind 等）は使えない |
| `--network none` | なし（制限しない） | 付ける | 検査は外へ出ない |
| `--log-opt`（`max-size=10m`・`max-file=3`） | 付ける | 付ける | 対話モードの大量出力で VM のログが増え続けない |

`start`・`resume` は起動の前に次を確かめ、足りなければ止める（`--allow-over-limit` が外すのは個数の上限だけで、この確認は外さない）。

- メモリ: 動作中の子と新しい子、検査 1 つの上限の合計が、`docker info` の VM のメモリを超えない。
- 空き容量: ホストの `~/agents/` があるディスクと、VM のディスク（cache volume の `df`）の空きが、どちらも 5 GiB 以上ある。VM 側の確認は cache volume を mount した短いコンテナで行うので、volume がまだ無ければこのとき作られる（後の確認で止まっても空の volume は残る。害は無い）。OrbStack の VM のディスクはホストのディスクの上に伸びるので、実際に効くのはホスト側の空きであることが多い。

作業中の子がディスクを使い切ることは防げない（`/work`・home・`/cache` に容量の上限は無い）。

`/tmp` に深い入れ子や大量のファイルを作っても、tmpfs なので overlayfs の書き込み層に残らず、片付けで Docker は止まらない（2026-10-12 の事故。[failure-patterns](./failure-patterns.md)）。`/work`・home はホストのファイルシステムなので、そこに作った入れ子はホストに残る。

## Docker が止まっているとき

`agent-box.sh` が「failed to connect to the docker API」等の接続エラーで止まったら、OrbStack が起動していない。AI は `orb start` で起動してよい（数秒。データは消えない。2026-10-16 に確認）。接続エラーのとき、`agent-box.sh` はこの案内をエラーに添える。起動してから同じコマンドを再実行する。起動しても繋がらない・固まっているときは、次の「固まったとき」で、`orb restart` / `orb reset` は利用者の判断。

repo を書かない調査（web・docs の調査、読むだけの探索）は、Docker が動いていなくても Agent tool の子（Explore・claude-code-guide 等）に任せてよい。書き込み・レビュー・実装はコンテナを使う。

## Linux で動かない repo（iOS など）

Linux のコンテナでビルド・検証できない repo（iOS の WordinCard など）は、その repo の `AGENTS.md` で宣言したときに限り、worktree で委譲してよい（決定: [ADR 20261017](../adr/20261017-allow-orb-start-and-declared-worktree-exception.md)）。

宣言の書き方: `AGENTS.md` に節 `## 委譲の作業場所` を置き、行頭に次の 1 行を書く。理由は具体的に書く（空の理由、宣言の無い repo、このテンプレート repo 自身は対象外）。

```
## 委譲の作業場所
- agent-box: 使えない（理由: iOS のビルドに macOS / Xcode が要り、Linux のコンテナでは動かない）
```

運用:

- owner が `~/worktrees/<repo>/<名前>` に `git worktree add` し、そこを作業 dir にして Agent tool の子に任せる。1 子 = 1 worktree。`/tmp` などの一時領域には作らない（ADR 20260729）。`~/worktrees` を作業許可範囲に入れるのは `setup-user-hooks.sh --worktree-access`。
- 同時数・checkpoint・標準制約は `delegate-work` skill に従う。コンテナほどの隔離（トークン・資源・ファイルの制限）は無い。
- worktree の管理 script は無い。後始末は owner が `git worktree remove` で行う（guard が確認する）。未 push の commit が無いことを確かめてから消す。

## Docker が固まったとき（復旧）

見分け方: `docker run --rm agent-box:latest true` や `start` が止まる・コンテナが `Dead` になる。`orb logs docker` に `too many open files` と `…/io.containerd.snapshotter.v1.overlayfs/snapshots/<番号>` の path が出る。

1. 動いている子が無いことを確かめる: `docker ps --filter label=agent-box=1`。`collect` は検査コンテナを使うのでエンジンが固まっている間は動かない。子の clone はホストにあり reset で消えないので、取り込みは復旧の後に行う。
2. `orb restart docker` は効かない（再起動後も、残った snapshot の削除で再び固まる。2026-10-12 に確認）。snapshot だけを消す方法も、補助コンテナの片付けで再び固まって完了しなかった。
3. `orb list` で Linux machine が無いことと、`docker images`・`docker volume ls` で消えるものを確かめてから、`orb reset` を実行する。`orb reset` は Docker のコンテナ・image・volume と **Linux machine を含む OrbStack の全データ**を消す（確認の表示: "This will PERMANENTLY DELETE ALL DOCKER AND LINUX DATA!"）。破壊的なので、実行の判断はユーザーが行う。実行後は `orb start` で起動する。
4. image を作り直す: `docker build -t agent-box:latest docker/agent`。cache volume は空から再作成される。
5. 子の clone（`~/agents/<repo>/`）と `.results/` はホストにあるので消えない。`list` で session が残っていることを確かめ、`collect`・必要なら `resume` する。

## 準備（ユーザーが 1 回）

1. image を作る: `docker build -t agent-box:latest docker/agent`（ツールの版は Dockerfile の ARG で固定）。各 repo は `FROM agent-box:latest` で自分の依存を足し、`--image` で指定する。
2. 子用 GitHub トークン: GitHub の Settings → Developer settings → Fine-grained tokens で、Repository access を対象 repo だけにし、Contents: Read-only、Issues: Read and write、Pull requests: Read and write を付ける（他は No access）。`security add-generic-password -a "$USER" -s agent-gh-token-<repo> -w` で保存する（値は貼らない）。repo ごとに別のトークンにする。
3. Claude のトークン（サブスクリプションの枠をホストと共有する）: `claude setup-token` で発行し、`security add-generic-password -U -a "$USER" -s agent-claude-oauth-token -w` を実行して、入力欄に表示された `sk-ant-oat…` のトークンを貼る。値の形が違えば `start` が起動前に止まる。
4. Codex は試作の後半で扱う（ログインは `codex login --device-auth`。保存先は未定）。

## コマンド

| コマンド | 用途 |
|---|---|
| `start <session> [--branch <name>] [--base <ref名>] [--tool claude\|codex] [--prompt-file <file>] [--image <img>] [--allow-over-limit]` | ホストの `<ref名>`（既定 `origin/main`）から専用 clone を作り、子のコンテナを起動する。`--prompt-file` を付けると headless（結果は session の `home/.agent-box/output.log` と `exit-code`。エントリポイントの stderr は `entrypoint.log` に残り、起動の直後（数秒）に止まったら `running` と返さず、その stderr と exit code を添えて失敗する。#175）、付けなければ対話。`refs/agents/<session>/` が残っている名前は使えない。state file を書く前に失敗したら、その `start` が作った clone と session の dir を消して止まる（同じ名前で再実行できる） |
| `resume <session> [--prompt-file <file>]` | 既存 session に新しいコンテナで入り直す（Claude は `--continue`） |
| `list` | session と動作中のコンテナ（上限 3） |
| `collect <session>` | 子の全 ref をホストの `refs/agents/<session>/` に取り込む |
| `clean <session>` | 下の条件を満たせば、headless の結果と成果物（`~/.agent-box/artifacts/`）を `~/agents/<repo>/.results/` へ写してから、clone と session を承認なしで消す |
| `prune` | 片付け済みの session の `refs/agents/<session>/` のうち、merge 済みと確かめられたものだけを承認なしで消す（下の「ref の整理の条件」）。消したものと、残したものとその理由を出す |

`--base` は ref 名に限る（commit SHA は不可）。PR の branch をレビューさせるときは、取り込んだ後のホストの branch 名を渡す。

## owner の流れ（委譲）

1. `scripts/agent-box.sh start impl-126 --branch feat/126-x --prompt-file <依頼>` で実装を委譲する。完了はコンテナの終了で分かる。待機は `docker wait <container>` をバックグラウンドで 1 回実行し、その完了通知に集約する（即興の polling loop は guard が止める）。結果は session の `home/.agent-box/output.log` と `exit-code` に残る。
2. `collect impl-126` で取り込み、`git branch feat/126-x refs/agents/impl-126/heads/feat/126-x` でホストの branch にしてから、通常どおり push・PR を作る。main を checkout したまま push しても、pre-push の branch 名・topology の検査は走る。self-test は作業ツリーと違う commit では流さず、その旨を表示するので、PR の前にホストで両方の Bash の全件を流す（`merge-pr.sh` の `self-test:` の記録が merge の条件）。
3. レビューは `start review-126 --base refs/heads/feat/126-x --prompt-file <依頼>` で別の子に委譲する。子は L2 トークンで PR に直接コメントできる。
4. merge は owner が [merge authority ADR](../adr/20260918-adopt-ai-merge-authority.md) に従って行う。
5. 使い終わった子は `clean <session>` で片付ける。PR の merge 後に `prune` を実行すると、merge 済みの session の `refs/agents/<session>/` が消える。

## 片付けの条件

`clean` は次をすべて満たす場合だけ消す。1 つでも欠けば停止し、何も消さない。

- その session のコンテナが動いていない（検査の前後で確認）。
- 未コミットの変更が無い（tracked の変更と、ignore されていない未追跡ファイル）。
- 子の全 ref（branch・tag・stash・detached HEAD）を `refs/agents/<session>/` に取り込み、SHA が一致した。
- clone と session の path に symlink が無く、agent-box が作った state と一致する。
- headless の結果（`prompt.md`・`output.log`・`exit-code`）が通常のファイルで、`~/agents/<repo>/.results/<session>-<時刻>/` へ写せた。
- 成果物（`~/.agent-box/artifacts/`）が通常の dir で、中身を `.results/<session>-<時刻>/artifacts/` へ写せた。写しに失敗したら（再帰上限を含む）、作りかけの写しだけ消して停止し、clone と session は消さない。

同じ session 名は、`refs/agents/<session>/` を整理するまで `start` で使えない（`collect` は強制更新なので、片付け済みの成果を上書きしないため）。

## ref の整理の条件

`prune` は session ごとに判定し、次をすべて満たす session の ref だけを消す。1 つでも欠けば、その session の ref は全部残す（判定の失敗は残す側に倒す）。決定の背景は [ADR 20261014 prune](../adr/20261014-prune-merged-agent-refs.md)。

- 片付け済み（`clean` で state が消えている）。
- 子の各 branch（`heads/*`）が、`origin/main` の祖先であるか、同じ名前の branch から `main` へ merge 済みの PR の head の祖先（同じ commit を含む）である。squash merge でも判定できる。親の branch へ merge しただけの stacked PR は数えない。PR は `gh pr list --state merged --base main --head <branch>` で調べ、`gh` が失敗したら残す。
- `HEAD` が、`origin/main` か、merge 済みと確かめた branch・PR の head から辿れる（detached のまま作った commit を消さない）。辿れなければ、その SHA を含む main への merge 済み PR を `gh pr list --search <sha>` で探し、その head から辿れるかを見る（branch を持たないレビューの子の session。[ADR](../adr/20261014-prune-review-sessions-by-commit-search.md)）。
- `remotes/*` が、ホストの `refs/remotes/origin/*` から辿れる（GitHub にある写しと確かめられる）。
- `tags/*` やそれ以外の ref が無い。

ホストの `origin/*` と PR の head の commit はホストにある前提で判定する。`git fetch origin` が古いと残る側に倒れるので、整理の前に fetch しておく。消すときは、判定した時点の SHA と一致する場合だけ 1 回の transaction で消す。

## 成果物と報告の置き場

決定の背景は [ADR 20261012](../adr/20261012-keep-agent-artifacts-on-clean.md)。

- commit しない成果物（分析の結果・HTML のレポート等）は、子の home の `~/.agent-box/artifacts/`（`start` が用意する）に置く。`clean` はここだけを `.results/<session>-<時刻>/artifacts/` へ写す。それ以外の ignore されたファイルは残らない。「無視されるファイルが在れば止める」案は、依存の dir でほぼ毎回止まるので採らない（[`decisions.md`](./decisions.md)）。
- symlink は辿らず、写さない（停止はしない）。symlink・fifo 等の通常のファイルと dir 以外は、写さずに相対 path を `.results/<session>-<時刻>/skipped.txt` に 1 行ずつ残す。子は home を書き換えられるので、symlink を辿るとホストの手元のファイルを写してしまうため。`artifacts` 自体が symlink や通常のファイルなら停止する。
- 大きさの上限は設けない。大きなファイルを置くと `.results/` が膨らむので、置く前に必要かを考える。
- 報告の正本は issue / PR へのコメント。`output.log`（headless の出力）は予備として `.results/` へ写し続ける。
- headless の `output.log` は最後の 1 メッセージだけを持つ。子が最終報告の後に背景ジョブの通知へ返答すると、報告が上書きされて失われる（2026-10-14、#147 の実装の子）。PR・issue へのコメントを書かない子（実装の子など）への依頼には、最終報告を `~/.agent-box/artifacts/report.md` にも書くよう含める（`clean` で `.results/` へ写る）。

消えるもの: ignore されたファイル（build 成果物・依存・開発用 `.env` の写し）と、どの ref からも辿れない commit（reflog だけのもの）。

## 注意

- 子のコンテナの中でも `bash tests/run-tests.sh` は全件を判定する。ホストにしか無い前提（macOS の Bash 3.2・git の設定ベースの hook・ホストで guard が外れないことの確認）に頼る判定は `SKIP:` 行に理由と件数を出し、合否に数えない。owner がホストで全件を確かめ直すのは、skip された範囲を子が変更したときに限る（#135）。
- 子の clone をホストのエディタや shell で開くと、git 連携が子の `.git/config`（`core.fsmonitor` 等）を読んで実行する。中身の確認はファイルの閲覧に留めるか、`collect` 後のホスト側 ref で行う。
- コンテナに入れる秘密情報は開発用に限る（本番用は入れない）。外への通信を制限しないので、入れたものは持ち出されうる前提で扱う。
- 検査コンテナの中でも子の `.git/config` は効くので、`inspect.json`（未コミットの一覧）は子が書いたデータとして扱う。ref の保全は、ホスト側の `bundle verify` と SHA の照合で確かめる。
- 子は PR・issue を編集・close でき、コメントを削除できる（fine-grained PAT にコメントだけの権限は無い）。merge 時は今までどおり `--match-head-commit` でレビューした SHA と照合する。
- worktree の管理 script は撤去した（[ADR](../adr/20261014-remove-worktree-lifecycle-management.md)）。既存の worktree の実体は残り、後始末は `git worktree remove`（guard が確認する）で行う。新しく始める委譲・並行作業は agent-box を使う（例外は、宣言した repo の worktree と、repo を書かない調査。上の 2 節）。
