#!/usr/bin/env bash
# AI コーディングエージェントの Stop hook。追跡ファイルに未コミット差分を残したまま応答を終えようとしたら、
# その差分状態につき 1 回だけ exit 2 で「commit するか、残す理由を報告する」よう促す。
# usage limit・セッション切断で未コミット差分が残置された実測事故への対策。
# Claude Code は同じ Stop hook を 8 回連続で block すると上書きする固有仕様があるため、
# 本 script 自身でも同一状態を 1 回だけ警告する。配線は各ツール固有の settings を参照。
# stdin は共通入力の session_id / stop_hook_active / cwd と、subagent の agent_id を読む。
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
if not isinstance(d, dict):
    d = {}
print(str(d.get("stop_hook_active", False)).lower())
print(d.get("session_id", "") if isinstance(d.get("session_id", ""), str) else "")
print(d.get("cwd", "") if isinstance(d.get("cwd", ""), str) else "")
print(d.get("agent_id", "") if isinstance(d.get("agent_id", ""), str) else "")
print("__GUARD_STOP_END__")
' 2>/dev/null)" || exit 0
active="${j%%$'\n'*}"
rest="${j#*$'\n'}"
sid="${rest%%$'\n'*}"
rest="${rest#*$'\n'}"
cwd="${rest%%$'\n'*}"
rest="${rest#*$'\n'}"
agent_id="${rest%%$'\n'*}"
[ "$active" = "true" ] && exit 0
[ -n "$agent_id" ] && exit 0
[ -n "$sid" ] || exit 0

# cwd は hook input の worktree を正本とする。旧 input だけは process cwd に fallback する。
if [ -n "$cwd" ]; then
  cd -- "$cwd" 2>/dev/null || exit 0
fi
git rev-parse --git-dir >/dev/null 2>&1 || exit 0
gitdir="$(git rev-parse --absolute-git-dir 2>/dev/null)" || exit 0
state_dir="$gitdir/agent-stop"
safe_sid="$(printf '%s' "$sid" | tr -c 'A-Za-z0-9_-' '_')"
[ -n "$safe_sid" ] || exit 0

# この worktree の state だけを掃除する。旧形式も git dir 直下に限定する。
if [ -d "$state_dir" ]; then
  find "$state_dir" -type f \( -name '*.state' -o -name '*.ack' \) -mtime +7 -exec rm -f {} \; 2>/dev/null || true
fi
find "$gitdir" -maxdepth 1 -type f \( -name 'claude-stop-*' -o -name 'agent-stop-*' \) -mtime +7 -exec rm -f {} \; 2>/dev/null || true

state_file="$state_dir/$safe_sid.state"
ack_file="$state_dir/$safe_sid.ack"
status="$(git status --porcelain --untracked-files=no 2>/dev/null)"
if [ -z "$status" ]; then
  rm -f "$state_file" "$ack_file" 2>/dev/null || true
  exit 0
fi

# merge の途中では index/worktree の差分は正常な中間状態なので block しない。
[ -e "$gitdir/MERGE_HEAD" ] && exit 0
[ -f "$ack_file" ] && exit 0

hash="$(printf '%s' "$status" | cksum | cut -d' ' -f1)"
if [ -f "$state_file" ] && [ "$(cat "$state_file")" = "$hash" ]; then
  exit 0
fi
mkdir -p "$state_dir" || exit 0
printf '%s' "$hash" > "$state_file"

n="$(printf '%s\n' "$status" | grep -c .)"
{
  printf '✖ 未コミットの追跡ファイル差分が %s 件ある:\n%s\n' "$n" "$status"
  printf '完了・区切りの前に commit するか、残す理由を明示して報告する。明示的に残すなら %s を作成する（同一 session の再警告を抑止）。\n' "$ack_file"
} >&2
exit 2
