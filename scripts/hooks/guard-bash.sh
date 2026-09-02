#!/usr/bin/env bash
# Claude Code の PreToolUse(Bash) hook。毎回例外なく守るべきガードを機械強制する。
# 配線は .agents/settings.json（.claude symlink 経由で読まれる）。exit 2 が拒否。
#   1. git worktree を /tmp・$TMPDIR 等の一時領域に作らない（ADR 20260729。掃除で未 push commit ごと消える）
#   2. secret ファイル（.env 系・秘密鍵）を Bash の読み取りコマンドへ渡さない
#      （.env.example / .env.sample は対象外。Read ツール側は settings の deny が塞ぐ）
# stdin: {"tool_input": {"command": "..."}} 形式の JSON（Claude Code が渡す）。
# JSON が読めない・command が空の場合は許可する（hook 自身の不具合で全コマンドを
# 塞がないため。ガード対象は上記 2 クラスに限定する）。
set -u

command -v python3 >/dev/null 2>&1 || exit 0

# JSON はこの hook の stdin で受けるため、script は -c で渡す（heredoc は stdin を奪う）。
# 判定は「行頭またはコマンド連結記号の直後」に限定し、行単位で見る。heredoc で書く
# PR 本文・docs 等の散文に "git worktree add" や "/tmp" が現れても誤発火させないため
#（導入時に PR 作成コマンド自体をブロックした実発生あり）。
exec python3 -c '
import json
import re
import sys

try:
    cmd = json.load(sys.stdin).get("tool_input", {}).get("command", "")
except Exception:
    sys.exit(0)
if not isinstance(cmd, str) or not cmd:
    sys.exit(0)

CMD_POS = r"(^|[;&|(]\s*)"  # コマンド位置(行頭か連結記号の直後)
q = "\x27\x22"              # クォート文字クラス用

worktree_tmp = re.compile(
    CMD_POS + r"git\s+worktree\s+add\s+(\S+\s+){0,4}?[" + q + r"]?"
    r"(/tmp/|/private/tmp/|/var/folders/|\$\{?TMPDIR)")
secret_ref = re.compile(
    r"(^|[\s/" + q + r"])\.env(\.[A-Za-z0-9_-]+)?($|[\s" + q + r"])"
    r"|(^|[\s/" + q + r"])id_(rsa|ed25519)($|[\s" + q + r"])"
    r"|\.(pem|key)($|[\s" + q + r"])")
reader_head = re.compile(
    r"^(cat|head|tail|less|more|grep|rg|sed|awk|cut|sort|strings|xxd|od|base64|source|\.)\s")
# パイプライン区間の区切り。区間ごとに「先頭が読み取りコマンド かつ 同じ区間に secret 参照」で
# 判定する。別区間の .env リテラル(例: printf の引数)と | grep の同居で誤拒否した実発生への対策。
seg_split = re.compile(r"\s*(?:\|\||&&|[;|&(])\s*")

for line in cmd.splitlines():
    # 1. 一時領域への git worktree add を拒否
    if worktree_tmp.search(line):
        print("✖ git worktree を一時領域(/tmp 等)に作らない。home 配下(例: ~/<repo>-worktrees/)を使う"
              "(AGENTS.md 編集ガードレール / ADR 20260729)", file=sys.stderr)
        sys.exit(2)
    # 2. secret ファイルを読み取りコマンドへ渡す操作を拒否(.env.example / .env.sample は許可)
    for seg in seg_split.split(line):
        seg = seg.strip()
        if (seg and reader_head.match(seg) and secret_ref.search(seg)
                and not re.search(r"\.env\.(example|sample)", seg)):
            print("✖ secret ファイル(.env 系・秘密鍵)を読み取りコマンドへ渡さない。"
                  "存在確認と .env.example の整備のみ可(AGENTS.md 編集ガードレール)", file=sys.stderr)
            sys.exit(2)

sys.exit(0)
'
