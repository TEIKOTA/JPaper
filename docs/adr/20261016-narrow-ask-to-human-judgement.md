# 2026/10/16 確認(ask)を人の判断が要る操作に絞り、一時領域の中の rm -rf は確認なしで通す

## Status
- accepted

2026-10-07 の決定（`docs/process/decisions.md`: `Bash(rm -rf *)` の確認ルールは対象を問わず維持）と、[20261014-add-trashable-workspace.md](./20261014-add-trashable-workspace.md) の「`rm -rf` の確認ルールは変えない」の条項を置き換える。`~/.trashable` の置き場と定期掃除の条項は存続する。

## Situation
- 2026-09-25〜10-16 の対話セッションのログ（集計スクリプトは #158 のコメント）で、guard の ask は 194 回、却下は 0 回だった（187 回は承認されて実行、7 回は実行時のエラー）。ask から実行までの待ちは中央値 34 秒、上位 1 割では 50 分を超え、自律実行が止まっていた。
- 内訳は `rm -rf` 88 回（JPaper が 80 回。対象のうち 31 回が scratchpad・`/tmp`）、worktree の回収 57 回（仕組みは #145 で撤去済み）、main への push 19 回（誤検知）、force push 14 回、`git branch -D` 10 回、`gh pr close` 4 回、`git clean -f` / `git reset --hard` が各 1 回。
- 2026-10-16 の grill（#158 本文の「認識合わせの結論」）で、ユーザーが基準と方針を決めた。

## Context
- ask が承認の形だけになると、本当に人が見るべき操作（共有状態の変更・作業の喪失）も同じ速さで承認され、確認の価値が薄れる。人の判断で結果が変わる操作だけに絞れば、止まる回数が減り、残る確認の重みが戻る。
- `rm -rf` の確認は、対象が一時領域の中でも出ていた。2026-10-07 と #146 は「確認ルールを緩める例外は抜け道になる」として、置き場を作る（AI は消さず、定期掃除が消す）側で止まる回数を減らした。しかし AI 自身が自作の一時物を消す場面は残り、確認が出続けた。
- `Bash(rm -rf *)` の静的な規則は path の条件を書けない。guard が通しても、この規則が確認を出す。
- main への push の誤検知は、`destructive_reason` が `cd` を追わず、hook 入力の cwd の branch で判定していたため。

## Material for decision
- #158 本文と集計、`docs/process/decisions.md` の 2026-10-07 の行、#48・#49・#113・#115・#146、PR #119・#122、`scripts/hooks/guard-bash.py`、`tests/guard-ask.py`（退行注入つき）。
- 旧版（origin/main の guard）と新版に同じ生成入力を渡した判定の比較（前置・後置のリダイレクト、wrapper、引用、`bash -c`・`eval`・`$()`、`;`・`&&`・`||`・`|` の連結を含む）。結果は PR のコメントに残す。

## Decision
- 基準: ask は、人の判断で結果が変わる操作だけにする。
- ask のまま残す操作（`scripts/hooks/guard-bash.py` の `destructive_reason` と `worktree` の回収）:
  - 共有・リモートの状態を変える操作: force push、main / master への push（明示の ref も、main 上の引数なしの push も）、`gh pr close`、`gh repo delete`。
  - 作業を失いうる操作: `git reset --hard`、`git clean -f`、`git checkout -- .`、`git branch -D`、`git worktree remove` / `move` / `prune`、ssh の任意コマンド。
  - `rm -rf`（再帰かつ強制）のうち、下の条件を満たさないもの。
- 確認なしで通す `rm -rf` の条件（`is_rm_temp_target`）。対象がすべて次を満たすときだけ通す:
  - 一時領域の「中」にある。一時領域は `~/.trashable`（HOME から）、`/tmp`、`/private/tmp`、`$TMPDIR`（hook プロセスの環境変数の値）、macOS の `/var/folders/<..>/<..>/T`（`/private` 付きも）。照合は大文字小文字を区別する（macOS で `/TMP` が同じ場所でも、確認する側に倒す）。
  - 一時領域のルートそのもの（`~/.trashable`・`/tmp`・`/private/tmp`・`$TMPDIR`・`/var/folders/<..>/T`）は通さない。`$TMPDIR` が `/` や HOME・その祖先を指すときは、一時領域として扱わない。
  - 変数・コマンド置換・glob・brace（`$` `` ` `` `*` `?` `[` `]` `{` `}` `!`）を含む形、`~user` / `~+` / `~-`、`..` を含む path は通さない。`~` と `~/…` だけを HOME に展開する。ただし、引用符・backslash を含む語、または command に `HOME` の文字列があるときは通さない（引用された `~` は展開されない。HOME の上書きで行き先が変わる）。
  - 相対 path は、基準 dir が分かるときだけ判定する。基準は hook 入力の cwd。command の先頭に並ぶ `cd` だけを追う（下記）。それ以外の `cd` / `pushd` / `popd` の言及がある、`env -C` / `sudo -D` がある、は基準を不明として確認する。
  - rm の option が `-r -R -f -v -d` と `--recursive --force --verbose --dir --one-file-system --preserve-root` だけ。それ以外（`--no-preserve-root`・`-i`・`-P` 等）は対象を読み切れないとして確認する。対象が 0 個の `rm -rf` も確認する。
- symlink の扱い（推測でなく判定方針として固定する）:
  - rm は最後の要素が symlink なら、リンク自体だけを消し、先を辿らない。そのため、最後の要素は symlink でも「親 dir の実体」で判定する。
  - 親 dir の実体（`realpath`）が一時領域（の実体）の中でなければ確認する。`/tmp/link/x` の `link` が外を指す形は、字面が `/tmp` の中でも確認になる。`link/*` は glob なので元から確認になる。
  - 末尾が `/` か `/.` で、最後の要素が symlink の形は確認する（`rm -rf link/` が先を辿りうる実装があるため）。
  - 途中の要素の symlink は、親 dir の `realpath` が解決する。一時領域の中にある symlink が外を指していても、`rm -r` はその中身を辿らない。
  - 判定と実行の間に symlink を差し替える競合（TOCTOU）は防がない。同じ UID の別 process が一時領域を操作できる前提では、guard では防げない。
- 先頭の `cd` を追う（`leading_cwd`）: `cd X && …` / `cd X; …` と、command の先頭に並ぶ `cd` だけを追い、移動先を git の branch の判定と rm の相対 path の基準にする。次のいずれかは追わず、旧来どおり hook 入力の cwd で判定する（追えない形は安全側＝今までどおり）: `cd` が先頭以外にも出る（条件の後・`then` の中・`eval` や `bash -c` の文字列の中）、`|`・`||`・`(`・`)`・単独の `&` がある、`$()` や `` ` `` を含む、行き先に展開がある、行き先が実在する dir でない、`cd -`・`popd`。`git -C` は従来どおり `git` の option として追う。`env -C` / `sudo -D` が付く segment は追わない。
- `.claude/settings.json` の `permissions.ask` から `Bash(rm -rf *)` を外す。`rm -rf` の判定は guard に一本化する。`tests/check-settings-permissions.py` は、`Bash(rm …)` の静的な ask 規則が戻ったら落ちる。他の ask 規則（`git push * main` など）は残す。
- `rm -rf` の確認の文面で、「一時物は `~/.trashable/<repo>/` に置く（その中と `/tmp` 等の中は確認なしで消せる）」と案内する。
- deny（secret の読み取り・即興の polling・一時領域の worktree）の判定は変えない。コンテナ内で guard を外す条件（`guard-bash.sh`）も変えない。
- Codex は `ask` を拒否（exit 2）に変えて通す（`guard-codex.py`）。そのため、通す条件が増えると Codex 側の拒否も減る。
- 却下した案: 10/07 の決定を維持して回数だけ減らす（確認が出る場面が残り、止まる原因が変わらない）。一覧はそのままで誤検知だけ直す（`rm -rf` の 88 回が残る）。ask を無くして拒否か許可に振り分ける（人の判断が要る操作の逃げ場が無くなる）。

## Consequences
- 良い面: `rm -rf` の 3 割強（scratchpad・`/tmp` が対象）と main への push の誤検知 19 回がなくなる。残る確認は共有状態の変更と作業の喪失に集まる。確認なしで通す条件が guard の中の 1 か所にまとまり、tests/guard-ask.py の退行注入（保護を 1 つずつ外すと red）で守られる。
- トレードオフ・残るリスク:
  - `/tmp`・`$TMPDIR` の下の、ほかのセッションの scratchpad や作業中の物も、確認なしで消せる。
  - 判定と実行の間の symlink の差し替えは防がない（上記）。
  - 判定できない形を確認に倒すので、`$TMPDIR/x` のような変数の形は確認が出る（実パスで書けば通る）。`xargs rm -rf`・`find -exec rm -rf` は従来どおり guard の対象外。
  - command に置換（`$()`・`` ` ``・`<()`・`>()`）が 1 つでもあれば、`rm -rf` は一時領域の判定を使わず確認する。`command_groups` が置換を別 segment に切り出し、rm の対象から消えるため（PR #165 の review B1）。同じ command に `ln` / `mv` があるときも確認する。判定時と実行時で path の実体が変わりうるため（N1）。どちらも粗く、安全側の形である。一時領域の判定で例外が出たときも確認する（N3）。
  - `ln` / `mv` の検出は command の文字列への正規表現で、`l''n`・`"l"n`・`l\n` のように引用や backslash で名前を割る形や、`ln`・`mv` 以外で symlink を作る形（`cp -s`・`install`・`python -c 'os.symlink(...)'`）は拾わない。シェルの全構文を再現しない方針（#113 の教訓）のため網羅的な検出はしない（#166、PR #165 の再レビュー R1）。なお行末の backslash＋改行の継続は、引用の外にあるものを guard が畳んでから読むので、`l\` ＋改行＋`n` と割る形は拾う（引用の中の継続は文字列の一部なので畳まない）。
  - `cd X && git checkout main && git push` のように、移動先での branch の切り替えや `--git-dir` の指定までは追わない（N2）。
  - 子のコンテナの中では guard を外す（`AGENT_BOX=1` かつ `/.dockerenv`）ので、静的な `Bash(rm -rf *)` を外したことで、コンテナの中の `rm -rf` は確認されなくなる。コンテナの境界が守る、という #126 D16 の設計どおり（N4）。
  - cd を追わない形が増えるほど、誤検知（main への push の確認）は旧来どおり残る。
  - `rm -Rf`（大文字 R）も `rm -rf` と同じ判定にした。旧版は確認しなかったので、この形だけ以前より厳しくなる。
- 効果の測り直し: merge から 3 週間ほど後に、#158 のコメントの集計スクリプトで ask の回数を測り直す。
