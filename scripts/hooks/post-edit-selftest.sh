#!/usr/bin/env bash
# Claude Code の PostToolUse(Edit / Write / Bash) hook。SELFTEST_WATCH 配下への編集・
# Bash 書き込みを検知したら self-test を自動実行し、失敗なら exit 2 で結果を返す。
# 「scripts/ を変更したら必ず self-test を実行する」(AGENTS.md コマンド)の機械強制。
# 配線は .claude/settings.json。SELFTEST_CMD / SELFTEST_WATCH で派生 repo 向けに上書きできる。
# SKIP_SELFTEST_HOOK=1、JSON が読めない、対象外、test command が無い場合は許可する。
set -u

[ "${SKIP_SELFTEST_HOOK:-0}" = "1" ] && exit 0
command -v python3 >/dev/null 2>&1 || exit 0

root="${CLAUDE_PROJECT_DIR:-$(pwd)}"
script_dir="$(cd "$(dirname "$0")" && pwd)"
target="$(CLAUDE_PROJECT_DIR="$root" python3 "$script_dir/post-edit-selftest.py" 2>/dev/null)" || exit 0
[ -n "$target" ] || exit 0

mode=""
if [ "${SELFTEST_CMD+x}" = "x" ]; then
  mode="command"
elif [ -f "$root/tests/run-tests.sh" ]; then
  mode="run-tests"
else
  set -- "$root"/scripts/tests/*.test.sh
  if [ -f "$1" ]; then
    mode="script-tests"
  elif command -v pytest >/dev/null 2>&1; then
    mode="pytest"
  fi
fi
[ -n "$mode" ] || exit 0

run_selftest() {
  case "$mode" in
    command) bash -c "$SELFTEST_CMD" ;;
    run-tests) bash tests/run-tests.sh ;;
    script-tests)
      rc=0
      for test_script in scripts/tests/*.test.sh; do
        bash "$test_script" || rc=$?
      done
      exit "$rc"
      ;;
    pytest) pytest ;;
  esac
}

out="$(cd "$root" && run_selftest 2>&1)"
rc=$?
if [ "$rc" -ne 0 ]; then
  {
    printf '✖ self-test が失敗した（%s への書き込み後）。修正してから進む:\n' "$target"
    printf '%s\n' "$out" | grep -E '^(FAIL|FAILED|ERROR|passed|failed)' || true
  } >&2
  exit 2
fi
printf 'self-test: %s\n' "$(printf '%s\n' "$out" | tail -n 1)"
exit 0
