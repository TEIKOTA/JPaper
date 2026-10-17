# 2026/10/14 子のコンテナの cache を repo ごとに分け、起動前に容量を確かめる

## Status
- accepted

[`20261012-restrict-agent-container-writes-and-resources.md`](./20261012-restrict-agent-container-writes-and-resources.md) の制限に、cache の分離・ログの上限・起動前の容量の確認を足す。同 ADR の決定はすべて存続する。

## Situation
- PR #134（#133）の独立レビューで、子のコンテナの資源について non-blocking の指摘が残った（N1・N2・N4/N5・N6。#131 から #137 へ分割）。
- 2026-10-13 の grill（#137 本文の「決定事項」）で、ユーザーが各指摘の扱いを決めた。容量に上限が無いことの影響を尋ねられ、起動前の空き容量の確認を足すことも決めた。

## Context
- `/cache`（npm・pip の cache）は volume `agent-box-cache` 1 つを全 repo・全セッションで共有していた。子は別の repo の子が使う cache を書き換えられ、#126 で問題とした「セッション間の干渉」の経路が残っていた（N1）。
- コンテナのログに上限が無く、対話モードの大量出力で VM のログが増え続けうる（N2）。
- メモリの上限（子 3 GiB × 3 ＋ 検査 1 GiB ＝ 10 GiB）は VM の約 11.7 GiB に収まる前提だが、`--allow-over-limit` で子を 4 個以上にすると崩れ、その整合を test で守っていなかった（N4/N5）。
- `/work`・home（ホストのディスク）と `/cache`（VM のディスク）には容量の上限が無い。満杯になると、原因のセッションと無関係な repo のセッションや `docker build` まで書き込みに失敗する。

## Material for decision
- 実測（2026-10-13〜14）: VM のメモリ 12,599,472,128 byte（`docker info`）。ホストのディスクの空きは 2026-10-13 に 15 GiB、2026-10-14 に 88 GiB（`df -h /`。日によって大きく動く）。cache volume 392 KB。OrbStack の VM のディスクは `df` 上 24 GB → 98 GB と伸び、実体はホストのディスクの上にある。
- Docker の local driver の volume には容量の上限を付ける標準の方法が無い（tmpfs 型はメモリを使い、ファイルシステムのイメージを作る方法は運用が重い）。
- npm は lockfile の integrity（hash）で中身を確かめるが、pip は `--require-hashes` を付けない限り確かめない。

## Decision
- cache の volume を repo ごとに分ける（`agent-box-cache-<repo>`）。repo をまたいだ書き換えを防ぐ。同じ repo のセッション同士は共有する（毎回の取得し直しを避ける）。
- 子と検査の `docker run` に `--log-opt max-size=10m --log-opt max-file=3` を付ける（`LOG_LIMITS`）。
- `start`・`resume` は起動の前に次を確かめ、足りなければ何も作らずに止める。`--allow-over-limit` が外すのは個数の上限だけで、この確認は外さない。
  - メモリ: 動作中の子と新しい子、検査 1 つの上限の合計が、`docker info` の VM のメモリ以下。
  - 空き容量: ホストの `~/agents/` があるディスクと、VM のディスク（cache volume を mount した検査用のコンテナの `df`）の空きが、どちらも 5 GiB（`MIN_FREE_BYTES`）以上。
- `list` に repo の cache volume の大きさを出す（`docker system df -v`。読めなければ `null` で一覧は止めない）。
- 定数の整合（上限個の子と検査 1 つが既定の VM 約 11.7 GiB に収まる、tmpfs が memory の内側）を test で守る。

## Consequences
- 良い面: repo をまたいだ cache の書き換えが無くなる。満杯やメモリ不足の状態で新しいセッションを始めず、理由を出して止まる。cache の大きさが見える。
- 残る弱さ: 同じ repo のセッション同士は cache を共有する（pip の cache は hash を確かめないので、同じ repo の別のセッションに影響しうる）。容量の上限は無く、作業中の子がディスクを使い切ることは防げない。起動前の確認は、その時点の空きしか見ない。
- コスト: 起動のたびに `docker info` と、`df` のための短いコンテナを 1 つ動かす（1 秒程度）。repo ごとに volume が増える。旧 volume `agent-box-cache` は使われなくなるが、削除は提案のみ（`docker volume rm agent-box-cache`）。
- 同じ名前の repo（別の path にある同名の repo）は同じ volume を使う。キーチェーンの GitHub トークン（`agent-gh-token-<repo>`）と同じ前提。
