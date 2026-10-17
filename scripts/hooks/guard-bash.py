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


TEMP_PREFIXES = ("/tmp", "/private/tmp", "/var/folders", "/private/var/folders")
# rm -rf を確認なしで通す一時領域（#158）。~/.trashable は HOME から、$TMPDIR は環境変数から足す
RM_TEMP_ROOTS = ("/tmp", "/private/tmp")
MACOS_TMPDIR_RE = re.compile(r"^(/(?:private/)?var/folders/[^/]+/[^/]+/T)(?:/|$)")
# rm が値を取らない option。これ以外（--no-preserve-root・-i・-P 等）が混じれば対象を読み切れないとして確認する
RM_SHORT_OPTIONS = set("rRfvd")
RM_LONG_OPTIONS = {"--recursive", "--force", "--verbose", "--dir", "--one-file-system", "--preserve-root"}
CD_COMMANDS = ("cd", "pushd", "popd")
LN_MV_RE = re.compile(r"(?<![A-Za-z0-9_.-])(?:ln|mv)(?![A-Za-z0-9_-])")
CD_WORD_RE = re.compile(r"\b(?:cd|pushd|popd)\b")
# shell が展開して行き先が変わりうる文字。cwd・作成先に含まれれば「判定できない」として扱う
EXPANSION_CHARS = "$`*?[]{}!"
# 作業 dir を変える wrapper の option（env -C / --chdir、sudo -D / --chdir）。値は cwd に反映せず「不明」として扱う
WRAPPER_CHDIR_SHORT = {"env": "C", "sudo": "D"}
# `worktree add` の作成先を実行前に判定できない間接実行（#155 N-b）。shell の script を stdin から読む形・名前が git でない呼び出し
SHELLS = ("bash", "sh", "zsh", "dash", "ksh")
# `worktree add` という語を引数に持っても何も実行しない（表示・検索）コマンド
NON_EXECUTING = ("echo", "printf", "grep", "rg", "man", "eval")  # eval は command_groups が引数を再帰検査する
WORKTREE_ADD_RE = re.compile(r"\bworktree\s+add\b")
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
# リダイレクトの token（2>&1・>/dev/null・&>f・<<<x・> のみ）。target が token に付いていなければ次の token が target
# target は空白・shell の meta 文字を含まない単純な語に限る。`bash -c '>/dev/null;cat .env'` の script のような
# 引用された引数を redirection と取り違えて検査から外さないため（外すと旧来より緩む）
REDIRECTION_RE = re.compile(r"^(?:\d+|&)?[<>][<>|&]*(?P<target>[A-Za-z0-9_./~=%+,:@-]*)$")


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


def split_segments(text, fd_duplication=True):
    """Split on unquoted shell control operators, preserving command order.

    fd_duplication=True は `2>&1`・`>&2` の `&` を区切りでなくリダイレクトの一部として読む（#155 N-a）。
    False は旧来の読み（`&` で割る）。command_groups が両方を検査候補にする。
    """
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
        if fd_duplication and char == "&" and current and current[-1][-1:] in ("<", ">"):
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


def fold_continuations(text):
    """引用の外の backslash＋改行（行の継続）を取り除く。shell は読む前にこれを畳む（#166）。

    path の直後で継ぐ形や、名前を割る形（コマンド名の途中で継ぐ）が、segment の分割・名前の判定で読めなくなるのを防ぐ。
    引用符の中（文字列の一部）とコメントの中は畳まない。backslash 自身の後の改行は継続でない。
    """
    folded = []
    quote = None
    ansi_c = False  # $'...' の中は backslash が次の 1 文字を飛ばす（\' で閉じない）。継続は畳まない
    index = 0
    while index < len(text):
        char = text[index]
        if char == "\\" and (quote != "'" or ansi_c):
            if not quote and text[index + 1 : index + 2] == "\n":
                index += 2
                continue
            folded.append(text[index : index + 2])
            index += 2
            continue
        if quote:
            if char == quote:
                quote = None
        elif char in ("'", '"'):
            quote = char
            ansi_c = char == "'" and folded[-1:] == ["$"]
        elif char == "#" and (not folded or folded[-1][-1:] in " \t\n;|&("):
            end = text.find("\n", index)
            end = len(text) if end < 0 else end
            folded.append(text[index:end])
            index = end
            continue
        folded.append(char)
        index += 1
    return "".join(folded)


def command_groups(text, legacy=True):
    """Produce segment groups for the outer command and every substitution."""
    text = fold_continuations(mask_heredoc_bodies(text))
    outer, substitutions = strip_command_substitutions(text)
    groups = [split_segments(outer)]
    # 旧来の分割（`2>&1` の & でも割る）で得られる segment も検査候補に残す。`x >& git push --force` 等を緩めない（#155）
    if legacy:
        groups[0].extend(segment for segment in split_segments(outer, fd_duplication=False) if segment not in groups[0])
    for substitution in substitutions:
        groups.extend(command_groups(substitution, legacy))
    for segment in list(groups[0]) if legacy else ():
        groups[0].extend(legacy_readings(segment))
    for segment in list(groups[0]):
        tokens = shell_tokens(segment)
        if tokens and command_name(tokens) in ("bash", "sh", "zsh"):
            for inner in shell_c_commands(tokens):
                groups.extend(command_groups(inner, legacy))
        if tokens and command_name(tokens) == "eval":
            # eval は引数を連結して command として評価する（#155 N-b）。`-c` と同じく内側を検査する
            groups.extend(command_groups(" ".join(tokens[1:]), legacy))
    return [group for group in groups if group]


def shell_c_commands(tokens):
    """`bash` / `sh` / `zsh` で command string になりうる引数を返す（`-c` の内側の再帰検査用）。

    最初に現れる c を含む option（-c / -lc / -euo pipefail -c の -c / +c / -rcfile 等）より後ろの引数を全て返す。
    option の解釈（o が引数を取る、先頭の long option、zsh の -O…）や「スクリプト名の後ろの -c は引数」という
    例外は持たない。どちらも展開・リダイレクト等の表記ですり抜けられ、旧来より緩くなる穴を生んだため（PR #113）。
    返す範囲は旧来の「最初の -c の次の引数」を常に含む（検査候補の包含）。main() は deny 系の検査を
    すべて終えてから ask を出すため、追加の候補が ask に当たっても後ろの deny は失われない（#115）。
    """
    for index, token in enumerate(tokens[1:], start=1):
        if len(token) > 1 and token[0] in "-+" and "c" in token.lstrip("-+"):
            return tokens[index + 1:]
    return []

# 前置 wrapper ごとの option 仕様: (値を取る 1 文字 option, 値を command として分割する 1 文字 option,
# 値を取る長い option, 値を分割する長い option)。値は token の残り（-n5 / -afoo）か次の token（-n 5）。
WRAPPER_OPTIONS = {
    "command": ("", "", (), ()),
    "noglob": ("", "", (), ()),  # zsh の precommand modifier
    "nocorrect": ("", "", (), ()),
    "-": ("", "", (), ()),
    "builtin": ("", "", (), ()),
    "nohup": ("", "", (), ()),
    "setsid": ("", "", (), ()),
    "exec": ("a", "", (), ()),
    "time": ("of", "", ("--output", "--format"), ()),
    "nice": ("n", "", ("--adjustment",), ()),
    "timeout": ("sk", "", ("--signal", "--kill-after"), ()),
    "gtimeout": ("sk", "", ("--signal", "--kill-after"), ()),
    "stdbuf": ("ioe", "", ("--input", "--output", "--error"), ()),
    "gstdbuf": ("ioe", "", ("--input", "--output", "--error"), ()),
    "env": ("uCPS", "S", ("--unset", "--chdir", "--split-string"), ("--split-string",)),
    "sudo": ("CDghpRTuUrt", "", ("--close-from", "--chdir", "--group", "--host", "--prompt", "--chroot",
                              "--command-timeout", "--user", "--other-user", "--role", "--type"), ()),
}


def split_words(value):
    try:
        return shlex.split(value, comments=False, posix=True)
    except ValueError:
        return [value]


def strip_wrapper_options(tokens, wrapper, consume_values, notes=None):
    """wrapper の option を剥がす。consume_values=False は値を取らない旧来の読み（検査候補の包含用）。

    notes が list なら、作業 dir を変える option を見たときに "chdir" を足す（値は読まない。呼び出し側が cwd を不明にする）。
    """
    short_values, short_split, long_values, long_split = WRAPPER_OPTIONS[wrapper]
    while tokens:
        if wrapper == "env" and ASSIGNMENT_RE.match(tokens[0]):
            # env は代入と option が混在しても剥がす（旧来の読みと同じ）
            tokens.pop(0)
            continue
        if not tokens[0].startswith("-") or (tokens[0] == "-" and wrapper != "env" and consume_values):
            break
        option = tokens.pop(0)
        if option == "--":
            if consume_values:
                break
            continue  # 旧来の読みは -- の後も option として剥がしていた
        if option.startswith("--"):
            name, has_value, value = option.partition("=")
            if len(name) > 2:
                # getopt_long は一意な省略形（--chd 等）も受け付ける。値を取る長い option の前方一致は、その option とみなす
                name = next((candidate for candidate in long_values if candidate.startswith(name)), name)
                if name == "--chdir" and notes is not None:
                    notes.append("chdir")
                if name == "--chroot" and notes is not None:
                    notes.append("chroot")
            if not has_value and name in long_values and consume_values and tokens:
                value, has_value = tokens.pop(0), "="
            if has_value and name in long_split:
                tokens[0:0] = split_words(value)
            continue
        for index, letter in enumerate(option[1:], start=1):
            if letter in WRAPPER_CHDIR_SHORT.get(wrapper, "") and notes is not None:
                notes.append("chdir")
            if wrapper == "sudo" and letter == "R" and notes is not None:
                notes.append("chroot")
            if letter in short_values:
                value = option[index + 1:]
                if not value and consume_values and tokens:
                    value = tokens.pop(0)
                if letter in short_split and value:
                    tokens[0:0] = split_words(value)
                break
    if wrapper in ("timeout", "gtimeout") and consume_values and tokens:
        tokens.pop(0)  # 期間


def raw_words(segment):
    """segment を shlex（posix）と同じ境界で分け、引用符・backslash を残したままの語を返す。閉じない引用は None。"""
    words, current, index = [], None, 0
    while index < len(segment):
        char = segment[index]
        if char in " \t\r\n":
            if current is not None:
                words.append(current)
                current = None
            index += 1
            continue
        current = current or ""
        if char == "'":
            end = segment.find("'", index + 1)
            if end < 0:
                return None
        elif char == '"':
            end = index + 1
            while end < len(segment) and segment[end] != '"':
                end += 2 if segment[end] == "\\" else 1
            if end >= len(segment):
                return None
        elif char == "\\":
            end = index + 1
        else:
            end = index
        current += segment[index:end + 1]
        index = end + 1
    if current is not None:
        words.append(current)
    return words


def strip_redirections(tokens, segment):
    """リダイレクトの token（と別 token の target）を除く。

    `>/dev/null git worktree add /tmp/wt x` のようにコマンド名の前や git の option の間に置かれても、
    コマンド名・subcommand を読めるようにする（#155 N-a）。除くのは token だけで、segment の文字列
    （secret の参照検査）は変えない。リダイレクトと読むのは引用符・backslash を含まない語だけで、
    `git push origin '>' --force` の `'>'` のような引用された引数は（次の語ごと）除かない（#156 B1）。
    語の境界が shlex と揃わなければ何も除かない（旧来の読み）。
    """
    raw = raw_words(segment)
    if raw is None or len(raw) != len(tokens):
        return list(tokens)
    result = []
    skip_next = False
    for token, word in zip(tokens, raw):
        if skip_next:
            skip_next = False
            continue
        match = REDIRECTION_RE.match(word)
        if match:
            skip_next = not match.group("target")
            continue
        result.append(token)
    return result


def shlex_words(segment):
    """segment を引数に分けた全 token（wrapper・リダイレクトを剥がさない読み）。"""
    return strip_redirections(split_words(segment), segment)


def shell_tokens(segment, preserve_control=False, consume_values=True, notes=None):
    try:
        tokens = shlex.split(segment, comments=False, posix=True)
    except ValueError:
        return []
    tokens = strip_redirections(tokens, segment)
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
            if tokens.pop(0) == "time":
                strip_wrapper_options(tokens, "time", consume_values, notes)
            continue
        wrapper = os.path.basename(tokens[0])
        if wrapper in WRAPPER_OPTIONS:
            tokens.pop(0)
            strip_wrapper_options(tokens, wrapper, consume_values, notes)
            continue
        break
    return tokens


def legacy_shell_tokens(segment, preserve_control=False):
    """#114 より前の main の shell_tokens をそのまま残した読み（検査候補の包含用。変更しない）。"""
    try:
        tokens = shlex.split(segment, comments=False, posix=True)
    except ValueError:
        return []
    tokens = strip_redirections(tokens, segment)
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


def legacy_readings(segment):
    """旧来の読みで本体が変わるなら、その本体を別 segment として返す。

    `env -u cat .env` の実際の本体は `.env` だが、旧来は `cat .env` と読んで deny していた。
    旧来より緩めないため、#114 より前の読みと、option の値を取らない読みも検査候補に含める（#114）。
    """
    primary = shell_tokens(segment)
    readings = []
    for alternative in (legacy_shell_tokens(segment), shell_tokens(segment, consume_values=False)):
        if alternative and alternative != primary and shlex.join(alternative) not in readings:
            readings.append(shlex.join(alternative))
    return readings


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
                path = os.path.expanduser(tokens[index + 1])
                if any(char in path for char in EXPANSION_CHARS) or path.startswith("~"):
                    effective_cwd = None  # 展開で行き先が変わる。以後の相対 path は判定できない
                elif os.path.isabs(path):
                    effective_cwd = os.path.normpath(path)
                else:
                    effective_cwd = os.path.join(effective_cwd, path) if effective_cwd else None
            index += 2
        else:
            index += 1
    if index >= len(tokens):
        return None, [], effective_cwd
    return tokens[index], tokens[index + 1 :], effective_cwd


def worktree_paths(args):
    """git worktree add の位置引数を順に返す（先頭が作成先 <path>、続きは <commit-ish>）。

    --orphan は値を取らない boolean（git worktree add の構文は `[--orphan] [(-b | -B) <new-branch>] <path>`）。
    ただし git の版や option の書き方（-fb br のような結合）で位置引数の解釈はずれうるので、呼び出し側は
    先頭以外の位置引数も、絶対 path として書かれていれば作成先の候補として検査する。
    """
    if not args or args[0] != "add":
        return []
    paths = []
    index = 1
    value_options = {"-b", "-B", "--reason"}
    while index < len(args):
        arg = args[index]
        if arg == "--":
            paths.extend(args[index + 1:])
            break
        if arg in value_options:
            index += 2
            continue
        if arg.startswith("-") and not arg.startswith("--"):
            # 結合した短い option（-fb br）。b / B が最後なら次の引数が値、途中なら残りが値
            letters = arg[1:]
            taken = next((i for i, letter in enumerate(letters) if letter in "bB"), None)
            index += 2 if taken is not None and taken == len(letters) - 1 else 1
            continue
        if arg.startswith("-"):
            index += 1
            continue
        paths.append(arg)
        index += 1
    return paths


def is_temporary_path(path):
    # macOS の既定の FS は大文字小文字を区別しないので、/TMP も /tmp になりうる。照合は大文字小文字によらず行う
    path = path.lower()
    return any(path == prefix or path.startswith(prefix + "/") for prefix in TEMP_PREFIXES)


def worktree_temporary_reason(path, base):
    """worktree の作成先が一時領域なら拒否の理由を返す（#139 の review B1）.

    文字列の前方一致だけでは //tmp・../../tmp・~/../../tmp・git -C /tmp・cd /tmp の後の相対 path が通るので、
    実効の cwd を基準に正規化し、実体（symlink を解決した path）でも照合する。基準が分からない相対 path は拒否する。
    """
    expanded = os.path.expanduser(path)
    if any(char in expanded for char in EXPANSION_CHARS) or expanded.startswith("~"):
        return "作成先に展開（glob・brace・~user 等）を使わない。実パスを明記する"
    if not os.path.isabs(expanded):
        if not base:
            return "cd 等の後の相対 path は作成先を判定できない。絶対 path で書く"
        expanded = os.path.join(os.path.expanduser(base), expanded)
    if re.match(r"/(proc|dev)(/|$)", re.sub(r"/+", "/", expanded).lower()):
        # /proc/self/cwd/../../tmp は normpath が先に .. を畳むと別の場所に見える。実体は実行時に決まるので判定できない（#155 N-d）
        return "/proc・/dev 配下は作成先を判定できない。通常の path で書く"
    candidate = os.path.normpath("/" + expanded.lstrip("/"))
    if is_temporary_path(candidate) or is_temporary_path(os.path.realpath(candidate)):
        return "git worktree を一時領域(/tmp 等)に作らない。(AGENTS.md 編集ガードレール / ADR 20260729)"
    return None


def shell_cwd(tokens, cwd):
    """cd・pushd・popd の後の cwd。行き先が分からなければ None（以後の相対 path は判定できないとして拒否する）."""
    name = command_name(tokens)
    if name not in ("cd", "pushd", "popd"):
        return cwd
    if name == "popd" or "-" in tokens[1:]:
        return None
    args = [token for token in tokens[1:] if not token.startswith("-")]
    if not args:
        return os.path.expanduser("~")
    target = os.path.expanduser(args[0])
    if any(char in target for char in EXPANSION_CHARS) or target.startswith("~"):
        return None
    if os.path.isabs(target):
        return os.path.normpath(target)
    return os.path.normpath(os.path.join(cwd, target)) if cwd else None


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


def real_root(path):
    """一時領域の root の実体。/ や HOME を覆う root（TMPDIR=/ 等）は一時領域として扱わない."""
    real = os.path.realpath(path)
    home = os.path.realpath(os.path.expanduser("~"))
    if real == os.sep or home == real or home.startswith(real + os.sep):
        return None
    return real


def rm_temp_roots():
    """(字面の root, 実体の root) の組。~/.trashable・/tmp・/private/tmp・$TMPDIR（#158）."""
    roots = [(root, os.path.realpath(root)) for root in RM_TEMP_ROOTS]
    home = os.path.expanduser("~")
    candidates = [os.path.join(home, ".trashable")] if os.path.isabs(home) else []
    tmpdir = os.environ.get("TMPDIR", "")
    if os.path.isabs(tmpdir):
        candidates.append(os.path.normpath(tmpdir))
    for root in candidates:
        real = real_root(root)
        if real:
            roots.append((root, real))
    return roots


def inside_temp(path, roots):
    """path が roots のどれか（か macOS の /var/folders/<..>/T）の厳密に「中」にあるか。root そのものは含めない."""
    if any(path.startswith(root.rstrip(os.sep) + os.sep) for root in roots):
        return True
    match = MACOS_TMPDIR_RE.match(path)
    return bool(match) and path != match.group(1)


def is_rm_temp_target(target, base, tilde_ok):
    """rm -rf の対象が、一時領域の「中」の実 path と判定できるか（#158）.

    判定できない形は全て False（確認する側）。次のいずれかも False:
    - 展開（$・コマンド置換・glob・brace）や ~user を含む、行き先が実行時に決まる形
    - ".." を含む path、基準 dir の分からない相対 path
    - 一時領域の root そのもの（~/.trashable・/tmp 等）
    - 親 dir の実体（symlink を解決した path）が一時領域の外。/tmp/link/x の link が外を指す形
    - 末尾が / や /. で、最後の要素が symlink（rm が link の先を辿りうる）
    最後の要素そのものが symlink なら rm は link だけを消すので、親 dir の実体で判定する。
    """
    if not target or "\0" in target or any(char in target for char in EXPANSION_CHARS):
        return False
    path = target
    if path.startswith("~"):
        if not tilde_ok or path != "~" and not path.startswith("~/"):
            return False
        path = os.path.expanduser("~") + path[1:]
    if not os.path.isabs(path):
        if not base:
            return False
        path = os.path.join(base, path)
    if ".." in path.split("/"):
        return False
    trailing = path.split("/")[-1] in ("", ".")
    path = os.path.normpath(path)
    if not inside_temp(path, [lexical for lexical, _ in rm_temp_roots()]):
        return False
    parent = os.path.realpath(os.path.dirname(path))
    if not inside_temp(parent.rstrip("/") + "/x", [real for _, real in rm_temp_roots()]):
        return False
    return not (trailing and os.path.islink(path))


def rm_targets(args):
    """rm の対象（option を除いた引数）。未知の option があれば None."""
    targets = []
    options_done = False
    for arg in args:
        if options_done:
            targets.append(arg)
        elif arg == "--":
            options_done = True
        elif arg.startswith("--"):
            if arg not in RM_LONG_OPTIONS:
                return None
        elif arg.startswith("-") and len(arg) > 1:
            if not set(arg[1:]) <= RM_SHORT_OPTIONS:
                return None
        else:
            targets.append(arg)
    return targets


def has_non_sequential_operator(text):
    """引用符の外に |・(・)・単独の & がある（cd が後続に及ぶと言い切れない）か."""
    quote = None
    index = 0
    while index < len(text):
        char = text[index]
        if char == "\\":
            index += 2
            continue
        if quote:
            if char == quote:
                quote = None
        elif char in ("'", '"'):
            quote = char
        elif char in "|()":
            return True
        elif char == "&":
            before = text[index - 1] if index else ""
            after = text[index + 1] if index + 1 < len(text) else ""
            if after == "&":
                index += 2
                continue
            if before not in ("<", ">", "&"):
                return True
        index += 1
    return False


def leading_cwd(command, start_cwd):
    """command の先頭に並ぶ cd を追った後の cwd（#158）。追い切れない形は None.

    追うのは、先頭から `cd X && …` / `cd X; …` と続く cd だけ。cd が後ろにも出る（条件の後・then の中・eval や
    bash -c の文字列の中）、| ( ) & がある、行き先に展開がある・存在しない dir、は None（呼び出し側は旧来の
    hook 入力の cwd で判定する）。cd が無ければ start_cwd のまま。
    """
    text = fold_continuations(mask_heredoc_bodies(command))
    total = len(CD_WORD_RE.findall(text))
    if not total:
        return start_cwd
    outer, _ = strip_command_substitutions(text)
    if outer.strip() != text.strip() or has_non_sequential_operator(outer):
        return None  # 置換を含む（cd の行き先・後続の評価順が変わりうる）
    cwd = start_cwd
    followed = 0
    for segment in split_segments(outer):
        tokens = shell_tokens(segment)
        if command_name(tokens) not in CD_COMMANDS:
            break
        followed += len(CD_WORD_RE.findall(segment))
        cwd = shell_cwd(tokens, cwd)
        if not cwd:
            return None
    if followed != total or not cwd or not os.path.isdir(cwd):
        return None
    return cwd


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


def destructive_reason(tokens, cwd, base=None, tilde_ok=False, temp_ok=True):
    """tokens が確認の要る破壊的コマンドなら理由を返す。

    cwd は git の branch を見る dir（旧来は hook 入力の cwd。cd を追えたときは移動先、#158）。
    base は rm の相対 path の基準 dir（追えなければ None）、tilde_ok は ~ を HOME に展開してよいか。
    temp_ok が偽なら rm -rf に一時領域の判定を使わず確認する（置換・ln / mv を含む command、#158 の review B1・N1）。
    """
    name = command_name(tokens)
    if name == "rm":
        recursive = any(
            arg == "--recursive" or (arg.startswith("-") and ("r" in arg[1:] or "R" in arg[1:]))
            for arg in tokens[1:]
        )
        force = any(
            arg == "--force" or (arg.startswith("-") and "f" in arg[1:])
            for arg in tokens[1:]
        )
        if recursive and force:
            targets = rm_targets(tokens[1:])
            try:
                if temp_ok and targets and all(is_rm_temp_target(target, base, tilde_ok) for target in targets):
                    return None
            except Exception:
                pass  # 判定できない（NUL を含む path 等）。確認する側に倒す（N3）
            return (
                "再帰的な強制削除は復旧不能になり得るため、対象を確認してから実行する。"
                "一時物は ~/.trashable/<repo>/ に置く（その中と /tmp 等の中は確認なしで消せる）"
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


GH_VALUE_OPTIONS = {"-R", "--repo", "--hostname"}
GH_MERGE_VALUE_OPTIONS = GH_VALUE_OPTIONS | {"-b", "--body", "-F", "--body-file", "-t", "--subject", "-A", "--author-email", "--match-head-commit"}
GH_API_MERGE_RE = re.compile(r"(?:^|/)pulls/[^/?#]+/merge/?(?:[?#].*)?$")
GH_GRAPHQL_PATH_RE = re.compile(r"(?:^|/)graphql/?(?:[?#].*)?$")
GH_GRAPHQL_MERGE_RE = re.compile(r"\b(?:mergePullRequest|enablePullRequestAutoMerge)\b")
MERGE_DENY_MESSAGE = "merge は scripts/merge-pr.sh を通す（承認の写しと条件を確かめ、判定表を PR に残してから squash merge する。#159）"


def gh_positionals(tokens):
    """gh の引数から option（と -R 等の値）を除いた語を返す。"""
    words = []
    skip = False
    for token in tokens:
        if skip:
            skip = False
        elif token in GH_VALUE_OPTIONS:
            skip = True
        elif not token.startswith("-"):
            words.append(token)
    return words


def merge_reason(tokens):
    """script を通らない merge（gh pr merge・gh api の merge endpoint・GraphQL の merge）を拒否する理由。

    xargs / find -exec が gh を呼ぶ形は、gh の位置から読む。--help / -h は何も merge しない。
    名前が gh でない呼び出し（変数・alias 等）は読めない。auto mode の判定が二重の守りになる（#159）。
    """
    if command_name(tokens) in ("xargs", "find"):
        for index, token in enumerate(tokens):
            if os.path.basename(token) == "gh":
                return merge_reason(tokens[index:])
        return None
    if command_name(tokens) != "gh":
        return None
    # 末尾の -h / --help だけを help とみなす。値を取る option の値（`--body -h`）は help でない
    if len(tokens) > 2 and tokens[-1] in ("-h", "--help") and tokens[-2] not in GH_MERGE_VALUE_OPTIONS:
        return None
    if len(tokens) == 2 and tokens[-1] in ("-h", "--help"):
        return None
    args = tokens[1:]
    words = gh_positionals(args)
    if words[:2] == ["pr", "merge"]:
        return MERGE_DENY_MESSAGE
    if words[:1] == ["api"]:
        method = None
        for index, token in enumerate(args):
            if token in ("-X", "--method") and index + 1 < len(args):
                method = args[index + 1]
            elif token.startswith("--method="):
                method = token.partition("=")[2]
            elif token.startswith("-X") and len(token) > 2:
                method = token[2:]
        if any(GH_API_MERGE_RE.search(word) for word in words[1:]) and (method or "").upper() != "GET":
            return MERGE_DENY_MESSAGE
        if any(GH_GRAPHQL_PATH_RE.search(word) for word in words[1:]) and any(GH_GRAPHQL_MERGE_RE.search(token) for token in args):
            return MERGE_DENY_MESSAGE
    return None


def has_merge_script(directory):
    """directory から git の root まで遡り、scripts/merge-pr.sh がある repo なら真（root を越えては探さない）。"""
    if not directory:
        return False
    current = os.path.abspath(directory)
    while True:
        if os.path.isfile(os.path.join(current, "scripts", "merge-pr.sh")):
            return True
        if os.path.exists(os.path.join(current, ".git")):
            return False
        parent = os.path.dirname(current)
        if parent == current:
            return False
        current = parent


def merge_script_in_scope(command, start_cwd):
    """merge の拒否（merge_reason）を効かせてよいか。merge 用の script がある project が 1 つでも関わるときだけ真（#184）。

    案内する scripts/merge-pr.sh が無い repo（派生 repo で #162 の反映前）で拒否すると、merge の手段が無くなる。
    関わる project は、$CLAUDE_PROJECT_DIR・hook 入力の cwd・先頭の cd を追った移動先。cd を追えない形は
    どの repo の merge か判定できないので、従来どおり拒否する側に倒す。
    """
    moved = leading_cwd(command, start_cwd)
    if moved is None:
        return True
    return any(has_merge_script(directory) for directory in (os.environ.get("CLAUDE_PROJECT_DIR", ""), start_cwd, moved))


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

    # 部分文字列の検査は継続を畳んだ command で行う（`l\\` ＋改行＋`n` も `ln` と読む, #166）
    folded = fold_continuations(command)
    groups = command_groups(command)
    segments = [segment for group in groups for segment in group]
    # ask は溜めておき、deny 系の検査をすべて終えてから出す。並んだ deny 対象を ask で素通りさせない（#115）
    pending_asks = []
    try:
        # hook の入力に cwd が無い旧形式は、hook の process の cwd（Claude Code は project の dir で起動する）を基準にする
        start_cwd = cwd or os.getcwd()
        # cd・pushd・popd や作業 dir を変える wrapper（env -C / sudo -D）がどこかにあれば、bash -c の内側や
        # コマンド置換の segment は呼び出し位置の cwd を追えない（外側を先に並べるため）。その先頭の cwd は不明にして、
        # 相対 path の worktree add を拒否する。内側で完結する cd は内側の中で追う
        changes_cwd = False
        for segment in segments:
            notes = []
            tokens = shell_tokens(segment, notes=notes)
            if notes or command_name(tokens) in ("cd", "pushd", "popd"):
                changes_cwd = True
        # 間接実行の検査は旧来の別読み（env -u FOO の値を command と読む等）を含まない主たる読みだけで行う
        for segment in (segment for group in command_groups(command, legacy=False) for segment in group):
            notes = []
            tokens = shell_tokens(segment, notes=notes)
            # git worktree add を間接に呼ぶ形は作成先を判定できない。拒否する側に倒す（#155 N-b〜N-c）
            words = shlex_words(segment)
            adds_worktree = any(first == "worktree" and second == "add" for first, second in zip(words, words[1:]))
            if "chroot" in notes and adds_worktree:
                deny("chroot 越しの git worktree add は作成先を判定できない。chroot を使わず書く")
            if adds_worktree and tokens and command_name(tokens) != "git" and command_name(tokens) not in NON_EXECUTING:
                deny("git 以外の名前（chroot・xargs・変数・alias 等）経由の git worktree add は作成先を判定できない。git を直接呼ぶ")
            if (
                tokens
                and command_name(tokens) in SHELLS
                and not shell_c_commands(tokens)
                and not [token for token in tokens[1:] if not token.startswith(("-", "<<<"))]
                and WORKTREE_ADD_RE.search(folded)
            ):
                deny("stdin（here-doc・here-string・pipe）で shell に渡す script の git worktree add は作成先を判定できない。直接書く")
        for index, group in enumerate(groups):
            current_cwd = None if index and changes_cwd else start_cwd
            for segment in group:
                notes = []
                tokens = shell_tokens(segment, notes=notes)
                current_cwd = shell_cwd(tokens, current_cwd) if tokens else current_cwd
                git_subcommand, git_args, git_cwd = git_command(tokens, current_cwd)
                if notes:
                    git_cwd = None  # env -C / sudo -D の行き先は読まない
                # `git -C $(…) worktree add` は置換が消えて -C が "worktree" を値に取り、subcommand を取り違える
                if (
                    command_name(tokens) == "git"
                    and ("$(" in folded or "`" in folded)
                    and any(first == "worktree" and second == "add" for first, second in zip(tokens, tokens[1:]))
                ):
                    deny("git worktree add にコマンド置換を使わない。作成先は実パスを明記する")
                if git_subcommand == "worktree":
                    paths = worktree_paths(git_args)
                    # command_groups はコマンド置換を別の segment に切り出すので、segment の path からは見えない
                    if git_args[:1] == ["add"] and ("$(" in folded or "`" in folded):
                        deny("git worktree add にコマンド置換を使わない。作成先は実パスを明記する")
                    if paths and any(char in paths[0] for char in "$`"):
                        deny("git worktree の作成先は変数・展開でなく実パスを明記する")
                    for position, path in enumerate(paths):
                        # 先頭が作成先。続き（commit-ish のはず）は、絶対 path・~ か、基準 dir が分かる相対 path だけ候補にする
                        # （基準が不明のときの commit-ish `origin/main` を、判定できない相対 path として拒否しないため）
                        if position and (
                            any(char in path for char in EXPANSION_CHARS)  # branch 変数等の commit-ish
                            or not (os.path.isabs(path) or path.startswith("~") or git_cwd)
                        ):
                            continue
                        reason = worktree_temporary_reason(path, git_cwd)
                        if reason:
                            deny(reason)
                    if git_args and git_args[0] in ("remove", "move", "prune"):
                        pending_asks.append("git worktree の回収・移動は対象一覧のユーザー承認が必要")

        for segment in segments:
            tokens = shell_tokens(segment)
            reason = merge_reason(tokens) if tokens else None
            if reason and merge_script_in_scope(command, start_cwd):
                deny(reason)
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

        # 先頭の cd を追えたときだけ、移動先を git の branch と rm の相対 path の基準にする。追えなければ旧来どおり
        followed = leading_cwd(command, start_cwd)
        tilde_ok = "HOME" not in folded  # HOME= の上書きで ~ の行き先が変わりうる
        # 置換（$()・``・<()・>()）は command_groups が別 segment に切り出し、rm の対象から消える（B1）。
        # ln / mv は判定時と実行時で path の実体が変わりうる（N1）。どちらも粗く、command に 1 つでもあれば一時領域の判定を使わない
        temp_ok = not any(mark in folded for mark in ("$(", "`", "<(", ">(")) and not LN_MV_RE.search(folded)
        for segment in segments:
            notes = []
            tokens = shell_tokens(segment, notes=notes)
            if not tokens:
                continue
            # env -C / sudo -D は行き先を読まないので、cd を追った結果も使わない
            git_cwd = cwd if notes or not followed or followed == start_cwd else followed
            base = None if notes else followed
            quoted = any(char in segment for char in "'\"\\")
            reason = destructive_reason(tokens, git_cwd, base, tilde_ok and not quoted, temp_ok)
            if reason:
                pending_asks.append(reason)
    except Exception:
        # 溜めた ask を例外で失わない（旧来は最初の ask で即終了していたため、例外より前の ask は出ていた）
        if pending_asks:
            ask(pending_asks[0])
        raise
    if pending_asks:
        ask(pending_asks[0])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
