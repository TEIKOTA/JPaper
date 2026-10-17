#!/usr/bin/env bash
# Claude Code の PreToolUse(Bash) hook。判定本体は同じ場所の guard-bash.py。
# stdin は Claude Code の hook JSON のまま Python へ渡す。Bash 3.2 互換。
set -u

# agent-box の子コンテナ内（#126 D16）では安全用の guard を外す。守りはコンテナの境界と L2 トークンが担う。
# 環境変数だけでは外さない（ホストの macOS ではルートが読み取り専用で /.dockerenv を作れない）。
if [ "${AGENT_BOX:-}" = 1 ] && [ -f /.dockerenv ]; then exit 0; fi
command -v python3 >/dev/null 2>&1 || exit 0
here="$(cd "$(dirname "$0")" && pwd)"
[ -f "$here/guard-bash.py" ] || exit 0
exec python3 "$here/guard-bash.py"
