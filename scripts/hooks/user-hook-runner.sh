#!/usr/bin/env bash
# ユーザーレベル配線（~/.claude/settings.json・~/.codex/hooks.json）から呼ばれる hook ランナー。
# usage: user-hook-runner.sh <hook-name> [event] [host]   （stdin = hook JSON をそのまま hook へ渡す）
#   host: 省略時は Claude Code。`codex` は Codex（~/.codex/hooks.json から呼ばれる）
# 解決順:
#   1. プロジェクト側 settings の同じ event で、matcher が一致する同名 hook があれば何もしない
#      （project hook と user-level hook の二重実行防止。stale matcher は fallback を抑止しない）。
#      matcher は tool_name と照らす。tool_name の無い SessionStart だけは payload の source（startup|resume|clear|compact）と照らす
#      Codex では行わない: project 側 hook は /hooks で trust されるまで実行されず、抑止すると guard が消える。
#      Codex に配線するのは二重実行しても結果が同じ PreToolUse guard だけ（setup-user-hooks.sh --codex）。
#   2. <project>/scripts/hooks/<name>.sh があればそれを実行する（プロジェクト側の fork を優先）。
#      <project> は $CLAUDE_PROJECT_DIR、無ければ $PWD。Codex では fork を使わない（project hook の trust 迂回になる）
#   3. 無ければ自身と同じディレクトリの複製（scripts/setup-user-hooks.sh が置く）を実行する
# hook 本体が届いていない checkout（古い branch・未 pull・長期統合 branch）でも複製が効くのが目的。
# 配線元: scripts/setup-user-hooks.sh。一時無効化は CLAUDE_USER_HOOKS_DISABLE=1。
set -u

name="${1:-}"
[ -n "$name" ] || exit 0
case "$name" in *[!A-Za-z0-9_.-]*) exit 0 ;; esac
[ "${CLAUDE_USER_HOOKS_DISABLE:-0}" = "1" ] && exit 0

event="${2:-}"
case "$event" in *[!A-Za-z0-9_.-]*) event="" ;; esac
host="${3:-claude}"
payload="$(cat)"
payload_field() { # payload_field <key>: payload の文字列 field（無い・文字列でない・解析失敗は空）
  printf '%s' "$payload" | python3 -c 'import json,sys
try:
    value=json.load(sys.stdin).get(sys.argv[1], "")
    print(value if isinstance(value, str) else "")
except Exception:
    print("")' "$1" 2>/dev/null
}
tool="$(payload_field tool_name)"
if [ -z "$event" ]; then
  event="$(payload_field hook_event_name)"
fi
# matcher と照らす対象: SessionStart は source、それ以外は tool_name
subject="$tool"
[ "$event" = "SessionStart" ] && subject="$(payload_field source)"

here="$(cd "$(dirname "$0")" && pwd)"
proj="${CLAUDE_PROJECT_DIR:-$PWD}"

[ "$host" = "codex" ] || for s in "$proj/.claude/settings.json" "$proj/.claude/settings.local.json" "$proj/.agents/settings.json"; do
  [ -f "$s" ] || continue
  if python3 - "$s" "$name" "$event" "$subject" <<'PY' 2>/dev/null
import json, re, sys

settings, name, event, subject = sys.argv[1:]
with open(settings) as handle:
    data = json.load(handle)
hooks = data.get("hooks") if isinstance(data.get("hooks"), dict) else {}
events = [event] if event else list(hooks)
needle = re.compile(r"(?:^|/)hooks/" + re.escape(name) + r"\.sh(?:[^A-Za-z0-9_.-]|$)")
for candidate in events:
    for group in hooks.get(candidate, []):
        matcher = group.get("matcher", "")
        if matcher:
            if not subject:
                continue
            try:
                if re.fullmatch(matcher, subject) is None:
                    continue
            except re.error:
                continue
        if any(needle.search(str(hook.get("command", ""))) for hook in group.get("hooks", []) if isinstance(hook, dict)):
            raise SystemExit(0)
raise SystemExit(1)
PY
  then
    exit 0
  fi
done

# Codex では project 側 fork を実行しない: project の hook は /hooks で trust されるまで実行されない
# 境界であり、user-level runner が任意 repo の scripts/hooks/*.sh を実行するとその trust を迂回する。
hook="$here/${name}.sh"
if [ "$host" != "codex" ] && [ -f "$proj/scripts/hooks/${name}.sh" ]; then
  hook="$proj/scripts/hooks/${name}.sh"
fi
[ -f "$hook" ] || exit 0
printf '%s' "$payload" | exec bash "$hook"
