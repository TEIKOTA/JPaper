# 2026/10/14 一時物の置き場 ~/.trashable を作り、定期掃除で消す

## Status
- accepted

AGENTS.md の「破壊的・不可逆な操作は提案のみ」の例外（自動の削除）に、`~/.trashable` の定期掃除を加える。`rm -rf` の確認ルール（`.claude/settings.json` の `Bash(rm -rf *)` と Bash guard の「`-r` と `-f` を両方付けた `rm`」）は変えない。

部分 supersede（2026-10-16）: 置換された条項 =「`rm -rf` の確認ルールは変えない」（Decision の 5 項目目を含む）／存続する条項 = `~/.trashable` の置き場・定期掃除・安全条件／後継 ADR = [20261016-narrow-ask-to-human-judgement.md](./20261016-narrow-ask-to-human-judgement.md)。

## Situation
- 作業・test 用に作った一時 dir を AI が `rm -rf` で消そうとすると、auto モードでも毎回確認が出て作業が止まる（#146、ユーザー報告 2026-10-14）。
- 2026-10-07 に、子が自分の scratchpad を `rm -rf` で掃除しないことを決めた。ただし、ホストのセッション・Codex・script がセッションを越えて使える共通の置き場は無かった。
- 2026-10-14 の grill-me（#146 本文の「決定事項」）で、ユーザーが置き場・掃除の条件・導入の手段を決めた。

## Context
- 確認ルールを緩める案（対象が一時 dir なら `rm -rf` を通す、掃除専用 script に `rm -rf` を内包する）は、文字列上の判定をすり抜ける抜け道になる。#113 で「例外で緩めない」と決め、2026-10-07 にも掃除専用 script を退けた。
- `/tmp` は OS の掃除で消え、セッションをまたいで使えない。置き場を決めて AI は消さず、消す作業を AI のコマンドの外（定期実行）に出せば、確認ルールを変えずに止まる回数を減らせる。

## Material for decision
- #146 本文と決定事項、`docs/process/decisions.md` の 2026-10-07 の行、#113、`scripts/setup-user-hooks.sh --git`（複製と配線の作りを揃える）。

## Decision
- 置き場: `~/.trashable/<project>/`（`<project>` は repo の名前）。AI は一時物をここに作り、自分では消さない（Claude の scratchpad も可。子のコンテナでは `/tmp`。子のコンテナには mount しない）。規則は AGENTS.md の編集ガードレールに置く。
- 掃除: `scripts/trashable-cleanup.py`（標準ライブラリだけ）を、macOS の launchd で毎日 12:00 に実行する。`setup-user-hooks.sh --trashable` が導入し、`--uninstall` が外す（`~/.trashable` の中身には触れない）。`--dry-run` に対応し、再実行しても結果は同じ（冪等）。
- 消す条件（単位は `~/.trashable/<project>/` 直下の項目。古さは項目の中で一番新しい更新時刻 `lstat`）:
  - 最後の更新から 7 日を超えた項目を消す。
  - 残った項目の `~/.trashable` 全体の合計（project ごとではない）が 10 GiB を超えたら、古い順に消して 10 GiB 以下にする。ただし直近 24 時間に更新した項目は消さない。それでも超えるなら警告を出す。
- 安全条件:
  - root が symlink、または通常の dir でなければ、何もせず理由を出す。root が無ければ何もしない。
  - symlink は辿らない。`<project>` が symlink ならその symlink 自体を 1 項目として扱い、消すのも symlink 自体だけ。root の外を指す symlink の先は残る。
  - 消すときは root を `O_NOFOLLOW` で開いた fd から `<project>` を `O_NOFOLLOW` で開き直し、その `dir_fd` で消す（`rmtree(dir_fd=…)`・`unlink(dir_fd=…)`）。path を辿り直さないので、判定と削除の間に途中の dir を symlink へ差し替えられても外を消さない（PR #151 の独立レビュー N1 で、path を検査してから消す方式では外を消せることを再現した）。このため Python 3.11 以上を要件にし、導入時と実行時に確かめる。
  - root が `/`・ホーム・その祖先なら何もしない（`--root` の誤用で全部を掃除対象にしない）。
  - 計測・削除に失敗した項目は残して警告を出す。
- `rm -rf` の確認ルール（settings・guard）は変えない。掃除は AI の Bash コマンドではなく launchd のジョブが行うので、確認ルールの対象外であり、緩める例外も作らない。
- AGENTS.md の自動回収の例外に、この定期掃除を加える。

## Consequences
- 良い面: 一時物の後片付けで AI が止まらない。確認ルールは対象を問わず維持される。置き場がセッション・ツールをまたいで共通になる。
- トレードオフ: 消すのは最大で 7 日後（合計が上限を超えれば、24 時間たった項目から早まる）。macOS の launchd 専用で、他の OS の定期実行は対象外。掃除は日に 1 回なので、1 日で 10 GiB を超えて書き込まれる場合は、その間は上限を超える。
- 残る弱さ: AI が置き場の外に一時物を作り続けることは規則では防げない。`rm -rf` の確認が残るので、止まる回数で気づける。掃除の不具合で置き場の外を消すリスクは、対象の解決・symlink の扱い・root の検査を fixture の test（保護を 1 つずつ外すと red になる）で守る。
