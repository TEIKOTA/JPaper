#!/usr/bin/env bash
# issue body の「重複確認」節が、起票前確認の記録として埋まっているかを検証する。
# 使い方:
#   check-issue.sh <issue-body-file>
#   gh issue view <number> --json body --jq .body | check-issue.sh
#
# テンプレート上の空欄・placeholder をそのまま通さないためのローカル gate。
# 採用判断: docs/adr/20260729-adopt-ai-session-operational-guards.md
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/check-issue.sh [<issue-body-file>]

issue body の「重複確認」節を検証する。file を省略した場合は stdin から読む。
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ $# -gt 1 ]]; then
  echo "✖ issue body file は 1 つだけ指定してください" >&2
  usage >&2
  exit 2
fi

if [[ $# -eq 1 ]]; then
  [[ -f "$1" ]] || { echo "✖ issue body file がありません: $1" >&2; exit 2; }
  body="$(cat "$1")"
else
  body="$(cat)"
fi

# check-pr-body-close.sh と同じ可視 Markdown 契約に揃え、comment / code 内の
# 見かけ上の見出しや field を起票前確認の記録として数えない。
sanitize_body() {
  awk '
    BEGIN { in_comment = 0; fence_marker = ""; fence_length = 0 }
    {
      line = $0
      # Fence は原文で判定する。code 内の comment は literal であり、
      # closer の末尾 text や fence 外の comment 状態を変えてはいけない。
      leading_spaces = 0
      while (substr(line, leading_spaces + 1, 1) == " ") {
        leading_spaces += 1
      }
      trimmed = substr(line, leading_spaces + 1)
      fence_indent_ok = (leading_spaces <= 3)
      marker = substr(trimmed, 1, 1)
      marker_length = 0
      if (marker == "`" || marker == "~") {
        while (substr(trimmed, marker_length + 1, 1) == marker) {
          marker_length += 1
        }
      }
      if (fence_marker != "") {
        rest = substr(trimmed, marker_length + 1)
        if (fence_indent_ok && marker == fence_marker && \
            marker_length >= fence_length && rest ~ /^[[:space:]]*$/) {
          fence_marker = ""
          fence_length = 0
        }
        next
      }
      if (!in_comment && fence_indent_ok && marker_length >= 3) {
        fence_marker = marker
        fence_length = marker_length
        next
      }
      visible = ""
      while (length(line) > 0) {
        if (in_comment) {
          end = index(line, "-->")
          if (end == 0) {
            line = ""
          } else {
            line = substr(line, end + 3)
            in_comment = 0
          }
        } else {
          start = index(line, "<!--")
          if (start == 0) {
            visible = visible line
            line = ""
          } else {
            visible = visible substr(line, 1, start - 1)
            line = substr(line, start + 4)
            in_comment = 1
          }
        }
      }
      if (visible ~ /^(    |\t)/) {
        next
      }
      if (visible != "") {
        print visible
      }
    }
  '
}

visible_body="$(printf '%s\n' "$body" | sanitize_body)"

section_ok=0
section="$(printf '%s\n' "$visible_body" | awk '
  /^##[[:space:]]+重複確認[[:space:]]*$/ {
    count += 1
    active = (count == 1)
    next
  }
  active && /^#{1,2}[[:space:]]/ { active = 0 }
  active { print }
  END { if (count != 1) exit 1 }
')" && section_ok=1
if [[ "$section_ok" -ne 1 ]]; then
  echo "✖ '## 重複確認' 節が 1 つ必要です" >&2
  exit 1
fi

field_value() { # field_value <label>
  local label="$1"
  printf '%s\n' "$section" | awk -v label="$label" '
    {
      line = $0
      sub(/^[[:space:]]*-[[:space:]]*/, "", line)
      prefix = label ":"
      if (index(line, prefix) == 1) {
        count += 1
        value = substr(line, length(prefix) + 1)
        sub(/^[[:space:]]+/, "", value)
        sub(/[[:space:]]+$/, "", value)
      }
    }
    END {
      if (count != 1) exit 1
      print value
    }
  '
}

normalize_inline_markdown() { # normalize_inline_markdown <value>
  # placeholder 判定用に、link label と一般的な強調 marker の可視文字だけを残す。
  # 元の field 値は変更せず、通常の記録内容や URL 自体の妥当性には干渉しない。
  printf '%s\n' "$1" \
    | sed -E 's/!?\[([^][]*)\]\([^()]*\)/\1/g; s/[*_~`]//g'
}

is_placeholder() { # is_placeholder <value>
  local value="$1" normalized lowered
  normalized="$(normalize_inline_markdown "$value")"
  lowered="$(printf '%s' "$normalized" | tr '[:upper:]' '[:lower:]')"
  case "$lowered" in
    ""|"-"|"..."|"<...>"|"＜...＞"|"todo"|"tbd"|"n/a"|"未記入"|"未入力"|"未確認") return 0 ;;
  esac
  case "$normalized" in
    *YYYY-MM-DD*|*yyyy-mm-dd*|*'#xxx'*|*'#zzz'*) return 0 ;;
  esac
  if printf '%s\n' "$lowered" \
    | grep -qE '^(todo|tbd|n/?a|none|未記入|未入力|未確認|未定|後で|あとで)([[:space:]:：-]|$)'; then
    return 0
  fi
  return 1
}

rc=0
check_field() { # check_field <label> [date]
  local label="$1" kind="${2:-text}" value value_ok=0
  value="$(field_value "$label")" && value_ok=1
  if [[ "$value_ok" -ne 1 ]]; then
    echo "✖ 重複確認の '${label}' は 1 行だけ必要です" >&2
    rc=1
    return
  fi
  if is_placeholder "$value"; then
    echo "✖ 重複確認の '${label}' が空または placeholder です" >&2
    rc=1
    return
  fi
  if [[ "$kind" == "date" && ! "$value" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
    echo "✖ 重複確認の '${label}' は YYYY-MM-DD 形式で記録してください" >&2
    rc=1
  fi
}

check_field "確認日時" date
check_field "検索キーワード"
check_field "確認した issue/PR"
check_field "判定"

if [[ "$rc" -eq 0 ]]; then
  echo "✔ issue の重複確認記録"
fi
exit "$rc"
