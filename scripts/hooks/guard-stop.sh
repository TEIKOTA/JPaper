#!/usr/bin/env bash
# Claude Code の Stop hook。追跡ファイルに未コミット差分を残したまま応答を終えようとしたら、
# その差分状態につき 1 回だけ exit 2 で「commit するか、残す理由を報告する」よう促す。
# usage limit・セッション切断で未コミット差分が残置された実測事故への対策。
# 配線は .agents/settings.json。stdin: {"session_id": "...", "stop_hook_active": bool, ...}
# ループ防止:
#   - stop_hook_active=true（hook 由来の継続後の停止）は常に許可する
#   - 同一の差分状態（git status --porcelain のハッシュ = 未コミットのファイル集合）は同一セッションで
#     2 回目以降許可する。同じファイルを編集し続ける間は再警告しない（集合が変わったら再警告）
# 未追跡ファイルは対象外（意図的に置く作業ファイルまで警告しない）。
set -u

command -v python3 >/dev/null 2>&1 || exit 0

j="$(python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    d = {}
print(str(d.get("stop_hook_active", False)).lower())
print(str(d.get("session_id", "nosession")))
' 2>/dev/null)" || exit 0
active="${j%%$'\n'*}"
sid="${j#*$'\n'}"
[ "$active" = "true" ] && exit 0

git rev-parse --git-dir >/dev/null 2>&1 || exit 0
status="$(git status --porcelain --untracked-files=no 2>/dev/null)"
[ -n "$status" ] || exit 0

gitdir="$(git rev-parse --git-dir)"
state_file="$gitdir/claude-stop-${sid//[^A-Za-z0-9_-]/_}.state"
hash="$(printf '%s' "$status" | cksum | cut -d' ' -f1)"
if [ -f "$state_file" ] && [ "$(cat "$state_file")" = "$hash" ]; then
  exit 0
fi
printf '%s' "$hash" > "$state_file"

n="$(printf '%s\n' "$status" | grep -c .)"
{
  printf '✖ 未コミットの追跡ファイル差分が %s 件ある:\n%s\n' "$n" "$status"
  printf '完了・区切りの前に commit するか、残す理由を明示して報告する（この差分状態での警告は 1 回だけ）。\n'
} >&2
exit 2
