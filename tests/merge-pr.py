#!/usr/bin/env python3
"""scripts/merge-pr.sh（#159）の test。gh は fake（本物の PR を merge しない）、origin はローカルの bare repo。

承認の写し・head・条件のどれかが欠ければ merge せず、揃えば fake の `gh pr merge` を --match-head-commit 付きで 1 回だけ呼び、
その前に判定表のコメントを残す。

--mutation は保護を 1 つ外した script をコピーして作り、対応する --case が red になることを示す。
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
SCRIPT = ROOT / "scripts/merge-pr.sh"

MUTATIONS = {
    "state": [('[[ "$STATE" == "OPEN" && "$DRAFT" == "false" ]]', "true")],
    "headmatch": [('[[ "$LIVE_HEAD" == "$HEAD_SHA" ]]', "true")],
    "base": [('elif [[ "$BASE" == "main" || "$BASE" == "$DEFAULT_BRANCH" ]]; then', 'elif true; then')],
    "basefailopen": [('DEFAULT_BRANCH="$(repo_field defaultBranch)"', 'DEFAULT_BRANCH="$(repo_field defaultBranch)"; DEFAULT_BRANCH="${DEFAULT_BRANCH:-main}"')],
    "mergeable": [('[[ "$MERGEABLE" == "MERGEABLE" && "$STATE_STATUS" == "CLEAN" ]]', "true")],
    "retryunknown": [('UNKNOWN_RETRIES="${MERGE_PR_UNKNOWN_RETRIES:-5}"', "UNKNOWN_RETRIES=0")],
    "mergetree": [(' \\\n   && git merge-tree --write-tree "refs/merge-pr/$PR_NUM/base" "refs/merge-pr/$PR_NUM/head" >/dev/null 2>&1; then', "; then")],
    "fetchhead": [(' \\\n   && [[ "$(git rev-parse "refs/merge-pr/$PR_NUM/head")" == "$HEAD_SHA" ]]', "")],
    "diffcheck": [('if [[ "$mt_ok" -eq 1 ]] && git diff --check', "if true || git diff --check")],
    "checkpr": [('bash "$ROOT/check-pr.sh" "$PR_NUM"', "true")],
    "threads": [('[[ "$unresolved" == "0" ]]', "true")],
    "review": [('if comment_has "review: head $HEAD_SHA blocking=なし"; then', "if true; then")],
    "selftest": [('if comment_has "self-test: head $HEAD_SHA bash=PASS /bin/bash=PASS"; then', "if true; then")],
    "judge": [('if [[ -n "$value" ]]; then row root 申告', "if true; then row root 申告")],
    "approval": [('if [[ -n "$approval" ]]; then row script PASS "merge の承認', 'if true; then row script PASS "merge の承認')],
    "preapproval": [("if printf '%s\\n' \"$section\" | grep -qE '^- 条件:'; then", "if true; then")],
    "perceptual": [('if [[ "$perceptual" == なし* ]]; then', "if true; then")],
    "heading": [('inside = line.strip() == "## merge の事前承認"', "inside = True")],
    "owner": [('if not owner or ((comment.get("author") or {}).get("login") or "").lower() != owner:', "if False:")],
    "ownerempty": [('if not owner or ((comment.get("author")', 'if owner and ((comment.get("author")')],
    "fullmatch": [("pattern.fullmatch(line.strip())", "pattern.search(line.strip())")],
    "preblocked": [('elif [[ -n "$pre_blocked" ]]; then', "elif false; then")],
    "preunconditional": [('elif [[ -n "$pre_blocked" ]]; then', "fi; if [[ -n \"$pre_blocked\" ]]; then")],
    "quote": [("not need_quote or any(re.match", "True or any(re.match")],
    "cphead": [('comment_has "merge 承認: head $HEAD_SHA" quote', 'comment_has "merge 承認: head [0-9a-f]{40}" quote')],
    "dryrun": [('if [[ "$DRY_RUN" -eq 1 ]]; then echo', 'if false; then echo')],
    "approvalhint": [('  if comment_has "merge 承認: head $HEAD_SHA.+"; then', '  if false; then')],
    "failstop": [('if [[ "$FAILS" -gt 0 ]]; then exit 1; fi', "if false; then exit 1; fi")],
    "matchhead": [('--squash --match-head-commit "$HEAD_SHA"', "--squash")],
    "waitci": [('if [[ "$WAIT_CI" -eq 0 ]]; then echo', 'if false; then echo')],
    "cired": [('docs/process/failure-patterns.md）" >&2; exit 1;;', 'docs/process/failure-patterns.md）" >&2;;')],
    "cipending": [('if [[ "$ci_verdict" != "pending" ]] || [[ "$SECONDS" -ge "$ci_deadline" ]]; then break; fi', 'if true; then break; fi')],
    "cicommit": [('--commit "$merge_sha"', '--commit "$LIVE_HEAD"')],
    "cibase": [('elif [[ -n "$ci_base" ]]; then', 'elif false; then')],
    "cibasefailopen": [('if [[ -n "$ci_base" && "$ci_base" == "$CUR_BASE" ]]; then', 'if [[ "$ci_base" == "$CUR_BASE" || -z "$ci_base" ]]; then')],
    "cibasehead": [('Merge $HEAD_SHA into ([0-9a-f]{40})', 'Merge [0-9a-f]{40} into ([0-9a-f]{40})')],
    "rerunfail": [('row script FAIL "head の CI に再実行で通した run が無い、または揺れとして理由がある" "再実行で通した', 'row script PASS "head の CI に再実行で通した run が無い、または揺れとして理由がある" "再実行で通した')],
    "rerunattempt": [('r["attempt"] >= 2', 'r["attempt"] >= 3')],
    "rerunfailclosed": [('row script FAIL "head の CI に再実行で通した run が無い、または揺れとして理由がある" "head の CI の run を取得できない"', 'row script PASS "head の CI に再実行で通した run が無い、または揺れとして理由がある" "head の CI の run を取得できない"')],
    "comment": [('gh pr comment "$PR_NUM" ${REPO_ARGS[@]+"${REPO_ARGS[@]}"} --body-file "$body_file"', "true")],
}
CASES = {
    "state": "test_closed_or_draft_pr_is_not_merged",
    "headmatch": "test_head_mismatch_is_not_merged",
    "base": "test_non_default_base_is_not_merged",
    "basefailopen": "test_unobtainable_default_branch_is_not_merged",
    "mergeable": "test_unmergeable_is_not_merged",
    "retryunknown": "test_unknown_mergeable_is_reread_until_settled",
    "mergetree": "test_merge_tree_conflict_is_not_merged",
    "fetchhead": "test_pull_ref_behind_live_head_is_not_merged",
    "diffcheck": "test_whitespace_error_is_not_merged",
    "checkpr": "test_check_pr_failure_is_not_merged",
    "threads": "test_unresolved_threads_are_not_merged",
    "review": "test_missing_or_stale_review_record_is_not_merged",
    "selftest": "test_missing_or_stale_selftest_record_is_not_merged",
    "judge": "test_missing_judge_is_not_merged",
    "approval": "test_no_approval_is_not_merged",
    "preapproval": "test_no_approval_is_not_merged",
    "perceptual": "test_pre_approval_needs_no_perceptual_external",
    "heading": "test_other_issue_section_is_not_pre_approval",
    "owner": "test_records_from_non_owner_are_not_counted",
    "ownerempty": "test_unobtainable_owner_is_not_merged",
    "fullmatch": "test_record_lines_must_match_exactly",
    "preblocked": "test_pre_approval_needs_no_perceptual_external",
    "preunconditional": "test_checkpoint_approval_skips_perceptual_judge",
    "quote": "test_checkpoint_approval_needs_quote_and_head",
    "cphead": "test_checkpoint_approval_needs_quote_and_head",
    "dryrun": "test_dry_run_changes_nothing",
    "approvalhint": "test_approval_fail_shows_expected_format",
    "failstop": "test_no_approval_is_not_merged",
    "matchhead": "test_approved_pr_is_merged_once_after_comment",
    "cibase": "test_ci_on_stale_base_is_not_merged",
    "cibasefailopen": "test_ci_base_is_matched_and_unobtainable_fails_closed",
    "cibasehead": "test_ci_base_is_matched_and_unobtainable_fails_closed",
    "comment": "test_approved_pr_is_merged_once_after_comment",
    "waitci": "test_no_wait_skips_ci",
    "cired": "test_red_main_ci_fails_after_merge",
    "cipending": "test_pending_ci_is_waited_for_then_reported",
    "cicommit": "test_ci_is_looked_up_by_merge_commit",
    "rerunfail": "test_rerun_success_is_not_merged_without_reason",
    "rerunattempt": "test_rerun_success_is_not_merged_without_reason",
    "rerunfailclosed": "test_unobtainable_head_runs_are_not_merged",
}
parser = argparse.ArgumentParser()
parser.add_argument("--mutation", choices=sorted(MUTATIONS))
parser.add_argument("--case", choices=sorted(CASES))
arguments = parser.parse_args()

WORK = Path(tempfile.mkdtemp(prefix="merge-pr-"))
shutil.copytree(ROOT / "scripts", WORK / "scripts", ignore=shutil.ignore_patterns("__pycache__"))
text = SCRIPT.read_text()
if arguments.mutation:
    for needle, replacement in MUTATIONS[arguments.mutation]:
        if text.count(needle) != 1:
            print("regression injection target changed: %r" % needle[:60], file=sys.stderr)
            sys.exit(3)
        text = text.replace(needle, replacement)
(WORK / "scripts/merge-pr.sh").write_text(text)

FAKE_GH = r'''#!/usr/bin/env python3
import json, os, sys
state = os.environ["FAKE_DIR"]
args = sys.argv[1:]
with open(state + "/log", "a") as log:
    log.write(" ".join(args) + "\n")
def load(name):
    with open(state + "/" + name) as handle:
        return json.load(handle)
if args[:2] == ["pr", "view"]:
    pr = load("pr.json")
    if "mergeable" in args[args.index("--json") + 1] and os.path.exists(state + "/unknown-count"):
        remaining = int(open(state + "/unknown-count").read())
        if remaining > 0:
            open(state + "/unknown-count", "w").write(str(remaining - 1))
            pr = {**pr, "mergeable": "UNKNOWN", "mergeStateStatus": "UNKNOWN"}
    fields = args[args.index("--json") + 1].split(",")
    if "--jq" in args:
        value = pr
        for key in args[args.index("--jq") + 1].lstrip(".").split("."):
            value = value[key]
        print(value)
    else:
        print(json.dumps({field: pr[field] for field in fields}))
elif args[:2] == ["run", "list"] and "pull_request" in args:
    if os.path.exists(state + "/no-pr-run"):
        print("")
    else:
        print(1234)
elif args[:2] == ["run", "view"]:
    if os.path.exists(state + "/no-pr-log"):
        sys.exit(1)
    print("node\tRun actions/checkout\t2026-10-22T00:00:00Z HEAD is now at 41b1f5c " + open(state + "/ci-merge-line").read())
elif args[:2] == ["run", "list"]:
    commit = args[args.index("--commit") + 1]
    if commit == load("pr.json")["headRefOid"]:
        if os.path.exists(state + "/head-runs-fail"):
            sys.exit(1)
        print(json.dumps(load("head-runs.json")))
        sys.exit(0)
    runs = load("runs.json")
    pending = os.path.exists(state + "/ci-pending-count")
    if pending:
        remaining = int(open(state + "/ci-pending-count").read())
        if remaining > 0:
            open(state + "/ci-pending-count", "w").write(str(remaining - 1))
            runs = [{**run, "status": "in_progress", "conclusion": ""} for run in runs]
    print(json.dumps(runs if commit == load("pr.json")["mergeCommit"]["oid"] else []))
elif args[:2] == ["issue", "view"]:
    print(json.dumps({"body": load("issue-%s.json" % args[2])["body"]}))
elif args[:2] == ["repo", "view"]:
    if os.path.exists(state + "/repo-fail"):
        sys.exit(1)
    if os.path.exists(state + "/repo-garbage"):
        print("これは JSON ではない")
        sys.exit(0)
    branch = open(state + "/default-branch").read() if os.path.exists(state + "/default-branch") else "main"
    if os.path.exists(state + "/no-default-branch"):
        print(json.dumps({"nameWithOwner": "o/r", "defaultBranchRef": None}))
    else:
        print(json.dumps({"nameWithOwner": "o/r", "defaultBranchRef": {"name": branch}}))
elif args[:2] == ["api", "graphql"]:
    if os.path.exists(state + "/threads-fail"):
        sys.exit(1)
    print(json.dumps(load("threads.json")))
elif args[:1] == ["api"]:
    print("issue")
elif args[:2] == ["pr", "comment"]:
    with open(state + "/comment.md", "w") as out:
        out.write(open(args[args.index("--body-file") + 1]).read())
'''


def git(cwd, *command):
    subprocess.run(["git", *command], cwd=cwd, check=True, capture_output=True,
                   env={**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@e", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@e"})


def rev(cwd, ref):
    return subprocess.run(["git", "rev-parse", ref], cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


class Fixture:
    """origin（bare）・clone・fake gh の状態 dir。conflict=True なら head が main と衝突する。"""

    def __init__(self, conflict=False, trailing_space=False):
        self.dir = Path(tempfile.mkdtemp(dir=WORK))
        origin, self.clone, self.state, bin_dir = (self.dir / name for name in ("origin.git", "clone", "state", "bin"))
        for path in (self.state, bin_dir):
            path.mkdir()
        git(self.dir, "init", "-q", "--bare", "-b", "main", str(origin))
        git(self.dir, "clone", "-q", str(origin), str(self.clone))
        git(self.clone, "checkout", "-q", "-b", "main")
        (self.clone / "a.txt").write_text("base\n")
        git(self.clone, "add", "."); git(self.clone, "commit", "-q", "-m", "base"); git(self.clone, "push", "-q", "origin", "main")
        git(self.clone, "checkout", "-q", "-b", "feat")
        (self.clone / ("a.txt" if conflict else "b.txt")).write_text("feature \n" if trailing_space else "feature\n")
        git(self.clone, "add", "."); git(self.clone, "commit", "-q", "-m", "feat")
        self.head = rev(self.clone, "HEAD")
        git(self.clone, "push", "-q", "origin", "feat:refs/pull/7/head")
        git(self.clone, "checkout", "-q", "main")
        if conflict:
            (self.clone / "a.txt").write_text("main side\n")
            git(self.clone, "commit", "-q", "-am", "main side"); git(self.clone, "push", "-q", "origin", "main")
        self.base = rev(self.clone, "main")
        (bin_dir / "gh").write_text(FAKE_GH)
        (bin_dir / "gh").chmod(0o755)
        self.bin = bin_dir
        self.pr = {
            "number": 7, "state": "OPEN", "isDraft": False, "title": "feat(x): テスト", "body": "Closes #5\n",
            "headRefOid": self.head, "baseRefName": "main", "baseRefOid": self.base, "mergeable": "MERGEABLE",
            "mergeStateStatus": "CLEAN", "mergeCommit": {"oid": "d" * 40},
            "comments": [self.comment(f"review: head {self.head} blocking=なし"), self.comment(f"self-test: head {self.head} bash=PASS /bin/bash=PASS")],
        }
        self.issue = "## Problem\nx\n\n## merge の事前承認\n\n- 2026-10-16 ユーザーが「事前承認」を選んだ\n- 条件: 別 context の独立レビュー / 退行注入\n- 条件から外れたら merge しない\n\n## Risks\nx\n"
        self.threads = {"data": {"repository": {"pullRequest": {"reviewThreads": {"pageInfo": {"hasNextPage": False}, "nodes": [{"isResolved": True}]}}}}}
        self.ci_base = self.base
        self.ci_head = None
        self.runs = [{"workflowName": name, "status": "completed", "conclusion": "success", "url": f"https://example/{name}"} for name in ("node-checks", "self-test")]
        self.head_runs = [{"workflowName": name, "attempt": 1, "conclusion": "success", "databaseId": 100 + index} for index, name in enumerate(("node-checks", "self-test"))]
        self.judges = ["scope=範囲内", "injection=対象外（docs のみ）", "no-perceptual-external=なし"]

    @staticmethod
    def comment(body, author="o"):
        return {"author": {"login": author}, "body": body, "createdAt": "2026-10-16T00:00:00Z"}

    def run(self, head=None, extra=(), pr_number="7", judges=None):
        (self.state / "pr.json").write_text(json.dumps(self.pr))
        (self.state / "issue-5.json").write_text(json.dumps({"body": self.issue}))
        (self.state / "threads.json").write_text(json.dumps(self.threads))
        (self.state / "runs.json").write_text(json.dumps(self.runs))
        (self.state / "ci-merge-line").write_text(f"Merge {self.ci_head or self.head} into {self.ci_base}\n")
        (self.state / "head-runs.json").write_text(json.dumps(self.head_runs))
        command = ["bash", str(WORK / "scripts/merge-pr.sh"), pr_number, "--head", head or self.head, *extra]
        for judge in (self.judges if judges is None else judges):
            command += ["--judge", judge]
        env = {**os.environ, "PATH": f"{self.bin}:{os.environ['PATH']}", "FAKE_DIR": str(self.state), "PROJECT_TEMPLATE_ALLOW_TMP_WORKTREE": "1", "MERGE_PR_UNKNOWN_WAIT": "0", "MERGE_PR_CI_INTERVAL": "0"}
        done = subprocess.run(command, cwd=self.clone, env=env, text=True, errors="replace", capture_output=True, check=False)
        log = (self.state / "log").read_text().splitlines() if (self.state / "log").exists() else []
        self.done, self.log = done, log
        return done

    def merges(self):
        return [line for line in self.log if line.startswith("pr merge")]

    def comments(self):
        return [line for line in self.log if line.startswith("pr comment")]


class MergePr(unittest.TestCase):
    def assert_not_merged(self, fixture, code=1, comment=False):
        self.assertEqual(fixture.done.returncode, code, fixture.done.stdout + fixture.done.stderr)
        self.assertEqual(fixture.merges(), [], "merge してはいけない")
        if not comment:
            self.assertEqual(fixture.comments(), [], "失敗した判定表はコメントしない")

    def test_approved_pr_is_merged_once_after_comment(self):
        fixture = Fixture()
        done = fixture.run()
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertEqual(fixture.merges(), [f"pr merge 7 --squash --match-head-commit {fixture.head}"])
        self.assertEqual(len(fixture.comments()), 1)
        self.assertLess(fixture.log.index(fixture.comments()[0]), fixture.log.index(fixture.merges()[0]), "判定表のコメントが先")
        table = (fixture.state / "comment.md").read_text()
        for needle in ("## merge 判定", fixture.head, "| 条件 | 確認者 | 結果 | 詳細 |", "事前承認（issue #5", "root | 申告", "merge する"):
            self.assertIn(needle, table)
        self.assertNotIn("FAIL", table)

    def test_green_main_ci_is_reported_after_merge(self):
        fixture = Fixture()
        done = fixture.run()
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertIn("main の CI は成功", done.stdout)
        self.assertIn("node-checks: success", done.stdout)
        self.assertIn("self-test: success", done.stdout)

    def test_no_wait_skips_ci(self):
        fixture = Fixture()
        done = fixture.run(extra=["--no-wait"])
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertEqual(len(fixture.merges()), 1)
        self.assertEqual([line for line in fixture.log if line.startswith("run list") and "--event push" in line], [])
        self.assertIn("--no-wait", done.stdout)

    def test_red_main_ci_fails_after_merge(self):
        fixture = Fixture()
        fixture.runs[1]["conclusion"] = "failure"
        done = fixture.run()
        self.assertEqual(len(fixture.merges()), 1, "merge は済んでいる")
        self.assertEqual(done.returncode, 1, done.stdout + done.stderr)
        self.assertIn("self-test: failure", done.stdout)
        self.assertIn("main の CI が failure", done.stderr)

    def test_red_is_reported_without_waiting_for_the_other_run(self):
        fixture = Fixture()
        fixture.runs = [fixture.runs[0]]  # self-test の実行がまだ無い
        fixture.runs[0]["conclusion"] = "failure"
        done = fixture.run(extra=["--ci-timeout", "60"])
        self.assertEqual(done.returncode, 1, done.stdout + done.stderr)
        self.assertIn("self-test: 実行待ち", done.stdout)

    def test_pending_ci_is_waited_for_then_reported(self):
        # 2 回は実行中、3 回目に success になる
        fixture = Fixture()
        (fixture.state / "ci-pending-count").write_text("2")
        done = fixture.run()
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertIn("main の CI は成功", done.stdout)
        self.assertEqual(len([line for line in fixture.log if line.startswith("run list") and "--event push" in line]), 3)
        # 上限（0 秒）で終わらなければ、未確認と表示して exit 0
        fixture = Fixture()
        (fixture.state / "ci-pending-count").write_text("99")
        done = fixture.run(extra=["--ci-timeout", "0"])
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertIn("未確認", done.stdout)
        self.assertNotIn("main の CI は成功", done.stdout)

    def test_ci_is_looked_up_by_merge_commit(self):
        fixture = Fixture()
        fixture.run(extra=["--ci-timeout", "0"])
        self.assertTrue(any(line.startswith("run list") and f"--commit {'d' * 40}" in line for line in fixture.log), fixture.log)

    def test_repo_option_is_passed_to_gh(self):
        fixture = Fixture()
        fixture.run(extra=["--repo", "o/r"])
        self.assertEqual(fixture.done.returncode, 0, fixture.done.stdout + fixture.done.stderr)
        self.assertEqual(fixture.merges(), [f"pr merge 7 --repo o/r --squash --match-head-commit {fixture.head}"])

    def test_ci_on_stale_base_is_not_merged(self):
        # PR の CI が検査した base と今の origin/main が違えば、再検査の方法つきで FAIL
        fixture = Fixture()
        fixture.ci_base = "e" * 40
        fixture.run()
        self.assert_not_merged(fixture)
        self.assertIn("PR の CI が今の base を検査している", fixture.done.stdout)
        self.assertIn("e" * 40, fixture.done.stdout)
        self.assertIn("--allow-empty", fixture.done.stdout)

    def test_ci_base_is_matched_and_unobtainable_fails_closed(self):
        fixture = Fixture()
        fixture.run(extra=["--dry-run"])
        self.assertEqual(fixture.done.returncode, 0, fixture.done.stdout + fixture.done.stderr)
        self.assertIn("検査した base", fixture.done.stdout)
        for marker in ("no-pr-run", "no-pr-log"):
            fixture = Fixture()
            (fixture.state / marker).write_text("")
            fixture.run()
            self.assert_not_merged(fixture)
            self.assertIn("取得できない", fixture.done.stdout)
        # ログの head が提示した head と違う（別の head の run）なら読み取れず FAIL
        fixture = Fixture()
        fixture.ci_head = "f" * 40
        fixture.run()
        self.assert_not_merged(fixture)
        self.assertIn("取得できない", fixture.done.stdout)

    def test_no_approval_is_not_merged(self):
        fixture = Fixture()
        fixture.issue = "## Problem\nx\n"
        fixture.run()
        self.assert_not_merged(fixture)
        self.assertIn("merge の承認の写しが記録されている", fixture.done.stdout)
        self.assertIn("FAIL", fixture.done.stdout)

    def test_approval_fail_shows_expected_format(self):
        # 括弧書き付きの承認の行は FAIL のまま、期待する書式と「余計な文字」の旨を出す
        fixture = Fixture()
        fixture.issue = "## Problem\nx\n"
        fixture.pr["comments"].append(fixture.comment(f"merge 承認: head {fixture.head}（区切りでの承認）\n> OK"))
        fixture.run()
        self.assert_not_merged(fixture)
        self.assertIn(f"期待する書式: owner のコメントの 1 行ぜんたいが `merge 承認: head {fixture.head}`", fixture.done.stdout)
        self.assertIn("行の後ろに余計な文字がある", fixture.done.stdout)
        # 記録がまったく無いときは書式だけを示し、余計な文字の旨は出さない
        fixture = Fixture()
        fixture.issue = "## Problem\nx\n"
        fixture.run()
        self.assertIn("期待する書式", fixture.done.stdout)
        self.assertNotIn("余計な文字", fixture.done.stdout)
        # 行は正しいが引用が無いときは、その旨を示す
        fixture = Fixture()
        fixture.issue = "## Problem\nx\n"
        fixture.pr["comments"].append(fixture.comment(f"merge 承認: head {fixture.head}"))
        fixture.run()
        self.assertIn("引用行が無い", fixture.done.stdout)

    def test_other_issue_section_is_not_pre_approval(self):
        # 「merge の承認」節（事前承認の対象外とする記述）は事前承認でない
        fixture = Fixture()
        fixture.issue = "## merge の承認\n\n- 本 issue の PR は事前承認の対象外とし、区切りで確認する\n- 条件: 区切りで見る\n"
        fixture.run()
        self.assert_not_merged(fixture)

    def test_checkpoint_approval_merges_without_pre_approval(self):
        fixture = Fixture()
        fixture.issue = "## Problem\nx\n"
        fixture.pr["comments"].append(fixture.comment(f"区切りの承認\n\nmerge 承認: head {fixture.head}\n> OK、merge していい"))
        fixture.run(judges=["scope=範囲内", "injection=対象外"])
        self.assertEqual(fixture.done.returncode, 0, fixture.done.stdout + fixture.done.stderr)
        self.assertEqual(len(fixture.merges()), 1)
        self.assertIn("区切りでの承認", fixture.done.stdout)

    def test_checkpoint_approval_needs_quote_and_head(self):
        for body in (f"merge 承認: head {'0' * 40}\n> OK", f"merge 承認: head {'a' * 40}\n> OK"):
            fixture = Fixture()
            fixture.issue = "## Problem\nx\n"
            fixture.pr["comments"].append(fixture.comment(body))
            fixture.run()
            self.assert_not_merged(fixture)
        fixture = Fixture()
        fixture.issue = "## Problem\nx\n"
        fixture.pr["comments"].append(fixture.comment(f"merge 承認: head {fixture.head}"))
        fixture.run()
        self.assert_not_merged(fixture)

    def test_checkpoint_approval_skips_perceptual_judge(self):
        # 事前承認の節がある issue でも、区切りの承認があれば no-perceptual-external は求めない（知覚の成果物の PR を区切りで承認できる）
        fixture = Fixture()
        fixture.pr["comments"].append(fixture.comment(f"merge 承認: head {fixture.head}\n> 見た。merge していい"))
        fixture.run(judges=["scope=範囲内", "injection=対象外", "no-perceptual-external=あり（PDF）"])
        self.assertEqual(fixture.done.returncode, 0, fixture.done.stdout + fixture.done.stderr)
        self.assertEqual(len(fixture.merges()), 1)
        self.assertNotIn("FAIL", fixture.done.stdout)

    def test_records_from_non_owner_are_not_counted(self):
        for kind in ("review", "self-test", "approval"):
            fixture = Fixture()
            fixture.issue = "## Problem\nx\n"
            records = {
                "review": f"review: head {fixture.head} blocking=なし",
                "self-test": f"self-test: head {fixture.head} bash=PASS /bin/bash=PASS",
                "approval": f"merge 承認: head {fixture.head}\n> OK",
            }
            fixture.pr["comments"] = [fixture.comment(body) for key, body in records.items() if key != kind]
            fixture.pr["comments"].append(fixture.comment(records[kind], author="mallory"))
            fixture.run()
            self.assert_not_merged(fixture)
        # owner の大文字小文字は区別しない
        fixture = Fixture()
        fixture.pr["comments"] = [dict(comment, author={"login": "O"}) for comment in fixture.pr["comments"]]
        fixture.run()
        self.assertEqual(fixture.done.returncode, 0, fixture.done.stdout + fixture.done.stderr)

    def test_unobtainable_owner_is_not_merged(self):
        # owner が取れない（gh の失敗・JSON でない出力）ときは、どの記録も数えず、FAIL の行を出して merge しない
        for marker in ("repo-fail", "repo-garbage"):
            fixture = Fixture()
            (fixture.state / marker).write_text("")
            fixture.run()
            self.assert_not_merged(fixture)
            self.assertIn("FAIL", fixture.done.stdout)
            self.assertIn("別 context の独立レビューが head に対して blocking なし | script | FAIL", fixture.done.stdout)

    def test_record_lines_must_match_exactly(self):
        for kind, text in (
            ("review", "review: head {head} blocking=なし"),
            ("self-test", "self-test: head {head} bash=PASS /bin/bash=PASS"),
        ):
            for variant in ("{line} だと思う", "> {line}", "確認: {line}", "{line}\u3000と、後ろに文が続く"):
                fixture = Fixture()
                line = text.format(head=fixture.head)
                fixture.pr["comments"] = [c for c in fixture.pr["comments"] if not c["body"].startswith(kind + ":")]
                fixture.pr["comments"].append(fixture.comment(variant.format(line=line)))
                fixture.run()
                self.assert_not_merged(fixture)
        # 区切りの承認の行も同じ
        for variant in ("{line} OK", "確認 {line}"):
            fixture = Fixture()
            fixture.issue = "## Problem\nx\n"
            fixture.pr["comments"].append(fixture.comment(variant.format(line=f"merge 承認: head {fixture.head}") + "\n> OK"))
            fixture.run()
            self.assert_not_merged(fixture)

    def test_pre_approval_needs_no_perceptual_external(self):
        for judges in (["scope=a", "injection=b"], ["scope=a", "injection=b", "no-perceptual-external=あり（PDF）"]):
            fixture = Fixture()
            fixture.run(judges=judges)
            self.assert_not_merged(fixture)
            self.assertIn("事前承認は知覚の成果物・外部影響を含まない PR に使えない", fixture.done.stdout)

    def test_head_mismatch_is_not_merged(self):
        fixture = Fixture()
        fixture.run(head="b" * 40)
        self.assert_not_merged(fixture)
        # 承認・記録が古い head に結ばれたまま、head が進んだ場合
        fixture = Fixture()
        fixture.pr["headRefOid"] = "c" * 40
        fixture.run()
        self.assert_not_merged(fixture)

    def test_pull_ref_behind_live_head_is_not_merged(self):
        fixture = Fixture()
        fixture.pr["headRefOid"] = fixture.head  # gh の head は一致しているが、取り直した pull ref が古い
        git(fixture.clone, "checkout", "-q", "-b", "other")
        (fixture.clone / "c.txt").write_text("x\n")
        git(fixture.clone, "add", "."); git(fixture.clone, "commit", "-q", "-m", "c")
        git(fixture.clone, "push", "-q", "-f", "origin", "other:refs/pull/7/head")
        fixture.run()
        self.assert_not_merged(fixture)

    def test_closed_or_draft_pr_is_not_merged(self):
        for change in ({"state": "MERGED"}, {"state": "CLOSED"}, {"isDraft": True}):
            fixture = Fixture()
            fixture.pr.update(change)
            fixture.run()
            self.assert_not_merged(fixture)

    def test_non_default_base_is_not_merged(self):
        fixture = Fixture()
        fixture.pr["baseRefName"] = "feat/parent"
        git(fixture.clone, "push", "-q", "origin", "main:refs/heads/feat/parent")  # base の取得・merge-tree 自体は通る状態にする
        fixture.run()
        self.assert_not_merged(fixture)
        self.assertIn("base が main か既定 branch | script | FAIL", fixture.done.stdout)

    def test_base_follows_the_repo_default_branch(self):
        # 既定 branch が development の repo: development 向けも main 向けも merge でき、別の branch 向けは merge しない
        for base, merged in (("development", True), ("main", True), ("feat/parent", False)):
            fixture = Fixture()
            (fixture.state / "default-branch").write_text("development")
            git(fixture.clone, "push", "-q", "origin", "main:refs/heads/development", "main:refs/heads/feat/parent")
            fixture.pr["baseRefName"] = base
            fixture.run()
            if merged:
                self.assertEqual(fixture.done.returncode, 0, base + fixture.done.stdout + fixture.done.stderr)
                self.assertEqual(len(fixture.merges()), 1)
            else:
                self.assert_not_merged(fixture)
                self.assertIn("base が main か既定 branch | script | FAIL", fixture.done.stdout)

    def test_unobtainable_default_branch_is_not_merged(self):
        # 既定 branch が取れない（gh の失敗・JSON でない出力・defaultBranchRef が null）ときは通る側に倒さない
        for marker in ("repo-fail", "repo-garbage", "no-default-branch"):
            fixture = Fixture()
            (fixture.state / marker).write_text("")
            fixture.run()
            self.assert_not_merged(fixture)
            self.assertIn("base が main か既定 branch | script | FAIL", fixture.done.stdout)

    def test_unmergeable_is_not_merged(self):
        for change in ({"mergeable": "CONFLICTING"}, {"mergeable": "UNKNOWN"}, {"mergeStateStatus": "BLOCKED"}, {"mergeStateStatus": "BEHIND"}):
            fixture = Fixture()
            fixture.pr.update(change)
            fixture.run()
            self.assert_not_merged(fixture)

    def views(self, fixture):
        return [line for line in fixture.log if line.startswith("pr view") and "mergeable" in line]

    def test_unknown_mergeable_is_reread_until_settled(self):
        fixture = Fixture()
        (fixture.state / "unknown-count").write_text("1")
        fixture.run()
        self.assertEqual(fixture.done.returncode, 0, fixture.done.stdout + fixture.done.stderr)
        self.assertEqual(len(fixture.merges()), 1)
        self.assertEqual(len(self.views(fixture)), 2, "UNKNOWN の 1 回目の後に 1 回読み直す")

    def test_unknown_forever_is_not_merged_and_says_computing(self):
        fixture = Fixture()
        (fixture.state / "unknown-count").write_text("99")
        fixture.run()
        self.assert_not_merged(fixture)
        self.assertEqual(len(self.views(fixture)), 6, "最初の 1 回 + 読み直し 5 回")
        self.assertIn("GitHub が計算中", fixture.done.stdout + fixture.done.stderr)

    def test_settled_mergeable_is_not_reread(self):
        fixture = Fixture()
        fixture.run()
        self.assertEqual(len(self.views(fixture)), 1)

    def test_merge_tree_conflict_is_not_merged(self):
        fixture = Fixture(conflict=True)
        fixture.run()
        self.assert_not_merged(fixture)
        self.assertIn("merge-tree に衝突が無い", fixture.done.stdout)

    def test_whitespace_error_is_not_merged(self):
        fixture = Fixture(trailing_space=True)
        fixture.run()
        self.assert_not_merged(fixture)
        self.assertIn("git diff --check", fixture.done.stdout)

    def test_check_pr_failure_is_not_merged(self):
        fixture = Fixture()
        fixture.pr["title"] = "タイトルが規約に合わない"
        fixture.run()
        self.assert_not_merged(fixture)

    def test_unresolved_threads_are_not_merged(self):
        fixture = Fixture()
        fixture.threads["data"]["repository"]["pullRequest"]["reviewThreads"]["nodes"].append({"isResolved": False})
        fixture.run()
        self.assert_not_merged(fixture)
        fixture = Fixture()
        fixture.threads["data"]["repository"]["pullRequest"]["reviewThreads"]["pageInfo"]["hasNextPage"] = True
        fixture.run()
        self.assert_not_merged(fixture)
        fixture = Fixture()
        (fixture.state / "threads-fail").write_text("")
        fixture.run()
        self.assert_not_merged(fixture)

    def test_missing_or_stale_review_record_is_not_merged(self):
        for body in (None, f"review: head {'d' * 40} blocking=なし", f"review: head {{head}} blocking=あり"):
            fixture = Fixture()
            fixture.pr["comments"] = [c for c in fixture.pr["comments"] if not c["body"].startswith("review:")]
            if body:
                fixture.pr["comments"].append(fixture.comment(body.replace("{head}", fixture.head)))
            fixture.run()
            self.assert_not_merged(fixture)

    def test_missing_or_stale_selftest_record_is_not_merged(self):
        for body in (None, f"self-test: head {'d' * 40} bash=PASS /bin/bash=PASS", "self-test: head {head} bash=PASS /bin/bash=FAIL"):
            fixture = Fixture()
            fixture.pr["comments"] = [c for c in fixture.pr["comments"] if not c["body"].startswith("self-test:")]
            if body:
                fixture.pr["comments"].append(fixture.comment(body.replace("{head}", fixture.head)))
            fixture.run()
            self.assert_not_merged(fixture)

    def test_missing_judge_is_not_merged(self):
        for judges in (["injection=対象外", "no-perceptual-external=なし"], ["scope=範囲内", "no-perceptual-external=なし"],
                       ["scope=", "injection=x", "no-perceptual-external=なし"]):
            fixture = Fixture()
            fixture.run(judges=judges)
            self.assert_not_merged(fixture)

    def test_rerun_success_is_not_merged_without_reason(self):
        for attempt in (2, 3):
            fixture = Fixture()
            fixture.head_runs[0]["attempt"] = attempt
            fixture.run()
            self.assert_not_merged(fixture)
            self.assertIn("node-checks(run 100, attempt %d)" % attempt, fixture.done.stdout)
        # 再実行でも失敗のままの run は CI の赤であってここでは数えない（attempt 1 の成功だけなら通る）
        fixture = Fixture()
        fixture.head_runs[0].update(attempt=2, conclusion="failure")
        fixture.run()
        self.assertEqual(fixture.done.returncode, 0, fixture.done.stdout + fixture.done.stderr)
        # 理由があれば通り、理由が判定表に写る。空の理由は無いのと同じ
        fixture = Fixture()
        fixture.head_runs[0]["attempt"] = 2
        fixture.run(judges=fixture.judges + ["rerun=#395 の揺れ"])
        self.assertEqual(fixture.done.returncode, 0, fixture.done.stdout + fixture.done.stderr)
        self.assertIn("#395 の揺れ", (fixture.state / "comment.md").read_text())
        self.assertEqual(len(fixture.merges()), 1)
        fixture = Fixture()
        fixture.head_runs[0]["attempt"] = 2
        fixture.run(judges=fixture.judges + ["rerun="])
        self.assert_not_merged(fixture)

    def test_unobtainable_head_runs_are_not_merged(self):
        fixture = Fixture()
        (fixture.state / "head-runs-fail").write_text("")
        fixture.run()
        self.assert_not_merged(fixture)
        self.assertIn("取得できない", fixture.done.stdout)

    def test_dry_run_changes_nothing(self):
        fixture = Fixture()
        fixture.run(extra=["--dry-run"])
        self.assertEqual(fixture.done.returncode, 0)
        self.assertEqual((fixture.merges(), fixture.comments()), ([], []))
        self.assertIn("merge する", fixture.done.stdout)

    def test_arguments_are_validated(self):
        fixture = Fixture()
        fixture.run(pr_number="abc")
        self.assert_not_merged(fixture, code=2)
        fixture.run(head="short")
        self.assert_not_merged(fixture, code=2)


if __name__ == "__main__":
    selected = unittest.TestSuite()
    if arguments.case:
        selected.addTest(MergePr(CASES[arguments.case]))
    else:
        selected.addTests(unittest.defaultTestLoader.loadTestsFromTestCase(MergePr))
    result = unittest.TextTestRunner(verbosity=0, stream=sys.stderr).run(selected)
    sys.exit(0 if result.wasSuccessful() else 1)
