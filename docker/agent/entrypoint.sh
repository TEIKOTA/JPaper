#!/usr/bin/env bash
# 子コンテナの起動処理（#126）。git の識別子と GitHub の読み取り用認証を整えてから、渡されたコマンドを実行する。
set -euo pipefail

git config --global --replace-all safe.directory /work
[ -n "${AGENT_GIT_NAME:-}" ] && git config --global user.name "$AGENT_GIT_NAME"
[ -n "${AGENT_GIT_EMAIL:-}" ] && git config --global user.email "$AGENT_GIT_EMAIL"
# GH_TOKEN（L2: 読み取りと PR・issue へのコメント）を git の https 認証にも使う。push は GitHub 側で拒否される。
if [ -n "${GH_TOKEN:-}" ]; then
  gh auth setup-git >/dev/null 2>&1 || echo "agent-box: gh auth setup-git に失敗（GitHub への fetch は認証なしになる）" >&2
fi
if [ -f /work/lefthook.yml ] && [ -d /work/.git ]; then
  (cd /work && lefthook install >/dev/null 2>&1) || echo "agent-box: lefthook install に失敗" >&2
fi
exec "$@"
