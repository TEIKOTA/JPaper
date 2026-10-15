# 2026/10/15 jpaper の起動時に、早送りで追いつける repo の更新を取り込んでから動かす

## Status
- accepted

## Situation
- jpaper は repo を clone して `pnpm link --global` で使う（[jpaper コマンドの決定](../process/decisions.md)、#367）。`bin/jpaper.mjs` は repo のソースを tsx で直接動かすので、`git pull` すれば build なしで新しい版になる。
- 利用者は repo の中で開発しない人もいて、`git pull` を忘れると修正の入らない古い版を使い続ける。

## Context
- 利用者から「jpaper の起動タイミングでリポジトリに更新あればアップデートするのが基本では」と指摘があった（#420）。
- ただし、黙って `git pull` すると、手元の変更・main 以外の branch とぶつかる、オフラインで起動が待たされる、依存が変わったのに入れ直さず壊れたまま動く、という事故が起きうる。

## Material for decision
- `git merge --ff-only` は、早送りできないときに何も変えずに失敗する。
- `jpaper web` は依存が古ければ `pnpm install --frozen-lockfile` を自分で行う（#410、契約付録 §5）。

## Decision
- `bin/jpaper.mjs` は、tsx と `src/cli.ts` を読む前に `bin/self-update.mjs` を呼び、repo の更新を取り込む。取り込んだ回から新しい版で動く。
- `git fetch origin main` を 5 秒の時間制限で行い、次の 4 つがすべて満たされるときだけ `git merge --ff-only origin/main` する: ① main にいる ② 追跡ファイルに未コミットの変更が無い ③ 早送りで追いつける ④ Web アプリ（`jpaper web`・`pnpm dev:web`）が動いていない。Web アプリは動いている間 `<repo>/.jpaper-web/<pid>` を置き、生きている pid の目印があれば取り込まない（Web の API は `tsx watch` で `src/` も見ており、取り込むと API が再起動して実行中の翻訳ジョブが消えるため。[failure-patterns](../process/failure-patterns.md) の「Web アプリ経由の e2e のジョブが消えた」と同じ仕組み）。
- 取り込んだら 1 行で知らせる（stderr）。入れた依存（`node_modules/.pnpm/lock.yaml`）が `pnpm-lock.yaml` と違えば、Web アプリが動いていない限り `pnpm install --frozen-lockfile` を実行する（取り込んだときに限らない。前回の失敗を次の起動でやり直す）。更新があるのに取り込めないとき（main 以外・未コミットの変更・分岐）は理由を 1 行で知らせて今の版で起動する。fetch の失敗・時間切れは黙って今の版で起動する。
- git は端末のプロンプトを出さないように動かす（`GIT_TERMINAL_PROMPT=0`、利用者が `GIT_SSH_COMMAND` を決めていなければ `ssh -o BatchMode=yes`）。認証が要る origin では fetch が失敗し、黙って今の版で起動する。`GIT_DIR`・`GIT_WORK_TREE`・`GIT_INDEX_FILE` などは引き継がない。
- 環境変数 `JPAPER_NO_UPDATE=1` で止められる。`.git` が無ければ何もしない。`pnpm dev`・`pnpm dev:web` では行わない。

## Consequences
- 利用者は `git pull` を忘れても最新の main で動く。手元の変更や作業中の branch は壊さない。
- 起動のたびに fetch の分だけ遅くなる（最大 5 秒）。
- origin の main に入ったコードを、次の起動で確認なしに動かす。main への merge は CI の全ジョブの成功を要する（[CI 必須の ADR](./20261015-require-ci-checks-on-public-repo.md)）が、壊れた変更や悪意のある変更が main に入れば、利用者の手元でもそのまま動く。止めたい利用者は `JPAPER_NO_UPDATE=1` を使う。
- stdout は使わない（翻訳の `RunSummary` の JSON を汚さない）。
- 見るのは `origin` の main だけ。origin が fork の利用者には、元の repo の更新は入らない。
- 取り込んだ回は、すでに読み込んだ古い `bin/jpaper.mjs`・`bin/self-update.mjs` で新しい `src/` を動かす。起動用のファイルの約束事を変えるときは、1 回目だけ食い違うことに気をつける。
- `jpaper web` を動かしている間は、別の端末の `jpaper` は更新を取り込まない（Web アプリを止めた後の起動で取り込む）。
