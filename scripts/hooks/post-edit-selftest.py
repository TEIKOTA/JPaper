#!/usr/bin/env python3
"""Decide whether a PostToolUse event wrote below SELFTEST_WATCH.

Only statically resolvable shell words, literal ``cd`` effects, and Python
``open`` calls are considered. Malformed or dynamic forms fail open. The shell
wrapper owns self-test discovery and execution.
"""

import ast
import json
import os
import re
import shlex
import sys


ASSIGNMENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
CONTROL_WORDS = {"!", "{", "do", "elif", "else", "if", "then", "time", "until", "while"}


def ansi_c_escape(text, index):
    """Decode one statically known Bash ANSI-C escape at ``index``."""
    cursor = index + 1
    if cursor >= len(text):
        return "\\", cursor
    char = text[cursor]
    cursor += 1
    simple = {
        "a": "\a",
        "b": "\b",
        "e": "\x1b",
        "E": "\x1b",
        "f": "\f",
        "n": "\n",
        "r": "\r",
        "t": "\t",
        "v": "\v",
        "\\": "\\",
        "'": "'",
        '"': '"',
        "?": "?",
    }
    if char in simple:
        return simple[char], cursor
    if char == "\n":
        return "", cursor
    if char in "01234567":
        digits = char
        while cursor < len(text) and len(digits) < 3 and text[cursor] in "01234567":
            digits += text[cursor]
            cursor += 1
        return chr(int(digits, 8)), cursor
    widths = {"x": (2, "0123456789abcdefABCDEF")}
    if char in widths:
        width, allowed = widths[char]
        digits = ""
        while cursor < len(text) and len(digits) < width and text[cursor] in allowed:
            digits += text[cursor]
            cursor += 1
        if digits:
            try:
                return chr(int(digits, 16)), cursor
            except ValueError:
                return "\\" + char + digits, cursor
        return "\\" + char, cursor
    if char == "c" and cursor < len(text):
        control = text[cursor]
        return chr(ord(control.upper()) ^ 64), cursor + 1
    return "\\" + char, cursor


def parse_heredoc_at(line, index):
    """Parse one heredoc operator and its statically quoted delimiter."""
    if not line.startswith("<<", index) or line.startswith("<<<", index):
        return None
    cursor = index + 2
    strip_tabs = cursor < len(line) and line[cursor] == "-"
    if strip_tabs:
        cursor += 1
    while cursor < len(line) and line[cursor] in " \t":
        cursor += 1

    word = []
    word_started = False
    quote = None
    while cursor < len(line):
        char = line[cursor]
        if quote == "ansi":
            if char == "'":
                quote = None
                cursor += 1
            elif char == "\\":
                decoded, cursor = ansi_c_escape(line, cursor)
                word.append(decoded)
            else:
                word.append(char)
                cursor += 1
            continue
        if quote:
            if char == quote:
                quote = None
            elif char == "\\" and quote == '"' and cursor + 1 < len(line):
                following = line[cursor + 1]
                if following in '$`"\\\n':
                    cursor += 1
                    if following != "\n":
                        word.append(following)
                else:
                    word.append(char)
            else:
                word.append(char)
            cursor += 1
            continue
        if line.startswith("$'", cursor):
            word_started = True
            quote = "ansi"
            cursor += 2
            continue
        if char in ("'", '"'):
            word_started = True
            quote = char
            cursor += 1
            continue
        if char == "\\" and cursor + 1 < len(line):
            word_started = True
            cursor += 1
            word.append(line[cursor])
            cursor += 1
            continue
        if char.isspace() or char in ";|&()<>":
            break
        word_started = True
        word.append(char)
        cursor += 1

    if not word_started or quote is not None:
        return None
    return (("".join(word), strip_tabs), cursor)


def heredoc_delimiters(line):
    """Return (delimiter-after-quote-removal, strip-tabs) for shell heredocs."""
    delimiters = []
    quote = None
    index = 0
    while index < len(line):
        char = line[index]
        if quote:
            if char == quote:
                quote = None
            elif char == "\\" and quote == '"' and index + 1 < len(line):
                index += 1
            index += 1
            continue
        if char == "\\":
            index += 2
            continue
        if char in ("'", '"'):
            quote = char
            index += 1
            continue
        parsed = parse_heredoc_at(line, index)
        if parsed:
            spec, index = parsed
            delimiters.append(spec)
        else:
            index += 1
    return delimiters


def terminates_heredoc(line, spec):
    delimiter, strip_tabs = spec
    probe = line.rstrip("\r\n")
    if strip_tabs:
        probe = probe.lstrip("\t")
    return probe == delimiter


def mask_heredoc_bodies(text):
    """Keep declaration lines while hiding heredoc data from shell parsing."""
    active = []
    masked = []
    for line in text.splitlines(True):
        if active:
            if terminates_heredoc(line, active[0]):
                active.pop(0)
            masked.append("\n" if line.endswith("\n") else "")
            continue
        masked.append(line)
        active.extend(heredoc_delimiters(line))
    return "".join(masked)


def shell_lex(text):
    """Tokenize the small shell subset needed by the write detector."""
    tokens = []
    current = []
    word_started = False
    word_quoted = False
    quote = None
    conditional_depth = 0
    index = 0

    def flush_word():
        nonlocal current, word_started, word_quoted, conditional_depth
        if not word_started:
            return
        value = "".join(current)
        tokens.append(("WORD", value, word_quoted))
        if not word_quoted and value == "[[":
            conditional_depth += 1
        elif not word_quoted and value == "]]" and conditional_depth:
            conditional_depth -= 1
        current = []
        word_started = False
        word_quoted = False

    while index < len(text):
        char = text[index]
        if quote:
            word_started = True
            word_quoted = True
            if char == quote:
                quote = None
            elif char == "\\" and quote == '"' and index + 1 < len(text):
                following = text[index + 1]
                if following in '$`"\\\n':
                    index += 1
                    if following != "\n":
                        current.append(following)
                else:
                    current.append(char)
            else:
                current.append(char)
            index += 1
            continue
        if char in ("'", '"'):
            word_started = True
            word_quoted = True
            quote = char
            index += 1
            continue
        if char == "\\":
            word_started = True
            word_quoted = True
            if index + 1 < len(text):
                index += 1
                current.append(text[index])
            index += 1
            continue
        if char == "#" and not word_started:
            while index < len(text) and text[index] != "\n":
                index += 1
            continue
        if char.isspace():
            flush_word()
            if char == "\n":
                tokens.append(("OP", ";", False))
            index += 1
            continue
        if conditional_depth:
            current.append(char)
            word_started = True
            index += 1
            continue
        parsed_heredoc = parse_heredoc_at(text, index)
        if parsed_heredoc:
            if word_started and not word_quoted and "".join(current).isdigit():
                current = []
                word_started = False
            else:
                flush_word()
            spec, index = parsed_heredoc
            tokens.append(("HEREDOC", spec, False))
            continue
        if not word_started and text.startswith("&>>", index):
            tokens.append(("REDIR", "&>>", False))
            index += 3
            continue
        if not word_started and text.startswith("&>", index):
            tokens.append(("REDIR", "&>", False))
            index += 2
            continue
        if char == ">":
            if word_started and not word_quoted and "".join(current).isdigit():
                current = []
                word_started = False
            else:
                flush_word()
            operator = ">"
            if index + 1 < len(text) and text[index + 1] in (">", "|"):
                operator += text[index + 1]
                index += 1
            tokens.append(("REDIR", operator, False))
            index += 1
            continue
        operator = ""
        if text.startswith("&&", index) or text.startswith("||", index):
            operator = text[index : index + 2]
        elif char in ";|()&":
            operator = char
        if operator:
            flush_word()
            tokens.append(("OP", operator, False))
            index += len(operator)
            continue
        current.append(char)
        word_started = True
        index += 1
    flush_word()
    return tokens


def normalized_words(command_tokens):
    words = []
    skip_redirect_target = False
    for kind, value, _quoted in command_tokens:
        if kind == "REDIR":
            skip_redirect_target = True
            continue
        if kind != "WORD":
            continue
        if skip_redirect_target:
            skip_redirect_target = False
            continue
        words.append(value)

    while words:
        if ASSIGNMENT_RE.match(words[0]) or words[0] in CONTROL_WORDS:
            words.pop(0)
            continue
        if words[0] in ("command", "builtin", "nohup"):
            words.pop(0)
            continue
        if words[0] == "env":
            words.pop(0)
            while words and (words[0].startswith("-") or ASSIGNMENT_RE.match(words[0])):
                words.pop(0)
            continue
        break
    return words


def shell_commands(text, initial_cwd):
    """Return simple command records plus the resulting top-level literal cwd."""
    records = []
    cwd_stack = [initial_cwd]
    current = []

    def finish():
        nonlocal current
        if not current:
            return
        words = normalized_words(current)
        command_cwd = cwd_stack[-1]
        records.append((command_cwd, current, words))
        if words and os.path.basename(words[0]) == "cd":
            operands = []
            after_options = False
            for word in words[1:]:
                if word == "--":
                    after_options = True
                    continue
                if not after_options and word.startswith("-"):
                    continue
                operands.append(word)
            if operands and "$" not in operands[0] and "`" not in operands[0] and not operands[0].startswith("~"):
                path = operands[0]
                if os.path.isabs(path):
                    cwd_stack[-1] = os.path.normpath(path)
                elif command_cwd is not None:
                    cwd_stack[-1] = os.path.normpath(os.path.join(command_cwd, path))
                else:
                    cwd_stack[-1] = None
            elif words and os.path.basename(words[0]) == "cd":
                cwd_stack[-1] = None
        current = []

    for token in shell_lex(text):
        kind, value, _quoted = token
        if kind != "OP":
            current.append(token)
            continue
        finish()
        if value == "(":
            cwd_stack.append(cwd_stack[-1])
        elif value == ")" and len(cwd_stack) > 1:
            cwd_stack.pop()
    finish()
    return records, cwd_stack[0]


def parse_watches(root, value):
    try:
        items = shlex.split(value, comments=False, posix=True)
    except ValueError:
        return []
    watches = []
    for item in items:
        item = resolve_project_variable(item, root)
        path = item if os.path.isabs(item) else os.path.join(root, item)
        watches.append(os.path.normpath(path))
    return watches


def resolve_project_variable(path, root):
    for prefix in ("$CLAUDE_PROJECT_DIR", "${CLAUDE_PROJECT_DIR}"):
        if path == prefix:
            return root
        if path.startswith(prefix + "/"):
            return root + path[len(prefix) :]
    return path


def watched_path(path, cwd, root, watches):
    if not path or "\x00" in path:
        return ""
    path = resolve_project_variable(path, root)
    if "$" in path or "`" in path:
        return ""
    if not os.path.isabs(path) and cwd is None:
        return ""
    candidate = path if os.path.isabs(path) else os.path.join(cwd, path)
    candidate = os.path.normpath(candidate)
    for watch in watches:
        try:
            if os.path.commonpath((candidate, watch)) == watch:
                return candidate
        except ValueError:
            continue
    return ""


def redirect_target(tokens, cwd, root, watches):
    for index, token in enumerate(tokens):
        if token[0] != "REDIR" or index + 1 >= len(tokens):
            continue
        next_token = tokens[index + 1]
        if next_token[0] != "WORD":
            continue
        path = watched_path(next_token[1], cwd, root, watches)
        if path:
            return path
    return ""


def sed_edit_operands(words):
    inplace = False
    explicit_script = False
    operands = []
    index = 1
    options = True
    while index < len(words):
        word = words[index]
        if options and word == "--":
            options = False
            index += 1
            continue
        if options and word.startswith("-") and word != "-":
            if word in ("-i", "--in-place"):
                inplace = True
                if word == "-i" and index + 1 < len(words) and words[index + 1] == "":
                    index += 1
            elif word.startswith("-i") or word.startswith("--in-place="):
                inplace = True
            elif word in ("-e", "--expression", "-f", "--file"):
                explicit_script = True
                index += 1
            elif word.startswith(("-e", "-f", "--expression=", "--file=")):
                explicit_script = True
            index += 1
            continue
        options = False
        operands.append(word)
        index += 1
    if not inplace:
        return []
    if not explicit_script and operands:
        operands.pop(0)
    return operands


def command_target(words, cwd, root, watches):
    name = os.path.basename(words[0]) if words else ""
    if name == "tee":
        operands = []
        after_options = False
        for word in words[1:]:
            if word == "--":
                after_options = True
                continue
            if not after_options and word.startswith("-"):
                continue
            operands.append(word)
    elif name == "sed":
        operands = sed_edit_operands(words)
    else:
        operands = []
    for operand in operands:
        path = watched_path(operand, cwd, root, watches)
        if path:
            return path
    return ""


def python_open_paths(source):
    try:
        tree = ast.parse(source)
    except (SyntaxError, ValueError):
        return []
    paths = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Name) or node.func.id != "open":
            continue
        path_node = node.args[0] if node.args else None
        mode_node = node.args[1] if len(node.args) > 1 else None
        for keyword in node.keywords:
            if keyword.arg == "file" and path_node is None:
                path_node = keyword.value
            elif keyword.arg == "mode" and mode_node is None:
                mode_node = keyword.value
        if not isinstance(path_node, ast.Constant) or not isinstance(path_node.value, str):
            continue
        mode = mode_node.value if isinstance(mode_node, ast.Constant) and isinstance(mode_node.value, str) else "r"
        if any(flag in mode for flag in ("w", "a", "x", "+")):
            paths.append(path_node.value)
    return paths


def python_command_target(words, cwd, root, watches):
    if not words or not re.fullmatch(r"python3?", os.path.basename(words[0])):
        return ""
    for index, word in enumerate(words[1:-1], 1):
        if word == "-c":
            for path in python_open_paths(words[index + 1]):
                target = watched_path(path, cwd, root, watches)
                if target:
                    return target
            break
    return ""


def python_heredoc_sources(command, initial_cwd):
    """Return (body, cwd) for heredocs owned by literal Python commands."""
    sources = []
    active = []
    cwd = initial_cwd
    for line in command.splitlines(True):
        if active:
            spec, python_owned, active_cwd, body = active[0]
            if terminates_heredoc(line, spec):
                if python_owned:
                    sources.append(("".join(body), active_cwd))
                active.pop(0)
            elif python_owned:
                body.append(line)
            continue

        records, cwd = shell_commands(line, cwd)
        for record_cwd, tokens, words in records:
            python_owned = bool(words and re.fullmatch(r"python3?", os.path.basename(words[0])))
            for kind, value, _quoted in tokens:
                if kind == "HEREDOC":
                    active.append((value, python_owned, record_cwd, []))
    return sources


def shell_target(command, initial_cwd, root, watches):
    masked = mask_heredoc_bodies(command)
    records, _final_cwd = shell_commands(masked, initial_cwd)
    for cwd, tokens, words in records:
        target = redirect_target(tokens, cwd, root, watches)
        if target:
            return target
        target = command_target(words, cwd, root, watches)
        if target:
            return target
        target = python_command_target(words, cwd, root, watches)
        if target:
            return target
    for source, cwd in python_heredoc_sources(command, initial_cwd):
        for path in python_open_paths(source):
            target = watched_path(path, cwd, root, watches)
            if target:
                return target
    return ""


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return 0
    tool_input = payload.get("tool_input", {})
    if not isinstance(tool_input, dict):
        return 0

    root = os.path.abspath(os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd())
    watches = parse_watches(root, os.environ.get("SELFTEST_WATCH", "scripts/ tests/"))
    if not watches:
        return 0

    initial_cwd = payload.get("cwd", root)
    if not isinstance(initial_cwd, str) or not os.path.isabs(initial_cwd) or "$" in initial_cwd or "`" in initial_cwd:
        initial_cwd = root
    initial_cwd = os.path.normpath(initial_cwd)

    path = tool_input.get("file_path", "")
    if isinstance(path, str):
        target = watched_path(path, initial_cwd, root, watches)
        if target:
            print(target)
            return 0

    command = tool_input.get("command", "")
    if not isinstance(command, str) or not command:
        return 0
    target = shell_target(command, initial_cwd, root, watches)
    if target:
        print(target)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
