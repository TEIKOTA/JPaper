#!/usr/bin/env bash
# Claude Code の PostToolUse(Edit / Write) hook。scripts/ か tests/ 配下のファイルを編集したら
# `bash tests/run-tests.sh` を自動実行し、失敗なら exit 2 で結果を Claude へ返す。
# 「scripts/ を変更したら必ず self-test を実行する」(AGENTS.md コマンド)の機械強制。
# 配線は .agents/settings.json。stdin: {"tool_input": {"file_path": "..."}, ...}
# JSON が読めない・対象外パス・run-tests.sh が無い場合は何もせず許可する。
set -u

command -v python3 >/dev/null 2>&1 || exit 0

path="$(python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
p = d.get("tool_input", {}).get("file_path", "")
print(p if isinstance(p, str) else "")
' 2>/dev/null)" || exit 0
[ -n "$path" ] || exit 0

root="${CLAUDE_PROJECT_DIR:-$(pwd)}"
case "$path" in
  "$root"/scripts/*|"$root"/tests/*|scripts/*|tests/*) ;;
  *) exit 0 ;;
esac
[ -f "$root/tests/run-tests.sh" ] || exit 0

out="$(cd "$root" && bash tests/run-tests.sh 2>&1)"
rc=$?
if [ "$rc" -ne 0 ]; then
  {
    printf '✖ self-test が失敗した（%s の編集後）。修正してから進む:\n' "$path"
    printf '%s\n' "$out" | grep -E '^(FAIL|passed)'
  } >&2
  exit 2
fi
printf 'self-test: %s\n' "$(printf '%s\n' "$out" | tail -n 1)"
exit 0
