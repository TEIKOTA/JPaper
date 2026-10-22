#!/usr/bin/env bash
# main への push の CI（node-checks・self-test）が failure になった実行を、失敗した job・テスト名つきで issue に報告する（#483）。
# 同じ workflow の open issue があればコメントを足し、無ければ issue を作る。呼び出し元は .github/workflows/main-ci-failure.yml。
# 使い方: scripts/report-main-ci-failure.sh <run-id> [--repo <owner>/<name>] [--dry-run]
#   --dry-run  issue もコメントも作らず、書く内容だけを出す
#   main の push の failure でない実行（PR・成功・別 branch）は何もせず exit 0
set -euo pipefail

RUN_ID=""
REPO=""
DRY_RUN=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) REPO="${2:?--repo には <owner>/<name> が必要です}"; shift 2;;
    --dry-run) DRY_RUN=1; shift;;
    -h|--help) sed -n '2,6p' "$0" | sed -nE 's/^# ?//p'; exit 0;;
    -*) echo "不明な引数: $1" >&2; exit 2;;
    *)
      if [[ -n "$RUN_ID" ]]; then echo "run-id は 1 つだけ指定してください" >&2; exit 2; fi
      RUN_ID="$1"; shift;;
  esac
done
if ! printf '%s\n' "$RUN_ID" | grep -qE '^[0-9]+$'; then
  echo "✖ run-id を数字で指定してください" >&2; exit 2
fi
command -v gh >/dev/null 2>&1 || { echo "✖ gh CLI が必要です" >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "✖ python3 が必要です" >&2; exit 1; }

REPO_ARGS=()
if [[ -n "$REPO" ]]; then REPO_ARGS=(--repo "$REPO"); fi

run_json="$(gh run view "$RUN_ID" ${REPO_ARGS[@]+"${REPO_ARGS[@]}"} --json name,workflowName,conclusion,headBranch,headSha,event,url,jobs)" \
  || { echo "✖ run $RUN_ID を取得できません" >&2; exit 1; }

# jq 相当: 対象の実行か（main の push の failure）と、題名・失敗した job の一覧を取り出す
target="$(printf '%s' "$run_json" | python3 -c '
import json, sys
run = json.load(sys.stdin)
ok = run["conclusion"] == "failure" and run["headBranch"] == "main" and run["event"] == "push"
print("yes" if ok else "no")')"
if [[ "$target" != "yes" ]]; then
  echo "対象外の実行（main の push の failure ではない）: run $RUN_ID"; exit 0
fi
workflow="$(printf '%s' "$run_json" | python3 -c 'import json, sys; run = json.load(sys.stdin); print(run.get("workflowName") or run["name"])')"
TITLE="ci(main): main の ${workflow} が失敗した（自動起票）"

# 失敗した job ごとの失敗 step とログ中の失敗行（取れなければ行は空）。ログ行は best-effort で、書式が変わっても本文の job 名は残る
failed_jobs="$(printf '%s' "$run_json" | python3 -c '
import json, sys
for job in json.load(sys.stdin)["jobs"]:
    if job["conclusion"] == "failure":
        steps = ",".join(s["name"] for s in job.get("steps", []) if s["conclusion"] == "failure")
        print("%s|%s|%s|%s" % (job["databaseId"], job["name"], steps, job.get("url", "")))')"

BODY_FILE="$(mktemp)"
trap 'rm -f "$BODY_FILE"' EXIT
SHA="$(printf '%s' "$run_json" | python3 -c 'import json, sys; print(json.load(sys.stdin)["headSha"])')"
URL="$(printf '%s' "$run_json" | python3 -c 'import json, sys; print(json.load(sys.stdin)["url"])')"
{
  echo "main への push の CI（${workflow}）が failure になった。"
  echo
  echo "- run: ${URL}"
  echo "- commit: \`${SHA}\`"
  echo
  echo "## 失敗した job"
  echo
  if [[ -z "$failed_jobs" ]]; then echo "- （failure の job を取得できなかった。run を見る）"; fi
  while IFS="|" read -r job_id job_name steps job_url; do
    [[ -n "$job_id" ]] || continue
    echo "- **${job_name}**（失敗した step: ${steps:-不明}）${job_url:+ ${job_url}}"
    log_lines="$(gh run view "$RUN_ID" ${REPO_ARGS[@]+"${REPO_ARGS[@]}"} --job "$job_id" --log-failed 2>/dev/null \
      | sed -E 's/^[^[:space:]]*[[:space:]]+[^[:space:]]*[[:space:]]+[0-9T:.Z-]+[[:space:]]+//' \
      | grep -E 'FAIL|✗|×|AssertionError|Error:' | head -n 15 || true)"
    if [[ -n "$log_lines" ]]; then
      echo
      echo '  ```text'
      printf '%s\n' "$log_lines" | sed 's/^/  /'
      echo '  ```'
    fi
  done <<EOT
$failed_jobs
EOT
  echo
  echo "揺れ（PR は緑・main は赤）なら、同じ失敗が 2 回出た時点で原因を調べる（docs/process/failure-patterns.md）。"
  echo "この issue は scripts/report-main-ci-failure.sh（.github/workflows/main-ci-failure.yml）が作った。同じ workflow の失敗はこの issue にコメントで足される。"
} > "$BODY_FILE"

# 同じ題名の open issue があればコメント、無ければ作る
existing="$(gh issue list ${REPO_ARGS[@]+"${REPO_ARGS[@]}"} --state open --search "${workflow} in:title" --limit 50 --json number,title 2>/dev/null \
  | python3 -c '
import json, sys
for issue in json.load(sys.stdin):
    if issue["title"] == sys.argv[1]:
        print(issue["number"]); break' "$TITLE")" || existing=""

if [[ "$DRY_RUN" -eq 1 ]]; then
  if [[ -n "$existing" ]]; then echo "（--dry-run）issue #$existing にコメントする:"; else echo "（--dry-run）issue を作る: $TITLE"; fi
  cat "$BODY_FILE"; exit 0
fi
if [[ -n "$existing" ]]; then
  gh issue comment "$existing" ${REPO_ARGS[@]+"${REPO_ARGS[@]}"} --body-file "$BODY_FILE"
else
  gh issue create ${REPO_ARGS[@]+"${REPO_ARGS[@]}"} --title "$TITLE" --body-file "$BODY_FILE"
fi
