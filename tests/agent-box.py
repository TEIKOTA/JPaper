#!/usr/bin/env python3
"""agent-box（#126）の fixture テスト。docker / security / git の入口を fake に差し替えて検証する.

--mutation は保護の判定を 1 つ外した backend をメモリ上で作り、対応する --case が red になることを示す。
実装ファイルは変更しない。fixture は checkout 直下の .test-agent-box-* に作り、終了時に消す。
"""
import argparse
import contextlib
import importlib.util
import inspect
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
MUTATIONS = {
    # 動作中の確認は検査の前後 2 か所にあるので、両方を外して保護の喪失を示す。
    "running": [('        if self.running(state["container"]):\n            raise Stop("コンテナが動作中です（停止してから片付ける）")\n',
                 '        if False:\n            raise Stop("コンテナが動作中です（停止してから片付ける）")\n'),
                ('        if self.running(state["container"]):\n            raise Stop("検査中にコンテナが起動しました")\n',
                 '        if False:\n            raise Stop("検査中にコンテナが起動しました")\n')],
    "dirty": [('            if inspected["dirty"]:\n', '            if False:\n')],
    "retained": [('            if got != item["sha"]:\n', '            if False:\n')],
    "symlink": [('        if current.is_symlink():\n', '        if False:\n')],
    "reuse": [('        if git("for-each-ref", "--count=1", "refs/agents/%s/" % session, cwd=self.host):\n',
               '        if False:\n')],
    "results": [('        results = self.keep_results(state)\n', '        results = None\n')],
    "artifacts": [('                skipped = self.copy_artifacts(artifacts, dest / "artifacts")\n',
                  '                skipped = []\n')],
    "keepdest": [('            shutil.rmtree(dest, ignore_errors=True)\n', '            pass\n')],
    # symlink を辿る退行（分岐を外し、判定を追従に戻す）
    "follow": [('                if entry.is_symlink():\n', '                if False:\n'),
               ('elif entry.is_dir(follow_symlinks=False):', 'elif entry.is_dir():'),
               ('elif entry.is_file(follow_symlinks=False):', 'elif entry.is_file():'),
               ('shutil.copyfile(entry.path, dst / entry.name, follow_symlinks=False)',
                'shutil.copyfile(entry.path, dst / entry.name)')],
    "discard": [('            self.discard(created)\n', '            pass\n')],
    "boxlink": [('        physical(box)\n', '        pass\n')],
    "statelink": [('        if any(path.exists() or path.is_symlink() for path in (state_path, clone)):\n',
                   '        if state_path.exists() or clone.exists():\n')],
    # 制限を docker run から外す退行（#133）。子と検査は別々に外す。
    "limits": [('                *restrictions(CHILD_LIMITS),\n', '')],
    "inspectlimits": [('"--network", "none", *restrictions(INSPECT_LIMITS),\n             "--label", "%s.inspect=1"',
                       '"--network", "none",\n             "--label", "%s.inspect=1"')],
    # #137: cache の共有・ログの上限・メモリと空き容量の確認を外す退行
    "cache": [('        return "agent-box-cache-" + self.name\n', '        return "agent-box-cache"\n')],
    "logs": [('    return [*HARDENING, *LOG_LIMITS, "--memory"', '    return [*HARDENING, "--memory"')],
    "memory": [('        if need > int(info):\n', '        if False:\n')],
    "disk": [('        if host_free < MIN_FREE_BYTES:\n', '        if False:\n'),
             ('        if vm_free < MIN_FREE_BYTES:\n', '        if False:\n')],
    # #136: merge 済みと確かめられない ref を消す退行
    "prunemerge": [('            if not self.reachable(sha, tips):\n                return "branch %s が',
                    '            if False:\n                return "branch %s が')],
    "prunehead": [('                if self.reachable(sha, merged_tips + [tip for _, tip in heads]):\n',
                   '                if True:\n')],
    "pruneactive": [('        if (self.sessions / (session + ".json")).exists():\n', '        if False:\n')],
    "pruneremote": [('                if not self.reachable(sha, remotes):\n', '                if False:\n')],
    "prunename": [('        if not SESSION_PATTERN.fullmatch(session):\n            return "agent-box の session 名ではありません"\n', '')],
    "prunebaseref": [('if item["baseRefName"] == "main"]', ']')],
    "prunebase": [('if item["baseRefName"] == "main"]', ']'), ('"--base", "main", ', '')],
    "pruneold": [('"delete %s %s\\n" % (name, sha)', '"delete %s\\n" % name')],
    "prunesearch": [('                if not self.reachable(sha, tips):\n                    return "HEAD が merge 済みと確かめられません"\n',
                     '                if False:\n                    return "HEAD が merge 済みと確かめられません"\n')],
    "pruneother": [('                return "%s があるので残します" % rest\n', '                pass\n')],
    # #160: docker に繋がらないときの案内を外す退行
    "dockerhint": [('            message += DOCKER_DOWN_HINT\n', '            pass\n')],
    # #175: 残す処理（entrypoint.log・exit-code）と、起動直後の確認を外す退行
    "record": [(" 2> ~/.agent-box/entrypoint.log;", " 2>/dev/null;")],
    "startcheck": [("        self.check_started(state, box)\n", "")],
    "stalelog": [('"exit-code", "entrypoint.log"):', '"exit-code"):')],
    "dockerenv": None,  # guard-bash.sh の /.dockerenv 条件（shell 側。test 内で写しを改変する）
}
CASES = {"running": "test_clean_protects_running_container", "dirty": "test_clean_protects_uncommitted_changes",
         "retained": "test_clean_protects_unretained_ref", "symlink": "test_clean_rejects_symlinked_clone",
         "reuse": "test_start_refuses_name_with_retained_refs", "results": "test_clean_keeps_headless_results",
         "artifacts": "test_clean_keeps_artifacts_without_following_symlinks",
         "keepdest": "test_clean_artifacts_copy_failure_keeps_clone_and_removes_partial",
         "follow": "test_clean_keeps_artifacts_without_following_symlinks",
         "discard": "test_start_failure_removes_only_what_it_created",
         "boxlink": "test_start_does_not_follow_symlinked_session_dir",
         "statelink": "test_start_refuses_dangling_state_symlink",
         "limits": "test_child_container_is_restricted", "inspectlimits": "test_inspect_container_is_restricted",
         "cache": "test_cache_volume_is_per_repo", "logs": "test_child_container_is_restricted",
         "memory": "test_memory_check_holds_even_over_limit", "disk": "test_start_refuses_low_disk",
         "prunemerge": "test_prune_removes_only_confirmed_merged_sessions",
         "prunehead": "test_prune_removes_only_confirmed_merged_sessions",
         "pruneactive": "test_prune_removes_only_confirmed_merged_sessions",
         "pruneother": "test_prune_removes_only_confirmed_merged_sessions",
         "pruneremote": "test_prune_removes_only_confirmed_merged_sessions",
         "prunename": "test_prune_removes_only_confirmed_merged_sessions",
         "prunebase": "test_prune_removes_only_confirmed_merged_sessions",
         "prunebaseref": "test_prune_checks_base_even_if_gh_ignores_it",
         "pruneold": "test_prune_reports_and_continues_when_a_ref_moves",
         "prunesearch": "test_prune_removes_merged_review_sessions_without_branch",
         "dockerhint": "test_docker_down_points_to_orb_start",
         "record": "test_entrypoint_failure_is_recorded_and_reported",
         "startcheck": "test_entrypoint_failure_is_recorded_and_reported",
         "stalelog": "test_stale_entrypoint_log_is_not_shown",
         "dockerenv": "test_guard_stays_on_host_even_with_agent_box_env"}
parser = argparse.ArgumentParser()
parser.add_argument("--mutation", choices=sorted(MUTATIONS))
parser.add_argument("--case", choices=sorted(CASES))
arguments = parser.parse_args()

backend = ROOT / "scripts/lib/agent_box.py"
spec = importlib.util.spec_from_file_location("agent_box", backend)
ab = importlib.util.module_from_spec(spec)
source = backend.read_text()
if arguments.mutation and MUTATIONS[arguments.mutation]:
    for needle, replacement in MUTATIONS[arguments.mutation]:
        if source.count(needle) != 1:
            # 注入できなかったことを、保護の喪失（assertion の red = exit 1）と区別する
            print("regression injection target changed: %r" % needle[:60], file=sys.stderr)
            sys.exit(3)
        source = source.replace(needle, replacement)
exec(compile(source, str(backend), "exec"), ab.__dict__)

REAL_GIT = shutil.which("git")
FAKE_DOCKER = r'''#!/usr/bin/env python3
import json, os, subprocess, sys
from pathlib import Path
state = Path(os.environ["FAKE_STATE"])
args = sys.argv[1:]
with (state / "docker.log").open("a") as log:
    log.write(json.dumps({"argv": args, "secrets": {k: k in os.environ for k in ("GH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN")}}) + "\n")
running = [n for n in (state / "running").read_text().split() if n] if (state / "running").exists() else []
if os.environ.get("FAKE_DOCKER_DOWN"):
    sys.stderr.write("failed to connect to the docker API at unix:///Users/fixture/.orbstack/run/docker.sock\\n")
    sys.exit(1)
if args[:1] == ["ps"]:
    names = running
    if (state / "just-started").exists():
        names = names + [(state / "just-started").read_text()]
        (state / "just-started").unlink()
    if "name=^/" in " ".join(args):
        wanted = [a for a in args if a.startswith("name=^/")][0][len("name=^/"):-1]
        names = [n for n in names if n == wanted]
    print("\n".join(names if "--format" in args else ["id-" + n for n in names]))
    sys.exit(0)
if args[:1] == ["run"] and "-d" in args and "--name" in args:
    name = args[args.index("--name") + 1]
    if os.environ.get("FAKE_NO_WRAPPER"):
        sys.exit(0)  # ラッパーが何も書かずに止まった（running にもならない）
    if os.environ.get("FAKE_ENTRYPOINT_FAIL"):
        # 実際のラッパーを、失敗する偽のエントリポイントで走らせる（コンテナの中の ~ は session の home）
        mounts = dict(reversed(a.split(":", 1)) for a in (args[i + 1] for i, x in enumerate(args) if x == "-v"))
        entry = state / "entrypoint.sh"
        entry.write_text(os.environ["FAKE_ENTRYPOINT_FAIL"])
        script = args[args.index("-c") + 1].replace("/usr/local/lib/agent-box/entrypoint.sh", "bash " + str(entry))
        subprocess.run(["bash", "-c", script, "agent-box", "true"], env=dict(os.environ, HOME=mounts["/home/node"]))
    else:
        (state / "just-started").write_text(name)  # 起動の確認の 1 回だけ running に見せる（後の clean を塞がない）
    sys.exit(0)
if args[:2] == ["image", "inspect"]:
    sys.exit(0)
if args[:1] == ["info"]:
    print(os.environ.get("FAKE_MEMTOTAL", str(16 * 1024 ** 3)))
    sys.exit(0)
if args[:1] == ["run"] and "--entrypoint" in args and args[args.index("--entrypoint") + 1] == "df" and os.environ.get("FAKE_DF_GARBLED"):
    print("unexpected")
    sys.exit(0)
if args[:2] == ["system", "df"]:
    print(json.dumps([{"Name": "agent-box-cache-other", "Size": "9GB"}, {"Name": "agent-box-cache-repo", "Size": "1.5MB"}]))
    sys.exit(0)
if args[:1] == ["run"] and "--entrypoint" in args and args[args.index("--entrypoint") + 1] == "df":
    print("Filesystem     1024-blocks     Used Available Capacity Mounted on")
    print("/dev/vdb1        102498304 14723308 %s      15%% /cache" % os.environ.get("FAKE_VM_FREE_KB", str(50 * 1024 * 1024)))
    sys.exit(0)
if args[:1] == ["run"] and "--entrypoint" in args:
    mounts = dict(reversed(a.rsplit(":", 2)[:2]) if a.endswith(":ro") else reversed(a.split(":", 1))
                  for a in (args[i + 1] for i, x in enumerate(args) if x == "-v"))
    env = dict(os.environ, INSPECT_REPO=mounts["/repo"], INSPECT_OUT=mounts["/out"], FAKE_IN_CONTAINER="1")
    result = subprocess.run(["bash", os.environ["FAKE_INSPECT"]], env=env)
    drop = os.environ.get("FAKE_DROP_REF")
    if drop and result.returncode == 0:
        data = json.loads(Path(mounts["/out"], "inspect.json").read_text())
        keep = [r["ref"] for r in data["refs"] if r["ref"] != drop]
        subprocess.run(["git", "-C", mounts["/repo"], "bundle", "create", str(Path(mounts["/out"], "refs.bundle")), *keep],
                       env=env, check=True, capture_output=True)
    sys.exit(result.returncode)
if args[:1] == ["run"]:
    sys.exit(0)
sys.exit(3)
'''
FAKE_GIT = r'''#!/usr/bin/env python3
import json, os, sys
with open(os.path.join(os.environ["FAKE_STATE"], "git.log"), "a") as log:
    log.write(json.dumps({"cwd": os.getcwd(), "argv": sys.argv[1:], "container": os.environ.get("FAKE_IN_CONTAINER") == "1"}) + "\n")
if os.environ.get("FAKE_GIT_FAIL") in sys.argv[1:]:
    sys.stderr.write("fake git: forced failure\n")
    sys.exit(2)
os.execv(os.environ["FAKE_REAL_GIT"], ["git", *sys.argv[1:]])
'''
FAKE_SECURITY = r'''#!/usr/bin/env python3
import json, os, sys
tokens = json.load(open(os.path.join(os.environ["FAKE_STATE"], "tokens.json")))
service = sys.argv[sys.argv.index("-s") + 1]
if service not in tokens:
    sys.exit(44)
print(tokens[service])
'''
FAKE_GH = r'''#!/usr/bin/env python3
import json, os, sys
if os.environ.get("FAKE_GH_FAIL"):
    sys.exit(1)
if os.environ.get("FAKE_GH_GARBLED"):
    print("not json")
    sys.exit(0)
args = sys.argv[1:]
prs = os.path.join(os.environ["FAKE_STATE"], "prs.json")
merged = json.load(open(prs)) if os.path.exists(prs) else {}
# 値は [head SHA, base branch]。--base を渡されたら、それ以外の base は GitHub と同じく返さない
key = args[args.index("--head") + 1] if "--head" in args else "search:" + args[args.index("--search") + 1]
items = [{"headRefOid": sha, "baseRefName": base} for sha, base in merged.get(key, [])]
if "--base" in args and not os.environ.get("FAKE_GH_IGNORE_BASE"):
    items = [item for item in items if item["baseRefName"] == args[args.index("--base") + 1]]
print(json.dumps(items))
'''
TOKENS = {"agent-gh-token-repo": "github_pat_FIXTURESECRET", "agent-claude-oauth-token": "sk-ant-oat-FIXTURESECRET"}


def git(cwd, *argv):
    return subprocess.run([REAL_GIT, *argv], cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


class AgentBox(unittest.TestCase):
    def setUp(self):
        self.fixture = Path(tempfile.mkdtemp(prefix=".test-agent-box-", dir=ROOT)).resolve()
        self.addCleanup(shutil.rmtree, self.fixture, True)
        self.home = self.fixture / "home"
        self.state = self.fixture / "state"
        fakebin = self.fixture / "bin"
        for directory in (self.home / ".claude/skills/demo", self.home / ".claude/projects", self.state, fakebin):
            directory.mkdir(parents=True)
        (self.home / ".claude/CLAUDE.md").write_text("# user rules\n")
        (self.home / ".claude/skills/demo/SKILL.md").write_text("demo\n")
        (self.home / ".claude/projects/memory.md").write_text("private memory\n")
        (self.home / ".claude/.credentials.json").write_text("{}")
        (self.state / "tokens.json").write_text(json.dumps(TOKENS))
        for name, body in (("docker", FAKE_DOCKER), ("git", FAKE_GIT), ("security", FAKE_SECURITY), ("gh", FAKE_GH)):
            (fakebin / name).write_text(body)
            (fakebin / name).chmod(0o755)
        self.repo = self.fixture / "repo"
        self.repo.mkdir()
        git(self.repo, "init", "-q", "-b", "main")
        git(self.repo, "config", "user.name", "Fixture")
        git(self.repo, "config", "user.email", "fixture@example.invalid")
        (self.repo / ".gitignore").write_text("ignored/\n")
        (self.repo / "README.md").write_text("fixture\n")
        git(self.repo, "add", ".")
        git(self.repo, "commit", "-qm", "fixture")
        git(self.repo, "remote", "add", "origin", "git@github.com:fixture/repo.git")
        git(self.repo, "update-ref", "refs/remotes/origin/main", "HEAD")
        environment = {"HOME": str(self.home), "AGENT_BOX_HOME": str(self.fixture / "agents"),
                       "PATH": str(fakebin) + os.pathsep + os.environ["PATH"], "FAKE_STATE": str(self.state),
                       "FAKE_REAL_GIT": REAL_GIT, "FAKE_INSPECT": str(ROOT / "docker/agent/inspect.sh"),
                       "GIT_CONFIG_NOSYSTEM": "1"}
        patcher = mock.patch.dict(os.environ, environment)
        patcher.start()
        self.addCleanup(patcher.stop)
        # ホストの実ディスクの空きに結果を左右させない（空きの判定は個別の test で与える）
        self.host_free = 50 * 1024 ** 3
        disk = mock.patch.object(ab.shutil, "disk_usage", side_effect=lambda path: SimpleNamespace(free=self.host_free))
        disk.start()
        self.addCleanup(disk.stop)
        wait = mock.patch.object(ab, "STARTUP_WAIT", 0)
        wait.start()
        self.addCleanup(wait.stop)
        self.prompt = self.fixture / "prompt.md"
        self.prompt.write_text("fixture task\n")

    def cli(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = ab.main(["--repo", str(self.repo), *argv])
        return code, (json.loads(out.getvalue()) if code == 0 else None), err.getvalue()

    def start(self, session="s1", *extra):
        code, result, err = self.cli("start", session, "--prompt-file", str(self.prompt), *extra)
        self.assertEqual(code, 0, err)
        return result

    def clone(self, session="s1"):
        return self.fixture / "agents/repo" / session

    def docker_log(self):
        return [json.loads(line) for line in (self.state / "docker.log").read_text().splitlines()]

    def set_running(self, *names):
        (self.state / "running").write_text("\n".join(names))

    # ---- 起動 ----
    def test_start_creates_clone_and_passes_secrets_by_name_only(self):
        self.start("s1", "--branch", "feat/126-fixture")
        clone = self.clone()
        self.assertEqual(git(clone, "branch", "--show-current"), "feat/126-fixture")
        self.assertEqual(git(clone, "rev-parse", "HEAD"), git(self.repo, "rev-parse", "origin/main"))
        self.assertEqual(git(clone, "remote", "get-url", "origin"), "https://github.com/fixture/repo.git")
        run = [entry for entry in self.docker_log() if entry["argv"][0] == "run"][-1]
        joined = " ".join(run["argv"])
        self.assertNotIn("FIXTURESECRET", joined)
        self.assertIn("-e GH_TOKEN", joined)
        self.assertIn("-e CLAUDE_CODE_OAUTH_TOKEN", joined)
        self.assertEqual(run["secrets"], {"GH_TOKEN": True, "CLAUDE_CODE_OAUTH_TOKEN": True})
        self.assertNotIn("docker.sock", joined)
        self.assertNotIn("SSH_AUTH_SOCK", joined)
        home = self.fixture / "agents/repo/.sessions/s1/home"
        self.assertTrue((home / ".claude/CLAUDE.md").is_file())
        self.assertTrue((home / ".claude/skills/demo/SKILL.md").is_file())
        self.assertFalse((home / ".claude/projects").exists())
        self.assertFalse((home / ".claude/.credentials.json").exists())
        self.assertNotIn("hooks", json.loads((home / ".claude/settings.json").read_text()))
        self.assertEqual((home / ".agent-box/prompt.md").read_text(), "fixture task\n")

    # ---- 起動の失敗の記録と検出（#175） ----
    def test_entrypoint_failure_is_recorded_and_reported(self):
        for command in ("start", "resume"):
            session = "s-" + command
            if command == "resume":
                self.start(session)
                self.set_running()
            with mock.patch.dict(os.environ, {"FAKE_ENTRYPOINT_FAIL": "echo entrypoint-boom >&2\nexit 7\n"}):
                code, result, err = self.cli(*(("start", session + "x") if command == "start" else ("resume", session)),
                                             "--prompt-file", str(self.prompt))
            self.assertNotEqual(code, 0)
            self.assertIsNone(result)
            self.assertIn("entrypoint-boom", err)
            self.assertIn("exit code: 7", err)
            box = self.fixture / "agents/repo/.sessions" / (session + ("x" if command == "start" else "")) / "home/.agent-box"
            self.assertIn("entrypoint-boom", (box / "entrypoint.log").read_text())
            self.assertEqual((box / "exit-code").read_text().strip(), "7")

    def test_stale_entrypoint_log_is_not_shown(self):
        self.start("s1")
        self.set_running()
        box = self.fixture / "agents/repo/.sessions/s1/home/.agent-box"
        (box / "entrypoint.log").write_text("STALE-FROM-LAST-RUN\n")
        with mock.patch.dict(os.environ, {"FAKE_NO_WRAPPER": "1"}):
            code, _, err = self.cli("resume", "s1", "--prompt-file", str(self.prompt))
        self.assertNotEqual(code, 0)
        self.assertNotIn("STALE-FROM-LAST-RUN", err)
        self.assertFalse((box / "entrypoint.log").exists())
        self.assertIn("resume s1", err)
        self.assertIn("clean s1", err)

    def test_entrypoint_failure_log_has_no_secret(self):
        with mock.patch.dict(os.environ, {"FAKE_ENTRYPOINT_FAIL": "echo failed >&2\nexit 1\n"}):
            code, _, err = self.cli("start", "s1", "--prompt-file", str(self.prompt))
        self.assertNotEqual(code, 0)
        box = self.fixture / "agents/repo/.sessions/s1/home/.agent-box"
        self.assertNotIn("FIXTURESECRET", err + (box / "entrypoint.log").read_text())

    def test_healthy_container_still_reports_running(self):
        result = self.start("s1")
        self.assertEqual(result["state"], "running")
        self.assertTrue(result["entrypoint_log"].endswith("entrypoint.log"))
        run = [entry for entry in self.docker_log() if entry["argv"][0] == "run"][-1]["argv"]
        self.assertEqual(run[run.index("--entrypoint") + 1], "bash")

    def assert_restricted(self, argv):
        """書き込み層・資源・権限の制限が入り、/tmp は exec 可の上限つき tmpfs になっている（#133）."""
        def value(flag):
            return argv[argv.index(flag) + 1]
        self.assertIn("--read-only", argv)
        self.assertEqual(value("--cap-drop"), "ALL")
        self.assertEqual(value("--security-opt"), "no-new-privileges")
        self.assertEqual(value("--memory-swap"), value("--memory"))
        self.assertTrue(value("--memory").endswith("g"))
        self.assertGreater(int(value("--pids-limit")), 0)
        options = value("--tmpfs").split(":", 1)
        self.assertEqual(options[0], "/tmp")
        flags = options[1].split(",")
        self.assertIn("exec", flags)
        self.assertNotIn("noexec", flags)
        self.assertTrue(any(flag.startswith("size=") for flag in flags))
        self.assertTrue(any(flag.startswith("nr_inodes=") for flag in flags))
        log_options = [argv[i + 1] for i, item in enumerate(argv) if item == "--log-opt"]
        self.assertIn("max-size=10m", log_options)
        self.assertIn("max-file=3", log_options)

    def test_child_container_is_restricted(self):
        self.start("s1")
        run = [entry["argv"] for entry in self.docker_log() if entry["argv"][0] == "run"][-1]
        self.assert_restricted(run)
        self.assertNotIn("--privileged", run)

    # ---- cache・メモリ・空き容量（#137） ----
    def test_cache_volume_is_per_repo(self):
        self.start("s1")
        run = [entry["argv"] for entry in self.docker_log() if entry["argv"][0] == "run"][-1]
        mounts = [run[i + 1] for i, item in enumerate(run) if item == "-v"]
        self.assertIn("agent-box-cache-repo:/cache", mounts)
        self.assertNotIn("agent-box-cache:/cache", mounts)
        code, listed, err = self.cli("list")
        self.assertEqual(code, 0, err)
        self.assertEqual(listed["cache"], {"volume": "agent-box-cache-repo", "size": "1.5MB"})

    def test_limits_fit_reference_vm(self):
        # OrbStack の既定の VM（約 11.7 GiB。ADR 20261012）に、上限個の子と検査 1 つが収まる
        reference = int(11.7 * 1024 ** 3)
        total = ab.DEFAULT_LIMIT * ab.size_bytes(ab.CHILD_LIMITS["memory"]) + ab.size_bytes(ab.INSPECT_LIMITS["memory"])
        self.assertLessEqual(total, reference)
        self.assertLess(ab.size_bytes(ab.CHILD_LIMITS["tmp_size"]), ab.size_bytes(ab.CHILD_LIMITS["memory"]))
        self.assertLess(ab.size_bytes(ab.INSPECT_LIMITS["tmp_size"]), ab.size_bytes(ab.INSPECT_LIMITS["memory"]))

    def test_memory_check_holds_even_over_limit(self):
        self.set_running("agent-repo-a", "agent-repo-b", "agent-repo-c")
        os.environ["FAKE_MEMTOTAL"] = str(int(11.7 * 1024 ** 3))
        code, _, err = self.cli("start", "s1", "--prompt-file", str(self.prompt), "--allow-over-limit")
        self.assertEqual(code, 1)
        self.assertIn("メモリが足りません", err)
        self.assert_nothing_created()
        os.environ["FAKE_MEMTOTAL"] = str(32 * 1024 ** 3)  # 容量が足りれば --allow-over-limit で個数を超えられる
        self.start("s1", "--allow-over-limit")

    def assert_nothing_created(self, session="s1"):
        self.assertFalse(self.clone(session).exists())
        self.assertFalse((self.fixture / "agents/repo/.sessions" / session).exists())
        self.assertFalse((self.fixture / "agents/repo/.sessions" / (session + ".json")).exists())

    def test_start_stops_when_capacity_is_unreadable(self):
        for variable, value, message in (("FAKE_MEMTOTAL", "unknown", "メモリ量を読めません"),
                                         ("FAKE_DF_GARBLED", "1", "ディスクの空きを読めません")):
            with mock.patch.dict(os.environ, {variable: value}):
                code, _, err = self.cli("start", "s1", "--prompt-file", str(self.prompt))
            self.assertEqual((code, message in err), (1, True), err)
            self.assert_nothing_created()

    def test_resume_checks_memory(self):
        self.start("s1")
        self.set_running("agent-repo-a", "agent-repo-b")
        os.environ["FAKE_MEMTOTAL"] = str(8 * 1024 ** 3)
        code, _, err = self.cli("resume", "s1", "--prompt-file", str(self.prompt))
        self.assertEqual((code, "メモリが足りません" in err), (1, True))

    def test_start_refuses_low_disk(self):
        self.host_free = 4 * 1024 ** 3
        code, _, err = self.cli("start", "s1", "--prompt-file", str(self.prompt))
        self.assertEqual((code, "ホストのディスクの空き" in err), (1, True))
        self.assert_nothing_created()
        self.host_free = 50 * 1024 ** 3
        os.environ["FAKE_VM_FREE_KB"] = str(4 * 1024 * 1024)
        code, _, err = self.cli("start", "s1", "--prompt-file", str(self.prompt))
        self.assertEqual((code, "VM のディスクの空き" in err), (1, True))
        self.assert_nothing_created()

    def test_inspect_container_is_restricted(self):
        self.start("s1")
        self.assertEqual(self.cli("clean", "s1")[0], 0)
        run = [entry["argv"] for entry in self.docker_log() if entry["argv"][0] == "run" and "--entrypoint" in entry["argv"]][-1]
        self.assert_restricted(run)
        self.assertEqual(run[run.index("--network") + 1], "none")

    def test_start_rejects_bad_input_before_creating_anything(self):
        for argv, message in ((["BAD"], "session 名"), (["s2", "--base", git(self.repo, "rev-parse", "HEAD")], "ref 名"),
                              (["s3", "--branch", "not-a-valid-branch"], "コマンド失敗")):
            code, _, err = self.cli("start", *argv, "--prompt-file", str(self.prompt))
            self.assertEqual(code, 1)
            self.assertIn(message, err)
        self.assertFalse(self.clone("s2").exists())
        self.start("s1")
        code, _, err = self.cli("start", "s1", "--prompt-file", str(self.prompt))
        self.assertEqual((code, "既にあります" in err), (1, True))

    def test_start_without_token_stops_before_clone(self):
        (self.state / "tokens.json").write_text(json.dumps({"agent-claude-oauth-token": "x"}))
        code, _, err = self.cli("start", "s1", "--prompt-file", str(self.prompt))
        self.assertEqual(code, 1)
        self.assertIn("agent-gh-token-repo", err)
        self.assertFalse(self.clone().exists())

    def test_start_rejects_malformed_token_without_showing_it(self):
        (self.state / "tokens.json").write_text(json.dumps(dict(
            TOKENS, **{"agent-claude-oauth-token": "security add-generic-password -a me -s x -w"})))
        code, _, err = self.cli("start", "s1", "--prompt-file", str(self.prompt))
        self.assertEqual(code, 1)
        self.assertIn("トークンの形ではありません", err)
        self.assertNotIn("add-generic-password", err)
        self.assertFalse(self.clone().exists())

    def fail_start(self, session="s1"):
        with mock.patch.dict(os.environ, {"FAKE_GIT_FAIL": "fetch"}):
            code, _, err = self.cli("start", session, "--prompt-file", str(self.prompt))
        self.assertEqual(code, 1)
        self.assertIn("コマンド失敗", err)

    def test_start_failure_removes_only_what_it_created(self):
        sessions = self.fixture / "agents/repo/.sessions"
        self.fail_start()
        self.assertFalse(self.clone().exists())
        self.assertFalse((sessions / "s1").exists())
        self.assertFalse((sessions / "s1.json").exists())
        self.start("s1")  # 同じ名前ですぐ始め直せる
        # 前から在った session の dir（別の物を含む）は残し、この start が作った home と clone だけ消す。
        (sessions / "s2").mkdir()
        (sessions / "s2/keep.txt").write_text("pre-existing")
        self.fail_start("s2")
        self.assertEqual((sessions / "s2/keep.txt").read_text(), "pre-existing")
        self.assertFalse((sessions / "s2/home").exists())
        self.assertFalse(self.clone("s2").exists())
        self.assertTrue((self.clone("s1") / ".git").is_dir())

    def test_start_failure_does_not_follow_symlinked_sessions_dir(self):
        agents = self.fixture / "agents/repo"
        elsewhere = self.fixture / "elsewhere"
        elsewhere.mkdir()
        (elsewhere / "keep.txt").write_text("pre-existing")
        agents.mkdir(parents=True)
        (agents / ".sessions").symlink_to(elsewhere)
        code, _, err = self.cli("start", "s1", "--prompt-file", str(self.prompt))
        self.assertEqual(code, 1)
        self.assertIn("symlink", err)
        self.assertEqual(sorted(path.name for path in elsewhere.iterdir()), ["keep.txt"])
        self.assertFalse(self.clone().exists())

    def test_start_does_not_follow_symlinked_session_dir(self):
        # .sessions/<session> が symlink なら、先に mkdir / chmod を作用させず、何も作らずに止まる。
        sessions = self.fixture / "agents/repo/.sessions"
        sessions.mkdir(parents=True)
        elsewhere = self.fixture / "elsewhere"
        elsewhere.mkdir(mode=0o755)
        elsewhere.chmod(0o755)
        (elsewhere / "keep.txt").write_text("pre-existing")
        (sessions / "s1").symlink_to(elsewhere)
        code, _, err = self.cli("start", "s1", "--prompt-file", str(self.prompt))
        self.assertEqual(code, 1)
        self.assertIn("symlink", err)
        self.assertEqual(sorted(path.name for path in elsewhere.iterdir()), ["keep.txt"])
        self.assertEqual((elsewhere / "keep.txt").read_text(), "pre-existing")
        self.assertEqual(elsewhere.stat().st_mode & 0o777, 0o755)
        self.assertFalse(self.clone().exists())

    def test_start_refuses_dangling_state_symlink(self):
        sessions = self.fixture / "agents/repo/.sessions"
        sessions.mkdir(parents=True)
        target = self.fixture / "elsewhere.json"
        (sessions / "s1.json").symlink_to(target)
        code, _, err = self.cli("start", "s1", "--prompt-file", str(self.prompt))
        self.assertEqual(code, 1)
        self.assertIn("既にあります", err)
        self.assertFalse(target.exists())
        self.assertFalse(self.clone().exists())

    def test_concurrency_limit(self):
        self.set_running("a", "b", "c")
        code, _, err = self.cli("start", "s1", "--prompt-file", str(self.prompt))
        self.assertEqual(code, 1)
        self.assertIn("上限", err)
        self.start("s1", "--allow-over-limit")

    def test_docker_down_points_to_orb_start(self):
        with mock.patch.dict(os.environ, {"FAKE_DOCKER_DOWN": "1"}):
            code, _, err = self.cli("list")
        self.assertEqual(code, 1)
        self.assertIn("failed to connect to the docker API", err)
        self.assertIn("orb start", err)
        # 再起動・リセットは案内しても、利用者の判断だと添える
        self.assertIn("利用者の判断", err)

    def test_list(self):
        self.start("s1")
        self.set_running("agent-repo-s1")
        code, result, _ = self.cli("list")
        self.assertEqual(code, 0)
        self.assertEqual([(row["session"], row["running"]) for row in result["sessions"]], [("s1", True)])

    # ---- 片付け ----
    def child_work(self):
        clone = self.clone()
        git(clone, "config", "user.name", "Child")
        git(clone, "config", "user.email", "child@example.invalid")
        (clone / "README.md").write_text("changed by child\n")
        git(clone, "commit", "-qam", "child work")
        git(clone, "tag", "child-tag")
        (clone / "README.md").write_text("stashed\n")
        git(clone, "stash", "-q")
        git(clone, "checkout", "-q", "--detach")
        git(clone, "commit", "-q", "--allow-empty", "-m", "detached work")
        (clone / "ignored").mkdir()
        (clone / "ignored/cache.bin").write_text("disposable")
        return {"branch": git(clone, "rev-parse", "feat/126-fixture"), "head": git(clone, "rev-parse", "HEAD"),
                "stash": git(clone, "rev-parse", "refs/stash"), "tag": git(clone, "rev-parse", "child-tag")}

    def test_clean_retains_every_ref_then_removes_session(self):
        self.start("s1", "--branch", "feat/126-fixture")
        expected = self.child_work()
        code, result, err = self.cli("clean", "s1")
        self.assertEqual(code, 0, err)
        self.assertFalse(self.clone().exists())
        self.assertFalse((self.fixture / "agents/repo/.sessions/s1").exists())
        self.assertFalse((self.fixture / "agents/repo/.sessions/s1.json").exists())
        for ref, key in (("refs/agents/s1/heads/feat/126-fixture", "branch"), ("refs/agents/s1/HEAD", "head"),
                         ("refs/agents/s1/stash", "stash"), ("refs/agents/s1/tags/child-tag", "tag")):
            self.assertEqual(git(self.repo, "rev-parse", ref), expected[key], ref)
        self.assertEqual(result["state"], "cleaned")

    def test_clean_protects_uncommitted_changes(self):
        self.start("s1")
        (self.clone() / "README.md").write_text("uncommitted\n")
        code, _, err = self.cli("clean", "s1")
        self.assertEqual(code, 1)
        self.assertIn("未コミット", err)
        git(self.clone(), "checkout", "--", "README.md")
        (self.clone() / "new-file").write_text("untracked\n")
        code, _, err = self.cli("clean", "s1")
        self.assertEqual(code, 1)
        self.assertTrue(self.clone().exists())

    def test_clean_protects_running_container(self):
        self.start("s1")
        self.set_running("agent-repo-s1")
        code, _, err = self.cli("clean", "s1")
        self.assertEqual(code, 1)
        self.assertIn("動作中", err)
        self.assertTrue(self.clone().exists())

    def test_clean_protects_unretained_ref(self):
        self.start("s1", "--branch", "feat/126-fixture")
        git(self.clone(), "commit", "-q", "--allow-empty", "-m", "only here")
        with mock.patch.dict(os.environ, {"FAKE_DROP_REF": "refs/heads/feat/126-fixture"}):
            code, _, err = self.cli("clean", "s1")
        self.assertEqual(code, 1)
        self.assertIn("取り込めていない", err)
        self.assertTrue(self.clone().exists())

    def test_clean_rejects_symlinked_clone(self):
        # ~/agents/<repo> 自体が別の場所を指す symlink なら、そこを消さずに止まる。
        self.start("s1")
        elsewhere = self.fixture / "elsewhere"
        (self.fixture / "agents/repo").rename(elsewhere)
        (self.fixture / "agents/repo").symlink_to(elsewhere)
        code, _, err = self.cli("clean", "s1")
        self.assertEqual(code, 1)
        self.assertIn("symlink", err)
        self.assertTrue((elsewhere / "s1/.git").is_dir())

    def test_start_refuses_name_with_retained_refs(self):
        # 片付け済みの session の成果は refs/agents/<session>/ だけに残る。同名の再利用で上書きさせない。
        self.start("s1", "--branch", "feat/126-fixture")
        git(self.clone(), "commit", "-q", "--allow-empty", "-m", "only here")
        code, _, err = self.cli("clean", "s1")
        self.assertEqual(code, 0, err)
        kept = git(self.repo, "rev-parse", "refs/agents/s1/heads/feat/126-fixture")
        code, _, err = self.cli("start", "s1", "--prompt-file", str(self.prompt))
        self.assertEqual(code, 1)
        self.assertIn("取り込み済み", err)
        self.assertFalse(self.clone().exists())
        self.assertEqual(git(self.repo, "rev-parse", "refs/agents/s1/heads/feat/126-fixture"), kept)

    def test_clean_keeps_headless_results(self):
        self.start("s1")
        box = self.fixture / "agents/repo/.sessions/s1/home/.agent-box"
        (box / "output.log").write_text("review report\n")
        (box / "exit-code").write_text("0\n")
        code, result, err = self.cli("clean", "s1")
        self.assertEqual(code, 0, err)
        self.assertFalse(box.exists())
        self.assertIsNotNone(result["results"], "headless の結果を写さずに消した")
        kept = Path(result["results"])
        self.assertEqual(kept.parent, self.fixture / "agents/repo/.results")
        self.assertEqual((kept / "output.log").read_text(), "review report\n")
        self.assertEqual((kept / "exit-code").read_text(), "0\n")
        self.assertEqual((kept / "prompt.md").read_text(), "fixture task\n")

    def test_clean_keeps_artifacts_without_following_symlinks(self):
        self.start("s1")
        box = self.fixture / "agents/repo/.sessions/s1/home/.agent-box"
        artifacts = box / "artifacts"
        self.assertTrue(artifacts.is_dir(), "artifacts の置き場が用意されていない")
        (artifacts / "a/b").mkdir(parents=True)
        (artifacts / "report.html").write_text("<p>top</p>\n")
        (artifacts / "a/b/data.csv").write_text("1,2\n")
        (artifacts / "leak").symlink_to(self.home / ".claude/.credentials.json")
        (artifacts / "a/dirleak").symlink_to(self.home / ".claude")
        os.mkfifo(artifacts / "a/pipe")
        code, result, err = self.cli("clean", "s1")
        self.assertEqual(code, 0, err)
        kept = Path(result["results"]) / "artifacts"
        self.assertTrue((kept / "report.html").is_file(), "成果物を写さずに消した")
        self.assertTrue((kept / "a/b/data.csv").is_file(), "入れ子の成果物を写さずに消した")
        self.assertEqual((kept / "report.html").read_text(), "<p>top</p>\n")
        self.assertEqual((kept / "a/b/data.csv").read_text(), "1,2\n")
        self.assertFalse((kept / "leak").exists() or (kept / "leak").is_symlink())
        self.assertFalse((kept / "a/dirleak").exists() or (kept / "a/dirleak").is_symlink())
        self.assertEqual((Path(result["results"]) / "skipped.txt").read_text().split(),
                         ["a/dirleak", "a/pipe", "leak"])
        self.assertFalse(self.clone().exists())

    def test_clean_artifacts_copy_failure_keeps_clone_and_removes_partial(self):
        self.start("s1")
        box = self.fixture / "agents/repo/.sessions/s1/home/.agent-box"
        (box / "artifacts/a").mkdir()
        (box / "artifacts/a/ok.txt").write_text("ok\n")
        (box / "artifacts/report.html").write_text("x\n")
        real = shutil.copyfile

        def failing(src, dst, **kwargs):
            if str(src).endswith("report.html"):
                raise OSError("disk full")
            return real(src, dst, **kwargs)
        with mock.patch.object(ab.shutil, "copyfile", failing):
            code, _, err = self.cli("clean", "s1")
        self.assertEqual(code, 1)
        self.assertIn("成果物を写せませんでした", err)
        self.assertTrue(self.clone().exists())
        self.assertTrue(box.exists())
        results = self.fixture / "agents/repo/.results"
        self.assertEqual(list(results.iterdir()) if results.exists() else [], [], "作りかけの写しが残った")

    def test_copy_artifacts_does_not_recurse(self):
        # 再帰で辿ると深い入れ子で RecursionError になる。軽い fixture（80 段）と低い再帰上限で、再帰しないことを示す。
        source, dest = self.fixture / "src", self.fixture / "dst"
        deep = source
        for _ in range(80):
            deep = deep / "d"
        deep.mkdir(parents=True)
        (deep / "leaf.txt").write_text("deep\n")
        limit = sys.getrecursionlimit()
        sys.setrecursionlimit(len(inspect.stack(0)) + 40)
        try:
            skipped = ab.Box.copy_artifacts(source, dest)
        finally:
            sys.setrecursionlimit(limit)
        self.assertEqual(skipped, [])
        self.assertTrue((dest / "/".join(["d"] * 80) / "leaf.txt").is_file())

    def test_clean_recursion_error_is_a_copy_failure(self):
        self.start("s1")
        box = self.fixture / "agents/repo/.sessions/s1/home/.agent-box"
        (box / "artifacts/x.txt").write_text("x\n")
        with mock.patch.object(ab.shutil, "copyfile", side_effect=RecursionError):
            code, _, err = self.cli("clean", "s1")
        self.assertEqual(code, 1)
        self.assertIn("成果物を写せませんでした", err)
        self.assertTrue(self.clone().exists())
        results = self.fixture / "agents/repo/.results"
        self.assertEqual(list(results.iterdir()) if results.exists() else [], [])

    def test_clean_rejects_symlinked_artifacts_dir(self):
        self.start("s1")
        box = self.fixture / "agents/repo/.sessions/s1/home/.agent-box"
        shutil.rmtree(box / "artifacts")
        (box / "artifacts").symlink_to(self.home / ".claude")
        code, _, err = self.cli("clean", "s1")
        self.assertEqual(code, 1)
        self.assertIn("ディレクトリではありません", err)
        self.assertTrue(self.clone().exists())
        self.assertFalse((self.fixture / "agents/repo/.results").exists())

    def test_clean_rejects_symlinked_results(self):
        # 子は home を書き換えられる。結果を写すときに symlink を辿って手元のファイルを読まない。
        self.start("s1")
        box = self.fixture / "agents/repo/.sessions/s1/home/.agent-box"
        (box / "output.log").symlink_to(self.home / ".claude/.credentials.json")
        code, _, err = self.cli("clean", "s1")
        self.assertEqual(code, 1)
        self.assertIn("通常のファイルではありません", err)
        self.assertTrue(self.clone().exists())
        self.assertFalse((self.fixture / "agents/repo/.results").exists())

    def test_clean_rejects_unknown_session(self):
        code, _, err = self.cli("clean", "nobody")
        self.assertEqual(code, 1)
        self.assertIn("agent-box が作った session ではありません", err)

    def test_host_never_runs_git_inside_child_clone_after_start(self):
        self.start("s1", "--branch", "feat/126-fixture")
        (self.state / "git.log").unlink()
        self.child_work()
        (self.state / "git.log").unlink(missing_ok=True)
        self.assertEqual(self.cli("collect", "s1")[0], 0)
        self.assertEqual(self.cli("clean", "s1")[0], 0)
        clone = str(self.clone())
        calls = [json.loads(line) for line in (self.state / "git.log").read_text().splitlines()]
        self.assertTrue(any(entry["container"] for entry in calls))  # fake の経路が実際に通ったこと
        self.assertTrue(any(entry["cwd"] == str(self.repo) for entry in calls))
        host_calls = [entry for entry in calls
                      if not entry["container"] and (entry["cwd"].startswith(clone) or any(clone in a for a in entry["argv"]))]
        self.assertEqual(host_calls, [])

    # ---- guard（D16） ----
    # ---- merge 済みの ref の整理（#136） ----
    def side_commit(self, message):
        """origin/main に含まれない commit を作る（squash merge 前の子の commit に相当）."""
        tree = git(self.repo, "rev-parse", "HEAD^{tree}")
        return git(self.repo, "commit-tree", tree, "-p", "HEAD", "-m", message)

    def agent_refs(self, session):
        return git(self.repo, "for-each-ref", "--format=%(refname)", "refs/agents/%s/" % session).split()

    def test_prune_removes_only_confirmed_merged_sessions(self):
        main = git(self.repo, "rev-parse", "origin/main")
        squashed, open_work, detached, hidden, tagged, stacked = (
            self.side_commit(m) for m in ("squash", "open", "detached", "hidden", "tag", "stacked"))
        refs = {
            "merged-main": {"heads/feat/1-a": main, "remotes/origin/main": main, "HEAD": main},
            "merged-squash": {"heads/feat/2-b": squashed, "HEAD": squashed},
            "open": {"heads/feat/3-c": open_work},
            "detached": {"heads/feat/4-d": main, "HEAD": detached},
            "remote-only": {"heads/feat/5-e": main, "remotes/origin/x": hidden},
            "tagged": {"heads/feat/6-f": main, "tags/v1": tagged},
            "stacked": {"heads/feat/8-h": stacked},  # 親の branch へ merge しただけで main に入っていない
            "Bad_Name": {"heads/feat/1-a": main},  # agent-box の session 名でない
        }
        for session, items in refs.items():
            for rest, sha in items.items():
                git(self.repo, "update-ref", "refs/agents/%s/%s" % (session, rest), sha)
        (self.state / "prs.json").write_text(json.dumps({"feat/2-b": [[squashed, "main"]],
                                                         "feat/8-h": [[stacked, "feat/2-b"]]}))
        self.start("active")  # 片付け前の session は、merge 済みでも残す
        git(self.repo, "update-ref", "refs/agents/active/heads/feat/7-g", main)
        code, result, err = self.cli("prune")
        self.assertEqual(code, 0, err)
        self.assertEqual(sorted(item["session"] for item in result["pruned"]), ["merged-main", "merged-squash"])
        kept = {item["session"]: item["reason"] for item in result["kept"]}
        self.assertEqual(sorted(kept), ["Bad_Name", "active", "detached", "open", "remote-only", "stacked", "tagged"])
        # どの条件で残ったかまで確かめる（別の条件が先に効いて通る test にしない）
        self.assertIn("session 名ではありません", kept["Bad_Name"])
        self.assertIn("片付け前", kept["active"])
        self.assertIn("HEAD", kept["detached"])
        self.assertIn("feat/3-c", kept["open"])
        self.assertIn("remotes/origin/x", kept["remote-only"])
        self.assertIn("feat/8-h", kept["stacked"])
        self.assertIn("tags/v1", kept["tagged"])
        for session in ("merged-main", "merged-squash"):
            self.assertEqual(self.agent_refs(session), [])
        for session in ("open", "detached", "remote-only", "tagged", "active", "stacked", "Bad_Name"):
            self.assertEqual(len(self.agent_refs(session)), len(refs.get(session, {"x": 1})), session)

    def test_prune_keeps_everything_when_github_is_unreachable(self):
        squashed = self.side_commit("squash")
        git(self.repo, "update-ref", "refs/agents/s9/heads/feat/9-x", squashed)
        (self.state / "prs.json").write_text(json.dumps({"feat/9-x": [[squashed, "main"]]}))
        for variable in ("FAKE_GH_FAIL", "FAKE_GH_GARBLED"):
            with mock.patch.dict(os.environ, {variable: "1"}):
                code, result, err = self.cli("prune")
            self.assertEqual(code, 0, err)
            self.assertEqual(result["pruned"], [])
            self.assertIn("gh", result["kept"][0]["reason"])
            self.assertEqual(self.agent_refs("s9"), ["refs/agents/s9/heads/feat/9-x"])

    def test_prune_checks_base_even_if_gh_ignores_it(self):
        # --base の絞り込みが効かなくても、baseRefName の確認だけで stacked PR を数えない（二重の確認の片方）
        stacked = self.side_commit("stacked")
        git(self.repo, "update-ref", "refs/agents/s8/heads/feat/8-h", stacked)
        (self.state / "prs.json").write_text(json.dumps({"feat/8-h": [[stacked, "feat/2-b"]]}))
        with mock.patch.dict(os.environ, {"FAKE_GH_IGNORE_BASE": "1"}):
            code, result, err = self.cli("prune")
        self.assertEqual((code, result["pruned"]), (0, []), err)
        self.assertEqual(len(self.agent_refs("s8")), 1)

    def test_prune_keeps_session_when_check_fails_midway(self):
        main = git(self.repo, "rev-parse", "origin/main")
        for session in ("s1", "s2"):
            git(self.repo, "update-ref", "refs/agents/%s/heads/feat/1-a" % session, main)
        real_reachable = ab.Box.reachable

        def failing(box, sha, tips):
            if os.environ.get("FAKE_FAIL_ONCE") == "1":
                os.environ["FAKE_FAIL_ONCE"] = "0"
                raise ab.Stop("timeout")
            return real_reachable(box, sha, tips)
        with mock.patch.dict(os.environ, {"FAKE_FAIL_ONCE": "1"}), mock.patch.object(ab.Box, "reachable", failing):
            code, result, err = self.cli("prune")
        self.assertEqual(code, 0, err)
        self.assertEqual([item["session"] for item in result["pruned"]], ["s2"])
        self.assertIn("判定できませんでした", result["kept"][0]["reason"])
        self.assertEqual(len(self.agent_refs("s1")), 1)

    def test_prune_removes_merged_review_sessions_without_branch(self):
        # レビューの子は branch を持たず、HEAD にレビューした SHA だけが残る（#149）
        reviewed, unmerged, stacked = (self.side_commit(m) for m in ("reviewed", "unmerged", "stacked"))
        # PR はレビュー後に commit が足されて merge された（PR の head は reviewed の子孫）
        tip = git(self.repo, "commit-tree", git(self.repo, "rev-parse", "HEAD^{tree}"), "-p", reviewed, "-m", "after review")
        for session, sha in (("review-a", reviewed), ("review-b", unmerged), ("review-c", stacked)):
            git(self.repo, "update-ref", "refs/agents/%s/HEAD" % session, sha)
        (self.state / "prs.json").write_text(json.dumps({
            "search:" + reviewed: [[tip, "main"]],          # main へ merge 済み。head は reviewed の子孫
            "search:" + stacked: [[stacked, "feat/2-b"]],   # 親の branch へ merge しただけ
        }))
        code, result, err = self.cli("prune")
        self.assertEqual(code, 0, err)
        self.assertEqual([item["session"] for item in result["pruned"]], ["review-a"])
        kept = {item["session"]: item["reason"] for item in result["kept"]}
        self.assertEqual(sorted(kept), ["review-b", "review-c"])
        self.assertIn("HEAD", kept["review-b"])
        self.assertEqual(self.agent_refs("review-a"), [])
        self.assertEqual(len(self.agent_refs("review-b")), 1)

    def test_prune_reports_and_continues_when_a_ref_moves(self):
        main = git(self.repo, "rev-parse", "origin/main")
        for session in ("s1", "s2"):
            git(self.repo, "update-ref", "refs/agents/%s/heads/feat/1-a" % session, main)
        real_run = ab.run

        def moving_run(argv, *args, **kwargs):
            # s1 を判定した後、消す直前に取り込み直された（旧値が変わった）状況を作る
            if argv[:3] == ["git", "update-ref", "--stdin"] and b"refs/agents/s1/" in kwargs.get("stdin", b""):
                git(self.repo, "update-ref", "refs/agents/s1/heads/feat/1-a", self.side_commit("moved"))
            return real_run(argv, *args, **kwargs)
        with mock.patch.object(ab, "run", moving_run):
            code, result, err = self.cli("prune")
        self.assertEqual(code, 0, err)
        self.assertEqual([item["session"] for item in result["pruned"]], ["s2"])
        self.assertIn("変わりました", result["kept"][0]["reason"])
        self.assertEqual(len(self.agent_refs("s1")), 1)

    # コンテナの中では /.dockerenv があり、ホストの条件を再現できない（#135。run-tests.sh も skip として数える）
    @unittest.skipIf(Path("/.dockerenv").exists(), "コンテナの中では確かめられない")
    def test_guard_stays_on_host_even_with_agent_box_env(self):
        guard = self.fixture / "guard"
        guard.mkdir()
        shutil.copyfile(ROOT / "scripts/hooks/guard-bash.py", guard / "guard-bash.py")
        text = (ROOT / "scripts/hooks/guard-bash.sh").read_text()
        if arguments.mutation == "dockerenv":
            needle = ' && [ -f /.dockerenv ]'
            if text.count(needle) != 1:
                print("regression injection target changed: %r" % needle, file=sys.stderr)
                sys.exit(3)
            text = text.replace(needle, "")
        (guard / "guard-bash.sh").write_text(text)
        payload = json.dumps({"tool_name": "Bash", "tool_input": {"command": "git worktree add /tmp/agent-box-fixture"}})
        result = subprocess.run(["bash", str(guard / "guard-bash.sh")], input=payload, text=True, capture_output=True,
                                env=dict(os.environ, AGENT_BOX="1", PYTHONDONTWRITEBYTECODE="1"))
        self.assertEqual(result.returncode, 2, result.stderr)


if arguments.case:
    suite = unittest.TestSuite([AgentBox(CASES[arguments.case])])
else:
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(AgentBox)
result = unittest.TextTestRunner(verbosity=2, stream=sys.stdout).run(suite)
print(json.dumps({"tests": result.testsRun, "failures": len(result.failures), "errors": len(result.errors),
                  "mutation": arguments.mutation, "successful": result.wasSuccessful()}))
sys.exit(0 if result.wasSuccessful() else 1)
