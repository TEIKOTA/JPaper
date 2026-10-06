#!/usr/bin/env bash
# Codex canonical Bash PreToolUse。ask は未対応なので拒否へ変換する。
set -euo pipefail
export PYTHONDONTWRITEBYTECODE=1
exec python3 "$(cd "$(dirname "$0")" && pwd)/guard-codex.py"
