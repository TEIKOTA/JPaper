#!/usr/bin/env python3
"""guard-bash.py の merge 拒否（#159）の test。

script（scripts/merge-pr.sh）を通らない merge（gh pr merge・gh api の merge endpoint・GraphQL の merge）は deny、
merge しない形（gh pr view / list / comment・gh pr merge --help・scripts/merge-pr.sh・GET）は deny にならない。

--mutation は保護を 1 つ外した guard をコピーして作り、対応する --case が red になることを示す。
実装ファイルは変更しない。注入先が 1 か所に決まらなければ exit 3（保護の喪失の red = exit 1 と区別する）。
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
GUARD = ROOT / "scripts/hooks/guard-bash.py"

MUTATIONS = {
    "prmerge": [('if words[:2] == ["pr", "merge"]:', "if False:")],
    "apimerge": [("if any(GH_API_MERGE_RE.search(word) for word in words[1:]) and", "if False and")],
    "apiget": [('and (method or "").upper() != "GET":', ":")],
    "graphql": [('if any(GH_GRAPHQL_PATH_RE.search(word) for word in words[1:]) and', "if False and")],
    "graphqlpos": [('if any(GH_GRAPHQL_PATH_RE.search(word) for word in words[1:]) and', 'if words[1:2] == ["graphql"] and')],
    "graphqlpath": [('(?:^|/)graphql/?(?:[?#].*)?$', '^graphql$')],
    "apiquery": [('(?:^|/)pulls/[^/?#]+/merge/?(?:[?#].*)?$', '(?:^|/)pulls/[^/]+/merge/?$')],
    "xargs": [('if command_name(tokens) in ("xargs", "find"):', "if False:")],
    "helpvalue": [("and tokens[-2] not in GH_MERGE_VALUE_OPTIONS:", ":")],
    "repoopt": [('GH_VALUE_OPTIONS = {"-R", "--repo", "--hostname"}', "GH_VALUE_OPTIONS = set()")],
    "wired": [("            reason = merge_reason(tokens) if tokens else None\n", "            reason = None\n")],
    "scriptcheck": [('if os.path.isfile(os.path.join(current, "scripts", "merge-pr.sh")):', "if True:")],
    "scriptonly": [('if os.path.isfile(os.path.join(current, "scripts", "merge-pr.sh")):', "if False:")],
    "cdfollowed": [("for directory in (os.environ.get(\"CLAUDE_PROJECT_DIR\", \"\"), start_cwd, moved))", "for directory in (os.environ.get(\"CLAUDE_PROJECT_DIR\", \"\"), start_cwd))")],
    "cdunknown": [("    if moved is None:\n        return True\n", "    if moved is None:\n        return False\n")],
}
CASES = {
    "prmerge": "test_pr_merge_is_denied",
    "apimerge": "test_api_merge_is_denied",
    "apiget": "test_api_get_is_not_denied",
    "graphql": "test_graphql_merge_is_denied",
    "graphqlpos": "test_graphql_merge_is_denied",
    "graphqlpath": "test_graphql_merge_is_denied",
    "apiquery": "test_api_merge_is_denied",
    "xargs": "test_indirect_gh_is_denied",
    "helpvalue": "test_help_as_option_value_is_denied",
    "repoopt": "test_global_repo_option_is_denied",
    "wired": "test_pr_merge_is_denied",
    "scriptcheck": "test_without_merge_script_is_not_denied",
    "scriptonly": "test_with_merge_script_is_denied_by_each_entry",
    "cdfollowed": "test_cd_into_project_with_script_is_denied",
    "cdunknown": "test_cd_into_project_with_script_is_denied",
}
parser = argparse.ArgumentParser()
parser.add_argument("--mutation", choices=sorted(MUTATIONS))
parser.add_argument("--case", choices=sorted(CASES))
arguments = parser.parse_args()

source = GUARD.read_text()
if arguments.mutation:
    for needle, replacement in MUTATIONS[arguments.mutation]:
        if source.count(needle) != 1:
            print("regression injection target changed: %r" % needle[:60], file=sys.stderr)
            sys.exit(3)
        source = source.replace(needle, replacement)
WORK = Path(tempfile.mkdtemp(prefix="guard-merge-"))
(WORK / "guard-bash.py").write_text(source)


def decide(command):
    environment = {key: value for key, value in os.environ.items() if key != "TMPDIR"}
    environment.update({"HOME": "/nonexistent-guard-home", "PYTHONDONTWRITEBYTECODE": "1"})
    done = subprocess.run(
        [sys.executable, str(WORK / "guard-bash.py")], input=json.dumps({"tool_input": {"command": command}, "cwd": str(ROOT)}),
        text=True, capture_output=True, env=environment, check=False,
    )
    if done.returncode == 2:
        return "deny", done.stderr
    return ("ask" if done.stdout.strip() else "allow"), ""


HOOKS = ROOT / "scripts/hooks"
PROJECTS = {}


def project(name, with_script):
    """git の root（.git）を持つ一時 project。with_script なら scripts/merge-pr.sh を置く（#184）。"""
    if name not in PROJECTS:
        path = WORK / name
        (path / ".git").mkdir(parents=True)
        (path / "sub").mkdir()
        if with_script:
            (path / "scripts").mkdir()
            (path / "scripts/merge-pr.sh").write_text("#!/usr/bin/env bash\n")
        PROJECTS[name] = str(path)
    return PROJECTS[name]


def entry_decide(entry, command, cwd, project_dir=None):
    """実際の入口（Claude: guard-bash.sh / Codex: guard-codex.sh と、user 側の runner 経由）で判定する。"""
    environment = {key: value for key, value in os.environ.items() if key not in ("TMPDIR", "CLAUDE_PROJECT_DIR", "AGENT_BOX")}
    environment.update({"HOME": "/nonexistent-guard-home", "PYTHONDONTWRITEBYTECODE": "1"})
    if project_dir:
        environment["CLAUDE_PROJECT_DIR"] = project_dir
    argv = {
        "claude": ["bash", str(WORK / "hooks/guard-bash.sh")],
        "codex": ["bash", str(WORK / "hooks/guard-codex.sh")],
        "runner": ["bash", str(WORK / "hooks/user-hook-runner.sh"), "guard-codex", "PreToolUse", "codex"],
    }[entry]
    done = subprocess.run(
        argv, input=json.dumps({"tool_name": "Bash", "tool_input": {"command": command}, "cwd": cwd}),
        text=True, capture_output=True, env=environment, check=False,
    )
    return "deny" if done.returncode == 2 else "allow"


class MergeGuard(unittest.TestCase):
    def setUp(self):
        # 入口のスクリプトは変更後（または退行注入後）の guard-bash.py と並べて使う
        if not (WORK / "hooks").exists():
            (WORK / "hooks").mkdir()
            for path in HOOKS.iterdir():
                if path.suffix == ".sh" or path.name == "guard-codex.py":
                    (WORK / "hooks" / path.name).write_bytes(path.read_bytes())
            (WORK / "hooks/guard-bash.py").write_text(source)

    def test_without_merge_script_is_not_denied(self):
        bare = project("bare", False)
        for entry in ("claude", "codex", "runner"):
            for cwd in (bare, bare + "/sub"):
                for command in ("gh pr merge 1 --squash", "gh api -X PUT repos/o/r/pulls/1/merge", "cd %s/sub && gh pr merge 1" % bare):
                    self.assertEqual(entry_decide(entry, command, cwd), "allow", (entry, cwd, command))
        self.assertEqual(entry_decide("claude", "gh pr merge 1", bare, project_dir=bare), "allow")

    def test_with_merge_script_is_denied_by_each_entry(self):
        full = project("full", True)
        for entry in ("claude", "codex", "runner"):
            for cwd in (full, full + "/sub"):
                for command in ("gh pr merge 1 --squash", "gh api -X PUT repos/o/r/pulls/1/merge", "gh pr merge 1 --auto"):
                    self.assertEqual(entry_decide(entry, command, cwd), "deny", (entry, cwd, command))
        self.assertEqual(entry_decide("claude", "gh pr merge 1", full, project_dir=full), "deny")
        self.assertEqual(entry_decide("codex", "scripts/merge-pr.sh 1 --head abc", full), "allow")

    def test_cd_into_project_with_script_is_denied(self):
        bare, full = project("bare", False), project("full", True)
        for entry in ("claude", "codex"):
            # 移動先に script がある。script の無い project の session からでも拒否する
            self.assertEqual(entry_decide(entry, "cd %s && gh pr merge 1" % full, bare), "deny", entry)
            # 移動先に script が無くても、起点の project に script があれば拒否する（緩めない）
            self.assertEqual(entry_decide(entry, "cd %s && gh pr merge 1" % bare, full), "deny", entry)
            # cd を追えない形（置換・条件の後）は、どの repo か判定できないので拒否する
            self.assertEqual(entry_decide(entry, "cd $(echo %s) && gh pr merge 1" % full, bare), "deny", entry)
            self.assertEqual(entry_decide(entry, "ls && cd %s && gh pr merge 1" % full, bare), "deny", entry)

    def denies(self, command):
        decision, message = decide(command)
        self.assertEqual(decision, "deny", command)
        self.assertIn("scripts/merge-pr.sh", message)

    def not_denied(self, command):
        self.assertNotEqual(decide(command)[0], "deny", command)

    def test_pr_merge_is_denied(self):
        for command in (
            "gh pr merge 1 --squash", "gh pr merge", "gh pr merge 1 --squash --match-head-commit abc", "gh pr merge 1 --auto",
            "env GH_TOKEN=x gh pr merge 1", "sudo gh pr merge 1", "timeout 5 gh pr merge 1", "/usr/bin/gh pr merge 1",
            "bash -c 'gh pr merge 1 --squash'", "sh -c \"gh pr merge 1\"", "eval 'gh pr merge 1'",
            "ls && gh pr merge 1", "ls; gh pr merge 1", "true || gh pr merge 1", "echo x | gh pr merge 1", "(gh pr merge 1)",
            "echo $(gh pr merge 1)", "cd /tmp && gh pr merge 1", "gh pr merge 1 2>&1", ">/dev/null gh pr merge 1",
            "if true; then gh pr merge 1; fi", "gh pr merge 1 --body -h", "FOO=1 gh pr merge 1",
        ):
            self.denies(command)

    def test_global_repo_option_is_denied(self):
        for command in ("gh -R o/r pr merge 3", "gh --repo o/r pr merge 3", "gh pr -R o/r merge 3", "gh pr --repo=o/r merge 3"):
            self.denies(command)

    def test_api_merge_is_denied(self):
        for command in (
            "gh api -X PUT repos/o/r/pulls/1/merge", "gh api --method PUT repos/o/r/pulls/1/merge", "gh api -XPUT repos/o/r/pulls/1/merge",
            "gh api --method=PUT repos/o/r/pulls/1/merge", "gh api repos/o/r/pulls/1/merge", "gh api repos/o/r/pulls/1/merge -f merge_method=squash",
            "gh api repos/{owner}/{repo}/pulls/1/merge -X PUT", "gh api -X PUT 'repos/o/r/pulls/5/merge?a=b'",
            "gh api -X PUT 'repos/o/r/pulls/5/merge#x'", "gh api -X PUT repos/o/r/pulls/5/merge/?a=b", "gh api /repos/o/r/pulls/$N/merge -X PUT",
            "bash -c 'gh api -X PUT repos/o/r/pulls/1/merge'", "gh api repos/o/r/pulls/1/merge -X POST",
        ):
            self.denies(command)

    def test_api_get_is_not_denied(self):
        self.not_denied("gh api -X GET repos/o/r/pulls/1/merge")
        self.not_denied("gh api repos/o/r/pulls/1/merge --method GET")
        self.not_denied("gh api repos/o/r/pulls/1")
        self.not_denied("gh api repos/o/r/pulls/1/comments")
        self.not_denied("gh api -X PUT repos/o/r/issues/1/labels")

    def test_graphql_merge_is_denied(self):
        for command in (
            'gh api graphql -f query="mutation{mergePullRequest(input:{pullRequestId:\\"x\\"}){clientMutationId}}"',
            "gh api graphql -f query='mutation { enablePullRequestAutoMerge(input:{}) { clientMutationId } }'",
            # graphql が api の直後にない形（option の値が先に来る）
            "gh api -H 'Accept: x' graphql -f query='mutation{mergePullRequest(input:{})}'",
            "gh api -f query='mutation{mergePullRequest(input:{})}' graphql",
            "gh api --hostname h graphql -f query='mutation{enablePullRequestAutoMerge(input:{})}'",
            # endpoint を graphql 以外の語で書いた形（先頭の /・URL・/api/graphql）
            "gh api /graphql -f query='mutation{mergePullRequest(input:{})}'",
            "gh api https://api.github.com/graphql -f query='mutation{mergePullRequest(input:{})}'",
            "gh api --hostname h /api/graphql -f query='mutation{mergePullRequest(input:{})}'",
        ):
            self.denies(command)
        self.not_denied("gh api graphql -f query='query { viewer { login } }'")
        self.not_denied("gh api /graphql -f query='query { viewer { login } }'")
        self.not_denied("gh api repos/o/r/contents/graphql.md")
        self.not_denied("gh api -H 'Accept: x' graphql -f query='query { viewer { login } }'")

    def test_indirect_gh_is_denied(self):
        for command in ("echo 1 | xargs gh pr merge", "xargs -I{} gh pr merge {}", "find . -exec gh pr merge 1 ;"):
            self.denies(command)
        self.not_denied("xargs echo gh")

    def test_help_as_option_value_is_denied(self):
        self.denies("gh pr merge 1 --body -h")
        self.denies("gh pr merge 1 -t --help")

    def test_non_merging_forms_are_not_denied(self):
        for command in (
            "scripts/merge-pr.sh 1 --head abc", "bash scripts/merge-pr.sh 1 --head abc --judge scope=ok", "gh pr view 1", "gh pr view 1 --json mergeable",
            "gh pr list --state merged", "gh pr list --search merge", "gh pr comment 1 --body merge", "gh pr create --title merge",
            "gh pr merge --help", "gh pr merge -h", "gh pr merge 1 -h", "gh pr diff 1", "gh pr checks 1", "gh issue view 1",
            "echo gh pr merge", "grep 'gh pr merge' README.md", "git commit -m 'gh pr merge を拒否'", "git merge origin/main",
            "gh pr ready 1", "gh pr close 1 --comment merge",
        ):
            self.not_denied(command)


if __name__ == "__main__":
    selected = unittest.TestSuite()
    if arguments.case:
        selected.addTest(MergeGuard(CASES[arguments.case]))
    else:
        selected.addTests(unittest.defaultTestLoader.loadTestsFromTestCase(MergeGuard))
    result = unittest.TextTestRunner(verbosity=0, stream=sys.stderr).run(selected)
    sys.exit(0 if result.wasSuccessful() else 1)
