#!/usr/bin/env bash
# 件名が日本語 Conventional Commits 形式かを検証する。
# 使い方:
#   check-commit-msg.sh <commit-msg-file>     commit-msg フックから（lefthook.yml 参照）
#   check-commit-msg.sh --subject "<text>"    件名文字列を直接検査（CI の PR タイトル検査など）
#   check-commit-msg.sh --types               許可 type の正規表現を出力
# 許可 type 一覧はこのファイルが正本。macOS(BSD) / Linux 両対応・pure bash。
set -euo pipefail

types='feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert'

if [[ "${1:-}" == "--types" ]]; then
  printf '%s\n' "$types"
  exit 0
fi

subject=""
if [[ "${1:-}" == "--subject" ]]; then
  subject="${2:?--subject には検査する文字列が必要です}"
else
  MSG_FILE="${1:?commit-msg ファイルのパスか --subject \"<text>\" が必要です}"
  # 最初の非コメント・非空行を件名として扱う
  subject="$(grep -vE '^[[:space:]]*#' "$MSG_FILE" | grep -vE '^[[:space:]]*$' | head -n1 || true)"
fi

valid_format=1
valid_japanese=1
printf '%s\n' "$subject" | grep -qE "^(${types})(\([a-zA-Z0-9._/-]+\))?!?: .+" || valid_format=0
printf '%s\n' "$subject" | grep -qE '[ぁ-んァ-ヶ一-龠々ー]' || valid_japanese=0

if [[ $valid_format -ne 1 || $valid_japanese -ne 1 ]]; then
  {
    echo "✖ 件名が規約に反しています（日本語 Conventional Commits）。"
    echo "  形式: <type>(任意のscope): 日本語の説明"
    echo "  例:   feat: ログイン画面を追加 / fix(api): タイムアウトを修正"
    echo "  許可 type: ${types}"
    echo "  実際の件名: '${subject}'"
  } >&2
  exit 1
fi
