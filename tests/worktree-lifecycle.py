#!/usr/bin/env python3
"""Lifecycle integration/negative fixtures. Only dedicated fake HOME repos mutate.

--mutation disables one guard in the in-memory backend for red evidence; the real
implementation is never changed. Fixture HOME is under the persistent task checkout.
"""
import argparse
import contextlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import shlex
import socket
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
argument_parser = argparse.ArgumentParser()
argument_parser.add_argument("--mutation", choices=("placement", "protection", "ownership", "special", "nested"))
argument_parser.add_argument("--case", choices=("placement", "protection", "ownership", "special", "nested"))
arguments = argument_parser.parse_args()
backend = ROOT / "scripts/lib/worktree.py"
module_spec = importlib.util.spec_from_file_location("worktree_backend", backend)
wt = importlib.util.module_from_spec(module_spec)
source = backend.read_text()
if arguments.mutation:
    needle, replacement = {
        "placement": ('            if not approval:\n', '            if False and not approval:\n'),
        "protection": ('        if tracked:\n', '        if False and tracked:\n'),
        "ownership": ('            if actor != record["root"]:\n', '            if False and actor != record["root"]:\n'),
        "special": ('                if not (stat.S_ISREG(mode) or stat.S_ISDIR(mode)):\n', '                if False and not (stat.S_ISREG(mode) or stat.S_ISDIR(mode)):\n'),
        "nested": ('        if any(entry.startswith(b"160000 ") for entry in stages):\n', '        if False and any(entry.startswith(b"160000 ") for entry in stages):\n'),
    }[arguments.mutation]
    if source.count(needle) != 1:
        raise RuntimeError("regression injection target changed")
    source = source.replace(needle, replacement)
    if arguments.mutation == "nested":
        source = source.replace('                if child.name == ".git" and child != p / ".git":\n',
                                '                if False and child.name == ".git" and child != p / ".git":\n')
    # Placement mutant actually permits a nonstandard path rather than falling through to external(None).
    if arguments.mutation == "placement":
        source = source.replace('            evidence, value = self.external(approval)\n', '            if approval is None:\n                return p, None\n            evidence, value = self.external(approval)\n')
exec(compile(source, str(backend), "exec"), wt.__dict__)


def ns(**values):
    return argparse.Namespace(**values)


def git(repo, *args):
    return subprocess.check_output(["git", "-C", str(repo), *args], stderr=subprocess.DEVNULL).decode().strip()


class Lifecycle(unittest.TestCase):
    def setUp(self):
        self.fixture = Path(tempfile.mkdtemp(prefix=".test-worktree-", dir=ROOT))
        self.home = self.fixture / "home"
        self.home.mkdir()
        self.repo = self.home / "sample"
        self.repo.mkdir()
        git(self.repo, "init", "-q", "-b", "main")
        git(self.repo, "config", "user.name", "fixture")
        git(self.repo, "config", "user.email", "fixture@example.invalid")
        (self.repo / "scripts").mkdir()
        shutil.copyfile(ROOT / "scripts/worktree-disposable.json", self.repo / "scripts/worktree-disposable.json")
        (self.repo / ".gitignore").write_text("cache/\n.env\n")
        (self.repo / "AGENTS.md").write_text("fixture\n")
        (self.repo / "CLAUDE.md").symlink_to("AGENTS.md")
        (self.repo / ".claude").mkdir()
        (self.repo / ".claude/config").write_text("fixture\n")
        (self.repo / ".agents").symlink_to(".claude")
        git(self.repo, "add", ".")
        git(self.repo, "commit", "-qm", "fixture")
        self.env = mock.patch.dict(os.environ, {"HOME": str(self.home), "PYTHONDONTWRITEBYTECODE": "1"})
        self.env.start()
        self.manager = wt.Manager(str(self.repo))
        self.evidence_dir = self.home / "evidence"
        self.evidence_dir.mkdir()
        self.processes = []
        self.root_cap = self.root("root")
        self.target = self.manager.standard / "child"

    def tearDown(self):
        for process in self.processes:
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=5)
        self.env.stop()
        # This path was created by this test and cannot refer to a real user worktree.
        if self.fixture.parent != ROOT or not self.fixture.name.startswith(".test-worktree-"):
            raise AssertionError("fixture cleanup boundary")
        shutil.rmtree(self.fixture)

    def evidence(self, filename, value):
        path = self.evidence_dir / filename
        path.write_text(json.dumps(value))
        return str(path)

    def root(self, session):
        approval = self.evidence(session + ".json", {"kind": "root-session", "approved_by": "user",
            "session": session, "repo": str(self.manager.common), "reason": "fixture prior authorization"})
        with self.manager.locked(True):
            return self.manager.root_open(ns(session=session, pid=os.getpid(), approval=approval))["capability"]

    def sleeper(self):
        process = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(300)"],
                                   cwd=self.home, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.processes.append(process)
        return process

    def create(self, child=True, purpose="implementation", path=None, branch="feat/105-fixture", session="child", **options):
        self.owner_process = self.sleeper() if child else None
        args = ns(path=str(path or self.target), base="HEAD", branch=branch, purpose=purpose, child=child,
                  session=session if child else None, pid=self.owner_process.pid if child else None,
                  capability=self.root_cap if child else None, placement_approval=None)
        vars(args).update(options)
        with self.manager.locked(True):
            self.created = self.manager.create(args)
        self.owner_cap = self.created["owner_capability"]
        return self.created

    def end(self, kill=True, **overrides):
        record = self.manager.db["records"][str(self.target)]
        report = {"kind": "end", "session": record["owner"], "path": str(self.target),
                  "head": git(self.target, "rev-parse", "HEAD"), "jobs": record["jobs"],
                  "jobs_ended": True, "work_ended": True, "evidence": []}
        report.update(overrides)
        self.report_path = self.evidence("end.json", report)
        with self.manager.locked(True):
            self.manager.end(ns(path=str(self.target), capability=self.owner_cap, report=self.report_path))
        if kill and self.owner_process:
            self.owner_process.terminate()
            self.owner_process.wait(timeout=5)

    def inspection(self, cap=None):
        with self.manager.locked():
            return self.manager.inspect(ns(path=str(self.target), capability=cap or self.root_cap))

    def reclaim_args(self, cap=None, session="root", user_approval=None):
        with self.manager.locked():
            snap = self.manager.snapshot(str(self.target), self.manager.db["records"][str(self.target)])
        confirm = {"kind": "root-confirmation", "root_session": session,
            "owner_session": self.manager.db["records"][str(self.target)]["owner"], "path": str(self.target),
            "snapshot_sha256": wt.digest(snap), "session_ended_observed": True,
            "jobs_ended_observed": True, "evidence_saved_verified": True,
            "observation": "fixture orchestrator observed dummy session ended"}
        return ns(path=str(self.target), capability=cap or self.root_cap,
                  confirmation=self.evidence("confirm-" + session + ".json", confirm), user_approval=user_approval)

    def reclaim(self, args=None):
        args = args or self.reclaim_args()
        with self.manager.locked(True):
            return self.manager.reclaim(args)

    def test_child_reclaim_preserves_branch_and_external_end(self):
        self.create()
        self.end()
        head = git(self.target, "rev-parse", "HEAD")
        self.assertEqual(self.reclaim()["state"], "reclaimed")
        self.assertFalse(self.target.exists())
        self.assertEqual(git(self.repo, "rev-parse", "feat/105-fixture"), head)
        self.assertTrue(Path(self.report_path).is_file())
        self.assertTrue((self.manager.state / "state.json").is_file())

    def test_regular_create_hold_end_requires_user_target_approval(self):
        self.create(child=False)
        with self.manager.locked(True):
            self.manager.hold(ns(path=str(self.target), capability=self.owner_cap, reason="fixture pause"))
        self.assertEqual(self.manager.db["records"][str(self.target)]["state"], "held")
        self.end()
        args = self.reclaim_args()
        with self.assertRaisesRegex(wt.Stop, "ユーザー承認"):
            self.reclaim(args)
        snapshot = self.inspection()["snapshot_sha256"]
        args.user_approval = self.evidence("user.json", {"kind": "reclaim", "approved_by": "user",
            "path": str(self.target), "snapshot_sha256": snapshot, "reason": "fixture explicit target approval"})
        self.assertEqual(self.reclaim(args)["state"], "reclaimed")

    def test_short_lived_create_shell_owner_can_hold_and_end_later(self):
        cmd = ["bash", str(ROOT / "scripts/new-branch.sh"), "feat", "105", "short-shell",
               "--from", "main", "--worktree", str(self.target)]
        fakebin = self.home / "fakebin"
        fakebin.mkdir()
        gh = fakebin / "gh"
        gh.write_text("#!/bin/sh\nexit 1\n")
        gh.chmod(0o755)
        result = subprocess.run(cmd, cwd=self.repo, capture_output=True, text=True,
                                env={**os.environ, "PATH": str(fakebin) + os.pathsep + os.environ["PATH"]})
        self.assertEqual(result.returncode, 0, result.stderr)
        begin = result.stdout.index("{")
        creation, _ = json.JSONDecoder().raw_decode(result.stdout[begin:])
        self.owner_cap = creation["owner_capability"]
        self.owner_process = None
        with self.manager.locked(True):
            record = self.manager.db["records"][str(self.target)]
            self.assertFalse(wt.alive(self.manager.db["sessions"][record["owner"]]["pid"]))
            self.manager.hold(ns(path=str(self.target), capability=self.owner_cap, reason="later invocation"))
        self.end()
        self.assertTrue(self.inspection())

    def test_nonstandard_home_denied_before_git_mutation(self):
        before = git(self.repo, "worktree", "list", "--porcelain")
        with self.assertRaises(wt.Stop):
            self.create(path=self.home / "outside")
        self.assertEqual(git(self.repo, "worktree", "list", "--porcelain"), before)
        self.assertFalse((self.home / "outside").exists())

    def test_placement_explicit_approval_and_temp_always_denied(self):
        outside = self.home / "outside"
        approval = self.evidence("placement.json", {"kind": "placement", "approved_by": "user",
            "path": str(outside), "repo": str(self.manager.common), "reason": "fixture authorized exception"})
        self.create(path=outside, placement_approval=approval)
        self.assertTrue(outside.is_dir())
        with self.assertRaises(wt.Stop):
            self.manager.validate_placement("/private/tmp/forbidden", approval)

    def test_symlink_ancestor_and_existing_path_denied(self):
        self.manager.standard.mkdir(parents=True)
        (self.manager.standard / "escape").symlink_to(self.evidence_dir)
        with self.assertRaisesRegex(wt.Stop, "symlink"):
            self.create(path=self.manager.standard / "escape" / "target")
        (self.manager.standard / "escape").unlink()
        self.target.mkdir()
        with self.assertRaisesRegex(wt.Stop, "上書き"):
            self.create()

    def test_duplicate_session_denied_before_git(self):
        with self.assertRaises(wt.Stop):
            self.create(session="root")
        self.assertFalse(self.target.exists())

    def test_same_name_repo_collision(self):
        self.manager.standard.mkdir(parents=True)
        (self.manager.standard / ".repo-id.json").write_text(json.dumps({"common": "/other/repo/.git"}))
        with self.assertRaisesRegex(wt.Stop, "衝突"):
            self.create()

    def test_bootstrap_existing_same_repo_preserves_legacy_protection(self):
        self.manager.standard.mkdir(parents=True)
        legacy = self.manager.standard / "legacy"
        git(self.repo, "worktree", "add", "--detach", str(legacy))
        self.create()
        listing = self.manager.list(ns(command="list"))["worktrees"]
        row = next(row for row in listing if row["worktree"] == str(legacy))
        self.assertFalse(row["managed"])
        self.assertEqual(row["state"], "needs-confirmation")
        with self.assertRaises(wt.Stop):
            self.manager.record(str(legacy))

    def test_bootstrap_unknown_existing_entry_denied(self):
        self.manager.standard.mkdir(parents=True)
        (self.manager.standard / "unknown").mkdir()
        with self.assertRaisesRegex(wt.Stop, "不明"):
            self.create()

    def test_no_end_or_held_never_candidate(self):
        self.create()
        with self.assertRaisesRegex(wt.Stop, "終了記録"):
            self.inspection()
        self.end(kill=False)
        with self.manager.locked(True):
            self.manager.hold(ns(path=str(self.target), capability=self.owner_cap, reason="correction round"))
        with self.assertRaisesRegex(wt.Stop, "終了記録"):
            self.inspection()

    def test_alive_owner_not_session_end_proof(self):
        self.create()
        self.end(kill=False)
        with self.assertRaisesRegex(wt.Stop, "担当 process"):
            self.inspection()

    def test_registered_job_alive_denies_end(self):
        self.create()
        process = self.sleeper()
        with self.manager.locked(True):
            self.manager.job_add(ns(path=str(self.target), capability=self.owner_cap, pid=process.pid, reason="fixture job"))
        with self.assertRaisesRegex(wt.Stop, "job"):
            self.end()
        process.terminate()
        process.wait(timeout=5)
        self.end()
        self.assertTrue(self.inspection())

    def test_unobserved_open_file_protects(self):
        self.create()
        self.end()
        with (self.target / "AGENTS.md").open() as held:
            with self.assertRaisesRegex(wt.Stop, "lsof"):
                self.inspection()
        self.assertTrue(self.inspection())

    def test_unknown_activity_missing_lsof_protects(self):
        self.create()
        self.end()
        with mock.patch.object(wt.shutil, "which", return_value=None):
            with self.assertRaisesRegex(wt.Stop, "活動不明"):
                self.inspection()

    def test_lsof_warning_or_failure_protects(self):
        self.create()
        self.end()
        actual = wt.run
        for code, stderr in ((1, b"permission denied"), (2, b""), (0, b"")):
            def mocked(argv, *args, **kwargs):
                if Path(argv[0]).name == "lsof":
                    if code not in kwargs.get("allowed", (0,)):
                        raise wt.Stop("lsof failed")
                    return subprocess.CompletedProcess(argv, code, b"", stderr)
                return actual(argv, *args, **kwargs)
            with mock.patch.object(wt, "run", side_effect=mocked):
                with self.assertRaises(wt.Stop):
                    self.inspection()

    def test_dirty_tracked_protects(self):
        self.create()
        self.end()
        (self.target / "AGENTS.md").write_text("changed after end\n")
        with self.assertRaisesRegex(wt.Stop, "未コミット"):
            self.inspection()

    def test_untracked_ignored_and_empty_directory_protect(self):
        self.create()
        self.end()
        for path in (self.target / "unknown.txt", self.target / "cache/data", self.target / ".env"):
            path.parent.mkdir(exist_ok=True)
            path.write_text("fixture-data")
            with self.assertRaisesRegex(wt.Stop, "未追跡"):
                self.inspection()
            path.unlink()
            if path.parent != self.target:
                path.parent.rmdir()
        (self.target / "empty").mkdir()
        with self.assertRaisesRegex(wt.Stop, "空 directory"):
            self.inspection()

    def test_fifo_and_closed_unix_socket_protect(self):
        self.create()
        self.end()
        fifo = self.target / "unclassified-fifo"
        os.mkfifo(fifo)
        self.assertEqual(git(self.target, "ls-files", "--others", "--exclude-standard"), "")
        with self.assertRaisesRegex(wt.Stop, "特殊 file"):
            self.inspection()
        fifo.unlink()
        node = self.target / "unclassified-socket"
        previous_cwd = Path.cwd()
        try:
            os.chdir(self.target)
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
                connection.bind(node.name)
        finally:
            os.chdir(previous_cwd)
        self.assertEqual(git(self.target, "ls-files", "--others", "--exclude-standard"), "")
        with self.assertRaisesRegex(wt.Stop, "特殊 file"):
            self.inspection()
        node.unlink()
        self.assertTrue(self.inspection())

    def disposable_cache_policy(self):
        (self.repo / "scripts/worktree-disposable.json").write_text(json.dumps({"version": 1, "paths": ["cache/"]}))
        git(self.repo, "add", "scripts/worktree-disposable.json")
        git(self.repo, "commit", "-qm", "fixture generated policy")

    def test_gitlink_ignore_all_private_artifact_and_allowed_cache_protect(self):
        module = self.home / "module"
        module.mkdir()
        git(module, "init", "-q", "-b", "main")
        git(module, "config", "user.email", "fixture@example.invalid")
        git(module, "config", "user.name", "fixture")
        (module / "README.md").write_text("fixture module\n")
        git(module, "add", ".")
        git(module, "commit", "-qm", "fixture module")
        git(self.repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", str(module), "nested")
        git(self.repo, "commit", "-qam", "fixture gitlink")
        self.disposable_cache_policy()
        self.create()
        git(self.target, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "-q")
        git(self.target, "config", "submodule.nested.ignore", "all")
        (self.target / "nested/private-result").write_text("fixture private artifact\n")
        (self.target / "cache").mkdir()
        (self.target / "cache/allowed").write_text("fixture generated\n")
        self.end()
        self.assertEqual(git(self.target, "status", "--porcelain", "--untracked-files=no"), "")
        with self.assertRaisesRegex(wt.Stop, "gitlink"):
            self.inspection()
        self.assertTrue((self.target / "nested/private-result").exists())

    def test_nested_git_marker_inside_allowed_prefix_protect(self):
        self.disposable_cache_policy()
        self.create()
        self.end()
        (self.target / "cache").mkdir()
        (self.target / "cache/allowed").write_text("fixture generated\n")
        for marker in ("gitdir: " + str(self.manager.common) + "\n", "unclassified marker\n"):
            (self.target / "cache/.git").write_text(marker)
            with self.assertRaises(wt.Stop):
                self.inspection()
            self.assertTrue((self.target / "cache/.git").exists())
            self.assertTrue((self.target / "cache/allowed").exists())

    def test_disposable_prefix_only_and_untracked_symlink_denied(self):
        config = self.repo / "scripts/worktree-disposable.json"
        config.write_text(json.dumps({"version": 1, "paths": ["cache/"]}))
        git(self.repo, "add", "scripts/worktree-disposable.json")
        git(self.repo, "commit", "-qm", "fixture policy")
        self.create()
        self.end()
        (self.target / "cache").mkdir()
        (self.target / "cache/allowed").write_text("fixture-generated")
        (self.target / "cache/leak").symlink_to(self.evidence_dir / "root.json")
        with self.assertRaisesRegex(wt.Stop, "symlink"):
            self.inspection()
        (self.target / "cache/leak").unlink()
        (self.target / "cache2").mkdir()
        (self.target / "cache2/protected").write_text("fixture-unclassified")
        with self.assertRaisesRegex(wt.Stop, "未追跡"):
            self.inspection()
        (self.target / "cache2/protected").unlink()
        (self.target / "cache2").rmdir()
        self.assertEqual(self.inspection()["snapshot"]["disposable"], ["cache/allowed"])
        self.reclaim()
        self.assertTrue((self.evidence_dir / "root.json").exists())

    def test_disposable_glob_and_modified_policy_denied(self):
        self.create()
        self.end()
        config = self.repo / "scripts/worktree-disposable.json"
        config.write_text(json.dumps({"version": 1, "paths": ["*"]}))
        with self.assertRaisesRegex(wt.Stop, "未コミット"):
            self.inspection()
        git(self.repo, "add", "scripts/worktree-disposable.json")
        git(self.repo, "commit", "-qm", "fixture unsafe policy")
        with self.assertRaisesRegex(wt.Stop, "exact path"):
            self.inspection()

    def test_report_and_evidence_tamper_protect(self):
        self.create()
        artifact = self.evidence("artifact.json", {"result": "original"})
        self.end(evidence=[artifact])
        Path(artifact).write_text(json.dumps({"result": "tampered"}))
        with self.assertRaisesRegex(wt.Stop, "根拠"):
            self.inspection()

    def test_secret_document_is_not_read_as_evidence(self):
        secret = self.evidence_dir / ".env"
        secret.write_text("fixture-secret-never-read")
        with self.assertRaisesRegex(wt.Stop, "secret file"):
            self.manager.external(str(secret))

    def test_end_requires_external_report_and_exact_job_head(self):
        self.create()
        with self.assertRaisesRegex(wt.Stop, "明示終了"):
            self.end(head="0" * 40)
        local = self.target / "report.json"
        local.write_text("{}")
        with self.assertRaisesRegex(wt.Stop, "外"):
            self.manager.end(ns(path=str(self.target), capability=self.owner_cap, report=str(local)))

    def test_review_result_and_target_sha_required(self):
        self.create(purpose="review", branch=None)
        with self.assertRaisesRegex(wt.Stop, "レビュー結果"):
            self.end()
        self.end(review_result="fixture pass", reviewed_sha=git(self.repo, "rev-parse", "HEAD"))
        self.assertTrue(self.inspection())

    def test_detached_unique_commit_without_ref_protect(self):
        self.create(branch=None)
        git(self.target, "commit", "--allow-empty", "-qm", "fixture unique detached")
        self.end()
        with self.assertRaisesRegex(wt.Stop, "保持先"):
            self.inspection()
        head = git(self.target, "rev-parse", "HEAD")
        git(self.repo, "update-ref", "refs/heads/chore/retained-fixture", head)
        self.reclaim()
        self.assertEqual(git(self.repo, "rev-parse", "chore/retained-fixture"), head)

    def test_changed_head_and_locked_protect(self):
        self.create()
        self.end()
        git(self.target, "commit", "--allow-empty", "-qm", "post end change")
        with self.assertRaisesRegex(wt.Stop, "HEAD"):
            self.inspection()
        git(self.repo, "worktree", "lock", str(self.target))
        with self.assertRaisesRegex(wt.Stop, "locked"):
            self.inspection()

    def test_other_root_cannot_reclaim_child(self):
        self.create()
        self.end()
        other = self.root("other-root")
        args = self.reclaim_args(cap=other, session="other-root")
        with self.assertRaisesRegex(wt.Stop, "別 root"):
            self.reclaim(args)
        self.assertTrue(self.target.exists())

    def test_child_cap_or_fake_role_not_root(self):
        self.create()
        self.end(kill=False)
        with self.assertRaisesRegex(wt.Stop, "権限"):
            self.manager.inspect(ns(path=str(self.target), capability=self.owner_cap))
        invalid = self.evidence("fake-cap.json", {"session": "root", "token": "fake", "role": "root"})
        with self.assertRaises(wt.Stop):
            self.manager.capability(invalid, "root")

    def test_confirmation_requires_actual_session_observation(self):
        self.create()
        self.end()
        args = self.reclaim_args()
        value = json.loads(Path(args.confirmation).read_text())
        value["session_ended_observed"] = False
        Path(args.confirmation).write_text(json.dumps(value))
        with self.assertRaisesRegex(wt.Stop, "確認 report"):
            self.reclaim(args)

    def test_post_inspection_change_prevents_reclaim(self):
        self.create()
        self.end()
        args = self.reclaim_args()
        (self.target / "new-untracked").write_text("late fixture data")
        with self.assertRaises(wt.Stop):
            self.reclaim(args)
        self.assertTrue(self.target.exists())

    def test_conflicting_manager_lock_stops(self):
        second = wt.Manager(str(self.repo))
        with self.manager.locked(True):
            with self.assertRaises(BlockingIOError):
                with second.locked(True):
                    pass

    def test_hook_grants_only_clean_literal_verified_child_manager(self):
        for relative in ("scripts/worktree.sh", "scripts/lib/worktree.py", "scripts/check-branch-name.sh"):
            target = self.repo / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / relative, target)
        git(self.repo, "add", "scripts")
        git(self.repo, "commit", "-qm", "fixture trusted manager")
        self.create()
        self.end()
        args = self.reclaim_args()
        tokens = [str(self.repo / "scripts/worktree.sh"), "reclaim", str(self.target), "--capability", args.capability,
                  "--confirmation", args.confirmation]
        direct = " ".join(shlex.quote(token) for token in tokens)
        cases = [(direct, 0), ("env ROLE=root " + direct, 2),
                 ("bash -c " + shlex.quote(direct), 2),
                 ("python3 -c " + shlex.quote("import os; os.system(" + repr(direct) + ")"), 2),
                 (direct + " --role root", 2)]
        for command, expected in cases:
            result = subprocess.run(["bash", str(ROOT / "scripts/hooks/guard-codex.sh")],
                input=json.dumps({"tool_name": "Bash", "tool_input": {"command": command}, "cwd": str(self.repo)}),
                text=True, capture_output=True)
            self.assertEqual(result.returncode, expected, (command, result.stderr))
            self.assertTrue(self.target.exists())
        (self.repo / "scripts/lib/worktree.py").write_text("# altered manager\n")
        result = subprocess.run(["bash", str(ROOT / "scripts/hooks/guard-codex.sh")],
            input=json.dumps({"tool_input": {"command": direct}, "cwd": str(self.repo)}), text=True, capture_output=True)
        self.assertEqual(result.returncode, 2)

    def test_hook_canonical_codex_payload_denies_ask(self):
        for script, command in (("guard-codex.sh", "git worktree remove /some/target"),
                                ("guard-codex.sh", "git worktree add ~/outside target"),
                                ("guard-codex.sh", "env ROLE=root scripts/worktree.sh reclaim /some/target --role root"),
                                ("guard-codex.sh", "bash -c 'git worktree add /tmp/target'")):
            payload = {"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": command}, "cwd": str(self.repo)}
            result = subprocess.run(["bash", str(ROOT / "scripts/hooks" / script)], input=json.dumps(payload),
                                    text=True, capture_output=True)
            self.assertEqual(result.returncode, 2, (command, result.stderr, result.stdout))
            self.assertFalse(result.stdout.strip())


if arguments.case:
    name = {"placement": "test_nonstandard_home_denied_before_git_mutation",
            "protection": "test_dirty_tracked_protects", "ownership": "test_other_root_cannot_reclaim_child", "special": "test_fifo_and_closed_unix_socket_protect", "nested": "test_gitlink_ignore_all_private_artifact_and_allowed_cache_protect"}[arguments.case]
    suite = unittest.TestSuite([Lifecycle(name)])
else:
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(Lifecycle)
result = unittest.TextTestRunner(verbosity=2, stream=sys.stdout).run(suite)
print(json.dumps({"tests": result.testsRun, "failures": len(result.failures), "errors": len(result.errors),
                  "mutation": arguments.mutation, "successful": result.wasSuccessful()}))
sys.exit(0 if result.wasSuccessful() else 1)
