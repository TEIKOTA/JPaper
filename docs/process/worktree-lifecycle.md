# repo 単位の worktree lifecycle

方針の正本は [採択 ADR](../adr/20261002-adopt-worktree-lifecycle-management.md)、入力 scope は [issue #105](https://github.com/TEIKOTA/project-template/issues/105)。本書は CLI と実装設計の正本。既存 ADR の本文は変更しない。

## 保存・信頼境界

`scripts/worktree.sh`（Python backend `scripts/lib/worktree.py`）は実行 repo の common Git directory を管理単位とする。新規配置は `~/worktrees/<repo>/`、repo 名は通常 common directory の親の basename。`~/worktrees/.state/<common-directory-hash>/` に状態 JSON・session capability・排他 lock を保存するため、対象の回収で終了記録が失われない。`<repo>/.repo-id.json` は同名 clone/repo の衝突を防ぐ。初回の標準 root が非空なら、全 entry が同一 common directory の登録 worktree と証明できた場合だけ marker を作る。既存 entry を管理 child へ昇格しない。未管理・独立 clone・不明な file が混在した標準 root は停止し、手動の導入計画へ返す。

管理対象・状態・根拠 path は絶対物理 path として扱い、ancestor symlink・一時領域・既存 path の上書きを拒否する。標準外の新規作成は対象 path・repo・理由を含むユーザー明示承認 JSON を必要とする。手動 Git の既存標準外 worktree は一覧から消さず利用を禁止しない。

capability は同じ OS ユーザーの信頼された担当間の誤操作防止であり、OS による AI role 認証・人間の署名・悪意ある同一ユーザーに対する security boundary ではない。root 登録の approval は、今回の issue/ADR 合意など**既に得たユーザー承認を root が記録してよい**。同一合意の子回収について run ごとの新しい承認質問は要求しない。未合意の通常回収・配置例外には新たな対象固有の承認が必要。

root の capability 内容は root のみが保持し、子へ渡すのは作成結果の `owner_capability` path だけ。capability は state directory 内の 0600 file に限定し、登録 token hash・role・session を照合する。所有権は管理 PID の生存と分離し、短命な作成 shell が終了した後でも同じ owner capability で hold/end できる。任意の `--role root` / env flag から回収権限を作らない。`--pid` は**管理用 process の PID**であり Codex の agent session ID と同一ではない。PID の存在・不在や lsof の空表示だけでは agent-session の終了を証明しない。実際の agent 終了観測は root の confirmation に別途記録する。

## CLI

全 command は `--repo <checkout>` を command より前に指定できる（省略時 cwd）。JSON を stdout へ出し、不明・保護条件・衝突は非zeroで停止する。`scripts/worktree.sh -h` と各 command の `-h` も参照。

| Command | 用途 |
|---|---|
| `root-open --session <ID> --pid <管理PID> --approval <JSON>` | 既存のユーザー合意の根拠から root capability を作る |
| `create <path> [--base <ref>] [--branch <new-branch>]` | 標準作成。branch 省略なら detached。通常 owner capability を返す |
| `create ... --child --session <child-ID> --pid <管理PID> --capability <root-cap>` | 作成時に root/child ownership を固定する。子は root cap を持たない |
| `create ... --purpose review` | 終了時に review result と reviewed SHA を必須にする |
| `list` | 全登録 worktree、管理状態・未管理「要確認」・状態保存先を表示 |
| `job-add <path> --capability <owner-cap> --pid <PID> --reason <説明>` | 使用者が担当 job を登録（終了後の追加は不可） |
| `hold <path> --capability <owner-cap> --reason <理由>` | 保留。以前の終了記録を無効にする |
| `end <path> --capability <owner-cap> --report <JSON>` | 使用者の明示終了・固定 head・job 終了・外部根拠を記録 |
| `candidates` | 終了済み候補と保護理由を確認。候補でも回収権限の検査は別途必要 |
| `inspect <path> --capability <root-cap>` | root の現物検査用 snapshot/hash を作る（根拠を対象外へ保存する） |
| `reclaim <path> --capability <root-cap> --confirmation <JSON> [--user-approval <JSON>]` | 最新の snapshot/終了/活動/根拠/保持先を再確認して登録と directory だけ回収 |
| `verify-reclaim ...` | 同一安全条件の read-only 検査。hook は限定された child 例外の確認に使う |

`scripts/new-branch.sh ... --worktree <標準path>` は管理 `create` を呼ぶ。`--session`・`--pid`・`--child`・`--capability`・`--purpose`・`--placement-approval` を転送できる。branch 規約・backlog/fetch の既存 gate は存続する。委譲では初めから child 登録して作成し、レビュー修正ラウンドの終端まで end を出さない。通常作成で session/PID を省略した場合は一意の user ID / 呼出親 PID を登録する。長期の担当は生存する管理用 PID と明示 ID を指定する。

## 根拠 JSON の契約

JSON は対象 worktree 外の永続位置へ置く。内容・SHA256 と対象は状態に固定し、変更があれば回収を停止する。根拠 artifact は JSON を使う（ログ・レビュー本文をその中の結果/参照として記録してよい）。secret file は根拠に使わない。capability token を PR/ログへ掲載しない。

root approval の例（repo は `git rev-parse --path-format=absolute --git-common-dir` の結果）:

```json
{"kind":"root-session","approved_by":"user","session":"root-105","repo":"/Users/me/repo/.git","reason":"issue #105 の合意範囲で子専用回収を root に委任","source":"issue #105 / 2026-10-02 の合意"}
```

配置例外は `kind: placement`、`approved_by: user`、`repo`、絶対物理 `path`、`reason` を含め、`create --placement-approval` で渡す。一時領域の禁止は例外でも解除できない。

終了 report の例。`head` は対象 HEAD、`jobs` は状態の登録 job と完全一致させる。レビューは `review_result` と `reviewed_sha` を追加する。`evidence` 配列は対象外 JSON artifact の path を列挙し、終了時に hash を固定する。

```json
{"kind":"end","session":"child-105","path":"/Users/me/worktrees/repo/review-105","head":"<40桁SHA>","jobs":[],"jobs_ended":true,"work_ended":true,"evidence":[],"review_result":"blocking finding なし。確認範囲は…","reviewed_sha":"<対象SHA>"}
```

root は報告の受領だけで終了としない。実際の担当 agent/session 終了、登録・未登録 job の有無、保存された根拠を現物確認する。`inspect` の snapshot hash に対して confirmation を作る:

```json
{"kind":"root-confirmation","root_session":"root-105","owner_session":"child-105","path":"/Users/me/worktrees/repo/review-105","snapshot_sha256":"<inspect のhash>","session_ended_observed":true,"jobs_ended_observed":true,"evidence_saved_verified":true,"observation":"担当 agent の終了通知を確認。root が対象・job・保存根拠を実確認した日時と根拠…"}
```

通常 worktree はさらに `kind: reclaim`、`approved_by: user`、`path`、同じ `snapshot_sha256`、`reason` を持つ対象固有の承認を必要とする。既存の未管理分は今回 import/移動/回収しない。別途承認された導入計画で担当・使用終了を確認するまで保護する。

## 回収検査と限界

- 管理記録の明示 end、終了 head の維持、外部 report/artifact の hash、child 作成時の同一 root/session ownership を確認。main、管理コードのある checkout、呼出 cwd の祖先、locked/prunable、未管理分は保護する。
- tracked gitlink / submodule と root以外の `.git` marker/file/directory は、内側の成果物とcommit保持をparent Gitから保証できないため保護し回収しない（submodule `ignore=all` でも同じ）。
- tracked の変更は常に保護。`git ls-files --others` で untracked/ignored の実 file を別々に列挙し、空 directory と Git の列挙に出ない FIFO/socket 等も lstat で分類し、特殊 file は保護する。初期 `scripts/worktree-disposable.json` は空。tracked 正本の exact relative path / 末尾 `/` の directory prefix だけが破棄許可で、glob、`..`、絶対 path は不可。`.gitignore` は許可と無関係。
- clean な tracked symlink（`CLAUDE.md`/`.agents` 等）はリンク自身だけを Git が回収し、target を辿らない。未追跡/ignored symlink・許可 path の ancestor symlink・未分類 file/directory は保護する。許可済み生成物が実在する場合だけ `git worktree remove --force` を用いる。branch/ref は削除しない。
- `HEAD` を contains する ref を保持先として要求する。detached HEAD に保持先がなければ停止し、必要な commit を保持する ref を先に作る。merge 済みか・PR の状態は代用にならない。
- 登録 job の PID が生存なら停止。child の管理 PID が生存なら停止。root の confirmation で agent-session と未登録 job の終了も実観測する。`lsof -nP +D <target> -Fpcfn` に open file/cwd/警告/権限エラーがあれば停止。lsof 不在・timeout・失敗は活動不明として保護する。
- repo 単位の nonblocking flock と原子的 JSON 更新を使い、回収直前に登録・head・ref・file・活動・根拠・directory inode を再検査する。manual Git・他processは lock に協調しないため、OS上の全競合や観測後の新規job起動を原子的に阻止する保証はない。root は担当終了/競合不在を確認できない対象を回収しない。
- PID reuse は保護側に倒れるが、同一ユーザーの capability 盗用・承認/観測 report の虚偽記載は OS から識別できない。trusted agent/user の合意と実観測が必要。今回の合意を一般的な破壊操作・branch削除・remote変更・merge許可へ拡張しない。

## Hook 適用

Claude の既存 PreToolUse(Bash) は直接の `git worktree add` を標準物理 path に限定し、直接 remove/move/prune は対象承認へ返す。子回収例外は、cwd repo の追跡済みで未変更の `scripts/worktree.sh reclaim` の literal invocation（`bash` prefix 可）だけ。hook が read-only `verify-reclaim` を実行して delegated-child を確認した場合に限る。env assignment/任意wrapper/別backend/改変script/偽role flagはこの例外を得ない。runtime は実行時にも同じ検査を繰り返す。

Codex は [Hooks 正式文書](https://learn.chatgpt.com/docs/hooks)（2026-10-03確認、local CLI 0.159.3）の `PreToolUse` / matcher `Bash` / canonical `tool_input.command` へ配線。`exec_command` も canonical Bash で受ける。`ask`/`continue:false` が未対応なので、共有guardの ask を `guard-codex.py` が exit 2 + stderr へ変換し、失敗して実行継続となる形を使わない。project-local hooks は trust が必要。専門 tool の一部 opt-out、`write_stdin` の後続入力、任意の Python/他wrapper 内 shell、手動Gitすべてを監視する sandbox/security boundary ではない。

SessionStart は既存一覧に管理状態を追加する。区切りには担当が `candidates` の候補/保護理由を報告する（[delegate-work](../../.claude/skills/delegate-work/SKILL.md)、[fix-issue](../../.claude/skills/fix-issue/SKILL.md)）。

## 検証と既存分

fixture は fake HOME と home配下の専用一時fixture repoだけを使用し、実 worktree を削除しない。[検証記録](./worktree-lifecycle-evidence/validation.md) に red→green・self-test・frontmatter/link・PR 自己検査を保存する。既存登録一覧と clone の区別・移行計画は [棚卸し](./worktree-lifecycle-inventory.md) に保存する。既存分の実行は今回の対象外。
