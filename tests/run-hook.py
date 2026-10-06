#!/usr/bin/env python3
"""Hook の実プロセスを呼び、終了値と Claude Code 応答 JSON を検証する。"""

import argparse
import json
import os
import subprocess
import sys


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--hook", required=True)
    parser.add_argument("--command", required=True)
    parser.add_argument("--cwd")
    parser.add_argument("--expect-return", type=int, required=True)
    parser.add_argument("--expect-decision", choices=("allow", "ask", "deny"))
    parser.add_argument("--expect-stderr-contains")
    args = parser.parse_args()

    payload = {"tool_input": {"command": args.command}}
    if args.cwd:
        payload["cwd"] = args.cwd

    completed = subprocess.run(
        ["bash", args.hook],
        input=json.dumps(payload),
        text=True,
        capture_output=True,
        env=os.environ.copy(),
        check=False,
    )

    errors = []
    if completed.returncode != args.expect_return:
        errors.append(
            f"return code: got {completed.returncode}, want {args.expect_return}"
        )

    if args.expect_decision:
        try:
            response = json.loads(completed.stdout)
            output = response["hookSpecificOutput"]
            decision = output["permissionDecision"]
            reason = output["permissionDecisionReason"]
            if output.get("hookEventName") != "PreToolUse":
                errors.append("hookEventName is not PreToolUse")
            if decision != args.expect_decision:
                errors.append(
                    f"permissionDecision: got {decision!r}, want {args.expect_decision!r}"
                )
            if not isinstance(reason, str) or not reason.strip():
                errors.append("permissionDecisionReason is empty")
        except (KeyError, TypeError, json.JSONDecodeError) as exc:
            errors.append(f"invalid hook response JSON: {exc}")

    if (
        args.expect_stderr_contains
        and args.expect_stderr_contains not in completed.stderr
    ):
        errors.append(
            f"stderr does not contain {args.expect_stderr_contains!r}: "
            f"{completed.stderr!r}"
        )

    if errors:
        print("; ".join(errors), file=sys.stderr)
        if completed.stdout:
            print(f"stdout: {completed.stdout!r}", file=sys.stderr)
        if completed.stderr:
            print(f"stderr: {completed.stderr!r}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
