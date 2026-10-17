# 2026/10/12 子のコンテナの書き込み層・資源・権限の制限

## Status
- accepted

[`20261008-adopt-container-isolated-agent-sessions.md`](./20261008-adopt-container-isolated-agent-sessions.md) の「子が手元で何を壊しても他のセッションには及ばない」を、コンテナの `docker run` の制限で成立させる。他の条項は存続する。

## Situation
- 2026-10-12、子のコンテナが自分の `/tmp`（コンテナの書き込み層）に約 1 万 4 千段の入れ子の dir（`/d/d/d/…`）を作った（深い入れ子で `RecursionError` を確かめる検証。#130 / PR #132 の作業中）。
- その片付けで containerd が書き込み層（overlayfs snapshot）の削除に失敗し、Docker エンジン全体が新しいコンテナを起動できなくなった。他の子の検査コンテナ・`docker run … true` も `Dead` で止まり、`orb restart docker` の後も残った snapshot の削除で再発した。
- 根拠のログ行（`orb logs docker`）: `…/d/d/d…: too many open files" path=/var/lib/docker/containerd/daemon/io.containerd.snapshotter.v1.overlayfs/snapshots/75`。
- 1 つのセッションが共有の Docker エンジンを止め、他のセッションに干渉した（#133）。

## Context
- 子のコンテナは権限確認を外したモードで動き、`docker run` に資源・書き込み層・capability の制限が無かった（PR #127 でも `--cap-drop` 等が non-blocking 指摘として残っていた）。
- 失敗した場所は子の中ではなく、ホスト側の containerd の削除処理。子の `ulimit nofile` を下げても防げない。overlayfs の snapshot に深い入れ子を作らせないことが要る。
- 子が書く必要のある場所は、mount した `/work`・home（`/home/node`）・`/cache` と一時 dir に限られる。

## Material for decision
- #133 本文と上のログ行。
- Docker の `--tmpfs` は既定で `noexec,nosuid,nodev`（docker run の仕様）。`/tmp` から実行するツール（npm の install script、Claude Code の一時 script 等）を壊さないため `exec` を明示する。
- tmpfs の容量は cgroup の memory に数えられる（Linux の仕様）。OrbStack の VM は約 11.7 GiB（2026-10-12 時点の実測）で、子は同時 3 個。
- 各ツールの書き込み先: Claude Code は `~/.claude`・`~/.claude.json` と `/tmp` の一時 dir、npm は `NPM_CONFIG_CACHE=/cache/npm`、git と gh は `~/.gitconfig`・`~/.config/gh`、lefthook は `/work/.git/hooks`、codex は `~/.codex`。これらは `/work`・home・`/cache`・`/tmp` に収まる（実ツールでの確認は owner が OrbStack で行う。#133 の Done When）。

## Decision
- 子と検査の `docker run` の両方に、同じ定数（`scripts/lib/agent_box.py` の `HARDENING`、`restrictions()`）から次を付ける。
  - `--read-only`: ルートを読み取り専用にする。書けるのは mount した `/work`・home・`/cache` と、下の tmpfs だけ。overlayfs の書き込み層に何も溜まらない。
  - `--tmpfs /tmp:rw,exec,nosuid,nodev,mode=1777,size=…,nr_inodes=200000`: 子 1 GiB・検査 256 MiB。tmpfs は snapshot の削除を通らない。`exec` を外さない。`nr_inodes` は入れ子や大量の小ファイルによる kernel 側の消費を抑える。`/tmp` はコンテナの終了で消える。
  - `--memory`（子 3 GiB・検査 1 GiB、`--memory-swap` は同値で swap なし）: 子 3 個＋検査 1 個の最大 10 GiB が VM の約 11.7 GiB に収まる。tmpfs もこの中に数える。
  - `--pids-limit`（子 1024・検査 256）: fork の暴走を止める。node・lefthook の並列・テストの実行には十分な余裕を持つ値。
  - `--cap-drop ALL` と `--security-opt no-new-privileges`: 子は非 root（uid 1000）で動き、setuid の binary も使わないので、ツールには影響しない。
- 検査コンテナは `--network none` のまま。
- `--ulimit nofile` は入れない。失敗したのはホスト側の containerd の削除処理で、子の fd 上限では防げず、下げると node・npm を壊すおそれだけが残る。
- `/var/tmp` は書き込み可にしない（`/tmp` に寄せる。必要になった時点で tmpfs を足す）。
- image は変えない（Dockerfile の ENV は調整不要）。再 build なしで効く。

## Consequences
- 良い面: 子が `/tmp` に深い入れ子や大量のファイルを作っても、書き込み層に残らないので片付けで Docker が止まらない。資源の暴走は子のコンテナの中で止まる（OOM kill・fork 失敗）。
- トレードオフ: `/tmp` は 1 GiB で、コンテナの終了で消える。大きな build の一時ファイルが 1 GiB を超えると失敗する（上限は定数 1 か所で変える）。子の `/work`・home はホストの dir なので、そこへの入れ子や大量ファイルは今回の制限の対象外（ホストのファイルシステムの話）。ルートに書く image 派生（`apt` 等のコンテナ内の実行時 install）は使えない（build 時に入れる）。
- 復旧手順（Docker が固まったとき）は [`agent-containers.md`](../process/agent-containers.md) に置く。
