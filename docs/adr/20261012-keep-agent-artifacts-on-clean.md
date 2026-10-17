# 2026/10/12 agent-box の片付けで子の成果物を残す

## Status
- accepted

[`20261008-adopt-container-isolated-agent-sessions.md`](./20261008-adopt-container-isolated-agent-sessions.md) の「片付けの条件 5」と「限界（ignore されたファイルは消える）」を補足する。他の条項は存続する。

## Situation
- #126 の試作で、子のコンテナへの委譲が実際に回り始めた。`clean` は子の clone を丸ごと消すので、commit しない成果物（分析の結果・HTML のレポート等）を ignore されるフォルダに置くと黙って消える。
- 子の報告の置き場に決まりが無く、headless の `output.log` を `.results/` へ写すだけだった。
- PR #127 の独立レビューの blocking 指摘を受け、2026-10-09 にユーザーと方針を合意した（#130）。

## Context
- 子は自分の home を自由に書き換えられる。写す処理が symlink を辿ると、ホストの手元のファイルを `.results/` へ写してしまう。
- 「ignore されたファイルが在れば `clean` を止める」案は、依存の dir（`node_modules`・`.venv` 等）でほぼ毎回止まり、片付けを承認なしで回す目的（ADR 20261008）に反する。

## Material for decision
- issue #130 の認識合わせ（2026-10-09）と、PR #127・#132 の独立レビュー。
- 関連: `start` が `refs/agents/<session>/` の残る名前を拒むこと、`start` の途中失敗の後始末（#128）は、ADR 20261008 と [`agent-containers.md`](../process/agent-containers.md) に既にあり、本 ADR では変えない。

## Decision
- 子の成果物の置き場を、子の home の `~/.agent-box/artifacts/` と決める。`start` が用意する。
- `clean` は、headless の結果（`prompt.md`・`output.log`・`exit-code`）と `artifacts/` の中身を、`~/agents/<repo>/.results/<session>-<時刻>/`（成果物は `artifacts/` 配下）へ写してから消す。これを ADR 20261008 の片付けの条件 5 に加える。
- 写すのは通常のファイルと dir だけ。symlink は辿らず写さず、fifo 等も写さない。写さなかったものの相対 path を `skipped.txt` に残す。symlink で停止はしない（子が置いた symlink 1 本で片付けが止まるのを避ける）。`artifacts` 自体が symlink や通常のファイルなら停止する。再帰せず辿るので、深い入れ子でも落ちない。
- 写しに失敗したら（`RecursionError` を含む）、作りかけの写しだけを消し、clone と session は消さずに停止する。
- 子の報告の正本は issue / PR へのコメントとする。`output.log` は予備として `.results/` へ写し続ける。
- 「ignore されたファイルが在れば止める」案は採らない。理由は Context のとおり。成果物の置き場を決め、そこだけ残す。
- 大きさの上限は設けない（文書で注意する）。

## Consequences
- 良い面: commit しない成果物が片付けで黙って消えなくなる。symlink を辿らないので、ホストの手元のファイルを写す経路が無い。報告の置き場が決まる。
- トレードオフ: `artifacts/` 以外の ignore されたファイルは従来どおり消える。大きなファイルを置くと `.results/` が膨らむ。`skipped.txt` は 1 行 1 path で、改行を含む名前は曖昧になる（ホストへの影響は無く、記録の信頼性だけの問題として受け入れる）。
