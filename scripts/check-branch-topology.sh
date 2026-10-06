#!/usr/bin/env bash
# Open PR の head -> base 鎖を検査し、通常 PR（depth 0）または親 + 子（depth 1）だけを許可する。
# 使い方: check-branch-topology.sh [--head <branch>] [--stdin] [--require-open] [--repo <owner>/<repo>]
# gh が無い、または GitHub へ到達できない場合は WARN を出して fail-open する。その場合 PASS は出力しない。
# --stdin は git pre-push の refspec（local-ref local-sha remote-ref remote-sha）を読む。
set -u

HEAD_BRANCH=""
REPO=""
READ_STDIN=0
REQUIRE_OPEN=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --head) HEAD_BRANCH="${2:-}"; [ -n "$HEAD_BRANCH" ] || { echo "✖ --head には branch 名が必要です" >&2; exit 2; }; shift 2 ;;
    --repo) REPO="${2:-}"; [ -n "$REPO" ] || { echo "✖ --repo には owner/repo が必要です" >&2; exit 2; }; shift 2 ;;
    --stdin) READ_STDIN=1; shift ;;
    --require-open) REQUIRE_OPEN=1; shift ;;
    -h|--help) sed -n '2,5p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "✖ 不明な引数: $1" >&2; exit 2 ;;
  esac
done

warn_open() { echo "WARN: $*（topology は未確認）" >&2; }

if ! command -v gh >/dev/null 2>&1; then
  warn_open "gh CLI が無いため branch topology gate を省略"
  exit 0
fi

gh_pr_list() { # gh_pr_list <head> <open|all>
  if [ -n "$REPO" ]; then
    gh pr list --repo "$REPO" --head "$1" --state "$2" --limit 2 \
      --json number,headRefName,baseRefName,state --jq '.[] | [.number, .headRefName, .baseRefName, .state] | @tsv'
  else
    gh pr list --head "$1" --state "$2" --limit 2 \
      --json number,headRefName,baseRefName,state --jq '.[] | [.number, .headRefName, .baseRefName, .state] | @tsv'
  fi
}

branch_status() { # branch_status <branch>: exists|missing|unknown
  # REST の ref path へ branch 名を連結すると /, #, % を安全に扱えない。
  # GraphQL variable は値を query 文字列へ展開しないので Bash 3.2 でも安全に渡せる。
  local owner name qualified result repo
  repo="$REPO"
  if [ -z "$repo" ]; then
    repo="$(gh repo view --json nameWithOwner --jq '.nameWithOwner' 2>/dev/null)" || {
      printf 'unknown\n'
      return 0
    }
  fi
  case "$repo" in */*) owner="${repo%%/*}"; name="${repo#*/}" ;; *) printf 'unknown\n'; return 0 ;; esac
  qualified="refs/heads/$1"
  result="$(gh api graphql \
    -f query='query($owner:String!, $name:String!, $qualified:String!) { repository(owner:$owner, name:$name) { ref(qualifiedName:$qualified) { name } } }' \
    -f owner="$owner" -f name="$name" -f qualified="$qualified" \
    --jq 'if .data.repository.ref == null then "missing" else "exists" end' 2>/dev/null)" || {
      printf 'unknown\n'
      return 0
    }
  case "$result" in
    exists|missing) printf '%s\n' "$result" ;;
    *) printf 'unknown\n' ;;
  esac
}

check_head() { # check_head <branch>
  local branch="$1" line number current base state depth=0 seen="|$1|" result parent_all parent_ref
  line="$(gh_pr_list "$branch" open 2>/dev/null)" || { warn_open "GitHub offline のため '$branch' を検査できません"; return 0; }
  if [ -z "$line" ]; then
    if [ "$REQUIRE_OPEN" -eq 1 ]; then
      echo "✖ '$branch' の open PR が見つかりません" >&2
      return 2
    fi
    warn_open "'$branch' の open PR がまだ無いため branch topology gate を省略"
    return 0
  fi
  if printf '%s\n' "$line" | sed -n '2p' | grep -q .; then
    echo "✖ '$branch' の open PR が複数あり topology を一意に決定できません" >&2
    return 2
  fi

  while [ -n "$line" ]; do
    number="$(printf '%s\n' "$line" | awk -F '\t' 'NR == 1 { print $1 }')"
    current="$(printf '%s\n' "$line" | awk -F '\t' 'NR == 1 { print $2 }')"
    base="$(printf '%s\n' "$line" | awk -F '\t' 'NR == 1 { print $3 }')"
    state="$(printf '%s\n' "$line" | awk -F '\t' 'NR == 1 { print $4 }')"
    if [ "$state" != "OPEN" ] || [ -z "$current" ] || [ -z "$base" ]; then
      echo "✖ PR #$number の live head/base/state を取得できません" >&2
      return 2
    fi
    if [ "$current" != "$branch" ]; then
      echo "✖ PR #$number の head '$current' は要求 branch '$branch' と一致しません" >&2
      return 2
    fi
    if [ "$base" = "$current" ]; then
      echo "✖ PR #$number は self-reference です: $current -> $base" >&2
      return 2
    fi
    case "$seen" in *"|$base|"*) echo "✖ PR #$number は cycle です: $current -> $base" >&2; return 2;; esac
    if [ "$base" = "main" ]; then
      echo "PASS: '$1' の open PR topology は depth $depth です（#${number}: $current -> main）"
      return 0
    fi
    depth=$((depth + 1))
    if [ "$depth" -gt 1 ]; then
      echo "✖ stacked PR は depth 1 までです（'$1' は depth ${depth}）" >&2
      return 2
    fi
    seen="$seen$base|"
    branch="$base"
    line="$(gh_pr_list "$branch" open 2>/dev/null)" || { warn_open "GitHub offline のため親 '$branch' を検査できません"; return 0; }
    if [ -z "$line" ]; then
      parent_all="$(gh_pr_list "$branch" all 2>/dev/null)" || { warn_open "GitHub offline のため親 '$branch' を検査できません"; return 0; }
      if [ -n "$parent_all" ]; then
        echo "✖ parent '$branch' の PR は open ではありません（${parent_all}）。main へ通常 merge後に child を main へ retarget してください" >&2
      else
        parent_ref="$(branch_status "$branch")"
        case "$parent_ref" in
          missing)
            echo "✖ child の base branch '$branch' が存在しません。latest main を通常 mergeし、parent merge前後の child-only diff が不変と確認してから child を main へ retarget してください" >&2
            ;;
          exists)
            echo "✖ child の base '$branch' に open parent PR がありません。latest main を通常 mergeし、parent merge前後の child-only diff が不変と確認してから child を main へ retarget してください" >&2
            ;;
          *)
            warn_open "parent '$branch' の ref 状態を確認できないため stale child 判定を省略"
            return 0
            ;;
        esac
      fi
      return 2
    fi
    if printf '%s\n' "$line" | sed -n '2p' | grep -q .; then
      echo "✖ parent '$branch' の open PR が複数あり topology を一意に決定できません" >&2
      return 2
    fi
  done
}

if [ "$READ_STDIN" -eq 1 ]; then
  found=0
  rc=0
  seen="|"
  while read -r local_ref local_sha remote_ref remote_sha; do
    [ -n "${remote_ref:-}" ] || continue
    case "$remote_ref" in
      refs/heads/*)
        # delete は更新後（local）SHA が all-zero。tag/object から branch への更新や
        # force push も remote_ref で同じように捕捉する。
        case "${local_sha:-}" in
          *[!0]*)
            branch="${remote_ref#refs/heads/}"
            case "$seen" in *"|$branch|"*) continue ;; esac
            seen="$seen$branch|"
            found=1
            check_head "$branch" || rc=$?
            ;;
        esac
        ;;
    esac
  done
  [ "$found" -eq 1 ] || exit 0
  exit "$rc"
fi

if [ -z "$HEAD_BRANCH" ]; then HEAD_BRANCH="$(git branch --show-current 2>/dev/null || true)"; fi
[ -n "$HEAD_BRANCH" ] || { echo "✖ branch を特定できません。--head を指定してください" >&2; exit 2; }
check_head "$HEAD_BRANCH"
