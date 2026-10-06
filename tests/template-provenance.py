"""Real local Git fixtures; no external service or credential is used."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


def run(*args, env=None):
    return subprocess.run(args, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)


def git(repo, *args):
    result = run("git", "-C", str(repo), *args)
    if result.returncode:
        raise AssertionError(result.stderr)
    return result.stdout.strip()


def tree(root):
    result = {}
    for path in root.rglob("*"):
        if path.is_symlink():
            result[str(path.relative_to(root))] = ("link", os.readlink(path))
        elif path.is_file():
            result[str(path.relative_to(root))] = (path.stat().st_mode, hashlib.sha256(path.read_bytes()).hexdigest())
    return result


class Provenance(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="test-provenance-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / "source"
        self.repo.mkdir()
        git(self.repo, "init", "-q")
        git(self.repo, "config", "user.email", "fixture@example.invalid")
        git(self.repo, "config", "user.name", "Fixture")
        (self.repo / "tracked").write_text("A\n")
        (self.repo / "executable").write_text("#!/bin/sh\nexit 0\n")
        (self.repo / "executable").chmod(0o755)
        (self.repo / "link").symlink_to("tracked")
        (self.repo / ".gitattributes").write_text("tracked export-ignore\n")
        git(self.repo, "add", ".")
        git(self.repo, "commit", "-qm", "A")
        self.a = git(self.repo, "rev-parse", "HEAD")
        (self.repo / "tracked").write_text("B\n")
        git(self.repo, "commit", "-qam", "B")
        self.b = git(self.repo, "rev-parse", "HEAD")
        (self.repo / "tracked").write_text("dirty\n")
        (self.repo / "untracked").write_text("not in snapshot\n")
        self.project = self.root / "project"

    def create(self, *args):
        return run("bash", str(ROOT / "scripts/new-project.sh"), "--source-repo", str(self.repo),
                   "--revision", self.a, "--output", str(self.project), *args)

    def compare(self, *args, env=None):
        return run("bash", str(ROOT / "scripts/template-diff.sh"), "--project", str(self.project),
                   "--source-repo", str(self.repo), *args, env=env)

    def generated(self):
        result = self.create()
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads((self.project / ".template-version").read_text())

    def test_committed_snapshot_and_same_commit_metadata(self):
        before = tree(self.repo)
        data = self.generated()
        self.assertEqual(data["revision"], self.a)
        self.assertEqual(data["source"], str(self.repo.resolve()))
        self.assertEqual(data["schema_version"], 1)
        self.assertEqual((self.project / "tracked").read_text(), "A\n")
        self.assertFalse((self.project / "untracked").exists())
        self.assertFalse((self.project / ".git").exists())
        self.assertTrue(os.access(self.project / "executable", os.X_OK))
        self.assertEqual(os.readlink(self.project / "link"), "tracked")
        self.assertEqual(tree(self.repo), before)

    def test_explicit_file_url(self):
        result = run("/bin/bash", str(ROOT / "scripts/new-project.sh"), "--source-url", self.repo.as_uri(),
                     "--revision", self.a, "--output", str(self.project))
        self.assertEqual(result.returncode, 0, result.stderr)
        data = json.loads((self.project / ".template-version").read_text())
        self.assertEqual(data["revision"], self.a)
        self.assertEqual(data["source"], self.repo.as_uri())
        self.assertEqual((self.project / "tracked").read_text(), "A\n")

    def test_source_subdirectory_preserves_full_commit_tree(self):
        nested = self.repo / "nested"
        nested.mkdir()
        (nested / "child").write_text("nested child\n")
        git(self.repo, "add", "nested")
        git(self.repo, "commit", "-qm", "nested fixture")
        self.a = git(self.repo, "rev-parse", "HEAD")
        self.generated()
        root_snapshot = tree(self.project)
        root_snapshot.pop(".template-version")
        subdir_project = self.root / "from-subdir"
        result = self.create("--source-repo", str(nested), "--output", str(subdir_project))
        self.assertEqual(result.returncode, 0, result.stderr)
        subdir_snapshot = tree(subdir_project)
        subdir_snapshot.pop(".template-version")
        self.assertEqual(subdir_snapshot, root_snapshot)
        self.assertEqual((subdir_project / "nested/child").read_text(), "nested child\n")
        metadata = json.loads((subdir_project / ".template-version").read_text())
        self.assertEqual(metadata["revision"], self.a)

    def test_comparison_read_only_no_network_or_external_diff(self):
        self.generated()
        sentinel = self.root / "executed"
        helper = self.root / "forbidden"
        helper.write_text("#!/bin/sh\ntouch '" + str(sentinel) + "'\nexit 99\n")
        helper.chmod(0o755)
        git(self.repo, "config", "remote.origin.url", "ext::" + str(helper))
        git(self.repo, "config", "diff.external", str(helper))
        git(self.repo, "config", "diff.bad.textconv", str(helper))
        (self.repo / ".gitattributes").write_text("* diff=bad\n")
        data = json.loads((self.project / ".template-version").read_text())
        data["source"] = "ext::" + str(helper)
        (self.project / ".template-version").write_text(json.dumps(data))
        before = tree(self.root)
        env = os.environ.copy()
        env["GIT_EXTERNAL_DIFF"] = str(helper)
        result = self.compare(env=env)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("-A\n+B", result.stdout)
        self.assertNotIn("dirty", result.stdout)
        self.assertEqual(tree(self.root), before)
        self.assertFalse(sentinel.exists())
        same = self.compare("--to", self.a)
        self.assertEqual(same.returncode, 0, same.stderr)
        self.assertEqual(same.stdout, "")
        self.assertIn("比較可能", same.stderr)

    def test_source_can_move(self):
        self.generated()
        moved = self.root / "moved"
        self.repo.rename(moved)
        self.repo = moved
        self.assertEqual(self.compare().returncode, 0)

    def test_existing_destinations_are_unchanged(self):
        for kind in ("directory", "file", "symlink", "dangling"):
            with self.subTest(kind=kind):
                target = self.root / kind
                if kind == "directory":
                    target.mkdir()
                    (target / "keep").write_text("keep")
                elif kind == "file":
                    target.write_text("keep")
                else:
                    target.symlink_to(self.repo if kind == "symlink" else self.root / "absent")
                before = tree(self.root)
                result = self.create("--output", str(target))
                self.assertEqual(result.returncode, 1, result.stderr)
                self.assertIn("上書きしない", result.stderr)
                self.assertEqual(tree(self.root), before)

    def test_invalid_source_or_revision_leaves_no_output(self):
        for args in (("--source-repo", str(self.root / "absent")), ("--revision", "missing"), ("--revision=-bad",)):
            with self.subTest(args=args):
                self.assertEqual(self.create(*args).returncode, 1)
                self.assertFalse(self.project.exists())

    def test_metadata_invalid_cases(self):
        good = self.generated()
        path = self.project / ".template-version"
        cases = [("invalid-json", "source=do-not-execute"), ("array", "[]")]
        for field in ("schema_version", "source", "revision", "fetched_at"):
            data = good.copy()
            del data[field]
            cases.append(("missing-" + field, json.dumps(data)))
        for field, value in (("schema_version", 2), ("schema_version", True), ("source", ""),
                             ("revision", "unversioned-working-tree"), ("revision", "abc"),
                             ("fetched_at", "2026-02-30T00:00:00Z"), ("fetched_at", "2026-09-26"),
                             ("fetched_at", "2026-09-26T00:00:00")):
            cases.append((field + repr(value), json.dumps(dict(good, **{field: value}))))
        for name, contents in cases:
            with self.subTest(name=name):
                path.write_text(contents)
                result = self.compare()
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn("比較不能:", result.stderr)
                self.assertEqual(result.stdout, "")
        path.unlink()
        self.assertEqual(self.compare().returncode, 2)
        path.symlink_to(self.repo / "tracked")
        self.assertEqual(self.compare().returncode, 2)

    def test_missing_commits_are_not_fetched(self):
        good = self.generated()
        git(self.repo, "config", "remote.origin.url", "file:///nonexistent/template-fixture")
        before = tree(self.repo)
        for revision in ("f" * 40,):
            (self.project / ".template-version").write_text(json.dumps(dict(good, revision=revision)))
            result = self.compare()
            self.assertEqual(result.returncode, 2, result.stderr)
            self.assertIn("必要な commit", result.stderr)
        (self.project / ".template-version").write_text(json.dumps(good))
        self.assertEqual(self.compare("--to", "missing").returncode, 2)
        self.assertEqual(tree(self.repo), before)

    def test_snapshot_metadata_symlink_cannot_write_outside(self):
        outside = self.root / "outside"
        outside.write_text("preserve\n")
        (self.repo / ".template-version").symlink_to(outside)
        git(self.repo, "add", ".template-version")
        git(self.repo, "commit", "-qm", "metadata symlink")
        self.a = git(self.repo, "rev-parse", "HEAD")
        self.generated()
        self.assertEqual(outside.read_text(), "preserve\n")
        self.assertFalse((self.project / ".template-version").is_symlink())

    def test_missing_promisor_blob_does_not_lazy_fetch(self):
        self.generated()
        blob = git(self.repo, "rev-parse", self.a + ":tracked")
        obj = self.repo / ".git/objects" / blob[:2] / blob[2:]
        obj.unlink()
        sentinel = self.root / "network-called"
        helper = self.root / "remote-helper"
        helper.write_text("#!/bin/sh\ntouch '" + str(sentinel) + "'\nexit 99\n")
        helper.chmod(0o755)
        git(self.repo, "config", "remote.origin.url", "ext::" + str(helper))
        git(self.repo, "config", "remote.origin.promisor", "true")
        git(self.repo, "config", "protocol.ext.allow", "always")
        before = tree(self.repo)
        result = self.compare()
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertFalse(sentinel.exists())
        self.assertEqual(tree(self.repo), before)

    def test_submodule_is_rejected_before_output_creation(self):
        git(self.repo, "update-index", "--add", "--cacheinfo", "160000," + self.a + ",module")
        git(self.repo, "commit", "-qm", "gitlink fixture")
        self.a = git(self.repo, "rev-parse", "HEAD")
        result = self.create()
        self.assertEqual(result.returncode, 1)
        self.assertIn("submodule", result.stderr)
        self.assertFalse(self.project.exists())

    def test_case_alias_symlink_parent_cannot_escape_staging(self):
        outside = self.root / "outside-directory"
        outside.mkdir()

        def obj(kind, content):
            result = subprocess.run(["git", "-C", str(self.repo), "hash-object", "-t", kind, "-w", "--stdin"],
                                    input=content, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            self.assertEqual(result.returncode, 0, result.stderr)
            return result.stdout.strip()

        link = obj("blob", os.fsencode(outside))
        blob = obj("blob", b"payload\n")
        subtree = obj("tree", b"100644 payload\0" + bytes.fromhex(blob.decode()))
        top = obj("tree", b"120000 Alias\0" + bytes.fromhex(link.decode()) +
                  b"40000 alias\0" + bytes.fromhex(subtree.decode()))
        self.a = git(self.repo, "commit-tree", top.decode(), "-p", self.a, "-m", "case alias fixture")
        result = self.create()
        self.assertFalse((outside / "payload").exists())
        # A case-sensitive filesystem can represent both paths safely. A
        # case-insensitive one must reject the colliding parent before copying.
        self.assertIn(result.returncode, (0, 1), result.stderr)
        if result.returncode == 1:
            self.assertFalse(self.project.exists())


if __name__ == "__main__":
    unittest.main()
