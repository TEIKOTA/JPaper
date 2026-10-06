#!/usr/bin/env bash
# repo 単位の worktree 作成・状態・安全な回収。仕様: docs/process/worktree-lifecycle.md
set -euo pipefail
export PYTHONDONTWRITEBYTECODE=1
exec python3 "$(cd "$(dirname "$0")" && pwd)/lib/worktree.py" "$@"
