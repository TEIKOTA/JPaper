#!/usr/bin/env bash
# pre-push フック: ブランチ名が規約に従うかを検証する。
# 規約: main / <type>/<issue番号>-<slug> / chore/<slug>（chore のみ issue 番号なし可）
# 許可 type 一覧の正本は scripts/check-commit-msg.sh。
# 使い方:
#   check-branch-name.sh <branch-name>  指定名を検査
#   check-branch-name.sh                pre-push stdin の ref、なければ現在のブランチを検査
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
types="$(bash "$script_dir/check-commit-msg.sh" --types)"

validate_branch() {
  local branch="$1"

  if [[ "$branch" == "main" ]]; then
    return 0
  fi
  if printf '%s\n' "$branch" | grep -qE "^(${types})/[0-9]+-[a-z0-9._-]+$"; then
    return 0
  fi
  if printf '%s\n' "$branch" | grep -qE "^chore/[a-z0-9._-]+$"; then
    return 0
  fi

  {
    echo "✖ ブランチ名 '${branch}' が規約に反しています。"
    echo "  規約: <type>/<issue番号>-<slug>（例: feat/12-login-screen）"
    echo "        chore/<slug> のみ issue 番号なしで可（例: chore/update-deps）"
    echo "  許可 type: ${types}"
  } >&2
  return 1
}

if [[ $# -gt 0 ]]; then
  validate_branch "$1"
  exit
fi

# pre-push hook は「local-ref local-sha remote-ref remote-sha」を stdin で渡す。
# current branch だけを見ると、refspec で別 branch を push した場合に規約を迂回できる。
push_refs=""
if [[ ! -t 0 ]]; then
  push_refs="$(cat)"
fi
if [[ -n "$push_refs" ]]; then
  while read -r local_ref _local_sha remote_ref _remote_sha; do
    [[ "$local_ref" == "(delete)" ]] && continue
    if [[ "$local_ref" == refs/heads/* ]]; then
      validate_branch "${local_ref#refs/heads/}"
    fi
    if [[ "$remote_ref" == refs/heads/* && "$remote_ref" != "$local_ref" ]]; then
      validate_branch "${remote_ref#refs/heads/}"
    fi
  done <<< "$push_refs"
  exit
fi

branch="$(git symbolic-ref --short HEAD 2>/dev/null || true)"
if [[ -z "$branch" ]]; then
  echo "✖ ブランチ名を特定できません（detached HEAD の可能性）" >&2
  exit 1
fi
validate_branch "$branch"
