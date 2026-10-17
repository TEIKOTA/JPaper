#!/usr/bin/env bash
# PR を squash merge する唯一の経路（#159。正本: docs/adr/20261016-gate-merge-behind-script-and-recorded-approval.md）。
# 承認の写しと merge 条件を確かめ、判定表を PR にコメントで残してから squash merge する（1 つでも欠ければ merge しない）。
# 使い方: scripts/merge-pr.sh <PR番号> --head <SHA> --judge scope=<判断> --judge injection=<判断>
#           [--judge no-perceptual-external=なし…] [--repo <owner>/<name>] [--dry-run]
#   --head   merge する head の SHA（40 桁）。live の head と違えば止まり、gh pr merge の --match-head-commit にも渡す
#   --judge  root の判断（script は中身を確かめず、判定表に「root の申告」として写す）。scope と injection は必須。
#            事前承認で merge するなら no-perceptual-external=なし（知覚の成果物・外部影響を含まない）も必須
#   --dry-run  判定表を出すだけで、コメントも merge もしない
#   PR のコメントに残す記録（行頭一致。書式は ADR 参照）:
#     review: head <SHA> blocking=なし / self-test: head <SHA> bash=PASS /bin/bash=PASS
#     merge 承認: head <SHA>（区切りでの承認。続けてユーザーの発言を > で引用）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
PR_NUM=""
HEAD_SHA=""
REPO=""
DRY_RUN=0
JUDGES=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --head) HEAD_SHA="${2:?--head には SHA が必要です}"; shift 2;;
    --judge) JUDGES+=("${2:?--judge には <key>=<判断> が必要です}"); shift 2;;
    --repo) REPO="${2:?--repo には <owner>/<name> が必要です}"; shift 2;;
    --dry-run) DRY_RUN=1; shift;;
    -h|--help) sed -n '2,14p' "$0" | sed -nE 's/^# ?//p'; exit 0;;
    -*) echo "不明な引数: $1" >&2; exit 2;;
    *)
      if [[ -n "$PR_NUM" ]]; then echo "PR番号は 1 つだけ指定してください" >&2; exit 2; fi
      PR_NUM="$1"; shift;;
  esac
done
if ! printf '%s\n' "$PR_NUM" | grep -qE '^[0-9]+$'; then
  echo "✖ PR番号を数字で指定してください" >&2; exit 2
fi
if ! printf '%s\n' "$HEAD_SHA" | grep -qE '^[0-9a-f]{40}$'; then
  echo "✖ --head に 40 桁の SHA が必要です" >&2; exit 2
fi
command -v gh >/dev/null 2>&1 || { echo "✖ gh CLI が必要です" >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "✖ python3 が必要です" >&2; exit 1; }

REPO_ARGS=()
if [[ -n "$REPO" ]]; then REPO_ARGS=(--repo "$REPO"); fi

# ---- 取得 ---------------------------------------------------------------

fetch_pr() {
  gh pr view "$PR_NUM" ${REPO_ARGS[@]+"${REPO_ARGS[@]}"} --json number,state,isDraft,title,body,headRefOid,baseRefName,baseRefOid,mergeable,mergeStateStatus,comments
}
pr_json="$(fetch_pr)" || { echo "✖ PR #$PR_NUM を取得できません" >&2; exit 1; }

# jfield <名前>: PR の JSON の単一フィールドを文字列で返す（真偽は true / false）
jfield() {
  printf '%s' "$pr_json" | python3 -c '
import json, sys
value = json.load(sys.stdin)[sys.argv[1]]
print(str(value).lower() if isinstance(value, bool) else value)' "$1"
}

# リポジトリの owner（記録の行は owner のコメントだけを数える。取れなければ誰のコメントも数えない）
nwo="$(gh repo view ${REPO:+"$REPO"} --json nameWithOwner 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["nameWithOwner"])' 2>/dev/null)" || nwo=""
OWNER="${nwo%%/*}"

# comment_has <正規表現> [quote]: owner のコメントに、行全体が正規表現に一致する行があるか。quote なら同じコメントに > の引用行も要る
comment_has() {
  printf '%s' "$pr_json" | python3 -c '
import json, re, sys
owner = sys.argv.pop(1).lower()
pattern, need_quote = re.compile(sys.argv[1]), len(sys.argv) > 2
for comment in json.load(sys.stdin)["comments"]:
    if not owner or ((comment.get("author") or {}).get("login") or "").lower() != owner:
        continue
    lines = comment["body"].splitlines()
    if any(pattern.fullmatch(line.strip()) for line in lines) and (
            not need_quote or any(re.match(r">\s*\S", line.strip()) for line in lines)):
        sys.exit(0)
sys.exit(1)' "$OWNER" "$@"
}

STATE="$(jfield state)"; DRAFT="$(jfield isDraft)"; TITLE="$(jfield title)"
LIVE_HEAD="$(jfield headRefOid)"; BASE="$(jfield baseRefName)"; BASE_OID="$(jfield baseRefOid)"
MERGEABLE="$(jfield mergeable)"; STATE_STATUS="$(jfield mergeStateStatus)"
# 直前に main が進むと GitHub が mergeable を計算中で UNKNOWN を返す。数秒おいて読み直し、確定した値で判定する（#183）。
# 読み直しても UNKNOWN なら、そのまま下の判定で FAIL にする（fail-closed）。待ちは MERGE_PR_UNKNOWN_WAIT（秒）、回数は MERGE_PR_UNKNOWN_RETRIES で変える
UNKNOWN_RETRIES="${MERGE_PR_UNKNOWN_RETRIES:-5}"
UNKNOWN_WAIT="${MERGE_PR_UNKNOWN_WAIT:-3}"
attempt=0
while [[ "$MERGEABLE" == "UNKNOWN" || "$STATE_STATUS" == "UNKNOWN" ]] && [[ "$attempt" -lt "$UNKNOWN_RETRIES" ]]; do
  attempt=$((attempt + 1))
  sleep "$UNKNOWN_WAIT"
  pr_json="$(fetch_pr)" || { echo "✖ PR #$PR_NUM を取得できません" >&2; exit 1; }
  STATE="$(jfield state)"; DRAFT="$(jfield isDraft)"; TITLE="$(jfield title)"
  LIVE_HEAD="$(jfield headRefOid)"; BASE="$(jfield baseRefName)"; BASE_OID="$(jfield baseRefOid)"
  MERGEABLE="$(jfield mergeable)"; STATE_STATUS="$(jfield mergeStateStatus)"
done

# ---- 判定表 ---------------------------------------------------------------

FAILS=0
ROWS=""
# row <確認者> <結果 PASS|FAIL|申告> <条件> <詳細>
row() {
  [[ "$2" == "FAIL" ]] && FAILS=$((FAILS + 1))
  ROWS="$ROWS| $3 | $1 | $2 | $4 |"$'\n'
}
judge_value() { # judge_value <key>: --judge の値（無ければ空）
  local entry
  for entry in ${JUDGES[@]+"${JUDGES[@]}"}; do
    if [[ "${entry%%=*}" == "$1" && "$entry" == *=* ]]; then printf '%s' "${entry#*=}"; return; fi
  done
}

# 1. 状態・head・base
if [[ "$STATE" == "OPEN" && "$DRAFT" == "false" ]]; then row script PASS "open かつ draft でない" "state=$STATE"; else row script FAIL "open かつ draft でない" "state=$STATE draft=$DRAFT"; fi
if [[ "$LIVE_HEAD" == "$HEAD_SHA" ]]; then row script PASS "head が提示した SHA と一致" "\`$HEAD_SHA\`"; else row script FAIL "head が提示した SHA と一致" "live=\`$LIVE_HEAD\` 提示=\`$HEAD_SHA\`"; fi
if [[ "$BASE" == "main" ]]; then row script PASS "base が main" "base=$BASE (\`$BASE_OID\`)"; else row script FAIL "base が main" "base=${BASE}（stacked child は親を merge してから main に付け替える）"; fi
if [[ "$MERGEABLE" == "MERGEABLE" && "$STATE_STATUS" == "CLEAN" ]]; then row script PASS "mergeable かつ clean" "mergeable=$MERGEABLE status=$STATE_STATUS"; else
  unknown_note=""
  if [[ "$MERGEABLE" == "UNKNOWN" || "$STATE_STATUS" == "UNKNOWN" ]]; then unknown_note="（GitHub が計算中。少しおいてやり直す）"; fi
  row script FAIL "mergeable かつ clean" "mergeable=$MERGEABLE status=$STATE_STATUS$unknown_note"
fi

# 2. merge-tree（base と head を取り直し、衝突が無いか）
mt_ok=0
if git fetch --quiet origin "+refs/pull/$PR_NUM/head:refs/merge-pr/$PR_NUM/head" "+refs/heads/$BASE:refs/merge-pr/$PR_NUM/base" 2>/dev/null \
   && [[ "$(git rev-parse "refs/merge-pr/$PR_NUM/head")" == "$HEAD_SHA" ]] \
   && git merge-tree --write-tree "refs/merge-pr/$PR_NUM/base" "refs/merge-pr/$PR_NUM/head" >/dev/null 2>&1; then
  mt_ok=1
fi
if [[ "$mt_ok" -eq 1 ]]; then row script PASS "merge-tree に衝突が無い" "origin/$BASE と \`$HEAD_SHA\`"; else row script FAIL "merge-tree に衝突が無い" "取得の失敗・head の不一致・衝突のいずれか"; fi

# 2b. git diff --check（merge-base からの差分に空白の誤りが無い）。取得に失敗していれば merge-tree の行が FAIL を出す
if [[ "$mt_ok" -eq 1 ]] && git diff --check "refs/merge-pr/$PR_NUM/base...refs/merge-pr/$PR_NUM/head" >/dev/null 2>&1; then
  row script PASS "git diff --check" "空白の誤りなし"
else
  row script FAIL "git diff --check" "空白の誤りがある、または head を取得できていない"
fi

# 3. scripts/check-pr.sh
if cp_out="$(bash "$ROOT/check-pr.sh" "$PR_NUM" ${REPO_ARGS[@]+"${REPO_ARGS[@]}"} 2>&1)"; then
  row script PASS "scripts/check-pr.sh" "タイトル・body・issue 連結"
else
  row script FAIL "scripts/check-pr.sh" "$(printf '%s' "$cp_out" | tr '\n' ' ')"
fi

# 4. 未解決のレビュースレッド
unresolved=""
if [[ -n "$nwo" ]]; then
  query='query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){pageInfo{hasNextPage} nodes{isResolved}}}}}'
  if unresolved="$(gh api graphql -f query="$query" -F owner="${nwo%%/*}" -F name="${nwo#*/}" -F number="$PR_NUM" 2>/dev/null | python3 -c '
import json, sys
threads = json.load(sys.stdin)["data"]["repository"]["pullRequest"]["reviewThreads"]
print("取りきれない" if threads["pageInfo"]["hasNextPage"] else sum(1 for node in threads["nodes"] if not node["isResolved"]))')"; then :; else unresolved="取得失敗"; fi
else
  unresolved="取得失敗"
fi
if [[ "$unresolved" == "0" ]]; then row script PASS "未解決のレビュースレッドが 0" "0 件"; else row script FAIL "未解決のレビュースレッドが 0" "$unresolved"; fi

# 5. 記録（コメントの行）。head に結んであり、head が変われば無効になる
if comment_has "review: head $HEAD_SHA blocking=なし"; then row script PASS "別 context の独立レビューが head に対して blocking なし" "コメントの記録"; else row script FAIL "別 context の独立レビューが head に対して blocking なし" "\`review: head <SHA> blocking=なし\` の記録が無い"; fi
if comment_has "self-test: head $HEAD_SHA bash=PASS /bin/bash=PASS"; then row script PASS "両方の Bash の self-test が通る" "コメントの記録"; else row script FAIL "両方の Bash の self-test が通る" "\`self-test: head <SHA> bash=PASS /bin/bash=PASS\` の記録が無い"; fi

# 6. root の判断（script は中身を確かめない）
for key in scope injection; do
  value="$(judge_value "$key")"
  case "$key" in
    scope) label="diff が issue の範囲内で、合意に無い新しい判断が無い";;
    injection) label="guard・bug 修正の退行注入で red → 復元後 green（対象外なら理由）";;
  esac
  if [[ -n "$value" ]]; then row root 申告 "$label" "$value"; else row root FAIL "$label" "--judge $key=<判断> が無い"; fi
done

# 7. 承認の写し。どちらも無ければ merge しない
approval=""
pre_blocked=""
perceptual="$(judge_value no-perceptual-external)"
issues="$(printf '%s' "$(jfield body)" | bash "$ROOT/check-pr-body-close.sh" --title "$TITLE" --print-issues 2>/dev/null || true)"
for n in $issues; do
  section="$(gh issue view "$n" ${REPO_ARGS[@]+"${REPO_ARGS[@]}"} --json body 2>/dev/null | python3 -c '
import json, sys
inside, lines = False, []
for line in json.load(sys.stdin)["body"].splitlines():
    if line.startswith("## "):
        inside = line.strip() == "## merge の事前承認"
    elif inside:
        lines.append(line)
print("\n".join(lines))' || true)"
  if printf '%s\n' "$section" | grep -qE '^- 条件:'; then
    if [[ "$perceptual" == なし* ]]; then
      approval="事前承認（issue #$n の「merge の事前承認」）"
    else
      pre_blocked="issue #$n に事前承認はあるが --judge no-perceptual-external=なし が無い（区切りでの承認なら不要）"
    fi
  fi
done
if comment_has "merge 承認: head $HEAD_SHA" quote; then
  approval="${approval:+$approval と }区切りでの承認（PR のコメント）"
elif [[ -n "$pre_blocked" ]]; then
  row script FAIL "事前承認は知覚の成果物・外部影響を含まない PR に使えない" "$pre_blocked"
fi
if [[ -n "$approval" ]]; then row script PASS "merge の承認の写しが記録されている" "$approval"; else row script FAIL "merge の承認の写しが記録されている" "issue の「merge の事前承認」も、head に結んだ区切りの承認も無い"; fi

# ---- 結果 -----------------------------------------------------------------

VERDICT="merge する"
[[ "$FAILS" -gt 0 ]] && VERDICT="merge しない（FAIL $FAILS 件）"
TABLE="## merge 判定（scripts/merge-pr.sh）"$'\n\n'"head: \`$HEAD_SHA\` / base: $BASE / 判定: $VERDICT"$'\n\n'
TABLE="$TABLE| 条件 | 確認者 | 結果 | 詳細 |"$'\n'"|---|---|---|---|"$'\n'"$ROWS"
printf '%s\n' "$TABLE"
if [[ "$FAILS" -gt 0 ]]; then exit 1; fi
if [[ "$DRY_RUN" -eq 1 ]]; then echo "（--dry-run: コメントも merge もしない）"; exit 0; fi

body_file="$(mktemp)"
trap 'rm -f "$body_file"' EXIT
printf '%s\n' "$TABLE" > "$body_file"
gh pr comment "$PR_NUM" ${REPO_ARGS[@]+"${REPO_ARGS[@]}"} --body-file "$body_file"
gh pr merge "$PR_NUM" ${REPO_ARGS[@]+"${REPO_ARGS[@]}"} --squash --match-head-commit "$HEAD_SHA"
