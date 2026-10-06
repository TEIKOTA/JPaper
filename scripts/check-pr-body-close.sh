#!/usr/bin/env bash
# PR body に issue close keyword（Closes/Fixes/Resolves #<番号>）か、
# 明示的な「例外理由: <理由>」があるかを検査する。scripts/check-pr.sh と
# pr-checks CI（既定オフ: .github/workflows-disabled/）から呼ばれる。
# 使い方: check-pr-body-close.sh [--title "<PR title>"] [--print-issues] [<body-file>]
#   body はファイル引数か stdin で渡す。
#   --title の type が chore の場合、issue 連結を免除する（chore は issue なしレーン）。
#   --print-issues は合否判定をせず、close keyword が参照する同一 repo の issue 番号だけを
#   出力する（chore / cross-repo 参照は出力なし）。CI の issue 実在検証が使う。
set -euo pipefail

title=""
body_file=""
print_issues=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --title) title="${2:-}"; shift 2;;
    --print-issues) print_issues=1; shift;;
    *) body_file="$1"; shift;;
  esac
done

if [[ -n "$body_file" ]]; then
  body="$(cat "$body_file")"
else
  body="$(cat)"
fi

sanitize_body() {
  awk '
    BEGIN { in_comment = 0; in_fence = 0 }
    {
      line = $0
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
      trimmed = visible
      sub(/^[[:space:]]*/, "", trimmed)
      if (!in_fence && visible ~ /^(    |\t)/) {
        next
      }
      if (trimmed ~ /^(```|~~~)/) {
        in_fence = !in_fence
        next
      }
      if (!in_fence && visible != "") {
        print visible
      }
    }
  '
}

visible_body="$(printf '%s\n' "$body" | sanitize_body)"

# --print-issues: 合否判定はせず、close keyword 行の先頭一致から同一 repo の
# issue 番号を抽出して出力する（cross-repo 参照 owner/repo#N は対象外）。
if [[ $print_issues -eq 1 ]]; then
  if printf '%s\n' "$title" | grep -qE '^chore(\([a-zA-Z0-9._/-]+\))?!?: '; then
    exit 0
  fi
  printf '%s\n' "$visible_body" \
    | grep -iE '^[ ]{0,3}([-*][[:space:]]*)?(close[sd]?|fix(e[sd])?|resolve[sd]?)[[:space:]]*:?[[:space:]]+([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)?#[0-9]+([[:space:]]|$)' \
    | sed -E 's/^[ ]{0,3}([-*][[:space:]]*)?//' \
    | grep -oiE '^(close[sd]?|fix(e[sd])?|resolve[sd]?)[[:space:]]*:?[[:space:]]+([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)?#[0-9]+' \
    | grep -vE '[A-Za-z0-9_.-]/[A-Za-z0-9_.-]*#' \
    | grep -oE '#[0-9]+' \
    | tr -d '#' \
    | sort -un \
    || true
  exit 0
fi

if printf '%s\n' "$title" | grep -qE '^chore(\([a-zA-Z0-9._/-]+\))?!?: '; then
  echo "✔ chore PR のため issue 連結チェックを免除"
  exit 0
fi

# close keyword は独立した Markdown 行として要求する。HTML コメントや
# 「この PR は close しない」のような説明文中の一致を誤認しないため。
if printf '%s\n' "$visible_body" | grep -qiE '^[ ]{0,3}([-*][[:space:]]*)?(close[sd]?|fix(e[sd])?|resolve[sd]?)[[:space:]]*:?[[:space:]]+([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)?#[0-9]+([[:space:]]|$)'; then
  echo "✔ issue close keyword を確認"
  exit 0
fi

# 「例外理由: <理由>」行を許可する。プレースホルダは不可。
reason_line="$(printf '%s\n' "$visible_body" | grep -iE '^[[:space:]]*(\*\*)?[[:space:]]*(例外理由|exception reason)[[:space:]]*(\*\*)?[[:space:]]*[:：]' | head -n1 || true)"
if [[ -n "$reason_line" ]]; then
  reason_line="${reason_line//：/:}"
  reason="${reason_line#*:}"
  reason="$(printf '%s' "$reason" | sed -E 's/^[[:space:]*]+//; s/[[:space:]*]+$//')"
  normalized_reason="$(printf '%s' "$reason" | tr '[:upper:]' '[:lower:]')"
  case "$normalized_reason" in
    ""|"-"|"なし"|"未定"|"tbd"|"todo"|"未記入"|"後で記載"|"具体的な理由"|"n/a"|"none") ;;
    *)
      if [[ "$reason" != *"<"*">"* ]]; then
        echo "✔ 例外理由を確認: ${reason}"
        exit 0
      fi
      ;;
  esac
fi

{
  echo "✖ PR body に issue 連結がありません。"
  echo "  次のいずれかを PR body に記載してください。"
  echo "    - Closes #<issue番号> / Fixes #<issue番号> / Resolves #<issue番号>"
  echo "    - 例外理由: <issue を閉じない具体的な理由>（プレースホルダ不可）"
  echo "  ※ chore PR（タイトルが 'chore:' で始まる）は本チェックの対象外です。"
} >&2
exit 1
