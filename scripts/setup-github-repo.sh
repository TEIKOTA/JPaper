#!/usr/bin/env bash
# GitHub repo の初期設定を gh CLI で一括適用する。
#   1. .github/labels.yml のラベルを作成・更新する（upsert）。
#      --prune 指定時のみ、labels.yml に無い既存ラベル（GitHub デフォルト含む）を削除する。
#      初回セットアップは --prune 付きで実行してデフォルトラベルを入れ替える。
#   2. merge 方式を squash のみに固定し、merge 後の head branch 自動削除を有効化する
#   3. private repo では GitHub Actions を repo 設定で無効化する（既定。template から生成された
#      repo には設定が引き継がれないため毎回必要。--enable-actions でスキップ）。public repo では
#      無効化せず、main の branch protection で CI の全ジョブの成功を merge の条件にする
# 使い方: scripts/setup-github-repo.sh [--repo <owner>/<name>] [--prune] [--dry-run] [--enable-actions]
#   --repo 省略時はカレントリポジトリの origin を使う。
#   --dry-run は変更コマンドを表示するだけで実行しない（読み取りは行う）。
set -euo pipefail

REPO=""
DRY_RUN=0
PRUNE=0
ENABLE_ACTIONS=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) REPO="${2:?--repo には <owner>/<name> が必要です}"; shift 2;;
    --prune) PRUNE=1; shift;;
    --dry-run) DRY_RUN=1; shift;;
    --enable-actions) ENABLE_ACTIONS=1; shift;;
    -h|--help) sed -n '2,12p' "$0" | sed -nE 's/^# ?//p'; exit 0;;
    *) echo "不明な引数: $1" >&2; exit 2;;
  esac
done

if [[ -n "$REPO" ]] && ! printf '%s\n' "$REPO" | grep -qE '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'; then
  echo "✖ --repo は <owner>/<name> 形式で指定してください: $REPO" >&2
  exit 2
fi

command -v gh >/dev/null 2>&1 || { echo "✖ gh CLI が必要です（brew install gh）" >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "✖ python3 が必要です" >&2; exit 1; }

LABELS_FILE="$(cd "$(dirname "$0")/.." && pwd)/.github/labels.yml"
[[ -f "$LABELS_FILE" ]] || { echo "✖ ${LABELS_FILE} がありません" >&2; exit 1; }

run() {
  if [[ $DRY_RUN -eq 1 ]]; then
    printf 'dry-run: %s\n' "$*"
  else
    "$@"
  fi
}

# labels.yml（- name / color / description のフラットな配列限定）を TSV へ変換する。
# 外部依存を避けるため python3 標準ライブラリのみでパースする。
parse_labels() {
  python3 - "$LABELS_FILE" <<'PY'
import re
import sys

path = sys.argv[1]
entries = []
current = None
with open(path, encoding="utf-8") as f:
    for raw in f:
        line = raw.rstrip("\n")
        if re.match(r"^\s*(#|$)", line):
            continue
        m = re.match(r"^- name:\s*\"?([^\"]+?)\"?\s*$", line)
        if m:
            current = {"name": m.group(1)}
            entries.append(current)
            continue
        m = re.match(r"^\s+(color|description):\s*\"?([^\"]*?)\"?\s*$", line)
        if m and current is not None:
            current[m.group(1)] = m.group(2)
            continue
        sys.exit(f"✖ labels.yml を解釈できない行: {line!r}")
for e in entries:
    if not all(k in e for k in ("name", "color", "description")):
        sys.exit(f"✖ name/color/description が揃っていません: {e}")
if not entries:
    sys.exit("✖ labels.yml にラベル定義がありません")
seen = set()
for e in entries:
    if e["name"] in seen:
        sys.exit(f"✖ label name が重複しています: {e['name']}")
    seen.add(e["name"])
    if not re.fullmatch(r"[0-9A-Fa-f]{6}", e["color"]):
        sys.exit(f"✖ label color は6桁の16進数で指定してください: {e['name']}={e['color']}")
    print("\t".join((e["name"], e["color"], e["description"])))
PY
}

echo "▶ ラベルを labels.yml の定義へ入れ替える"
labels_tsv="$(parse_labels)"
if [[ -n "$REPO" ]]; then
  existing="$(gh label list --repo "$REPO" --limit 1000 --json name --jq '.[].name')"
else
  existing="$(gh label list --limit 1000 --json name --jq '.[].name')"
fi

# 先に全定義を upsert し、途中失敗時に既存ラベルだけが消える状態を避ける。
while IFS=$'\t' read -r name color desc; do
  [[ -z "$name" ]] && continue
  if [[ -n "$REPO" ]]; then
    run gh label create "$name" --repo "$REPO" --color "$color" --description "$desc" --force
  else
    run gh label create "$name" --color "$color" --description "$desc" --force
  fi
done <<< "$labels_tsv"

# 定義外ラベルの削除は明示的な --prune の時だけ行う。既定では一覧表示に留め、
# チームが後から作った運用ラベルを誤って消さない（clarify ADR 参照）。
while IFS= read -r name; do
  [[ -z "$name" ]] && continue
  if ! printf '%s\n' "$labels_tsv" | cut -f1 | grep -qxF "$name"; then
    if [[ $PRUNE -ne 1 ]]; then
      printf "  info: 定義外ラベル '%s'（--prune で削除）\n" "$name"
      continue
    fi
    if [[ -n "$REPO" ]]; then
      run gh label delete "$name" --repo "$REPO" --yes
    else
      run gh label delete "$name" --yes
    fi
  fi
done <<< "$existing"

echo "▶ merge 方式を squash のみに設定する"
if [[ -n "$REPO" ]]; then
  run gh repo edit "$REPO" \
    --enable-squash-merge \
    --enable-merge-commit=false \
    --enable-rebase-merge=false \
    --delete-branch-on-merge
else
  run gh repo edit \
    --enable-squash-merge \
    --enable-merge-commit=false \
    --enable-rebase-merge=false \
    --delete-branch-on-merge
fi

echo "▶ squash commit の件名を PR title に固定する"
if [[ -n "$REPO" ]]; then
  run gh api --silent --method PATCH "repos/$REPO" \
    -f squash_merge_commit_title=PR_TITLE \
    -f squash_merge_commit_message=PR_BODY
else
  run gh api --silent --method PATCH 'repos/{owner}/{repo}' \
    -f squash_merge_commit_title=PR_TITLE \
    -f squash_merge_commit_message=PR_BODY
fi

# private repo の Actions は既定で無効化する（ADR: docs/adr/20260901-disable-github-actions-by-default.md）。
# public repo では無効化しない（ADR: docs/adr/20261014-enable-github-actions-on-public-repo.md）。
# -F は enabled=false を boolean に型変換する（-f だと文字列 "false" になり無効）。
if [[ -n "$REPO" ]]; then
  REPO_API="repos/$REPO"
else
  REPO_API='repos/{owner}/{repo}'
fi
if [[ $ENABLE_ACTIONS -eq 1 ]]; then
  echo "▶ GitHub Actions は有効のまま維持する（--enable-actions）"
else
  VISIBILITY="$(gh api "$REPO_API" --jq .visibility 2>/dev/null || true)"
  if [[ "$VISIBILITY" == "public" ]]; then
    echo "▶ public repo なので GitHub Actions は有効のまま維持する"
    # main への merge・push には CI の全ジョブの成功を要する（ADR: docs/adr/20261015-require-ci-checks-on-public-repo.md）。
    # ジョブ名の正本は .github/workflows/ の node-checks（node）・pr-checks（pr-check）・self-test（test の matrix）。
    echo "▶ main への merge に CI の全ジョブの成功を要する（branch protection の required status checks）"
    run gh api --silent --method PUT "$REPO_API/branches/main/protection" \
      -F 'required_status_checks[strict]=false' \
      -f 'required_status_checks[contexts][]=node' \
      -f 'required_status_checks[contexts][]=pr-check' \
      -f 'required_status_checks[contexts][]=test (ubuntu-latest)' \
      -f 'required_status_checks[contexts][]=test (macos-latest)' \
      -F enforce_admins=true \
      -F required_pull_request_reviews=null \
      -F restrictions=null
  else
    if [[ -z "$VISIBILITY" ]]; then
      echo "WARN: repo の公開状態を読めないため private として扱う" >&2
    fi
    echo "▶ GitHub Actions を無効化する（無効化しない場合は --enable-actions。ADR: docs/adr/20261014-enable-github-actions-on-public-repo.md）"
    run gh api --method PUT "$REPO_API/actions/permissions" -F enabled=false
  fi
fi

echo "✔ 完了"
