#!/usr/bin/env python3
"""~/.trashable の定期掃除（#146）の fixture テスト。

TrashableCleanup は scripts/trashable-cleanup.py の掃除の条件を、一時 dir の fixture で確かめる。
SetupTrashable は scripts/setup-user-hooks.sh --trashable を、一時 HOME と fake の launchctl（PATH に置き、呼び出しを
記録する）で確かめる。実際の ~/.trashable・~/Library・launchctl には触れない。

--mutation は保護を 1 つ外した実装をメモリ上で作り、対応する --case が red になることを示す。実装ファイルは変更しない。
"""
import argparse
import contextlib
import importlib.util
import io
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import tempfile
import unittest
import unittest.mock

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
LABEL = "com.project-template.trashable-cleanup"
NOW = 1_800_000_000
DAY = 86400

MUTATIONS = {
    "age": [("        if now - item.mtime > max_age:\n", "        if False:\n")],
    "total": [("    if total > cap:\n        for item in sorted(", "    if False:\n        for item in sorted(")],
    "order": [("key=lambda i: (i.mtime, i.path)", "key=lambda i: (-i.mtime, i.path)")],
    "recent": [("            if now - item.mtime < protect:\n", "            if False:\n")],
    "warn": [("        if total > cap:\n            warn(", "        if False:\n            warn(")],
    "newest": [("                if st.st_mtime > newest:\n", "                if False:\n")],
    "follow": [("entry.stat(follow_symlinks=False)", "entry.stat()")],
    "linkdelete": [("st = os.stat(name, dir_fd=parent, follow_symlinks=False)", "st = os.stat(name, dir_fd=parent)")],
    "projectlink": [("if entry.is_dir(follow_symlinks=False):", "if entry.is_dir():")],
    "nofollow": [("os.open(project, NOFOLLOW_DIR, dir_fd=root_fd)", "os.open(project, os.O_RDONLY | os.O_DIRECTORY, dir_fd=root_fd)")],
    "homeguard": [("    if root_real == os.sep or covers_home(root_real):\n", "    if False:\n")],
    "rootlink": [("root_st = os.lstat(root)", "root_st = os.stat(root)")],
    "dryrun": [("        if not args.dry_run:\n            try:", "        if True:\n            try:")],
}
CASES = {
    "age": "test_deletes_items_older_than_seven_days",
    "total": "test_total_over_cap_deletes_oldest_first",
    "order": "test_total_over_cap_deletes_oldest_first",
    "recent": "test_recent_items_survive_cap_and_warn",
    "warn": "test_recent_items_survive_cap_and_warn",
    "newest": "test_item_age_is_newest_mtime_inside",
    "follow": "test_measure_does_not_follow_symlinks",
    "linkdelete": "test_symlink_item_removes_only_the_link",
    "projectlink": "test_symlinked_project_is_one_item",
    "nofollow": "test_swapped_project_symlink_is_not_followed",
    "homeguard": "test_home_or_its_ancestor_as_root_does_nothing",
    "rootlink": "test_symlinked_root_does_nothing",
    "dryrun": "test_dry_run_deletes_nothing",
}
parser = argparse.ArgumentParser()
parser.add_argument("--mutation", choices=sorted(MUTATIONS))
parser.add_argument("--case", choices=sorted(CASES))
arguments = parser.parse_args()

backend = ROOT / "scripts/trashable-cleanup.py"
source = backend.read_text()
if arguments.mutation:
    for needle, replacement in MUTATIONS[arguments.mutation]:
        if source.count(needle) != 1:
            # 注入できなかったことを、保護の喪失（assertion の red = exit 1）と区別する
            print("regression injection target changed: %r" % needle[:60], file=sys.stderr)
            sys.exit(3)
        source = source.replace(needle, replacement)
tc = importlib.util.module_from_spec(importlib.util.spec_from_file_location("trashable_cleanup", backend))
exec(compile(source, str(backend), "exec"), tc.__dict__)


def touch(path, age_days=None, age_seconds=None, size=0, data=None):
    """file を作り、更新時刻を NOW からの経過に合わせる。"""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data if data is not None else b"x" * size)
    age = DAY * age_days if age_days is not None else age_seconds
    os.utime(path, (NOW - age, NOW - age))
    return path


def age(path, days=None, seconds=None):
    stamp = NOW - (DAY * days if days is not None else seconds)
    os.utime(path, (stamp, stamp), follow_symlinks=False)


class TrashableCleanup(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="trashable-test-")).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.root = self.tmp / "trashable"
        self.root.mkdir()
        self.outside = self.tmp / "outside"
        self.outside.mkdir()

    def run_cleanup(self, *extra, root=None):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = tc.main(["--root", str(root or self.root), "--now", str(NOW)] + list(extra))
        return code, out.getvalue()

    def test_defaults_are_seven_days_ten_gib_twenty_four_hours(self):
        args = tc.build_parser().parse_args([])
        self.assertEqual((args.max_age_days, args.max_total_bytes, args.protect_hours), (7.0, 10 * 1024 ** 3, 24.0))
        self.assertEqual(args.root, "~/.trashable")

    def test_deletes_items_older_than_seven_days(self):
        old = touch(self.root / "p/old.txt", age_seconds=7 * DAY + 1)
        edge = touch(self.root / "p/edge.txt", age_days=7)
        new = touch(self.root / "p/new.txt", age_days=6)
        code, out = self.run_cleanup()
        self.assertEqual(code, 0, out)
        self.assertFalse(old.exists())
        self.assertTrue(edge.exists() and new.exists())
        self.assertIn("削除: %s" % old, out)
        self.assertIn("残す: %s" % new, out)
        self.assertIn("要約:", out)

    def test_total_over_cap_deletes_oldest_first(self):
        files = {d: touch(self.root / ("p/d%d" % d), age_days=d, size=100) for d in (5, 4, 3, 2)}
        code, out = self.run_cleanup("--max-total-bytes", "250")
        self.assertEqual(code, 0, out)
        self.assertFalse(files[5].exists() or files[4].exists(), out)
        self.assertTrue(files[3].exists() and files[2].exists(), out)

    def test_total_at_or_under_cap_deletes_nothing(self):
        files = [touch(self.root / ("p/d%d" % d), age_days=d, size=100) for d in (5, 4, 3)]
        code, out = self.run_cleanup("--max-total-bytes", "300")
        self.assertEqual(code, 0, out)
        self.assertTrue(all(f.exists() for f in files), out)

    def test_recent_items_survive_cap_and_warn(self):
        recent = touch(self.root / "p/recent", age_seconds=2 * 3600, size=200)
        older = touch(self.root / "p/older", age_days=3, size=100)
        code, out = self.run_cleanup("--max-total-bytes", "150")
        self.assertEqual(code, 0, out)
        self.assertTrue(recent.exists(), out)
        self.assertFalse(older.exists(), out)
        self.assertIn("警告: 合計", out)

    def test_item_age_is_newest_mtime_inside(self):
        keep = self.root / "p/keep"
        touch(keep / "old.txt", age_days=10)
        touch(keep / "sub/fresh.txt", age_days=1)
        age(keep, days=10)
        age(keep / "sub", days=10)
        stale = self.root / "p/stale"
        touch(stale / "old.txt", age_days=10)
        age(stale, days=10)
        code, out = self.run_cleanup()
        self.assertEqual(code, 0, out)
        self.assertTrue((keep / "sub/fresh.txt").exists(), out)
        self.assertFalse(stale.exists(), out)

    def test_measure_does_not_follow_symlinks(self):
        fresh = touch(self.outside / "dir/fresh.txt", age_seconds=60)
        item = self.root / "p/item"
        touch(item / "old.txt", age_days=10)
        (item / "link").symlink_to(self.outside / "dir")
        age(item / "link", days=10)
        age(item, days=10)
        code, out = self.run_cleanup()
        self.assertEqual(code, 0, out)
        self.assertFalse(item.exists(), out)
        self.assertTrue(fresh.exists(), "root の外を指す symlink の先は残る")

    def test_symlink_item_removes_only_the_link(self):
        target = touch(self.outside / "dir/keep.txt", age_days=30)
        link = self.root / "p/link"
        link.parent.mkdir()
        link.symlink_to(self.outside / "dir")
        age(link, days=10)
        code, out = self.run_cleanup()
        self.assertEqual(code, 0, out)
        self.assertFalse(link.is_symlink(), out)
        self.assertTrue(target.exists())

    def test_symlinked_project_is_one_item(self):
        target = touch(self.outside / "dir/keep.txt", age_days=30)
        link = self.root / "proj"
        link.symlink_to(self.outside / "dir")
        age(link, days=10)
        code, out = self.run_cleanup()
        self.assertEqual(code, 0, out)
        self.assertFalse(link.is_symlink(), out)
        self.assertTrue(target.exists())

    def test_swapped_project_symlink_is_not_followed(self):
        # 判定の後で <project> を外への symlink に差し替えても、外の同名の項目を消さない（#151 の review N1）
        touch(self.root / "proj/item/old.txt", age_days=30)
        victim = touch(self.outside / "item/victim.txt", age_days=30)
        root_fd = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY)
        self.addCleanup(os.close, root_fd)
        (self.root / "proj").rename(self.root / "proj.moved")
        (self.root / "proj").symlink_to(self.outside)
        with self.assertRaises(OSError):
            tc.remove(root_fd, "proj", "item")
        self.assertTrue(victim.exists())
        with self.assertRaises(tc.Refused):
            tc.remove(root_fd, "proj.moved", "../outside")

    def test_home_or_its_ancestor_as_root_does_nothing(self):
        home = self.tmp / "home"
        precious = touch(home / "Documents/thesis.txt", age_days=30)
        for root in (home, self.tmp):
            with unittest.mock.patch.dict(os.environ, {"HOME": str(home)}):
                code, out = self.run_cleanup(root=root)
            self.assertEqual(code, 1, out)
            self.assertIn("ホーム", out)
            self.assertTrue(precious.exists())

    @unittest.skipIf(hasattr(os, "geteuid") and os.geteuid() == 0, "root では chmod 0 でも読めるので確かめられない")
    def test_unmeasurable_item_is_kept_and_reported(self):
        locked = self.root / "p/locked"
        touch(locked / "inner/a.txt", age_days=30)
        os.chmod(locked / "inner", 0)
        self.addCleanup(os.chmod, locked / "inner", 0o755)
        code, out = self.run_cleanup()
        self.assertEqual(code, 1, out)
        self.assertIn("計測できないので残す", out)
        self.assertTrue(locked.exists())

    def test_symlinked_root_does_nothing(self):
        real = self.tmp / "real"
        old = touch(real / "p/old.txt", age_days=30)
        link = self.tmp / "link-root"
        link.symlink_to(real)
        code, out = self.run_cleanup(root=link)
        self.assertEqual(code, 1, out)
        self.assertIn("symlink", out)
        self.assertTrue(old.exists())

    def test_non_directory_or_missing_root_does_nothing(self):
        plain = touch(self.tmp / "plain-file", age_days=30)
        code, out = self.run_cleanup(root=plain)
        self.assertEqual(code, 1, out)
        self.assertTrue(plain.exists())
        code, out = self.run_cleanup(root=self.tmp / "absent")
        self.assertEqual(code, 0, out)

    def test_dry_run_deletes_nothing(self):
        old = touch(self.root / "p/old.txt", age_days=30)
        link = self.root / "p/link"
        link.symlink_to(self.outside)
        age(link, days=30)
        code, out = self.run_cleanup("--dry-run")
        self.assertEqual(code, 0, out)
        self.assertTrue(old.exists() and link.is_symlink(), out)
        self.assertIn("[dry-run] 削除: %s" % old, out)


def fake_launchctl(path, log, fail_first_bootstrap=False):
    path.write_text(
        '#!/usr/bin/env bash\n'
        'printf "%%s\\n" "$*" >> "%s"\n'
        'if [ "$1" = bootstrap ] && [ "%d" = 1 ] && [ ! -e "%s.failed" ]; then touch "%s.failed"; exit 5; fi\n'
        'exit 0\n' % (log, 1 if fail_first_bootstrap else 0, log, log))
    path.chmod(0o755)


class SetupTrashable(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="trashable-setup-")).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        # setup-user-hooks.sh は派生 repo（root に .template-version がある）では止まる（#157）。派生 repo の self-test でも
        # 試せるよう、.template-version の無い fixture root から scripts/ を symlink で指して呼ぶ。
        self.src = ROOT
        if (ROOT / ".template-version").exists():
            self.src = self.tmp / "src"
            self.src.mkdir()
            (self.src / "scripts").symlink_to(ROOT / "scripts")
        self.home = self.tmp / "home"
        self.home.mkdir()
        self.bin = self.tmp / "bin"
        self.bin.mkdir()
        self.log = self.tmp / "launchctl.log"
        fake_launchctl(self.bin / "launchctl", self.log)
        self.dst = self.home / ".config/project-template/trashable-cleanup.py"
        self.plist = self.home / "Library/LaunchAgents" / (LABEL + ".plist")
        self.store = self.home / ".trashable"
        self.uid = str(os.getuid())

    def env(self, path):
        env = {k: v for k, v in os.environ.items() if k not in ("XDG_CONFIG_HOME", "CLAUDE_CONFIG_DIR")}
        env.update(HOME=str(self.home), PATH=path)
        return env

    def run_setup(self, *args, path=None):
        path = path or (str(self.bin) + os.pathsep + os.environ["PATH"])
        return subprocess.run(["bash", str(self.src / "scripts/setup-user-hooks.sh"), "--trashable"] + list(args),
                              env=self.env(path), text=True, capture_output=True)

    def calls(self):
        return self.log.read_text().splitlines() if self.log.exists() else []

    def tree(self):
        return sorted(str(p.relative_to(self.home)) for p in self.home.rglob("*"))

    def test_install_copies_writes_plist_registers_and_makes_store(self):
        result = self.run_setup()
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertEqual(self.dst.read_bytes(), (ROOT / "scripts/trashable-cleanup.py").read_bytes())
        self.assertTrue(os.access(self.dst, os.X_OK))
        data = plistlib.loads(self.plist.read_bytes())
        python = shutil.which("python3", path=str(self.bin) + os.pathsep + os.environ["PATH"])
        self.assertEqual(data["Label"], LABEL)
        self.assertEqual(data["ProgramArguments"], [python, str(self.dst), "--root", str(self.store)])
        self.assertTrue(data["ProgramArguments"][0].startswith("/"))
        self.assertEqual(data["StartCalendarInterval"], {"Hour": 12, "Minute": 0})
        log = str(self.home / "Library/Logs/project-template-trashable.log")
        self.assertEqual((data["StandardOutPath"], data["StandardErrorPath"]), (log, log))
        self.assertTrue(self.store.is_dir())
        self.assertEqual(self.calls(), ["bootout gui/%s/%s" % (self.uid, LABEL), "bootstrap gui/%s %s" % (self.uid, self.plist)])

    def test_dry_run_writes_nothing(self):
        result = self.run_setup("--dry-run")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.tree(), [])
        self.assertEqual(self.calls(), [])
        self.assertIn(str(self.plist), result.stdout)
        self.assertIn("[dry-run]", result.stdout)
        installed = self.run_setup()
        self.assertEqual(installed.returncode, 0, installed.stderr)
        before = self.tree()
        again = self.run_setup("--dry-run", "--uninstall")
        self.assertEqual(again.returncode, 0, again.stderr)
        self.assertEqual(self.tree(), before)
        self.assertEqual(len(self.calls()), 2)

    def test_rerun_is_idempotent(self):
        self.assertEqual(self.run_setup().returncode, 0)
        before_tree = self.tree()
        before = (self.dst.read_bytes(), self.plist.read_bytes())
        again = self.run_setup()
        self.assertEqual(again.returncode, 0, again.stderr)
        self.assertEqual(self.tree(), before_tree)
        self.assertEqual((self.dst.read_bytes(), self.plist.read_bytes()), before)
        want = ["bootout gui/%s/%s" % (self.uid, LABEL), "bootstrap gui/%s %s" % (self.uid, self.plist)]
        self.assertEqual(self.calls(), want * 2)

    def test_bootstrap_is_retried(self):
        fake_launchctl(self.bin / "launchctl", self.log, fail_first_bootstrap=True)
        result = self.run_setup()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([c.split()[0] for c in self.calls()], ["bootout", "bootstrap", "bootstrap"])

    def test_uninstall_removes_registration_but_keeps_store_contents(self):
        self.assertEqual(self.run_setup().returncode, 0)
        kept = touch(self.store / "proj/work.txt", age_days=30)
        result = self.run_setup("--uninstall")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(self.plist.exists() or self.dst.exists())
        self.assertFalse(self.dst.parent.exists())
        self.assertTrue(kept.exists())
        self.assertEqual(self.calls()[-1], "bootout gui/%s/%s" % (self.uid, LABEL))
        again = self.run_setup("--uninstall")
        self.assertEqual(again.returncode, 0, again.stderr)
        self.assertTrue(kept.exists())

    def test_uninstall_keeps_other_files_in_config_dir(self):
        self.assertEqual(self.run_setup().returncode, 0)
        other = self.dst.parent / "other.txt"
        other.write_text("x")
        self.assertEqual(self.run_setup("--uninstall").returncode, 0)
        self.assertTrue(other.exists() and not self.dst.exists())

    def test_fails_without_launchctl(self):
        tools = self.tmp / "tools"
        tools.mkdir()
        for name in ("bash", "python3", "id", "cmp", "mkdir", "rm", "rmdir", "cp", "chmod", "dirname", "cat", "sleep", "sed", "git", "grep", "tr"):
            found = shutil.which(name)
            if found:
                (tools / name).symlink_to(found)
        self.assertIsNone(shutil.which("launchctl", path=str(tools)))
        for extra in ([], ["--dry-run"], ["--uninstall"]):
            result = self.run_setup(*extra, path=str(tools))
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("launchctl", result.stderr)
            self.assertEqual(self.tree(), [])


if arguments.case:
    suite = unittest.TestSuite([TrashableCleanup(CASES[arguments.case])])
else:
    suite = unittest.TestSuite([unittest.defaultTestLoader.loadTestsFromTestCase(TrashableCleanup),
                                unittest.defaultTestLoader.loadTestsFromTestCase(SetupTrashable)])
result = unittest.TextTestRunner(verbosity=2, stream=sys.stdout).run(suite)
print('{"tests": %d, "failures": %d, "errors": %d, "mutation": %s, "successful": %s}' % (
    result.testsRun, len(result.failures), len(result.errors),
    '"%s"' % arguments.mutation if arguments.mutation else "null", "true" if result.wasSuccessful() else "false"))
sys.exit(0 if result.wasSuccessful() else 1)
