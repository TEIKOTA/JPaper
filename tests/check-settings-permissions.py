#!/usr/bin/env python3
"""Validate the security-sensitive permission contract in settings.json."""

import json
import sys


EXPECTED_BRANCH_ALLOW = {
    "Bash(git branch)",
    "Bash(git branch --show-current)",
    "Bash(git branch -a)",
    "Bash(git branch -vv)",
    "Bash(git branch --list:*)",
}

EXPECTED_DENY = {
    "Read(.env)",
    "Read(.env.local)",
    "Read(.env.production)",
    "Read(secrets/**)",
    "Read(*.pem)",
    "Read(*.key)",
    "Read(id_rsa)",
    "Read(id_ed25519)",
}

EXPECTED_ASK = {
    "Bash(git push * main)",
    "Bash(git push * master)",
    "Bash(gh repo delete *)",
    "Bash(git reset --hard*)",
    "Bash(git push --force*)",
}
# rm -rf の確認は guard-bash.py が対象の path で判定する（#158）。静的な ask 規則を足すと、guard が通した一時領域の
# 中の削除にも確認が出る
FORBIDDEN_ASK_PREFIX = "Bash(rm "

DESTRUCTIVE_BRANCH_COMMANDS = (
    "git branch -D topic",
    "git branch -d topic",
    "git branch --delete topic",
    "git branch -m old new",
    "git branch -M old new",
)


def bash_rule_matches(rule: str, command: str) -> bool:
    if not (rule.startswith("Bash(") and rule.endswith(")")):
        return False
    pattern = rule[5:-1]
    if pattern.endswith(":*"):
        return command.startswith(pattern[:-2])
    return command == pattern


def require_string_list(permissions: dict, key: str, errors: list[str]) -> list[str]:
    value = permissions.get(key)
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        errors.append(f"permissions.{key} must be a list of strings")
        return []
    if len(value) != len(set(value)):
        errors.append(f"permissions.{key} must not contain duplicates")
    return value


def main() -> int:
    if len(sys.argv) != 2:
        print(f"usage: {sys.argv[0]} <settings.json>", file=sys.stderr)
        return 2

    try:
        with open(sys.argv[1], encoding="utf-8") as source:
            settings = json.load(source)
    except (OSError, json.JSONDecodeError) as exc:
        print(f"invalid settings JSON: {exc}", file=sys.stderr)
        return 1

    errors: list[str] = []
    permissions = settings.get("permissions")
    if not isinstance(permissions, dict):
        print("permissions must be an object", file=sys.stderr)
        return 1

    allow = require_string_list(permissions, "allow", errors)
    deny = require_string_list(permissions, "deny", errors)
    ask = require_string_list(permissions, "ask", errors)

    branch_allow = {rule for rule in allow if rule.startswith("Bash(git branch")}
    if branch_allow != EXPECTED_BRANCH_ALLOW:
        errors.append("git branch allow rules must be the fixed read-only set")

    for command in DESTRUCTIVE_BRANCH_COMMANDS:
        admitting_rules = [rule for rule in allow if bash_rule_matches(rule, command)]
        if admitting_rules:
            errors.append(f"allow admits destructive command {command!r}: {admitting_rules}")

    if set(deny) != EXPECTED_DENY or len(deny) != len(EXPECTED_DENY):
        errors.append("deny rules must match the fixed secret-file set")
    if any(".env.*" in rule for rule in deny):
        errors.append("deny must not block .env.example through .env.*")

    if set(ask) != EXPECTED_ASK or len(ask) != len(EXPECTED_ASK):
        errors.append("ask rules must match the fixed destructive-command set")
    if any(rule.startswith(FORBIDDEN_ASK_PREFIX) for rule in ask):
        errors.append("ask must not carry a static rm rule; guard-bash.py judges rm -rf by target path")

    if errors:
        for error in errors:
            print(f"ERROR: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
