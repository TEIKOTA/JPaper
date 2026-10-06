#!/usr/bin/env python3
"""Adapt shared Bash guard to Codex's supported PreToolUse response.

Codex canonical Bash payload uses tool_input.command, including exec_command.
PreToolUse ask is unsupported; never emit it as if it enforced confirmation.
"""
import json
from pathlib import Path
import subprocess
import sys


def main():
    try:
        payload = json.load(sys.stdin)
        command = payload["tool_input"]["command"]
        if not isinstance(command, str):
            raise ValueError("command")
    except (ValueError, KeyError, TypeError):
        print("Codex Bash guard: command を確認できません", file=sys.stderr)
        return 2
    result = subprocess.run([sys.executable, str(Path(__file__).with_name("guard-bash.py"))],
                            input=json.dumps(payload), text=True, capture_output=True)
    if result.stderr:
        print(result.stderr, end="", file=sys.stderr)
    if result.returncode:
        return 2
    if result.stdout.strip():
        try:
            response = json.loads(result.stdout)["hookSpecificOutput"]
            if response.get("permissionDecision") in ("ask", "deny"):
                print("Codex Bash guard: " + response["permissionDecisionReason"], file=sys.stderr)
                return 2
        except (ValueError, KeyError, TypeError):
            print("Codex Bash guard: guard 応答を確認できません", file=sys.stderr)
            return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
