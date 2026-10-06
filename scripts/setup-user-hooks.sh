#!/usr/bin/env bash
# テンプレの hook をユーザーレベル（~/.claude・~/.codex・グローバル git 設定）にも配線する。
# hook と settings は tracked ファイルなので、古い branch・未 pull の checkout・長期統合 branch には届かない
# （第 2 ラウンド監査の実測: 展開後も 4〜43 時間ガード無し）。ユーザーレベルに同じ配線を置くと
# checkout の状態に依らず hook が効く。プロジェクト側 .claude/settings.json は他ツール向けに維持する。
#
# usage: scripts/setup-user-hooks.sh [--claude] [--codex] [--git] [--worktree-access] [--dry-run] [--uninstall]
#   - 対象の指定が無ければ --claude のみ（従来どおり）。複数指定で順に処理する
#   - --claude: 正本は .claude/settings.json の hooks（scripts/hooks/<name>.sh を参照する項目）。scripts/hooks の
#     hook 実装（.sh / .py）を <config>/hooks/template/ へ複製し、<config>/settings.json に同じ event / matcher で
#     `bash <config>/hooks/template/user-hook-runner.sh <name> <event>` を追加する（解決順はランナーのヘッダ参照）。
#     <config> は $CLAUDE_CONFIG_DIR、未設定なら $HOME/.claude（Claude Code と同じ解決）
#   - --codex: 正本は .codex/hooks.json の PreToolUse（二重実行しても結果が同じ guard だけ）。$CODEX_HOME
#     （未設定なら $HOME/.codex）の hooks.json と hooks/template/ へ同じ方式で配線する。Codex は /hooks で
#     trust するまで hook を実行しない（状態の確認は scripts/check-codex-hooks.sh）
#   - --git: scripts/hooks/git-tmp-worktree-guard.sh を ${XDG_CONFIG_HOME:-$HOME/.config}/git/project-template-hooks/
#     へ複製し、グローバル git 設定（$GIT_CONFIG_GLOBAL に従う）の hook.project-template-tmp-worktree を
#     post-checkout に配線する。一時領域への worktree 作成をツールに依らず取り消す（要: 設定ベース hook 対応の git）
#   - --worktree-access: 選んだ --claude / --codex の対象に、worktree 標準配置 ~/worktrees（$PROJECT_TEMPLATE_WORKTREES_DIR
#     で変更可）への作業許可を加える。Claude は settings.json の permissions.additionalDirectories、Codex は
#     config.toml の [sandbox_workspace_write].writable_roots。--uninstall 併用時はこの path だけを外す
#     （hook の配線は残す。判断の正本: docs/adr/20261006-allow-agent-access-to-worktree-root.md）
#   - 既存の hooks と他のキーは保持する。自分が入れた項目（command に user-hook-runner.sh を含む）だけを
#     入れ替えるので再実行しても増殖しない（冪等）。hook を追加・変更したら再実行する
#   - settings.json / hooks.json を書き換える前に <file>.bak-<timestamp> を取る（内容が変わる時だけ）
#   - --dry-run: 複製するファイルと設定の差分を表示して何も書かない
#   - --uninstall: 自分が入れた配線を外し、複製ディレクトリを削除する（他の hook には触れない）
set -eu

root="$(cd "$(dirname "$0")/.." && pwd)"

dry=0
uninstall=0
access=0
targets=""
for a in "$@"; do
  case "$a" in
    --worktree-access) access=1 ;;
    --claude|--codex|--git) case " $targets " in *" ${a#--} "*) ;; *) targets="$targets ${a#--}" ;; esac ;;
    --dry-run) dry=1 ;;
    --uninstall) uninstall=1 ;;
    -h|--help) sed -n '2,27p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) printf '✖ 不明なオプション: %s\n' "$a" >&2; exit 2 ;;
  esac
done
[ -n "$targets" ] || targets="claude"
case " $targets " in
  *" claude "*|*" codex "*) ;;
  *) [ "$access" = 1 ] && printf '⚠ --worktree-access は --claude / --codex と併用する（今回の対象には適用しない）\n' >&2 ;;
esac

command -v python3 >/dev/null 2>&1 || { printf '✖ python3 が必要\n' >&2; exit 1; }

# setup_json_hooks <正本 json> <config dir> <設定ファイル名> <host> <許可 event（空は全 event）>
setup_json_hooks() {
python3 - "$1" "$root/scripts/hooks" "$2" "$dry" "$uninstall" "$3" "$4" "$5" <<'PY'
import difflib, json, os, re, shlex, shutil, stat, sys, time

src, hooks_dir, cfg = sys.argv[1], sys.argv[2], sys.argv[3]
dry, uninstall = sys.argv[4] == "1", sys.argv[5] == "1"
fname, host = sys.argv[6], sys.argv[7]
events_allowed = set(sys.argv[8].split())
tmpl = os.path.join(cfg, "hooks", "template")
settings = os.path.join(cfg, fname)
runner = os.path.join(tmpl, "user-hook-runner.sh")
MARK = "hooks/template/user-hook-runner.sh"
NAME_RE = re.compile(r"scripts/hooks/([A-Za-z0-9_.-]+)\.sh")
tag = "[dry-run] " if dry else ""


def is_ours(h):
    return isinstance(h, dict) and MARK in str(h.get("command", ""))


# 1. 配線の正本（repo の settings.json）から event / matcher / hook 名を導く
with open(src) as f:
    proj = json.load(f)
desired, names = {}, []
for event, groups in (proj.get("hooks") or {}).items():
    if events_allowed and event not in events_allowed:
        continue
    for g in groups:
        found = []
        for h in g.get("hooks", []):
            m = NAME_RE.search(str(h.get("command", "")))
            if h.get("type") == "command" and m:
                found.append((m.group(1), h))
        if not found:
            continue
        names.extend(n for n, _ in found)
        ng = {}
        if "matcher" in g:
            ng["matcher"] = g["matcher"]
        ng["hooks"] = []
        for n, h in found:
            argv = [runner, n, event] + ([host] if host != "claude" else [])
            nh = {"type": "command", "command": "bash " + " ".join(shlex.quote(x) for x in argv)}
            if host != "claude" and "timeout" in h:
                nh["timeout"] = h["timeout"]
            ng["hooks"].append(nh)
        desired.setdefault(event, []).append(ng)
if not names and not uninstall:
    print("✖ %s に scripts/hooks/<name>.sh を参照する hook が無い" % src, file=sys.stderr)
    sys.exit(1)

# 2. 既存 settings から自分の項目だけ外し、（uninstall でなければ）望む配線を足す
cur = {}
settings_existed = os.path.exists(settings)
if settings_existed:
    with open(settings) as f:
        cur = json.load(f)
new = json.loads(json.dumps(cur))
hooks = new.get("hooks") if isinstance(new.get("hooks"), dict) else {}
for event in list(hooks):
    kept = []
    for g in hooks[event]:
        hs = [h for h in g.get("hooks", []) if not is_ours(h)]
        if hs:
            kept.append(dict(g, hooks=hs))
    if kept:
        hooks[event] = kept
    else:
        del hooks[event]
if not uninstall:
    for event, groups in desired.items():
        hooks.setdefault(event, []).extend(groups)
if hooks:
    new["hooks"] = hooks
else:
    new.pop("hooks", None)
changed = cur != new

# 3. 複製する hook ファイルの差分
copies = []  # (name, "更新" | "変更なし")
if not uninstall:
    for fn in sorted(os.listdir(hooks_dir)):
        if not fn.endswith((".sh", ".py")):
            continue
        s, d = os.path.join(hooks_dir, fn), os.path.join(tmpl, fn)
        same = os.path.exists(d) and open(s, "rb").read() == open(d, "rb").read()
        copies.append((fn, "変更なし" if same else "更新"))

# 4. 報告（dry-run はここまで）
print("%shooks: %s" % (tag, ", ".join(sorted(set(names))) or "(none)"))
if uninstall:
    print("%s複製ディレクトリ: %s を削除" % (tag, tmpl) if os.path.isdir(tmpl) else "%s複製ディレクトリ: なし" % tag)
else:
    n_up = sum(1 for _, k in copies if k == "更新")
    print("%s複製: %d ファイル → %s（更新 %d・変更なし %d）" % (tag, len(copies), tmpl, n_up, len(copies) - n_up))
if changed:
    before = json.dumps(cur, indent=2, ensure_ascii=False).splitlines(True)
    after = json.dumps(new, indent=2, ensure_ascii=False).splitlines(True)
    sys.stdout.writelines(difflib.unified_diff(before, after, settings, settings + " (after)"))
    if before and not before[-1].endswith("\n"):
        print()
else:
    print("%ssettings: 変更なし（%s）" % (tag, settings))
if dry:
    sys.exit(0)

# 5. 書き込み
if uninstall:
    if os.path.isdir(tmpl) and tmpl.endswith(os.path.join("hooks", "template")):
        shutil.rmtree(tmpl)
else:
    os.makedirs(tmpl, exist_ok=True)
    for fn, kind in copies:
        if kind == "更新":
            d = os.path.join(tmpl, fn)
            shutil.copyfile(os.path.join(hooks_dir, fn), d)
            if fn.endswith(".sh"):
                os.chmod(d, os.stat(d).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
if changed:
    os.makedirs(cfg, exist_ok=True)
    if settings_existed:
        bak = settings + ".bak-" + time.strftime("%Y%m%d-%H%M%S")
        shutil.copyfile(settings, bak)
        print("backup: %s" % bak)
    with open(settings, "w") as f:
        json.dump(new, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print("settings: %s を%s" % (settings, "更新した" if settings_existed else "作成した"))
print("✔ %s" % ("ユーザーレベル配線を撤去した" if uninstall else "ユーザーレベル配線を反映した"))
PY
}

# setup_worktree_access <claude|codex> <config dir>: worktree 標準配置への作業許可を設定ファイルへ冪等に足す / 外す
setup_worktree_access() {
python3 - "$1" "$2" "${PROJECT_TEMPLATE_WORKTREES_DIR:-$HOME/worktrees}" "$dry" "$uninstall" <<'PY'
import copy, difflib, json, os, re, shutil, sys, time

tool, cfg, dry, uninstall = sys.argv[1], sys.argv[2], sys.argv[4] == "1", sys.argv[5] == "1"
wt = os.path.abspath(os.path.expanduser(sys.argv[3])).rstrip("/") or "/"
tag = "[dry-run] " if dry else ""


def same(path):
    """~ 展開・末尾スラッシュ違いの同じ場所を同一とみなす（重複追加・取りこぼしの防止）。"""
    return isinstance(path, str) and (os.path.abspath(os.path.expanduser(path)).rstrip("/") or "/") == wt


def fail(message):
    print("✖ %s" % message, file=sys.stderr)
    sys.exit(1)


def report_and_write(path, before, after, existed, newline="\n"):
    if before == after:
        print("%s%s: worktree 許可は変更なし（%s）" % (tag, tool, path))
        return
    sys.stdout.writelines(difflib.unified_diff(before.splitlines(True), after.splitlines(True), path, path + " (after)"))
    if not after.endswith("\n") or not before.endswith("\n"):
        print()
    if dry:
        return
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if existed:
        bak = path + ".bak-" + time.strftime("%Y%m%d-%H%M%S")
        shutil.copyfile(path, bak)
        print("backup: %s" % bak)
    with open(path, "w", newline="") as handle:
        handle.write(after.replace("\n", newline) if newline != "\n" else after)
    print("%s: %s の worktree 許可を%s" % (tool, path, "外した" if uninstall else "反映した"))


if tool == "claude":
    path = os.path.join(cfg, "settings.json")
    existed = os.path.exists(path)
    try:
        data = json.load(open(path)) if existed else {}
    except ValueError as error:
        fail("%s を解析できない: %s" % (path, error))
    if not isinstance(data, dict) or not isinstance(data.get("permissions", {}), (dict, type(None))):
        fail("%s の permissions を自動編集できない形式のため中止した（手で追加する）" % path)
    before = json.dumps(data, indent=2, ensure_ascii=False) + "\n" if existed else ""
    new = copy.deepcopy(data)
    perms = new.get("permissions") or {}
    dirs = perms.get("additionalDirectories") or []
    if not isinstance(dirs, list):
        fail("%s の additionalDirectories が配列でないため中止した" % path)
    want = [d for d in dirs if not same(d)] if uninstall else (dirs if any(same(d) for d in dirs) else dirs + [wt])
    if want != dirs:
        if want:
            perms["additionalDirectories"] = want
        else:
            perms.pop("additionalDirectories", None)
        new["permissions"] = perms
        if not perms:  # 自分の path を外して空になった permissions は残さない（外す対象が無ければここに来ない）
            del new["permissions"]
    after = json.dumps(new, indent=2, ensure_ascii=False) + "\n" if new != data else before
    report_and_write(path, before, after, existed)
    sys.exit(0)

# codex: config.toml を行単位で最小編集する。置き換えるのは writable_roots の値の範囲だけで、
# 書き込み前に「範囲外の行が不変」かつ「tomllib で解釈した他の設定が不変」であることを確かめる。
if sys.version_info < (3, 11):
    fail("Codex の config.toml 編集には python3.11 以上（tomllib）が必要")
import tomllib

path = os.path.join(cfg, "config.toml")
existed = os.path.exists(path)
raw = open(path, newline="").read() if existed else ""
newline = "\r\n" if "\r\n" in raw else "\n"
before = raw.replace("\r\n", "\n")
try:
    parsed = tomllib.loads(before)
except tomllib.TOMLDecodeError as error:
    fail("%s を解析できない: %s" % (path, error))
section = parsed.get("sandbox_workspace_write", {})
roots = section.get("writable_roots", []) if isinstance(section, dict) else None
if not isinstance(roots, list):
    fail("%s の [sandbox_workspace_write].writable_roots を自動編集できない形式のため中止した（手で追加する）" % path)
want = [r for r in roots if not same(r)] if uninstall else (roots if any(same(r) for r in roots) else roots + [wt])
if want == roots:
    report_and_write(path, before, before, existed)
    sys.exit(0)


def value_end(lines, key):
    """key 行の `=` 以降の配列の終わりの行を、文字列とコメントを除いた括弧の対応で求める。"""
    depth, started, quote = 0, False, None
    for i in range(key, len(lines)):
        text = lines[i] if i > key else lines[i].split("=", 1)[1]
        j = 0
        while j < len(text):
            c = text[j]
            if quote:
                if c == "\\" and quote == '"':
                    j += 1
                elif c == quote:
                    quote = None
            elif c in "\"'":
                quote = c
            elif c == "#":
                break
            elif c == "[":
                depth, started = depth + 1, True
            elif c == "]":
                depth -= 1
                if started and depth == 0:
                    return i
            j += 1
    return None


def comment_in(text):
    """文字列の外に # があるか（置き換えで消えるコメントの検出）。"""
    quote, j = None, 0
    while j < len(text):
        c = text[j]
        if quote:
            if c == "\\" and quote == '"':
                j += 1
            elif c == quote:
                quote = None
        elif c in "\"'":
            quote = c
        elif c == "#":
            return True
        j += 1
    return False


line = "writable_roots = " + json.dumps(want, ensure_ascii=False)
lines = before.splitlines(True)
header = next((i for i, l in enumerate(lines) if re.match(r"\[sandbox_workspace_write\]\s*(#.*)?$", l.strip())), None)
if header is None:
    if "sandbox_workspace_write" in parsed:
        fail("%s の sandbox_workspace_write を自動編集できない形式のため中止した（手で追加する）" % path)
    span = (len(lines), 0)
    if lines and not lines[-1].endswith("\n"):
        lines[-1] += "\n"
        span = (len(lines) - 1, 1)
    lines += (["\n"] if lines else []) + ["[sandbox_workspace_write]\n", line + "\n"]
else:
    table = re.compile(r"\s*\[\[?[A-Za-z0-9_.\"' -]+\]\]?\s*(#.*)?$")
    end = next((i for i in range(header + 1, len(lines)) if table.match(lines[i])), len(lines))
    key = next((i for i in range(header + 1, end) if re.match(r"\s*writable_roots\s*=", lines[i])), None)
    if key is None:
        lines.insert(header + 1, line + "\n")
        span = (header + 1, 0)
    else:
        stop = value_end(lines, key)
        if stop is None:
            fail("%s の writable_roots の範囲を特定できないため中止した（手で追加する）" % path)
        span = (key, stop - key + 1)
        value = "".join(lines[key:stop + 1]).split("=", 1)[1]
        if "\'\'\'" in value or '"""' in value or any(
                comment_in(lines[i] if i > key else lines[i].split("=", 1)[1]) for i in range(key, stop + 1)):
            fail("%s の writable_roots にコメントまたは複数行文字列があり、置き換えると消えうるため中止した（手で追加する）" % path)
        lines[key:stop + 1] = [line + "\n"]
after = "".join(lines)
old_lines, new_lines = before.splitlines(True), after.splitlines(True)
start, removed = span
added = len(new_lines) - len(old_lines) + removed
outside_same = old_lines[:start] == new_lines[:start] and old_lines[start + removed:] == new_lines[start + added:]
try:
    check = tomllib.loads(after)
except tomllib.TOMLDecodeError:
    check = None
expected = copy.deepcopy(parsed)
expected.setdefault("sandbox_workspace_write", {})["writable_roots"] = want
if not outside_same or check != expected:
    fail("%s の編集で他の設定・コメントが変わるため中止した（手で追加する）" % path)
report_and_write(path, before, after, existed, newline)
PY
}

# setup_git_guard: グローバル git 設定の post-checkout へ一時領域 worktree の取り消し hook を配線する
setup_git_guard() {
  local name="project-template-tmp-worktree" dir dst cmd tag="" cur_event cur_cmd
  [ "$dry" = 1 ] && tag="[dry-run] "
  dir="${XDG_CONFIG_HOME:-$HOME/.config}/git/project-template-hooks"
  dst="$dir/git-tmp-worktree-guard.sh"
  cmd="bash '$dst'"
  case "$dst" in *"'"*) printf '✖ 配置先に引用符を含む: %s\n' "$dst" >&2; return 1 ;; esac
  cur_event="$(git config --global --get-all "hook.$name.event" 2>/dev/null || true)"
  cur_cmd="$(git config --global --get "hook.$name.command" 2>/dev/null || true)"
  if [ "$uninstall" = 1 ]; then
    if [ -n "$cur_event$cur_cmd" ]; then
      printf '%sgit: グローバル設定から hook.%s を外す\n' "$tag" "$name"
      [ "$dry" = 1 ] || git config --global --remove-section "hook.$name"
    else
      printf '%sgit: hook.%s は未配線\n' "$tag" "$name"
    fi
    if [ -d "$dir" ]; then
      printf '%sgit: 複製ディレクトリ %s を削除\n' "$tag" "$dir"
      [ "$dry" = 1 ] || rm -rf "$dir"
    fi
    printf '✔ git の一時領域 worktree guard を撤去した\n'
    return 0
  fi
  if ! git -C "$root" -c "hook.$name-probe.event=post-checkout" -c "hook.$name-probe.command=true" hook list post-checkout 2>/dev/null | grep -qx "$name-probe"; then
    printf '✖ この git (%s) は設定ベースの hook（hook.<name>.event）に対応していない。git を更新する\n' "$(git --version)" >&2
    return 1
  fi
  if cmp -s "$root/scripts/hooks/git-tmp-worktree-guard.sh" "$dst"; then
    printf '%sgit: 複製 %s は変更なし\n' "$tag" "$dst"
  else
    printf '%sgit: 複製 %s を更新\n' "$tag" "$dst"
    if [ "$dry" != 1 ]; then
      mkdir -p "$dir"
      cp "$root/scripts/hooks/git-tmp-worktree-guard.sh" "$dst"
      chmod +x "$dst"
    fi
  fi
  if [ "$cur_event" = "post-checkout" ] && [ "$cur_cmd" = "$cmd" ]; then
    printf '%sgit: hook.%s は変更なし\n' "$tag" "$name"
  else
    printf '%sgit: hook.%s.event = post-checkout / command = %s を設定\n' "$tag" "$name" "$cmd"
    if [ "$dry" != 1 ]; then
      git config --global --replace-all "hook.$name.event" post-checkout
      git config --global "hook.$name.command" "$cmd"
    fi
  fi
  printf '✔ git の一時領域 worktree guard を反映した\n'
}

for target in $targets; do
  case "$target" in
    claude)
      src="$root/.claude/settings.json"
      [ -f "$src" ] || src="$root/.agents/settings.json"
      [ -f "$src" ] || { printf '✖ %s が無い（テンプレ repo の中で実行する）\n' "$src" >&2; exit 1; }
      # --worktree-access --uninstall は許可だけを外し、guard hook の配線は残す
      if [ "$access" != 1 ] || [ "$uninstall" != 1 ]; then
        setup_json_hooks "$src" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" settings.json claude ""
      fi
      if [ "$access" = 1 ]; then setup_worktree_access claude "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"; fi
      ;;
    codex)
      src="$root/.codex/hooks.json"
      [ -f "$src" ] || { printf '✖ %s が無い（テンプレ repo の中で実行する）\n' "$src" >&2; exit 1; }
      if [ "$access" != 1 ] || [ "$uninstall" != 1 ]; then
        setup_json_hooks "$src" "${CODEX_HOME:-$HOME/.codex}" hooks.json codex PreToolUse
      fi
      if [ "$access" = 1 ]; then setup_worktree_access codex "${CODEX_HOME:-$HOME/.codex}"; fi
      ;;
    git)
      if [ "$access" != 1 ] || [ "$uninstall" != 1 ]; then setup_git_guard; fi
      ;;
  esac
done
