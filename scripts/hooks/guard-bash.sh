#!/usr/bin/env bash
# Claude Code の PreToolUse(Bash) hook。判定本体は同じ場所の guard-bash.py。
# stdin は Claude Code の hook JSON のまま Python へ渡す。Bash 3.2 互換。
set -u

command -v python3 >/dev/null 2>&1 || exit 0
here="$(cd "$(dirname "$0")" && pwd)"
[ -f "$here/guard-bash.py" ] || exit 0
exec python3 "$here/guard-bash.py"
