#!/usr/bin/env bash
# Claude Code の PostToolUse(Bash) hook。成功した gh pr create / edit の直後に
# 対象 PR を scripts/check-pr.sh で検査する。command 全体が単一の simple command
# と静的に確定できる場合だけを対象にする。検査違反は exit 2、GitHub が offline
# または対象 checkout に checker が無い場合は警告して許可する。
# stdin: {"tool_input":{"command":"..."},"cwd":"...", ...}
set -u

command -v python3 >/dev/null 2>&1 || exit 0

parsed="$(python3 -c '
import json, os, re, shlex, sys

try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
command = data.get("tool_input", {}).get("command", "")
cwd = data.get("cwd", "")
if not isinstance(command, str) or not command:
    sys.exit(0)
if not isinstance(cwd, str):
    cwd = ""
# PostToolUse には shell の実行 trace が無い。複数行・control flow は、文字列中に
# gh があっても実行されたか確定できないため保守的に対象外とする。
if "\n" in command or "\r" in command:
    sys.exit(0)
try:
    lexer = shlex.shlex(command, posix=True, punctuation_chars=";&|()")
    lexer.whitespace_split = True
    lexer.commenters = "#"
    tokens = list(lexer)
except ValueError:
    sys.exit(0)

operators = {";", "&&", "||", "|", "&", "(", ")"}
if not tokens or any(token in operators for token in tokens):
    sys.exit(0)
if os.path.basename(tokens[0]) != "gh":
    sys.exit(0)

# gh global option は repo 選択だけを受理する。未知 option を推測して pr を探さない。
repo = ""
i = 1
while i < len(tokens) and tokens[i] != "pr":
    token = tokens[i]
    if token in {"--repo", "-R"} and i + 1 < len(tokens):
        repo = tokens[i + 1]
        i += 2
    elif token.startswith("--repo="):
        repo = token.split("=", 1)[1]
        i += 1
    else:
        sys.exit(0)
if i + 1 >= len(tokens) or tokens[i] != "pr" or tokens[i + 1] not in {"create", "edit"}:
    sys.exit(0)

mode = tokens[i + 1]
target = head = resolution = warning = ""
segment = tokens[i + 2:]
if mode == "create":
    for j, token in enumerate(segment):
        if token == "--head" and j + 1 < len(segment):
            head = segment[j + 1]
        elif token.startswith("--head="):
            head = token.split("=", 1)[1]
        elif token in {"--repo", "-R"} and j + 1 < len(segment):
            repo = segment[j + 1]
        elif token.startswith("--repo="):
            repo = token.split("=", 1)[1]
else:
    # gh pr edit の positional target と、値を取る option を区別する。
    # 未知 option は値の有無を推測せず、別 PR の誤検査を避けるため skip する。
    value_options = {
        "--add-assignee", "--add-label", "--add-project", "--add-reviewer",
        "--attach", "--base", "--body", "--body-file", "--milestone",
        "--remove-assignee", "--remove-label", "--remove-project",
        "--remove-reviewer", "--repo", "--title",
    }
    short_value_options = {"-B", "-b", "-F", "-m", "-R", "-t"}
    flag_options = {"--help", "--remove-milestone"}
    positional = []
    positional_only = False
    j = 0
    while j < len(segment):
        token = segment[j]
        if positional_only:
            positional.append(token)
            j += 1
            continue
        if token == "--":
            positional_only = True
            j += 1
            continue
        if token in value_options or token in short_value_options:
            if j + 1 >= len(segment):
                warning = f"{token} の値がない"
                break
            if token in {"--repo", "-R"}:
                repo = segment[j + 1]
            j += 2
            continue
        if token in flag_options:
            j += 1
            continue
        if token.startswith("--"):
            name, separator, value = token.partition("=")
            if not separator or name not in value_options:
                warning = f"未知または不完全な option: {token}"
                break
            if name == "--repo":
                repo = value
            j += 1
            continue
        if token.startswith("-") and token != "-":
            short = token[:2]
            if short not in short_value_options or len(token) == 2:
                warning = f"未知または不完全な option: {token}"
                break
            if short == "-R":
                repo = token[2:]
            j += 1
            continue
        positional.append(token)
        j += 1

    if not warning and len(positional) > 1:
        warning = "positional target が複数ある"
    if not warning and not positional:
        resolution = "current"
    elif not warning:
        raw_target = positional[0]
        if re.fullmatch(r"[0-9]+", raw_target):
            target = raw_target
            resolution = "number"
        elif raw_target.startswith(("http://", "https://")):
            match = re.fullmatch(
                r"https?://([^/]+)/([^/]+)/([^/]+)/pull/([0-9]+)(?:[/?#].*)?",
                raw_target,
            )
            if not match:
                warning = "PR URL の形式を安全に解釈できない"
            else:
                host, owner, name, target = match.groups()
                url_repo = f"{owner}/{name}"
                if host.lower() not in {"github.com", "www.github.com"}:
                    url_repo = f"{host}/{url_repo}"
                normalized_repo = re.sub(r"^(?:www\.)?github\.com/", "", repo)
                normalized_url_repo = re.sub(
                    r"^(?:www\.)?github\.com/", "", url_repo
                )
                if repo and normalized_repo != normalized_url_repo:
                    warning = "PR URL と --repo の repository が一致しない"
                else:
                    repo = url_repo
                    resolution = "url"
        elif ":" in raw_target:
            warning = "owner 付き branch target は --head で安全に解決できない"
        else:
            head = raw_target
            resolution = "branch"
print(mode)
print(target)
print(head)
print(repo)
print(cwd)
print(resolution)
print(warning)
' 2>/dev/null)" || exit 0

mode="$(printf '%s\n' "$parsed" | sed -n '1p')"
[ -n "$mode" ] || exit 0
target="$(printf '%s\n' "$parsed" | sed -n '2p')"
head_branch="$(printf '%s\n' "$parsed" | sed -n '3p')"
repo="$(printf '%s\n' "$parsed" | sed -n '4p')"
cwd="$(printf '%s\n' "$parsed" | sed -n '5p')"
resolution="$(printf '%s\n' "$parsed" | sed -n '6p')"
warning="$(printf '%s\n' "$parsed" | sed -n '7p')"

if [ -n "$warning" ]; then
  printf 'WARN: gh pr %s の target を解釈できないため check-pr を省略（%s）\n' \
    "$mode" "$warning" >&2
  exit 0
fi

if [ -z "$cwd" ] || [ ! -d "$cwd" ]; then
  cwd="${CLAUDE_PROJECT_DIR:-$(pwd)}"
fi
root="$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null || true)"
[ -n "$root" ] || exit 0
checker="$root/scripts/check-pr.sh"
if [ ! -f "$checker" ]; then
  printf 'WARN: gh pr %s 後の検査を省略（%s がありません）\n' "$mode" "$checker" >&2
  exit 0
fi

if ! command -v gh >/dev/null 2>&1 || ! (cd "$cwd" && gh api rate_limit >/dev/null 2>&1); then
  printf 'WARN: GitHub offline のため gh pr %s 後の check-pr を省略\n' "$mode" >&2
  exit 0
fi

one_pr_number() { # stdin がちょうど1個の PR number のときだけ成功
  awk 'NR == 1 && /^[0-9]+$/ { valid = 1 } END { exit !(NR == 1 && valid) }'
}

if [ "$mode" = "edit" ] && [ "$resolution" = "current" ]; then
  current_branch="$(git -C "$cwd" branch --show-current 2>/dev/null || true)"
  if [ -z "$current_branch" ]; then
    printf 'WARN: gh pr edit の current branch を一意に解決できないため check-pr を省略\n' >&2
    exit 0
  fi
  if [ -n "$repo" ]; then
    target="$(cd "$cwd" && gh pr view --repo "$repo" --json number --jq '.number' 2>/dev/null || true)"
  else
    target="$(cd "$cwd" && gh pr view --json number --jq '.number' 2>/dev/null || true)"
  fi
  if ! printf '%s\n' "$target" | one_pr_number; then
    printf 'WARN: gh pr edit の current branch に紐づく PR を一意に解決できないため check-pr を省略\n' >&2
    exit 0
  fi
fi

if [ "$mode" = "create" ] && [ -z "$head_branch" ]; then
  # --fill 等で --head を明示しない create は、成功後に current PR を一意に解決する。
  if [ -n "$repo" ]; then
    target="$(cd "$cwd" && gh pr view --repo "$repo" --json number --jq '.number' 2>/dev/null)"
  else
    target="$(cd "$cwd" && gh pr view --json number --jq '.number' 2>/dev/null)"
  fi
  if ! printf '%s\n' "$target" | one_pr_number; then
    printf 'WARN: gh pr create 後の PR を一意に解決できないため topology 検査を省略\n' >&2
    exit 0
  fi
fi

set --
if [ -n "$target" ]; then set -- "$@" "$target"; fi
if [ -n "$head_branch" ]; then set -- "$@" --head "$head_branch"; fi
if [ -n "$repo" ]; then set -- "$@" --repo "$repo"; fi

out="$(cd "$cwd" && bash "$checker" "$@" 2>&1)"
rc=$?
if [ "$rc" -eq 0 ]; then
  printf '%s\n' "$out"
  topology="$root/scripts/check-branch-topology.sh"
  if [ ! -f "$topology" ]; then
    printf 'WARN: gh pr %s 後の topology 検査を省略（%s がありません）\n' "$mode" "$topology" >&2
    exit 0
  fi
  # target は番号指定でも、check-pr が live PR を解決済みなので current branch の代わりに
  # 明示 head を gh から再解決する。番号を checker と異なる対象へ渡さない。
  if [ -n "$target" ]; then
    if [ -n "$repo" ]; then
      head_branch="$(cd "$cwd" && gh pr view "$target" --repo "$repo" --json headRefName --jq '.headRefName' 2>/dev/null)"
    else
      head_branch="$(cd "$cwd" && gh pr view "$target" --json headRefName --jq '.headRefName' 2>/dev/null)"
    fi
    head_rc=$?
    if [ "$head_rc" -ne 0 ] || ! git check-ref-format --branch "$head_branch" >/dev/null 2>&1; then
      printf 'WARN: gh pr %s 後の head branch を解決できないため topology 検査を省略\n' "$mode" >&2
      exit 0
    fi
  fi
  if ! git check-ref-format --branch "$head_branch" >/dev/null 2>&1; then
    printf 'WARN: gh pr %s 後の head branch が不正なため topology 検査を省略\n' "$mode" >&2
    exit 0
  fi
  # shell の語分割を避けるため固定引数に組み立て直す。
  if [ -n "$repo" ]; then (cd "$cwd" && bash "$topology" --head "$head_branch" --repo "$repo" --require-open) || exit $?
  else (cd "$cwd" && bash "$topology" --head "$head_branch" --require-open) || exit $?; fi
  exit 0
fi
printf '%s\n' "$out" >&2
printf '✖ gh pr %s 後の check-pr が失敗しました\n' "$mode" >&2
exit 2
