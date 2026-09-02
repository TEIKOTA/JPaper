#!/usr/bin/env bash
# PR のタイトル・body・issue 連結をローカルで検査する（CI 既定オフ環境の正本ゲート。
# ADR: docs/adr/20260901-disable-github-actions-by-default.md）。検査ロジックは
# scripts/check-commit-msg.sh / scripts/check-pr-body-close.sh を再利用する。
# 使い方: scripts/check-pr.sh [<PR番号>] [--repo <owner>/<name>]
#   PR番号省略時はカレント branch に紐づく PR を対象にする。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
PR_NUM=""
REPO=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) REPO="${2:?--repo には <owner>/<name> が必要です}"; shift 2;;
    -h|--help) sed -nE 's/^# ?//p' "$0" | sed -n '1,6p'; exit 0;;
    -*) echo "不明な引数: $1" >&2; exit 2;;
    *) PR_NUM="$1"; shift;;
  esac
done

if [[ -n "$PR_NUM" ]] && ! printf '%s\n' "$PR_NUM" | grep -qE '^[0-9]+$'; then
  echo "✖ PR番号は数字で指定してください: $PR_NUM" >&2
  exit 2
fi

command -v gh >/dev/null 2>&1 || { echo "✖ gh CLI が必要です（brew install gh）" >&2; exit 1; }

view() { # view <field> — PR の JSON フィールドを 1 つ取得する
  if [[ -n "$REPO" ]]; then
    gh pr view ${PR_NUM:+"$PR_NUM"} --repo "$REPO" --json "$1" --jq ".$1"
  else
    gh pr view ${PR_NUM:+"$PR_NUM"} --json "$1" --jq ".$1"
  fi
}

title="$(view title)"
body="$(view body)"

rc=0
if bash "$ROOT/check-commit-msg.sh" --subject "$title"; then
  echo "✔ PR タイトル: $title"
else
  rc=1
fi

if printf '%s' "$body" | bash "$ROOT/check-pr-body-close.sh" --title "$title"; then
  echo "✔ PR body の issue 連結"
else
  rc=1
fi

# --print-issues は同一 repo の close 参照だけを返す（chore / 例外理由 / cross-repo は空）
issues="$(printf '%s' "$body" | bash "$ROOT/check-pr-body-close.sh" --title "$title" --print-issues 2>/dev/null || true)"
if [[ -z "$issues" ]]; then
  echo "・同一 repo の close 参照なしのため issue 実在検証をスキップ"
else
  for n in $issues; do
    if [[ -n "$REPO" ]]; then
      path="repos/$REPO/issues/$n"
    else
      path="repos/{owner}/{repo}/issues/$n"
    fi
    # gh 内蔵の --jq で判定し、外部 jq への依存を持たない
    if ! kind="$(gh api "$path" --jq 'if has("pull_request") then "pr" else "issue" end' 2>/dev/null)"; then
      echo "✖ close keyword が参照する issue #$n が存在しません" >&2
      rc=1
      continue
    fi
    if [[ "$kind" = "pr" ]]; then
      echo "✖ #$n は issue ではなく Pull Request です。issue を参照してください" >&2
      rc=1
      continue
    fi
    echo "✔ issue #$n の実在を確認"
  done
fi

exit "$rc"
