#!/usr/bin/env bash
# テンプレート検査スクリプト群の self-test。
# 使い方: bash tests/run-tests.sh（CI: .github/workflows/self-test.yml）
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
expect_out "print-issues: chore は空" "" print_issues "chore: x" "Closes #12"
expect_out "print-issues: HTML コメント内は空" "" print_issues "feat: x" "<!-- Closes #9 -->"

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
