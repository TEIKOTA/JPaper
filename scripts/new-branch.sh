#!/usr/bin/env bash
# 規約準拠の topic branch を作成する（命名検証を pre-push から branch 作成時点へ前倒し）。
# 検証は scripts/check-branch-name.sh を再利用し、違反名なら branch を作らない。
# 使い方: scripts/new-branch.sh <type> <issue番号> <slug> [--from <base>]
#         scripts/new-branch.sh <branch名> [--from <base>]        # chore/<slug> 等はこちら
#   例: scripts/new-branch.sh feat 12 login-screen  → feat/12-login-screen を main から作成
#   --from 省略時は main から分岐する。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
FROM="main"
ARG1=""
ARG2=""
ARG3=""
COUNT=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --from) FROM="${2:?--from には base branch が必要です}"; shift 2;;
    -h|--help) sed -nE 's/^# ?//p' "$0" | sed -n '1,7p'; exit 0;;
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

if git show-ref --verify --quiet "refs/heads/$NAME"; then
  echo "✖ branch '$NAME' は既に存在します" >&2
  exit 1
fi

git switch -c "$NAME" "$FROM"
echo "✔ branch '$NAME' を '$FROM' から作成した"
