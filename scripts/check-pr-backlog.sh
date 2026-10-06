#!/usr/bin/env bash
# 自分の open PR 数を確認する新規着手用 gate。
# 使い方: check-pr-backlog.sh [--repo <owner>/<repo>] [--allow-backlog <理由>] [--report]
# PR_WIP_WARNING_LIMIT（既定 6）超は WARN、PR_WIP_HARD_LIMIT（既定 12）超は exit 2。
# --report は非遮断。旧 PR_WIP_LIMIT 単独指定は従来の単一閾値として扱う。
# gh が無い・offline・応答が不明確な場合は WARN で fail-open する（PASS は出さない）。
set -u

REPO=""
ALLOW_REASON=""
REPORT=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo)
      REPO="${2:-}"
      [ -n "$REPO" ] || { echo "✖ --repo には <owner>/<repo> が必要です" >&2; exit 2; }
      shift 2
      ;;
    --allow-backlog)
      ALLOW_REASON="${2:-}"
      case "$ALLOW_REASON" in
        ''|*[![:space:]]*) ;;
        *) echo "✖ --allow-backlog には空白以外の理由が必要です" >&2; exit 2 ;;
      esac
      case "$ALLOW_REASON" in
        ''|-*|*[[:cntrl:]]*)
          echo "✖ --allow-backlog の理由は leading '-' や制御文字を含められません" >&2
          exit 2
          ;;
      esac
      shift 2
      ;;
    --report) REPORT=1; shift ;;
    -h|--help) sed -n '2,5p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "✖ 不明な引数: $1" >&2; exit 2 ;;
  esac
done

validate_limit() {
  case "$2" in ''|*[!0-9]*) return 1 ;; esac
  [ "${#2}" -le 6 ]
}
warning="${PR_WIP_WARNING_LIMIT-6}"
hard="${PR_WIP_HARD_LIMIT-12}"
legacy=0
if [ "${PR_WIP_LIMIT+x}" = x ] && [ "${PR_WIP_WARNING_LIMIT+x}${PR_WIP_HARD_LIMIT+x}" = "" ]; then
  legacy=1
  warning="${PR_WIP_LIMIT:-3}"
  hard="$warning"
  echo "WARN: PR_WIP_LIMIT は旧単一閾値です。PR_WIP_WARNING_LIMIT / PR_WIP_HARD_LIMIT への移行を検討してください" >&2
fi
if ! validate_limit warning "$warning" || ! validate_limit hard "$hard"; then
  echo "✖ backlog 閾値は 0 から 999999 の整数で指定してください" >&2
  [ "$REPORT" -eq 1 ] && exit 0
  exit 2
fi
# 長さ検証後に十進変換し、Bash の算術 overflow / 先頭ゼロを避ける。
warning_value=$((10#$warning))
limit_value=$((10#$hard))
if [ "$legacy" -eq 0 ] && [ "$warning_value" -ge "$limit_value" ]; then
  echo "✖ PR_WIP_WARNING_LIMIT < PR_WIP_HARD_LIMIT が必要です" >&2
  [ "$REPORT" -eq 1 ] && exit 0
  exit 2
fi

warn_open() { echo "WARN: $*（PR backlog は未確認）" >&2; }

is_valid_created_at() { # RFC3339 の暦日・時刻・offset を Bash だけで検証する
  local ts="$1" year month day hour minute second zone year_value max_day
  [[ "$ts" =~ ^([0-9]{4})-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]+)?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$ ]] || return 1
  year="${BASH_REMATCH[1]}"
  month="${BASH_REMATCH[2]}"
  day="${BASH_REMATCH[3]}"
  year_value=$((10#$year))
  case "$month" in
    01|03|05|07|08|10|12) max_day=31 ;;
    04|06|09|11) max_day=30 ;;
    02)
      if (( (year_value % 4 == 0 && year_value % 100 != 0) || year_value % 400 == 0 )); then max_day=29; else max_day=28; fi
      ;;
  esac
  [ "$((10#$day))" -le "$max_day" ]
}

if ! command -v gh >/dev/null 2>&1; then
  warn_open "gh CLI が無いため新規着手 gate を省略"
  exit 0
fi

REPORT_FETCH_LIMIT=1001 # report は最大1000件を完全表示し、次の1件で打ち切りを検知する。
if [ "$REPORT" -eq 1 ]; then
  fetch_limit="$REPORT_FETCH_LIMIT"
else
  fetch_limit=$((limit_value + 1))
fi

if [ -n "$REPO" ]; then
  rows="$(gh pr list --repo "$REPO" --author @me --state open --limit "$fetch_limit" \
    --json number,createdAt,headRefName,baseRefName,isDraft \
    --jq 'sort_by(.createdAt) | if length == 0 then "__EMPTY__" else .[] | [.number, .createdAt, .headRefName, .baseRefName, .isDraft] | @tsv end' 2>/dev/null)" || {
    warn_open "GitHub へ到達できないため新規着手 gate を省略"
    exit 0
  }
else
  rows="$(gh pr list --author @me --state open --limit "$fetch_limit" \
    --json number,createdAt,headRefName,baseRefName,isDraft \
    --jq 'sort_by(.createdAt) | if length == 0 then "__EMPTY__" else .[] | [.number, .createdAt, .headRefName, .baseRefName, .isDraft] | @tsv end' 2>/dev/null)" || {
    warn_open "GitHub へ到達できないため新規着手 gate を省略"
    exit 0
  }
fi

count=0
truncated=0
if [ "$rows" = "__EMPTY__" ]; then
  : # gh の空配列は明示的な sentinel としてのみ 0 件扱いにする。
elif [ -z "$rows" ]; then
  warn_open "GitHub の PR 一覧が空で応答形式を確認できないため新規着手 gate を省略"
  exit 0
else
  while IFS="$(printf '\t')" read -r number created head base draft extra; do
    case "$number" in ''|*[!0-9]*) warn_open "GitHub の PR 番号が不正または曖昧です"; exit 0 ;; esac
    is_valid_created_at "$created" || {
      warn_open "GitHub の PR 作成日時が不正または曖昧です"
      exit 0
    }
    [ -n "$head" ] && [ -n "$base" ] && [ -z "${extra:-}" ] || {
      warn_open "GitHub の PR 一覧が不正または曖昧です"
      exit 0
    }
    case "$draft" in true|false) ;; *) warn_open "GitHub の PR draft 状態が不正または曖昧です"; exit 0 ;; esac
    count=$((count + 1))
  done <<EOF
$rows
EOF
fi

if [ "$REPORT" -eq 1 ] && [ "$count" -ge "$REPORT_FETCH_LIMIT" ]; then
  truncated=1
fi

display_rows="$rows"
if [ "$truncated" -eq 1 ]; then
  # 1001件目は打ち切り検知専用であり、一覧には含めない。
  display_rows="$(printf '%s\n' "$rows" | sed -n '1,1000p')"
  echo "PR backlog: 1000+（author: @me, state: open、作成日順・先頭1000件のみ表示）"
else
  echo "PR backlog: ${count}/${limit_value}（warning: ${warning_value}, author: @me, state: open、作成日順）"
fi
if [ "$count" -gt 0 ]; then
  printf '%s\n' "$display_rows" | awk -F '\t' \
    '{ printf "  #%s %s %s -> %s draft=%s\n", $1, $2, $3, $4, $5 }'
fi

if [ "$REPORT" -eq 1 ]; then
  if [ "$truncated" -eq 1 ]; then
    warn_open "PR 一覧が 1000 件を超えるため完全な棚卸しを確認できません"
    exit 0
  fi
  echo "INFO: --report のため backlog 件数にかかわらず許可"
  exit 0
fi
if [ "$count" -le "$warning_value" ]; then
  echo "PASS: open PR は上限以内のため新規着手可能"
  exit 0
fi
if [ "$count" -le "$limit_value" ]; then
  echo "WARN: open PR が warning ${warning_value} を超えています。新規着手は許可しますが、merge・review・一本化を優先してください" >&2
  exit 0
fi
if [ -n "$ALLOW_REASON" ]; then
  printf 'OVERRIDE: backlog 超過を許可します。理由: %s\n' "$ALLOW_REASON"
  exit 0
fi
echo "✖ open PR が上限 ${limit_value} を超えています。新規 issue へ着手せず、merge・review・一本化を優先してください" >&2
exit 2
