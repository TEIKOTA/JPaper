#!/usr/bin/env python3
"""Claude Code PreToolUse(Bash) guard.

Hard guards exit 2. Destructive commands return Claude Code's structured
``permissionDecision: ask`` response so the user retains the final decision.
Malformed hook input is allowed to avoid disabling every Bash invocation.
Derived repositories can add secret path patterns with
``GUARD_BASH_EXTRA_SECRET_RE``.
"""

import json
import os
import re
import shlex
import subprocess
import sys


TEMP_PREFIXES = ("/tmp", "/private/tmp", "/var/folders")
READERS = {
    "cat",
    "head",
    "tail",
    "less",
    "more",
    "grep",
    "rg",
    "sed",
    "awk",
    "cut",
    "sort",
    "strings",
    "xxd",
    "od",
    "base64",
    "source",
    ".",
    "cp",
    "scp",
    "rsync",
    "node",
    "curl",
}
ENV_RE = re.compile(
    r"(?<![A-Za-z0-9_.-])(?P<name>\.env(?:\.[A-Za-z0-9_-]+)*)(?![A-Za-z0-9_.-])"
)
KEY_RE = re.compile(
    r"(?<![A-Za-z0-9_-])id_(?:rsa|ed25519)(?![A-Za-z0-9_-])"
    r"|\.(?:pem|key)(?![A-Za-z0-9_-])"
)
ASSIGNMENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")


def deny(message):
    print("✖ " + message, file=sys.stderr)
    raise SystemExit(2)


def ask(reason):
    print(
        json.dumps(
            {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "ask",
                    "permissionDecisionReason": reason,
                }
            },
            ensure_ascii=False,
        )
    )
    raise SystemExit(0)


def heredoc_delimiters(line):
    """Find heredoc operators outside quoted prose."""
    delimiters = []
    quote = None
    index = 0
    while index < len(line):
        char = line[index]
        if char == "\\":
            index += 2
            continue
        if quote:
            if char == quote:
                quote = None
            index += 1
            continue
        if char in ("'", '"'):
            quote = char
            index += 1
            continue
        if not line.startswith("<<", index) or line.startswith("<<<", index):
            index += 1
            continue
        cursor = index + 2
        if cursor < len(line) and line[cursor] == "-":
            cursor += 1
        while cursor < len(line) and line[cursor].isspace():
            cursor += 1
        delimiter_quote = None
        if cursor < len(line) and line[cursor] in ("'", '"'):
            delimiter_quote = line[cursor]
            cursor += 1
        match = re.match(r"[A-Za-z_][A-Za-z0-9_]*", line[cursor:])
        if not match:
            index += 2
            continue
        delimiter = match.group(0)
        cursor += len(delimiter)
        if delimiter_quote:
            if cursor >= len(line) or line[cursor] != delimiter_quote:
                index += 2
                continue
            cursor += 1
        delimiters.append(delimiter)
        index = cursor
    return delimiters


def mask_heredoc_bodies(text):
    """Keep heredoc declarations but hide their prose/data bodies."""
    delimiters = []
    masked = []
    for line in text.splitlines(True):
        probe = line.rstrip("\r\n")
        if delimiters:
            if probe.lstrip("\t") == delimiters[0]:
                delimiters.pop(0)
            masked.append("\n" if line.endswith("\n") else "")
            continue
        masked.append(line)
        delimiters.extend(heredoc_delimiters(line))
    return "".join(masked)


def find_subshell_end(text, start):
    depth = 1
    quote = None
    index = start
    while index < len(text):
        char = text[index]
        if char == "\\":
            index += 2
            continue
        if quote:
            if char == quote:
                quote = None
            index += 1
            continue
        if char in ("'", '"'):
            quote = char
        elif text.startswith("$(", index):
            depth += 1
            index += 1
        elif char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
            if depth == 0:
                return index
        index += 1
    return None


def strip_command_substitutions(text):
    """Return outer command text and the contents of $() / backticks."""
    outer = []
    substitutions = []
    quote = None
    index = 0
    while index < len(text):
        char = text[index]
        if char == "\\":
            outer.append(text[index : index + 2])
            index += 2
            continue
        if quote == "'":
            outer.append(char)
            if char == "'":
                quote = None
            index += 1
            continue
        if char == "'" and quote is None:
            quote = "'"
            outer.append(char)
            index += 1
            continue
        if char == '"':
            quote = None if quote == '"' else ('"' if quote is None else quote)
            outer.append(char)
            index += 1
            continue
        if text.startswith("$(", index):
            end = find_subshell_end(text, index + 2)
            if end is not None:
                substitutions.append(text[index + 2 : end])
                outer.append(" ")
                index = end + 1
                continue
        if char == "`":
            end = index + 1
            while end < len(text):
                if text[end] == "\\":
                    end += 2
                    continue
                if text[end] == "`":
                    break
                end += 1
            if end < len(text):
                substitutions.append(text[index + 1 : end])
                outer.append(" ")
                index = end + 1
                continue
        outer.append(char)
        index += 1
    return "".join(outer), substitutions


def split_segments(text):
    """Split on unquoted shell control operators, preserving command order."""
    segments = []
    current = []
    quote = None
    index = 0
    while index < len(text):
        char = text[index]
        if char == "\\":
            current.append(text[index : index + 2])
            index += 2
            continue
        if quote:
            current.append(char)
            if char == quote:
                quote = None
            index += 1
            continue
        if char in ("'", '"'):
            quote = char
            current.append(char)
            index += 1
            continue
        if char in ";|&()\n":
            segment = "".join(current).strip()
            if segment:
                segments.append(segment)
            current = []
            if index + 1 < len(text) and text[index + 1] == char and char in "|&":
                index += 1
        else:
            current.append(char)
        index += 1
    segment = "".join(current).strip()
    if segment:
        segments.append(segment)
    return segments


def command_groups(text):
    """Produce segment groups for the outer command and every substitution."""
    text = mask_heredoc_bodies(text)
    outer, substitutions = strip_command_substitutions(text)
    groups = [split_segments(outer)]
    for substitution in substitutions:
        groups.extend(command_groups(substitution))
    for segment in list(groups[0]):
        tokens = shell_tokens(segment)
        if tokens and command_name(tokens) in ("bash", "sh", "zsh"):
            for inner in shell_c_commands(tokens):
                groups.extend(command_groups(inner))
    return [group for group in groups if group]


def shell_c_commands(tokens):
    """`bash` / `sh` / `zsh` で command string になりうる引数を返す（`-c` の内側の再帰検査用）。

    最初に現れる c を含む option（-c / -lc / -euo pipefail -c の -c / +c / -rcfile 等）より後ろの引数を全て返す。
    option の解釈（o が引数を取る、先頭の long option、zsh の -O…）や「スクリプト名の後ろの -c は引数」という
    例外は持たない。どちらも展開・リダイレクト等の表記ですり抜けられ、旧来より緩くなる穴を生んだため（PR #113）。
    返す範囲は旧来の「最初の -c の次の引数」を常に含む（検査候補の包含）。ただし main() は最初に当たった
    判定で終わるため、追加の候補が ask に当たると後ろの deny に届かない組み合わせがある（deny 優先化は別 issue）。
    """
    for index, token in enumerate(tokens[1:], start=1):
        if len(token) > 1 and token[0] in "-+" and "c" in token.lstrip("-+"):
            return tokens[index + 1:]
    return []

def shell_tokens(segment, preserve_control=False):
    try:
        tokens = shlex.split(segment, comments=False, posix=True)
    except ValueError:
        return []
    controls = {
        "!",
        "{",
        "do",
        "elif",
        "else",
        "if",
        "then",
        "time",
        "until",
        "while",
    }
    while tokens:
        if ASSIGNMENT_RE.match(tokens[0]):
            tokens.pop(0)
            continue
        if tokens[0] in controls:
            if preserve_control:
                break
            tokens.pop(0)
            continue
        if tokens[0] in ("command", "builtin", "nohup"):
            tokens.pop(0)
            continue
        if tokens[0] == "env":
            tokens.pop(0)
            while tokens and (
                tokens[0].startswith("-") or ASSIGNMENT_RE.match(tokens[0])
            ):
                tokens.pop(0)
            continue
        if tokens[0] == "sudo":
            tokens.pop(0)
            while tokens and tokens[0].startswith("-"):
                option = tokens.pop(0)
                if option in (
                    "-C",
                    "-D",
                    "-g",
                    "-h",
                    "-p",
                    "-R",
                    "-T",
                    "-u",
                ) and tokens:
                    tokens.pop(0)
            continue
        break
    return tokens


def command_name(tokens):
    return os.path.basename(tokens[0]) if tokens else ""


def git_command(tokens, cwd):
    if command_name(tokens) != "git":
        return None, [], cwd
    index = 1
    effective_cwd = cwd
    options_with_value = {"-C", "-c", "--git-dir", "--work-tree", "--namespace"}
    while index < len(tokens) and tokens[index].startswith("-"):
        option = tokens[index]
        if option in options_with_value and index + 1 < len(tokens):
            if option == "-C":
                path = tokens[index + 1]
                effective_cwd = (
                    path
                    if os.path.isabs(path) or not effective_cwd
                    else os.path.join(effective_cwd, path)
                )
            index += 2
        else:
            index += 1
    if index >= len(tokens):
        return None, [], effective_cwd
    return tokens[index], tokens[index + 1 :], effective_cwd


def worktree_path(args):
    if not args or args[0] != "add":
        return None
    index = 1
    value_options = {"-b", "-B", "--reason"}
    while index < len(args):
        arg = args[index]
        if arg == "--":
            return args[index + 1] if index + 1 < len(args) else None
        if arg in value_options:
            index += 2
            continue
        if arg.startswith("--reason="):
            index += 1
            continue
        if arg.startswith("-"):
            index += 1
            continue
        return arg
    return None


def worktree_standard_path(path, cwd):
    """Resolve repo and ancestors; do not trust shell HOME/role overrides."""
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
            cwd=cwd or os.getcwd(), capture_output=True, text=True, timeout=3,
        )
        if result.returncode != 0:
            return False
        common = os.path.realpath(result.stdout.strip())
        repo_name = os.path.basename(os.path.dirname(common)) if os.path.basename(common) == ".git" else os.path.basename(common)
        standard = os.path.join(os.path.expanduser("~"), "worktrees", repo_name)
        candidate = os.path.abspath(os.path.join(cwd or os.getcwd(), os.path.expanduser(path)))
        ancestor = candidate
        while ancestor != os.path.dirname(ancestor):
            if os.path.islink(ancestor):
                return False
            ancestor = os.path.dirname(ancestor)
        return candidate.startswith(standard + os.sep) and os.path.realpath(candidate) == candidate
    except (OSError, subprocess.TimeoutExpired):
        return False


def managed_reclaim_authority(segment, cwd):
    """Only a literal clean tracked manager invocation can use the child exception.

    env assignments, wrappers, alternate backend paths and modified manager code do
    not inherit this exception. Runtime repeats all validation before removal.
    """
    try:
        raw = shlex.split(segment)
    except ValueError:
        return None
    if raw and raw[0] in ("bash", "/bin/bash"):
        raw = raw[1:]
    if not raw:
        return None
    try:
        root = subprocess.run(["git", "rev-parse", "--show-toplevel"], cwd=cwd or os.getcwd(),
                              capture_output=True, text=True, timeout=3)
        if root.returncode:
            return None
        root = root.stdout.strip()
        script = os.path.abspath(os.path.join(cwd or os.getcwd(), raw[0]))
        if script != os.path.join(root, "scripts", "worktree.sh") or os.path.islink(script):
            return None
        if raw[1:2] != ["reclaim"] or any("$" in item for item in raw):
            return None
        paths = ["scripts/worktree.sh", "scripts/lib/worktree.py"]
        status = subprocess.run(["git", "status", "--porcelain", "--", *paths], cwd=root,
                                capture_output=True, text=True, timeout=3)
        tracked = subprocess.run(["git", "ls-files", "--", *paths], cwd=root,
                                 capture_output=True, text=True, timeout=3)
        if status.returncode or status.stdout or tracked.returncode or set(tracked.stdout.splitlines()) != set(paths):
            return None
        verified = subprocess.run(["bash", script, "verify-reclaim", *raw[2:]], cwd=cwd or os.getcwd(),
                                  capture_output=True, text=True, timeout=40)
        if verified.returncode == 0 and json.loads(verified.stdout).get("authority") == "delegated-child":
            return "delegated-child"
    except (OSError, ValueError, subprocess.TimeoutExpired):
        pass
    return None


def is_temporary_path(path):
    return any(path == prefix or path.startswith(prefix + "/") for prefix in TEMP_PREFIXES)


def has_secret_reference(segment, extra_secret_re):
    for match in ENV_RE.finditer(segment):
        if match.group("name") not in (".env.example", ".env.sample"):
            return True
    if KEY_RE.search(segment):
        return True
    return bool(extra_secret_re and extra_secret_re.search(segment))


def is_secret_reader(segment, tokens):
    name = command_name(tokens)
    if name in READERS or re.fullmatch(r"python3?", name):
        return True
    return name in ("ruby", "perl") and bool(re.search(r"\bopen\s*\(", segment))


def control_tokens(tokens):
    while tokens and tokens[0] in ("do", "then", "else", "{"):
        tokens = tokens[1:]
    return tokens


def has_polling(groups):
    for group in groups:
        in_loop = False
        normalized = []
        for segment in group:
            tokens = shell_tokens(segment, preserve_control=True)
            if not tokens:
                continue
            name = command_name(tokens)
            if name in ("while", "until"):
                in_loop = True
                continue
            if name == "done":
                in_loop = False
                continue
            tokens = control_tokens(tokens)
            normalized.append(tokens)
            if in_loop and command_name(tokens) == "sleep":
                return True
        for current, following in zip(normalized, normalized[1:]):
            if command_name(current) != "sleep" or len(current) < 2:
                continue
            next_name = command_name(following)
            if next_name == "tail":
                return True
            if next_name == "gh" and following[1:3] == ["pr", "checks"]:
                return True
    return False


def current_branch(cwd):
    if not cwd or not os.path.isdir(cwd):
        return ""
    try:
        completed = subprocess.run(
            ["git", "-C", cwd, "branch", "--show-current"],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=2,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    return completed.stdout.strip() if completed.returncode == 0 else ""


def destructive_reason(tokens, cwd):
    name = command_name(tokens)
    if name == "rm":
        recursive = any(
            arg == "--recursive" or (arg.startswith("-") and "r" in arg[1:])
            for arg in tokens[1:]
        )
        force = any(
            arg == "--force" or (arg.startswith("-") and "f" in arg[1:])
            for arg in tokens[1:]
        )
        if recursive and force:
            return (
                "再帰的な強制削除は復旧不能になり得るため、"
                "対象を確認してから実行する"
            )

    git_subcommand, git_args, git_cwd = git_command(tokens, cwd)
    if git_subcommand == "reset" and "--hard" in git_args:
        return (
            "git reset --hard は未コミット作業を失うため、"
            "差分と対象 ref を確認してから実行する"
        )
    if git_subcommand == "push":
        if any(arg.startswith("--force") for arg in git_args):
            return (
                "force push はリモート履歴を書き換えるため、"
                "対象 branch を確認してから実行する"
            )
        if any(
            arg in ("main", "master", "refs/heads/main", "refs/heads/master")
            or arg.endswith(":main")
            or arg.endswith(":master")
            or arg.endswith(":refs/heads/main")
            or arg.endswith(":refs/heads/master")
            for arg in git_args
        ):
            return (
                "main/master への push は共有 branch を変更するため、"
                "内容を確認してから実行する"
            )
        positional = [arg for arg in git_args if not arg.startswith("-")]
        if len(positional) <= 1 and current_branch(git_cwd) in ("main", "master"):
            return (
                "main/master 上の push は共有 branch を変更するため、"
                "内容を確認してから実行する"
            )
    if git_subcommand == "branch" and "-D" in git_args:
        return (
            "git branch -D は未マージ branch を強制削除するため、"
            "対象を確認してから実行する"
        )
    if git_subcommand == "clean" and any(
        arg == "--force" or (arg.startswith("-") and "f" in arg[1:])
        for arg in git_args
    ):
        return (
            "git clean -f は未追跡ファイルを削除するため、"
            "dry-run で対象を確認してから実行する"
        )
    if git_subcommand == "checkout" and any(
        git_args[index : index + 2] == ["--", "."]
        for index in range(max(0, len(git_args) - 1))
    ):
        return (
            "git checkout -- . は作業ツリーの変更を破棄するため、"
            "差分を確認してから実行する"
        )

    if name == "gh" and tokens[1:3] == ["repo", "delete"]:
        return (
            "gh repo delete はリモート repository を削除するため、"
            "対象を確認してから実行する"
        )
    if name == "gh" and tokens[1:3] == ["pr", "close"]:
        return (
            "gh pr close は共有 PR の状態を変更するため、"
            "対象を確認してから実行する"
        )
    if name == "ssh" and ssh_has_remote_command(tokens):
        return (
            "ssh 経由の任意コマンドはリモート状態を変更し得るため、"
            "許可済み wrapper を使う"
        )
    return None


def ssh_has_remote_command(tokens):
    value_options = {
        "-B",
        "-b",
        "-c",
        "-D",
        "-E",
        "-e",
        "-F",
        "-I",
        "-i",
        "-J",
        "-L",
        "-l",
        "-m",
        "-O",
        "-o",
        "-p",
        "-Q",
        "-R",
        "-S",
        "-W",
        "-w",
    }
    index = 1
    while index < len(tokens) and tokens[index].startswith("-"):
        option = tokens[index]
        if option == "--":
            index += 1
            break
        if option in value_options:
            index += 2
        else:
            index += 1
    return index + 1 < len(tokens)


def main():
    try:
        payload = json.load(sys.stdin)
        command = payload.get("tool_input", {}).get("command", "")
        cwd = payload.get("cwd", "")
    except Exception:
        return 0
    if not isinstance(command, str) or not command:
        return 0

    extra_secret_re = None
    extra_pattern = os.environ.get("GUARD_BASH_EXTRA_SECRET_RE", "")
    if extra_pattern:
        try:
            extra_secret_re = re.compile(extra_pattern)
        except re.error as exc:
            print(f"guard-bash: GUARD_BASH_EXTRA_SECRET_RE を無視: {exc}", file=sys.stderr)

    groups = command_groups(command)
    segments = [segment for group in groups for segment in group]

    for segment in segments:
        tokens = shell_tokens(segment)
        git_subcommand, git_args, git_cwd = git_command(tokens, cwd)
        if git_subcommand == "worktree":
            path = worktree_path(git_args)
            if path and path.startswith("$"):
                deny("git worktree の作成先は変数でなく実パスを明記する")
            if path and is_temporary_path(path):
                deny(
                    "git worktree を一時領域(/tmp 等)に作らない。"
                    "標準配置 ~/worktrees/<repo>/ を使う"
                    "(AGENTS.md 編集ガードレール / ADR 20260729)"
                )
            if path and not worktree_standard_path(path, git_cwd):
                deny("新規 worktree は標準配置 ~/worktrees/<repo>/ の実 path を使う。理由付き例外承認は scripts/worktree.sh 経由")
            if git_args and git_args[0] in ("remove", "move", "prune"):
                ask("直接の git worktree 回収・移動は対象一覧のユーザー承認が必要。子専用回収は scripts/worktree.sh の検査付き経路を使う")

    for segment in segments:
        # A manager-shaped string in an unparsed wrapper never grants deletion authority.
        if re.search(r"worktree\.(?:sh|py).*\b(?:reclaim)\b", segment):
            if managed_reclaim_authority(segment, cwd) != "delegated-child":
                ask("worktree 管理の通常回収は根拠確認が必要。子例外は clean な正本コマンドの実検査時だけ適用")

    for segment in segments:
        tokens = shell_tokens(segment)
        if (
            tokens
            and is_secret_reader(segment, tokens)
            and has_secret_reference(segment, extra_secret_re)
        ):
            deny(
                "secret ファイル(.env 系・秘密鍵)を読み取りコマンドへ渡さない。"
                "存在確認と .env.example の整備のみ可(AGENTS.md 編集ガードレール)"
            )

    if has_polling(groups):
        deny(
            "即興の polling loop を作らない。scripts/wait-for-marker.sh または "
            "run_in_background の完了通知を使う"
        )

    for segment in segments:
        tokens = shell_tokens(segment)
        reason = destructive_reason(tokens, cwd) if tokens else None
        if reason:
            ask(reason)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
