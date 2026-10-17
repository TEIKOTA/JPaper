#!/usr/bin/env bash
# Codex canonical Bash PreToolUse。ask は未対応なので拒否へ変換する。
set -euo pipefail
# agent-box の子コンテナ内（#126 D16）では安全用の guard を外す。守りはコンテナの境界と L2 トークンが担う。
# 環境変数だけでは外さない（ホストの macOS ではルートが読み取り専用で /.dockerenv を作れない）。
if [ "${AGENT_BOX:-}" = 1 ] && [ -f /.dockerenv ]; then exit 0; fi
export PYTHONDONTWRITEBYTECODE=1
exec python3 "$(cd "$(dirname "$0")" && pwd)/guard-codex.py"
