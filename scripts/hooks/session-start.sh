#!/usr/bin/env bash
# SessionStart(startup/resume/compact) の stdout を、再開直後の最小コンテキストとして返す。
# GitHub 参照は短い timeout 付きで fail-open とし、ローカル状態の報告を妨げない。
set -u

payload="$(cat 2>/dev/null)"
cwd=""
if command -v python3 >/dev/null 2>&1; then
  cwd="$(printf '%s' "$payload" | python3 -c '
import json, sys
try:
    value = json.load(sys.stdin)
except Exception:
    value = {}
cwd = value.get("cwd", "") if isinstance(value, dict) else ""
print(cwd if isinstance(cwd, str) else "")
' 2>/dev/null)" || cwd=""
fi
[ -n "$cwd" ] && [ -d "$cwd" ] || cwd="$PWD"

root="$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null)" || root=""

printf '## セッション再開リマインド\n'
printf -- '- ユーザーへの回答・進捗報告は日本語で行う。\n'

if [ -z "$root" ]; then
  printf -- '- 現在の checkout: Git repository を確認できません（cwd: %s）\n' "$cwd"
  printf -- '- handoff: Git repository 確認後に docs/templates/handoff.md を参照する。\n'
  exit 0
fi

branch="$(git -C "$cwd" branch --show-current 2>/dev/null)" || branch=""
if [ -z "$branch" ]; then
  branch="(detached HEAD)"
fi
status="$(git -C "$cwd" status --short 2>/dev/null)" || status="(取得失敗)"

printf '\n## 現在の checkout\n'
printf -- '- root: %s\n' "$root"
printf -- '- branch: %s\n' "$branch"
printf '\n## git status --short\n'
if [ -n "$status" ]; then
  printf '%s\n' "$status"
else
  printf '(clean)\n'
fi

printf '\n## git worktree list / worktree 一覧（未コミット件数）\n'
worktrees="$(git -C "$root" worktree list --porcelain 2>/dev/null)" || worktrees=""
wt_path=""
wt_branch=""
print_worktree() {
  local dirty dirty_status
  [ -n "$wt_path" ] || return 0
  if dirty_status="$(git -C "$wt_path" status --short 2>/dev/null)"; then
    if [ -n "$dirty_status" ]; then
      dirty="$(printf '%s\n' "$dirty_status" | awk 'END { print NR + 0 }')"
    else
      dirty=0
    fi
  else
    dirty="?"
  fi
  [ -n "$wt_branch" ] || wt_branch="(detached)"
  printf -- '- %s branch=%s dirty=%s\n' "$wt_path" "$wt_branch" "$dirty"
}
if [ -n "$worktrees" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      worktree\ *)
        print_worktree
        wt_path="${line#worktree }"
        wt_branch=""
        ;;
      branch\ refs/heads/*) wt_branch="${line#branch refs/heads/}" ;;
      detached) wt_branch="(detached)" ;;
    esac
  done <<EOF
$worktrees
EOF
  print_worktree
else
  printf '(取得失敗)\n'
fi

guard_notes=""
# Codex を使う環境（CODEX_HOME が在る）だけ検査する。未 trust（exit 1）と設定の破損（読めない）を警告し、
# それ以外の検査不能（exit 2: python3.11 未満など）は SessionStart を汚さない。
if [ -f "$root/scripts/check-codex-hooks.sh" ] && [ -d "${CODEX_HOME:-$HOME/.codex}" ]; then
  codex_trust="$(bash "$root/scripts/check-codex-hooks.sh" --repo "$root" --quiet 2>&1)"
  case "$?:$codex_trust" in
    1:*) guard_notes="$codex_trust" ;;
    2:*"を読めない"*) guard_notes="⚠ Codex hook 設定を読めない（Codex の guard が効かない可能性）: $(printf '%s' "$codex_trust" | head -n 1)" ;;
  esac
fi
if ! git -C "$root" hook list post-checkout 2>/dev/null | grep -qx 'project-template-tmp-worktree'; then
  guard_notes="${guard_notes:+$guard_notes
}⚠ 一時領域 worktree の git guard が未配線（全ツール共通の防衛線）: scripts/setup-user-hooks.sh --git"
fi
if [ -n "$guard_notes" ]; then
  printf '\n## ガード配線の確認（未 trust・未配線のガードは効かない）\n%s\n' "$guard_notes"
fi

printf '\n## authored open PR\n'
if [ -f "$root/scripts/worktree.sh" ]; then
  printf '\n## worktree 使用状態（明示終了なしは要確認）\n'
  bash "$root/scripts/worktree.sh" --repo "$root" list || printf '(管理状態を取得できません)\n'
fi

gh_timeout="${SESSION_START_GH_TIMEOUT:-3}"
pr_result="__PYTHON_MISSING__"
if command -v python3 >/dev/null 2>&1; then
  pr_result="$(python3 - "$gh_timeout" "$root" <<'PY'
import subprocess
import sys

try:
    timeout = float(sys.argv[1])
    if timeout < 0:
        raise ValueError
except (TypeError, ValueError):
    timeout = 3.0

try:
    result = subprocess.run(
        [
            "gh", "pr", "list", "--author", "@me", "--state", "open",
            "--limit", "1000", "--json", "number", "--jq", "length",
        ],
        capture_output=True,
        cwd=sys.argv[2],
        text=True,
        timeout=timeout,
        check=False,
    )
except FileNotFoundError:
    print("__GH_MISSING__")
    raise SystemExit
except subprocess.TimeoutExpired:
    print("__TIMEOUT__")
    raise SystemExit

if result.returncode != 0:
    print("__UNAVAILABLE__")
    raise SystemExit

value = result.stdout.strip()
try:
    count = int(value)
    if count < 0:
        raise ValueError
except ValueError:
    print("__MALFORMED__")
else:
    print(count)
PY
)" || pr_result="__UNAVAILABLE__"
fi
case "$pr_result" in
  __TIMEOUT__) printf -- '- open PR: 未確認 (timeout)\n' ;;
  __GH_MISSING__) printf -- '- open PR: 未確認 (gh not found)\n' ;;
  __PYTHON_MISSING__) printf -- '- open PR: 未確認 (python3 not found)\n' ;;
  __UNAVAILABLE__) printf -- '- open PR: 未確認 (GitHub unavailable)\n' ;;
  __MALFORMED__) printf -- '- open PR: 未確認 (unexpected response)\n' ;;
  *) printf -- '- open PR: %s\n' "$pr_result" ;;
esac

recent_table_rows() { # recent_table_rows <markdown-table-file>
  local file="$1"
  if [ ! -f "$file" ]; then
    printf '(file not found)\n'
    return 0
  fi
  awk '
    /^\|/ {
      if ($0 ~ /^\|[[:space:]]*-+/) next
      if (!header_seen) { header_seen = 1; next }
      print
    }
  ' "$file" | tail -n 3
}

printf '\n## 直近の decisions（末尾3件）\n'
recent_table_rows "$root/docs/process/decisions.md"
printf '\n## 直近の failure patterns（末尾3件）\n'
recent_table_rows "$root/docs/process/failure-patterns.md"

printf '\n## handoff\n'
printf -- '- セッション引き継ぎが必要なら docs/templates/handoff.md を使用する。\n'

exit 0
