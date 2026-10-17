#!/usr/bin/env bash
# PR のタイトル・body・issue 連結をローカルで検査する（正本ゲート。CI の pr-checks も同じ script を呼ぶ。
# ADR: docs/adr/20261014-enable-github-actions-on-public-repo.md）。検査ロジックは
# scripts/check-commit-msg.sh / scripts/check-pr-body-close.sh を再利用する。
# 使い方: scripts/check-pr.sh [<PR番号>] [--head <branch>] [--repo <owner>/<name>] [--backlog]
#   PR番号と --head の両方を省略した場合はカレント branch に紐づく PR を対象にする。
#   CHECK_PR_TITLE_CMD: PR title を $1 で受け取る checker の shell command
#   CHECK_PR_BODY_CMD: title を $1、PR body を stdin で受け取る checker の shell command
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
PR_NUM=""
REPO=""
HEAD_BRANCH=""
BACKLOG=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) REPO="${2:?--repo には <owner>/<name> が必要です}"; shift 2;;
    --head) HEAD_BRANCH="${2:?--head には branch 名が必要です}"; shift 2;;
    --backlog) BACKLOG=1; shift;;
    -h|--help) sed -n '2,9p' "$0" | sed -nE 's/^# ?//p'; exit 0;;
    -*) echo "不明な引数: $1" >&2; exit 2;;
    *)
      if [[ -n "$PR_NUM" ]]; then
        echo "PR番号は 1 つだけ指定してください" >&2
        exit 2
      fi
      PR_NUM="$1"
      shift
      ;;
  esac
done

if [[ "$BACKLOG" -eq 1 ]]; then
  if [[ -n "$PR_NUM" || -n "$HEAD_BRANCH" ]]; then
    echo "--backlog は PR番号または --head と同時に指定できません" >&2
    exit 2
  fi
  backlog_args=(--report)
  if [[ -n "$REPO" ]]; then backlog_args+=(--repo "$REPO"); fi
  bash "$ROOT/check-pr-backlog.sh" "${backlog_args[@]}"
  exit 0
fi

if [[ -n "$PR_NUM" ]] && ! printf '%s\n' "$PR_NUM" | grep -qE '^[0-9]+$'; then
  echo "✖ PR番号は数字で指定してください: $PR_NUM" >&2
  exit 2
fi
if [[ -n "$PR_NUM" && -n "$HEAD_BRANCH" ]]; then
  echo "PR番号と --head は同時に指定できません" >&2
  exit 2
fi

command -v gh >/dev/null 2>&1 || { echo "✖ gh CLI が必要です（brew install gh）" >&2; exit 1; }

if [[ -n "$HEAD_BRANCH" ]]; then
  if [[ -n "$REPO" ]]; then
    PR_NUM="$(gh pr list --head "$HEAD_BRANCH" --repo "$REPO" --state open --limit 1 --json number --jq '.[0].number')"
  else
    PR_NUM="$(gh pr list --head "$HEAD_BRANCH" --state open --limit 1 --json number --jq '.[0].number')"
  fi
  if [[ -z "$PR_NUM" ]]; then
    echo "✖ head branch '$HEAD_BRANCH' の open PR が見つかりません" >&2
    exit 1
  fi
fi

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
if [[ -n "${CHECK_PR_TITLE_CMD:-}" ]]; then
  title_ok=0
  bash -c "$CHECK_PR_TITLE_CMD" check-pr-title "$title" || title_ok=$?
else
  title_ok=0
  bash "$ROOT/check-commit-msg.sh" --subject "$title" || title_ok=$?
fi
if [[ "$title_ok" -eq 0 ]]; then
  echo "✔ PR タイトル: $title"
else
  rc=1
fi

if [[ -n "${CHECK_PR_BODY_CMD:-}" ]]; then
  body_ok=0
  printf '%s' "$body" | bash -c "$CHECK_PR_BODY_CMD" check-pr-body "$title" || body_ok=$?
else
  body_ok=0
  printf '%s' "$body" | bash "$ROOT/check-pr-body-close.sh" --title "$title" || body_ok=$?
fi
if [[ "$body_ok" -eq 0 ]]; then
  echo "✔ PR body の issue 連結"
else
  rc=1
fi

# --print-issues は同一 repo の close 参照だけを返す（例外理由 / cross-repo は空）。
# chore は連結を免除するが、明記された参照は実在検証する。
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

# テスト節に未完了を示す語が残っていても PR 検査自体は落とさず、見落としを警告する。
# awk の区間表現（{1,6}）は mawk（子のコンテナの awk）で使えないので、# の数は RLENGTH で数える（#135）。
test_section="$(printf '%s\n' "$body" | awk '
  /^#+[[:space:]]/ && match($0, /^#+/) && RLENGTH <= 6 {
    heading = $0
    level = RLENGTH
    sub(/^#+[[:space:]]+/, "", heading)
    lowered = tolower(heading)
    if (active && level <= active_level) exit
    if (!active && lowered ~ /(テスト|検証|test)/) {
      active = 1
      active_level = level
    }
    next
  }
  active { print }
')"
if printf '%s\n' "$test_section" | grep -qiE '未完走|未実施|TODO'; then
  echo "WARN: PR body のテスト節に未検証語（未完走 / 未実施 / TODO）が残っています" >&2
fi

exit "$rc"
