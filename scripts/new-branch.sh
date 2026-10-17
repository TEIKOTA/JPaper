#!/usr/bin/env bash
# 規約準拠の topic branch を作成する（命名検証を pre-push から branch 作成時点へ前倒し）。
# 検証は scripts/check-branch-name.sh を再利用し、違反名なら branch を作らない。
# 使い方: scripts/new-branch.sh <type> <issue番号> <slug> [--from <base>] [--allow-backlog <理由>]
#         scripts/new-branch.sh <branch名> [--from <base>] [--allow-backlog <理由>] # chore/<slug> 等はこちら
#   例: scripts/new-branch.sh feat 12 login-screen → feat/12-login-screen を origin/main から作成
#   --from 省略時は origin/main を fetch してから分岐し、失敗時は local main へ fallback する。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"

FROM="main"
FROM_SPECIFIED=0
ALLOW_BACKLOG=""
ARG1=""
ARG2=""
ARG3=""
COUNT=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --from) FROM="${2:?--from には base branch が必要です}"; FROM_SPECIFIED=1; shift 2;;
    --allow-backlog) ALLOW_BACKLOG="${2:?--allow-backlog には理由が必要です}"; shift 2;;
    -h|--help) sed -n '2,10p' "$0" | sed -nE 's/^# ?//p'; exit 0;;
    -*) echo "不明な引数: $1" >&2; exit 2;;
    *)
      COUNT=$((COUNT + 1))
      case "$COUNT" in
        1) ARG1="$1";;
        2) ARG2="$1";;
        3) ARG3="$1";;
      esac
      shift;;
  esac
done

case "$COUNT" in
  1) NAME="$ARG1";;
  3) NAME="$ARG1/$ARG2-$ARG3";;
  *) echo "✖ 引数は <branch名> か <type> <issue番号> <slug> で指定してください（-h で使い方）" >&2; exit 2;;
esac

bash "$ROOT/check-branch-name.sh" "$NAME"

if [[ -n "$ALLOW_BACKLOG" ]]; then
  bash "$ROOT/check-pr-backlog.sh" --allow-backlog "$ALLOW_BACKLOG"
else
  bash "$ROOT/check-pr-backlog.sh"
fi

if [[ "$FROM_SPECIFIED" -eq 0 ]]; then
  if git fetch origin main; then
    FROM="origin/main"
  else
    echo "⚠ origin/main を取得できなかったため local main を使用します" >&2
  fi
fi

if git show-ref --verify --quiet "refs/heads/$NAME"; then
  echo "✖ branch '$NAME' は既に存在します" >&2
  exit 1
fi

git switch -c "$NAME" "$FROM"
echo "✔ branch '$NAME' を '$FROM' から作成した"
