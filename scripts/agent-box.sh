#!/usr/bin/env bash
# セッションごとのコンテナ隔離（#126）の入口。本体は scripts/lib/agent_box.py、運用は docs/process/agent-containers.md。
set -euo pipefail
exec python3 "$(cd "$(dirname "$0")" && pwd)/lib/agent_box.py" "$@"
