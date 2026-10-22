#!/usr/bin/env python3
"""scripts/report-main-ci-failure.sh と .github/workflows/main-ci-failure.yml（#483）の test。gh は fake（本物の issue は作らない）。

main の push の failure だけを、失敗した job・テスト名つきで issue にし、同じ workflow の open issue があればコメントを足す。
workflow は fork の PR の実行を対象にせず、権限を最小にする。

--mutation は保護を 1 つ外した写しを作り、対応する --case が red になることを示す。
実装ファイルは変更しない。注入先が 1 か所に決まらなければ exit 3（保護の喪失の red = exit 1 と区別する）。
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/report-main-ci-failure.sh"
WORKFLOW = ROOT / ".github/workflows/main-ci-failure.yml"

MUTATIONS = {
    "branch": ('run["headBranch"] == "main" and ', "", SCRIPT),
    "event": (' and run["event"] == "push"', "", SCRIPT),
    "conclusion": ('run["conclusion"] == "failure" and ', "", SCRIPT),
    "dedupe": ('if issue["title"] == sys.argv[1]:', "if True:", SCRIPT),
    "dryrun": ('if [[ "$DRY_RUN" -eq 1 ]]; then', "if false; then", SCRIPT),
    "wfevent": ("      github.event.workflow_run.event == 'push' &&\n", "", WORKFLOW),
    "wfrepo": ("      github.event.workflow_run.head_repository.full_name == github.repository\n", "      true\n", WORKFLOW),
    "wfperm": ("  issues: write\n", "  issues: write\n  pull-requests: write\n", WORKFLOW),
}
CASES = {
    "branch": "test_non_main_or_pull_request_runs_are_ignored",
    "event": "test_non_main_or_pull_request_runs_are_ignored",
    "conclusion": "test_non_main_or_pull_request_runs_are_ignored",
    "dedupe": "test_existing_issue_of_same_workflow_gets_a_comment",
    "dryrun": "test_dry_run_creates_nothing",
    "wfevent": "test_workflow_is_limited_to_main_push_of_own_repo",
    "wfrepo": "test_workflow_is_limited_to_main_push_of_own_repo",
    "wfperm": "test_workflow_permissions_are_minimal",
}
parser = argparse.ArgumentParser()
parser.add_argument("--mutation", choices=sorted(MUTATIONS))
parser.add_argument("--case", choices=sorted(CASES))
arguments = parser.parse_args()

WORK = Path(tempfile.mkdtemp(prefix="report-ci-"))
script_path = WORK / "report-main-ci-failure.sh"
script_text, workflow_text = SCRIPT.read_text(), WORKFLOW.read_text()
if arguments.mutation:
    needle, replacement, target = MUTATIONS[arguments.mutation]
    text = script_text if target == SCRIPT else workflow_text
    if text.count(needle) != 1:
        print("regression injection target changed: %r" % needle[:60], file=sys.stderr)
        sys.exit(3)
    text = text.replace(needle, replacement)
    if target == SCRIPT:
        script_text = text
    else:
        workflow_text = text
script_path.write_text(script_text)

FAKE_GH = r'''#!/usr/bin/env python3
import json, os, sys
state = os.environ["FAKE_DIR"]
args = sys.argv[1:]
with open(state + "/log", "a") as log:
    log.write(" ".join(args) + "\n")
if args[:2] == ["run", "view"] and "--log-failed" in args:
    sys.stdout.write(open(state + "/log-failed.txt").read())
elif args[:2] == ["run", "view"]:
    print(open(state + "/run.json").read())
elif args[:2] == ["issue", "list"]:
    print(open(state + "/issues.json").read())
elif args[:2] in (["issue", "create"], ["issue", "comment"]):
    open(state + "/body.md", "w").write(open(args[args.index("--body-file") + 1]).read())
'''
LOG_FAILED = (
    "node\tpnpm test\t2026-10-22T01:02:03.4567890Z  FAIL  src/sign.test.ts > 署名鍵を並行に作る\n"
    "node\tpnpm test\t2026-10-22T01:02:03.4567890Z AssertionError: expected 1 to be +0\n"
    "node\tpnpm test\t2026-10-22T01:02:03.4567890Z  ✓ ほかのテスト\n"
    "test (ubuntu-latest)\tRun bash tests/run-tests.sh\t2026-10-22T01:02:04.0000000Z FAIL ```spaced job```\n"
)


class Fixture:
    def __init__(self, **run):
        self.dir = Path(tempfile.mkdtemp(dir=WORK))
        self.bin = self.dir / "bin"
        self.bin.mkdir()
        (self.bin / "gh").write_text(FAKE_GH)
        (self.bin / "gh").chmod(0o755)
        self.run_data = {
            "name": "node-checks", "workflowName": "node-checks", "conclusion": "failure", "headBranch": "main",
            "headSha": "a" * 40, "event": "push", "url": "https://example/runs/9",
            "jobs": [
                {"databaseId": 11, "name": "node", "conclusion": "success", "url": "https://example/jobs/11", "steps": []},
                {"databaseId": 12, "name": "node-windows", "conclusion": "failure", "url": "https://example/jobs/12",
                 "steps": [{"name": "pnpm test", "conclusion": "failure"}, {"name": "pnpm build", "conclusion": "skipped"}]},
            ],
        }
        self.run_data.update(run)
        self.issues = []

    def run(self, *extra):
        (self.dir / "run.json").write_text(json.dumps(self.run_data))
        (self.dir / "issues.json").write_text(json.dumps(self.issues))
        (self.dir / "log-failed.txt").write_text(LOG_FAILED)
        env = {**os.environ, "PATH": f"{self.bin}:{os.environ['PATH']}", "FAKE_DIR": str(self.dir)}
        done = subprocess.run(["bash", str(script_path), "9", "--repo", "o/r", *extra], env=env, text=True,
                              errors="replace", capture_output=True, check=False)
        self.done = done
        log = self.dir / "log"
        self.log = log.read_text().splitlines() if log.exists() else []
        return done

    def writes(self):
        return [line for line in self.log if line.startswith(("issue create", "issue comment"))]

    def body(self):
        return (self.dir / "body.md").read_text()


class ReportMainCiFailure(unittest.TestCase):
    def test_failed_main_push_creates_issue_with_job_and_test_names(self):
        fixture = Fixture()
        done = fixture.run()
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertEqual(len(fixture.writes()), 1)
        self.assertTrue(fixture.writes()[0].startswith("issue create --repo o/r --title ci(main): main の node-checks が失敗した"), fixture.writes())
        body = fixture.body()
        for needle in ("https://example/runs/9", "a" * 40, "node-windows", "pnpm test", "FAIL  src/sign.test.ts > 署名鍵を並行に作る", "AssertionError: expected 1 to be +0"):
            self.assertIn(needle, body)
        # 空白を含む job・step 名の接頭辞を落とし、ログの ``` で fence を閉じない
        self.assertIn("  FAIL spaced job\n", body)
        self.assertNotIn("Run bash tests/run-tests.sh\t", body)
        self.assertEqual(body.count("```"), 2, body)
        self.assertNotIn("ほかのテスト", body)
        self.assertNotIn("**node**", body, "成功した job は載せない")

    def test_existing_issue_of_same_workflow_gets_a_comment(self):
        fixture = Fixture()
        fixture.issues = [
            {"number": 40, "title": "ci(main): main の self-test が失敗した（自動起票）"},
            {"number": 41, "title": "ci(main): main の node-checks が失敗した（自動起票）"},
        ]
        fixture.run()
        self.assertEqual(fixture.writes(), ["issue comment 41 --repo o/r --body-file " + fixture.writes()[0].split("--body-file ")[1]])
        # 別の workflow の issue しか無ければ新しく作る
        fixture = Fixture()
        fixture.issues = [{"number": 40, "title": "ci(main): main の self-test が失敗した（自動起票）"}]
        fixture.run()
        self.assertTrue(fixture.writes()[0].startswith("issue create"), fixture.writes())

    def test_non_main_or_pull_request_runs_are_ignored(self):
        for change in ({"headBranch": "feat/1-x"}, {"event": "pull_request"}, {"conclusion": "success"}, {"conclusion": "cancelled"}):
            fixture = Fixture(**change)
            done = fixture.run()
            self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
            self.assertEqual(fixture.writes(), [], change)

    def test_dry_run_creates_nothing(self):
        fixture = Fixture()
        done = fixture.run("--dry-run")
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertEqual(fixture.writes(), [])
        self.assertIn("node-windows", done.stdout)

    def test_unobtainable_log_still_names_the_failed_job(self):
        fixture = Fixture()
        (fixture.dir / "log-failed.txt").write_text("")
        fixture.run()
        self.assertIn("node-windows", fixture.body())

    def test_bad_arguments(self):
        for arguments_ in ([], ["x"]):
            done = subprocess.run(["bash", str(script_path), *arguments_], capture_output=True, text=True, errors="replace")
            self.assertEqual(done.returncode, 2)

    def test_workflow_is_limited_to_main_push_of_own_repo(self):
        for needle in (
            "workflow_run:", "workflows: [node-checks, self-test]", "branches: [main]",
            "github.event.workflow_run.conclusion == 'failure'",
            "github.event.workflow_run.event == 'push'",
            "github.event.workflow_run.head_branch == 'main'",
            "github.event.workflow_run.head_repository.full_name == github.repository",
        ):
            self.assertIn(needle, workflow_text)
        self.assertNotIn("pull_request", workflow_text.split("\non:\n")[1].split("\npermissions:")[0])

    def test_workflow_permissions_are_minimal(self):
        block = workflow_text.split("permissions:\n")[1].split("\njobs:")[0]
        self.assertEqual(sorted(line.strip() for line in block.splitlines() if line.strip()), ["actions: read", "contents: read", "issues: write"])


if __name__ == "__main__":
    selected = unittest.TestSuite()
    if arguments.case:
        selected.addTest(ReportMainCiFailure(CASES[arguments.case]))
    else:
        selected.addTests(unittest.defaultTestLoader.loadTestsFromTestCase(ReportMainCiFailure))
    result = unittest.TextTestRunner(verbosity=0, stream=sys.stderr).run(selected)
    sys.exit(0 if result.wasSuccessful() else 1)
