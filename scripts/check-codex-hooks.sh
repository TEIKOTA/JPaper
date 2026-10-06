#!/usr/bin/env bash
# Codex hook の trust 状態を検査する。Codex は /hooks で trust した hook しか実行しないため、
# 配線済みでも未 trust の guard は効かない（2026-10 に派生 repo で /tmp worktree 作成を素通りさせた原因）。
#
# usage: scripts/check-codex-hooks.sh [--repo <dir>] [--quiet]
#   - 対象: <repo>/.codex/hooks.json と $CODEX_HOME/hooks.json（未設定なら ~/.codex）の各 command hook
#   - $CODEX_HOME/config.toml の [hooks.state."<hooks.json の path>:<event>:<group>:<hook>"] に
#     trusted_hash があれば trust 済み、enabled = false なら無効とみなす。event は snake_case（pre_tool_use 等）
#   - trusted_hash の内容一致（hook 変更後の再 trust 要否）は検証しない。Codex の再レビュー表示に委ねる
#   - --quiet: 問題がある時だけ出力する
#   - exit: 0 = 全 hook が trust 済み（または検査対象なし）/ 1 = 未 trust・無効の hook あり / 2 = 引数・設定の誤り
set -u

repo=""
quiet=0
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) repo="${2:?--repo には directory が必要}"; shift 2 ;;
    --quiet) quiet=1; shift ;;
    -h|--help) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) printf '✖ 不明なオプション: %s\n' "$1" >&2; exit 2 ;;
  esac
done
[ -n "$repo" ] || repo="$(git rev-parse --show-toplevel 2>/dev/null)" || repo=""
command -v python3 >/dev/null 2>&1 || { printf '✖ python3 が必要\n' >&2; exit 2; }

exec python3 - "$repo" "${CODEX_HOME:-$HOME/.codex}" "$quiet" <<'PY'
import json, os, re, sys

repo, codex_home, quiet = sys.argv[1], sys.argv[2], sys.argv[3] == "1"
try:
    import tomllib
except ImportError:
    print("✖ python3.11 以上（tomllib）が必要", file=sys.stderr)
    sys.exit(2)

files = []
if repo:
    files.append(os.path.join(os.path.abspath(repo), ".codex", "hooks.json"))
files.append(os.path.join(os.path.abspath(codex_home), "hooks.json"))
files = [f for f in files if os.path.isfile(f)]
if not files:
    if not quiet:
        print("Codex hooks: 検査対象の hooks.json なし")
    sys.exit(0)

state = {}
config = os.path.join(codex_home, "config.toml")
if os.path.isfile(config):
    try:
        with open(config, "rb") as handle:
            state = (tomllib.load(handle).get("hooks") or {}).get("state") or {}
    except (OSError, tomllib.TOMLDecodeError) as error:
        print("✖ %s を読めない: %s" % (config, error), file=sys.stderr)
        sys.exit(2)


def snake(event):
    return re.sub(r"(?<!^)(?=[A-Z])", "_", event).lower()


lines, bad = [], 0
for path in files:
    try:
        with open(path) as handle:
            hooks = json.load(handle).get("hooks") or {}
    except (OSError, ValueError, AttributeError) as error:
        print("✖ %s を読めない: %s" % (path, error), file=sys.stderr)
        sys.exit(2)
    keys_base = {path, os.path.realpath(path)}
    for event, groups in hooks.items():
        for gi, group in enumerate(groups if isinstance(groups, list) else []):
            for hi, hook in enumerate(group.get("hooks", []) if isinstance(group, dict) else []):
                if not isinstance(hook, dict) or hook.get("type") != "command":
                    continue
                entry = None
                for base in keys_base:
                    entry = state.get("%s:%s:%d:%d" % (base, snake(event), gi, hi)) or entry
                label = "%s %s[%d][%d] %s" % (path, event, gi, hi, str(hook.get("command", ""))[:80])
                if not isinstance(entry, dict) or not entry.get("trusted_hash"):
                    bad += 1
                    lines.append("⚠ 未 trust: " + label)
                elif entry.get("enabled") is False:
                    bad += 1
                    lines.append("⚠ 無効: " + label)
                else:
                    lines.append("✔ trust 済み: " + label)

for line in lines:
    if not quiet or not line.startswith("✔"):
        print(line)
if bad:
    print("→ Codex で /hooks を開き、内容を確認して trust する（未 trust の hook は実行されない）")
sys.exit(1 if bad else 0)
PY
