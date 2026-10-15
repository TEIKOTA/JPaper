#!/usr/bin/env python3
"""Detached validation supervisor. Progress comes from each instrumented test.

Fail immediately if prerequisites/output acquisition fail. A unique positive
success marker is written only when all required commands pass; failure is separate.
Launch with start_new_session=True and log redirection; wait-for-marker is the waiter.
"""
import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
EVIDENCE = ROOT / "docs/process/worktree-lifecycle-evidence"
run_id = sys.argv[1]
for name in ("bash", "git", "python3", "ruby", "lsof", "pnpm"):
    if not shutil.which(name):
        raise SystemExit("required resource unavailable: " + name)
if not EVIDENCE.is_dir():
    raise SystemExit("required evidence directory unavailable")
base = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
diff = subprocess.check_output(["git", "diff", "--stat"], cwd=ROOT, text=True)
commands = [
    ("fixture", ["python3", "tests/worktree-lifecycle.py"], 0),
    ("red-placement", ["python3", "tests/worktree-lifecycle.py", "--case", "placement", "--mutation", "placement"], 1),
    ("green-placement", ["python3", "tests/worktree-lifecycle.py", "--case", "placement"], 0),
    ("red-protection", ["python3", "tests/worktree-lifecycle.py", "--case", "protection", "--mutation", "protection"], 1),
    ("green-protection", ["python3", "tests/worktree-lifecycle.py", "--case", "protection"], 0),
    ("red-ownership", ["python3", "tests/worktree-lifecycle.py", "--case", "ownership", "--mutation", "ownership"], 1),
    ("green-ownership", ["python3", "tests/worktree-lifecycle.py", "--case", "ownership"], 0),
    ("red-special", ["python3", "tests/worktree-lifecycle.py", "--case", "special", "--mutation", "special"], 1),
    ("green-special", ["python3", "tests/worktree-lifecycle.py", "--case", "special"], 0),
    ("red-nested", ["python3", "tests/worktree-lifecycle.py", "--case", "nested", "--mutation", "nested"], 1),
    ("green-nested", ["python3", "tests/worktree-lifecycle.py", "--case", "nested"], 0),
    ("bash-selftest", ["bash", "tests/run-tests.sh"], 0),
    ("system-bash-selftest", ["/bin/bash", "tests/run-tests.sh"], 0),
    ("frontmatter", ["pnpm", "exec", "tsx", "scripts/check-skill-frontmatter.ts"], 0),
    ("instruction-links", ["bash", "scripts/check-agent-instruction-links.sh"], 0),
    ("diff-check", ["git", "diff", "--check"], 0),
]
manifest_paths = subprocess.check_output(
    ["git", "ls-files", "--cached", "--others", "--exclude-standard", "--",
     "scripts", "tests", ".codex/hooks.json", ".claude/skills/delegate-work/SKILL.md",
     ".claude/skills/fix-issue/SKILL.md", "AGENTS.md", "README.md", "docs/process/worktree-lifecycle.md"],
    cwd=ROOT, text=True).splitlines()
manifest = {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in sorted(set(manifest_paths)) if (ROOT / name).is_file()}
results = []
for label, command, expected in commands:
    print("VALIDATION_START=" + label, flush=True)
    log = EVIDENCE / (run_id + "-" + label + ".txt")
    counter = EVIDENCE / (run_id + "-" + label + "-counts.json")
    environment = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1", "PYTHONUNBUFFERED": "1"}
    if "selftest" in label:
        environment["SELFTEST_SUMMARY_PATH"] = str(counter)
        environment["SELFTEST_PROGRESS"] = "1"
    with log.open("w") as output:
        result = subprocess.run(command, cwd=ROOT, stdout=output, stderr=subprocess.STDOUT,
                                env=environment)
    row = {"label": label, "command": command, "exit": result.returncode, "expected_exit": expected,
           "log": str(log.relative_to(ROOT)), "passed": result.returncode == expected}
    # Read structured fixture counts, never generalize from progress/log-tail.
    if "selftest" not in label and label not in ("frontmatter", "instruction-links", "diff-check"):
        lines = log.read_text().splitlines()
        for line in reversed(lines):
            if line.startswith('{"tests":'):
                row["fixture_summary"] = json.loads(line)
                break
    if label in ("fixture",) or label.startswith(("red-", "green-")):
        counts = row.get("fixture_summary", {})
        if label.startswith("red-"):
            row["passed"] = row["passed"] and counts.get("errors") == 0 and counts.get("failures", 0) > 0 and counts.get("mutation") == label[4:]
        else:
            row["passed"] = row["passed"] and counts.get("successful") is True and counts.get("errors") == 0
    if "selftest" in label and counter.is_file():
        row["selftest_counts"] = json.loads(counter.read_text())
        row["selftest_counts_path"] = str(counter.relative_to(ROOT))
    results.append(row)
    print("VALIDATION_RESULT=" + label + " exit=" + str(result.returncode), flush=True)
summary = {"run": run_id, "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
           "head_before_run": base, "source_sha256_manifest": manifest, "uncommitted_diff_before_run": diff,
           "results": results, "passed": all(row["passed"] for row in results)}
(EVIDENCE / (run_id + "-summary.json")).write_text(json.dumps(summary, indent=2, ensure_ascii=False) + "\n")
print("WORKTREE_VALIDATION_" + run_id + ("_SUCCESS" if summary["passed"] else "_FAILED"), flush=True)
sys.exit(0 if summary["passed"] else 1)
