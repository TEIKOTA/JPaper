#!/usr/bin/env bash
# テンプレート検査スクリプト群の self-test。
# 使い方: bash tests/run-tests.sh（ローカル実行が正本。CI は既定オフ: .github/workflows-disabled/self-test.yml）
# bash 3.2（macOS /bin/bash）互換。失敗ケースを意図的に踏むため set -e は使わない。
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PASS=0
FAIL=0

report() { # report <want-rc> <got-rc> <desc>
  if [ "$1" -eq "$2" ]; then
    PASS=$((PASS + 1))
    printf 'PASS: %s\n' "$3"
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL: %s (exit=%s expected=%s)\n' "$3" "$2" "$1"
  fi
}

expect() { # expect <0|1> <desc> <cmd...>
  local want="$1" desc="$2" rc=0
  shift 2
  "$@" >/dev/null 2>&1 || rc=1
  report "$want" "$rc" "$desc"
}

expect_out() { # expect_out <desc> <expected-output> <cmd...>
  local desc="$1" wantout="$2" out
  shift 2
  out="$("$@" 2>/dev/null)"
  if [ "$out" = "$wantout" ]; then
    PASS=$((PASS + 1))
    printf 'PASS: %s\n' "$desc"
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL: %s (got=[%s] want=[%s])\n' "$desc" "$out" "$wantout"
  fi
}

# ---- helpers -----------------------------------------------------------

subject() { bash "$ROOT/scripts/check-commit-msg.sh" --subject "$1"; }
branch_arg() { bash "$ROOT/scripts/check-branch-name.sh" "$1"; }
branch_stdin() { printf '%s\n' "$1" | bash "$ROOT/scripts/check-branch-name.sh"; }
body() { printf '%s' "$2" | bash "$ROOT/scripts/check-pr-body-close.sh" --title "$1"; }
print_issues() { printf '%s' "$2" | bash "$ROOT/scripts/check-pr-body-close.sh" --title "$1" --print-issues; }

# ---- check-commit-msg.sh ----------------------------------------------

echo "== check-commit-msg.sh =="
expect 0 "subject: feat 正常" subject "feat: ログイン画面を追加"
expect 0 "subject: scope 付き" subject "fix(api): タイムアウトを修正"
expect 0 "subject: revert type" subject "revert: 変更を取り消す"
expect 1 "subject: 日本語なしを拒否" subject "feat: add login screen"
expect 1 "subject: type なし" subject "ログイン画面を追加"
expect 1 "subject: 不正 type" subject "feature: ログイン画面を追加"
expect 1 "subject: 説明なし" subject "feat:"
expect_out "--types が revert を含む" "feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert" \
  bash "$ROOT/scripts/check-commit-msg.sh" --types

msg_ok="$(mktemp)"; msg_ng="$(mktemp)"
printf '# comment\n\nfeat: テストを追加\n\nbody\n' > "$msg_ok"
printf 'bad message\n' > "$msg_ng"
expect 0 "file: コメント行スキップで正常" bash "$ROOT/scripts/check-commit-msg.sh" "$msg_ok"
expect 1 "file: 不正な件名" bash "$ROOT/scripts/check-commit-msg.sh" "$msg_ng"
rm -f "$msg_ok" "$msg_ng"

# ---- check-branch-name.sh ----------------------------------------------

echo "== check-branch-name.sh =="
expect 0 "branch: main" branch_arg main
expect 0 "branch: feat/12-login-screen" branch_arg feat/12-login-screen
expect 0 "branch: chore/update-deps（issue なし可）" branch_arg chore/update-deps
expect 0 "branch: chore/34-with-issue" branch_arg chore/34-with-issue
expect 1 "branch: issue 番号なし feat" branch_arg feat/login-screen
expect 1 "branch: 不正 prefix" branch_arg feature/12-login
expect 1 "branch: 大文字 slug" branch_arg feat/12-LoginScreen
expect 0 "stdin: 準拠 ref" branch_stdin "refs/heads/feat/12-x s1 refs/heads/feat/12-x s2"
expect 1 "stdin: 違反 ref" branch_stdin "refs/heads/feature/bad s1 refs/heads/feature/bad s2"
expect 1 "stdin: refspec 別名 push を拒否" branch_stdin "refs/heads/feat/12-x s1 refs/heads/feature/bad s2"
expect 0 "stdin: branch 削除はスキップ" branch_stdin "(delete) 0000 refs/heads/feature/bad s2"
expect 0 "stdin: tag push は対象外" branch_stdin "refs/tags/v1 s1 refs/tags/v1 s2"

# ---- new-branch.sh ------------------------------------------------------

echo "== new-branch.sh =="
nb_repo="$(mktemp -d)"
git -C "$nb_repo" init -q -b main
git -C "$nb_repo" -c user.email=t@example.com -c user.name=t commit -q --allow-empty -m init
run_newbranch() { (cd "$nb_repo" && bash "$ROOT/scripts/new-branch.sh" "$@"); }
expect 0 "new-branch: 3 引数形式で作成" run_newbranch feat 12 login-screen
rc=0; [ "$(git -C "$nb_repo" branch --show-current)" = "feat/12-login-screen" ] || rc=1
report 0 "$rc" "new-branch: 作成後に checkout 済み"
expect 0 "new-branch: 1 引数形式（chore・issue なし）" run_newbranch chore/update-deps --from main
expect 1 "new-branch: 既存 branch 名を拒否" run_newbranch feat 12 login-screen
expect 1 "new-branch: 規約違反名を拒否" run_newbranch feature 12 bad
rc=0; git -C "$nb_repo" show-ref --verify -q refs/heads/feature/12-bad && rc=1
report 0 "$rc" "new-branch: 拒否時に branch を作らない"
expect 1 "new-branch: 引数 2 個は usage エラー" run_newbranch feat 12
rm -rf "$nb_repo"

# ---- check-pr-body-close.sh --------------------------------------------

echo "== check-pr-body-close.sh =="
expect 0 "body: Closes 正常" body "feat: x" "- Closes #12"
expect 0 "body: fixes 小文字" body "feat: x" "fixes #3"
expect 0 "body: chore 免除" body "chore: 依存更新" ""
expect 0 "body: 例外理由あり" body "feat: x" "例外理由: stacked PR のため base 確定後に連結する"
expect 1 "body: HTML コメント内 Closes は無効" body "feat: x" "<!-- Closes #9 -->"
expect 1 "body: コードフェンス内 Closes は無効" body "feat: x" '```
Closes #9
```'
expect 1 "body: 文中の close は無効" body "feat: x" "この PR は Closes #12 を含まない扱いにする"
expect 1 "body: 番号なし Closes #" body "feat: x" "- Closes #"
expect 1 "body: 例外理由プレースホルダ(-)" body "feat: x" "例外理由: -"
expect 1 "body: 例外理由プレースホルダ(<...>)" body "feat: x" "例外理由: <具体的な理由>"
expect 1 "body: 連結なし" body "feat: x" "説明だけ"
expect_out "print-issues: 単一" "12" print_issues "feat: x" "- Closes #12"
expect_out "print-issues: 複数・昇順・重複排除" "3
12" print_issues "feat: x" "Closes #12
fixes #3
closes #12"
expect_out "print-issues: cross-repo は対象外" "" print_issues "feat: x" "Closes owner/repo#5"
expect_out "print-issues: chore でも明記した番号を返す" "12" print_issues "chore: x" "Closes #12"
expect_out "print-issues: HTML コメント内は空" "" print_issues "feat: x" "<!-- Closes #9 -->"

# PR テンプレート自体と gate の整合（テンプレの構造を gate 自身が拒否する
# 自己矛盾の再発防止）。記入済みサンプルは通り、プレースホルダのままは落ちる。
expect 0 "PR テンプレ: 記入済みサンプルは gate を通る" \
  body "feat: サンプル" "$(sed 's/^- Closes #$/- Closes #123/' "$ROOT/.github/PULL_REQUEST_TEMPLATE.md")"
expect 1 "PR テンプレ: プレースホルダのままは落ちる" \
  body "feat: サンプル" "$(cat "$ROOT/.github/PULL_REQUEST_TEMPLATE.md")"

# ---- check-pr.sh（fake gh）----------------------------------------------

echo "== check-pr.sh =="
CP_FAKE="$ROOT/tests/fake-gh"
cp_log="$(mktemp)"
run_checkpr() { # run_checkpr <title> <body> <existing-issues> <existing-prs> [args...]
  local t="$1" b="$2" is="$3" prs="$4"
  shift 4
  FAKE_GH_LOG="$cp_log" FAKE_GH_PR_TITLE="$t" FAKE_GH_PR_BODY="$b" \
    FAKE_GH_ISSUES="$is" FAKE_GH_ISSUE_PRS="$prs" PATH="$CP_FAKE:$PATH" \
    bash "$ROOT/scripts/check-pr.sh" "$@"
}
expect 0 "pr: タイトル+Closes+実在 issue で正常" run_checkpr "feat: 機能を追加" "- Closes #12" "12" "" 12
expect 0 "pr: chore は連結免除" run_checkpr "chore: 依存更新" "" "" ""
expect 1 "pr: 不正タイトルを拒否" run_checkpr "feature: bad" "- Closes #12" "12" "" 12
expect 1 "pr: 連結なし body を拒否" run_checkpr "feat: 機能を追加" "説明だけ" "" ""
expect 1 "pr: 存在しない issue 参照を拒否" run_checkpr "feat: 機能を追加" "- Closes #99" "12" ""
expect 1 "pr: PR 番号への参照を拒否" run_checkpr "feat: 機能を追加" "- Closes #7" "" "7"
expect 1 "pr: 数字でない PR 番号引数を拒否" run_checkpr "feat: x" "" "" "" abc
rm -f "$cp_log"

# ---- wait-for-marker.sh -------------------------------------------------

echo "== wait-for-marker.sh =="
wm_log="$(mktemp)"
printf 'working...\nDONE_MARKER=1\n' > "$wm_log"
expect 0 "wait: marker 既出で即 exit 0" \
  bash "$ROOT/scripts/wait-for-marker.sh" --log "$wm_log" --marker 'DONE_MARKER=' --timeout 5
expect 1 "wait: marker 不在は timeout（exit 124）" \
  bash "$ROOT/scripts/wait-for-marker.sh" --log "$wm_log" --marker 'NEVER_APPEARS' --timeout 1 --interval 1
expect 1 "wait: 必須引数なしは usage エラー" \
  bash "$ROOT/scripts/wait-for-marker.sh" --log "$wm_log"
expect 1 "wait: 不明な引数を拒否" \
  bash "$ROOT/scripts/wait-for-marker.sh" --log "$wm_log" --marker x --bogus 1
expect 1 "wait: timeout に非整数を拒否" \
  bash "$ROOT/scripts/wait-for-marker.sh" --log "$wm_log" --marker x --timeout abc
rm -f "$wm_log"

# ---- hooks/guard-bash.sh（PreToolUse hook）------------------------------

echo "== hooks/guard-bash.sh =="
run_hook() { # run_hook <bash-command-string>
  printf '{"tool_input":{"command":"%s"}}' "$1" | bash "$ROOT/scripts/hooks/guard-bash.sh"
}
expect 0 "hook: 通常コマンドは許可" run_hook "ls -la src"
expect 0 "hook: home 配下への worktree add は許可" run_hook "git worktree add ~/repo-worktrees/wt feat/1-x"
expect 1 "hook: /tmp への worktree add を拒否" run_hook "git worktree add /tmp/wt feat/1-x"
expect 1 "hook: /private/tmp への worktree add を拒否" run_hook "git worktree add /private/tmp/wt feat/1-x"
expect 1 "hook: \$TMPDIR への worktree add を拒否" run_hook "git worktree add \$TMPDIR/wt feat/1-x"
expect 1 "hook: cat .env を拒否" run_hook "cat .env"
expect 1 "hook: grep で .env.local を拒否" run_hook "grep KEY .env.local"
expect 1 "hook: 秘密鍵の読み取りを拒否" run_hook "cat ~/.ssh/id_rsa"
expect 0 "hook: cat .env.example は許可" run_hook "cat .env.example"
expect 0 "hook: .env の存在確認は許可" run_hook "ls .env"
expect 1 "hook: 連結記号の後の worktree add も拒否" run_hook "cd repo && git worktree add /tmp/wt"
expect 1 "hook: 2 行目の cat .env も拒否" run_hook "ls\\ncat .env"
expect 0 "hook: 散文中の worktree・/tmp 言及は許可" run_hook "echo git worktree add の説明を /private/tmp/x.md に書く"
expect 0 "hook: 別区間の .env リテラルと reader の同居は許可" run_hook "ls | grep x && printf {\\\"c\\\":\\\".env\\\"} | bash h.sh"
expect 1 "hook: パイプ後段の reader に .env は拒否" run_hook "echo x | grep KEY .env"
expect 1 "hook: && 後段の cat .env は拒否" run_hook "cd repo && cat .env"
expect 0 "hook: 空入力は許可" bash "$ROOT/scripts/hooks/guard-bash.sh" < /dev/null
expect 0 "settings.json: 正しい JSON" python3 -m json.tool "$ROOT/.agents/settings.json"

# ---- hooks/post-edit-selftest.sh（PostToolUse hook）---------------------

echo "== hooks/post-edit-selftest.sh =="
pe_root="$(mktemp -d)"
mkdir -p "$pe_root/scripts" "$pe_root/tests"
printf '#!/usr/bin/env bash\nexit 0\n' > "$pe_root/tests/run-tests.sh"
run_pe() { # run_pe <edited-file-path>
  printf '{"tool_input":{"file_path":"%s"}}' "$1" | CLAUDE_PROJECT_DIR="$pe_root" bash "$ROOT/scripts/hooks/post-edit-selftest.sh"
}
expect 0 "post-edit: scripts/ 編集後に self-test 成功なら許可" run_pe "$pe_root/scripts/x.sh"
printf '#!/usr/bin/env bash\necho FAIL: x\nexit 1\n' > "$pe_root/tests/run-tests.sh"
expect 1 "post-edit: scripts/ 編集後に self-test 失敗なら拒否" run_pe "$pe_root/scripts/x.sh"
expect 1 "post-edit: tests/ 編集も対象" run_pe "$pe_root/tests/run-tests.sh"
expect 0 "post-edit: docs 編集は self-test を実行しない" run_pe "$pe_root/docs/a.md"
expect 0 "post-edit: 空入力は許可" bash "$ROOT/scripts/hooks/post-edit-selftest.sh" < /dev/null
rm -rf "$pe_root"

# ---- hooks/guard-stop.sh（Stop hook）------------------------------------

echo "== hooks/guard-stop.sh =="
gs_repo="$(mktemp -d)"
git -C "$gs_repo" init -q -b main
printf 'a\n' > "$gs_repo/f.txt"
printf 'a\n' > "$gs_repo/g.txt"
git -C "$gs_repo" add f.txt g.txt
git -C "$gs_repo" -c user.email=t@example.com -c user.name=t commit -q -m init
run_stop() { # run_stop <json>
  (cd "$gs_repo" && printf '%s' "$1" | bash "$ROOT/scripts/hooks/guard-stop.sh")
}
expect 0 "stop: 差分なしは許可" run_stop '{"session_id":"s1","stop_hook_active":false}'
printf 'b\n' > "$gs_repo/f.txt"
expect 1 "stop: 未コミット差分があれば 1 回目は拒否" run_stop '{"session_id":"s1","stop_hook_active":false}'
expect 0 "stop: 同一差分状態の 2 回目は許可（ループ防止）" run_stop '{"session_id":"s1","stop_hook_active":false}'
expect 1 "stop: 別セッションでは再度警告" run_stop '{"session_id":"s2","stop_hook_active":false}'
printf 'c\n' > "$gs_repo/f.txt"
expect 0 "stop: 同じファイルの編集継続は再警告しない" run_stop '{"session_id":"s1","stop_hook_active":false}'
printf 'b\n' > "$gs_repo/g.txt"
expect 1 "stop: 差分ファイル集合が変われば再度警告" run_stop '{"session_id":"s1","stop_hook_active":false}'
expect 0 "stop: stop_hook_active は常に許可" run_stop '{"session_id":"s3","stop_hook_active":true}'
git -C "$gs_repo" checkout -q f.txt g.txt
printf 'x\n' > "$gs_repo/new.txt"
expect 0 "stop: 未追跡ファイルだけなら許可" run_stop '{"session_id":"s4","stop_hook_active":false}'
rm -rf "$gs_repo"

# ---- setup-github-repo.sh（fake gh）------------------------------------

echo "== setup-github-repo.sh =="
FAKE_BIN="$ROOT/tests/fake-gh"
EXISTING_LABELS="bug
enhancement
kind:bug"

run_setup() { # run_setup <log> <stdout-file> <args...>
  local log="$1" out="$2"
  shift 2
  : > "$log"
  FAKE_GH_LOG="$log" FAKE_GH_LABELS="$EXISTING_LABELS" PATH="$FAKE_BIN:$PATH" \
    bash "$ROOT/scripts/setup-github-repo.sh" "$@" > "$out" 2>&1
}

log="$(mktemp)"; out="$(mktemp)"

expect 0 "既定: 実行成功" run_setup "$log" "$out"
rc=0; [ "$(grep -c '^label create' "$log")" -eq 11 ] || rc=1
report 0 "$rc" "既定: labels.yml の 11 件を upsert"
rc=0; grep -q '^label delete' "$log" && rc=1
report 0 "$rc" "既定: 削除を実行しない"
rc=0; grep -q "定義外ラベル 'bug'" "$out" || rc=1
report 0 "$rc" "既定: 定義外ラベルを info 表示"
rc=0; grep -qF 'api --method PUT repos/{owner}/{repo}/actions/permissions -F enabled=false' "$log" || rc=1
report 0 "$rc" "既定: Actions を無効化する"

expect 0 "--prune: 実行成功" run_setup "$log" "$out" --prune
rc=0; grep -q '^label delete bug ' "$log" && grep -q '^label delete enhancement ' "$log" || rc=1
report 0 "$rc" "--prune: 定義外ラベルを削除"
rc=0; grep -q '^label delete kind:bug' "$log" && rc=1
report 0 "$rc" "--prune: 定義済みラベルは削除しない"
last_create="$(grep -n '^label create' "$log" | tail -n1 | cut -d: -f1)"
first_delete="$(grep -n '^label delete' "$log" | head -n1 | cut -d: -f1)"
rc=1
if [ -n "$last_create" ] && [ -n "$first_delete" ] && [ "$last_create" -lt "$first_delete" ]; then rc=0; fi
report 0 "$rc" "--prune: upsert 完了後に削除する順序"

expect 0 "--dry-run: 実行成功" run_setup "$log" "$out" --dry-run --prune
rc=0; [ "$(grep -c . "$log")" -eq 1 ] && grep -q '^label list' "$log" || rc=1
report 0 "$rc" "--dry-run: 読み取り以外の gh を呼ばない"
rc=0; grep -q '^dry-run: gh label create' "$out" || rc=1
report 0 "$rc" "--dry-run: 実行予定コマンドを表示"
rc=0; grep -qF 'dry-run: gh api --method PUT' "$out" || rc=1
report 0 "$rc" "--dry-run: Actions 無効化コマンドを表示"

expect 0 "--enable-actions: 実行成功" run_setup "$log" "$out" --enable-actions
rc=0; grep -q 'actions/permissions' "$log" && rc=1
report 0 "$rc" "--enable-actions: 無効化を呼ばない"

# 不正な labels.yml の拒否（重複 name / 不正 color）
tmp_root="$(mktemp -d)"
mkdir -p "$tmp_root/.github" "$tmp_root/scripts"
cp "$ROOT/scripts/setup-github-repo.sh" "$tmp_root/scripts/"
cat > "$tmp_root/.github/labels.yml" <<'EOF'
- name: "dup"
  color: "ffffff"
  description: "a"
- name: "dup"
  color: "ffffff"
  description: "b"
EOF
expect 1 "labels.yml: name 重複を拒否" env FAKE_GH_LOG="$log" FAKE_GH_LABELS="" \
  PATH="$FAKE_BIN:$PATH" bash "$tmp_root/scripts/setup-github-repo.sh"
cat > "$tmp_root/.github/labels.yml" <<'EOF'
- name: "x"
  color: "red"
  description: "a"
EOF
expect 1 "labels.yml: 不正 color を拒否" env FAKE_GH_LOG="$log" FAKE_GH_LABELS="" \
  PATH="$FAKE_BIN:$PATH" bash "$tmp_root/scripts/setup-github-repo.sh"
: > "$tmp_root/.github/labels.yml"
expect 1 "labels.yml: 空定義を拒否" env FAKE_GH_LOG="$log" FAKE_GH_LABELS="" \
  PATH="$FAKE_BIN:$PATH" bash "$tmp_root/scripts/setup-github-repo.sh"

rm -rf "$tmp_root"
rm -f "$log" "$out"

# ---- summary -------------------------------------------------------------

echo
echo "passed: $PASS / failed: $FAIL"
[ "$FAIL" -eq 0 ]
