#!/usr/bin/env python3
"""Fail-closed, repository-local worktree lifecycle. No branch deletion.

Capabilities coordinate trusted same-user actors; they are not OS role authentication.
The root bootstrap needs an explicit user approval artifact. See the process contract.
"""
import argparse
import contextlib
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import stat
import subprocess
import sys


class Stop(RuntimeError):
    pass


def run(argv, cwd=None, allowed=(0,)):
    try:
        result = subprocess.run(argv, cwd=cwd, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, timeout=30)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise Stop("確認コマンド失敗: " + str(exc)) from exc
    if result.returncode not in allowed:
        # No arbitrary file contents/command output in diagnostics.
        raise Stop("確認コマンド失敗: " + argv[0] + " exit=" + str(result.returncode))
    return result


def git(*argv, cwd=None):
    return run(["git", *argv], cwd=cwd).stdout.decode().strip()


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def within(path, parent):
    return path == parent or parent in path.parents


def physical(path):
    p = Path(os.path.abspath(os.path.expanduser(str(path))))
    if any(c in str(p) for c in "\n\r\x00"):
        raise Stop("path に制御文字は使えません")
    for part in (p, *p.parents):
        if part.is_symlink():
            raise Stop("symlink 経由の path は管理対象にできません: " + str(p))
    return p.resolve()


def write_json(path, value):
    temporary = path.with_name(path.name + "." + secrets.token_hex(8))
    with open(temporary, "x", encoding="utf-8") as stream:
        os.chmod(temporary, 0o600)
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def read_json(path):
    try:
        p = physical(path)
        if (p.name.startswith(".env") and p.name != ".env.example") or p.suffix in (".key", ".pem") or p.name in ("id_rsa", "id_ed25519"):
            raise Stop("secret file を JSON 根拠として読めません")
        if not p.is_file():
            raise Stop("JSON evidence がありません: " + str(p))
        with p.open(encoding="utf-8") as stream:
            value = json.load(stream)
        if not isinstance(value, dict):
            raise ValueError("object required")
        return value
    except (OSError, ValueError) as exc:
        raise Stop("JSON evidence を確認できません: " + str(path)) from exc


def alive(pid):
    if type(pid) is not int or pid <= 1:
        raise Stop("有効な PID が必要です")
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError as exc:
        raise Stop("PID の状態が不明です") from exc


class Manager:
    def __init__(self, repo):
        self.repo = physical(git("rev-parse", "--show-toplevel", cwd=repo))
        self.common = physical(git("rev-parse", "--path-format=absolute", "--git-common-dir", cwd=repo))
        self.identity = hashlib.sha256(str(self.common).encode()).hexdigest()[:24]
        self.home = physical(Path.home())
        self.name = self.common.parent.name if self.common.name == ".git" else self.common.name
        self.standard = physical(self.home / "worktrees" / self.name)
        self.state = physical(self.home / "worktrees" / ".state" / self.identity)
        if within(self.state, self.repo):
            raise Stop("状態保存先が対象 worktree 内です")
        for temporary in ("/tmp", "/private/tmp", "/var/folders", os.environ.get("TMPDIR")):
            if temporary and within(self.home, Path(temporary).resolve()):
                raise Stop("HOME / 状態領域に一時領域は使えません")
        self.db = {"version": 1, "repo": str(self.common), "sessions": {}, "records": {}}

    @contextlib.contextmanager
    def locked(self, mutate=False):
        if mutate:
            self.state.mkdir(parents=True, exist_ok=True, mode=0o700)
        if not self.state.exists():
            yield
            return
        # Even readers share the same repo-wide lock. Lock file is never unlinked.
        physical(self.state / "lock")
        with open(self.state / "lock", "a+") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            if (self.state / "state.json").exists():
                self.db = read_json(self.state / "state.json")
                if self.db.get("repo") != str(self.common) or self.db.get("version") != 1:
                    raise Stop("repo 状態の衝突 / 未知 version")
            yield
            if mutate:
                write_json(self.state / "state.json", self.db)

    def worktrees(self):
        raw = run(["git", "worktree", "list", "--porcelain", "-z"], cwd=self.repo).stdout
        rows, row = [], {}
        for field in raw.split(b"\0"):
            if not field:
                if row:
                    rows.append(row)
                    row = {}
                continue
            key, _, value = field.decode().partition(" ")
            row[key] = value
        if row:
            rows.append(row)
        return rows

    def row(self, path):
        p = physical(path)
        matches = [r for r in self.worktrees() if physical(r["worktree"]) == p]
        if len(matches) != 1 or not p.is_dir():
            raise Stop("登録済み worktree を確認できません")
        if physical(git("rev-parse", "--path-format=absolute", "--git-common-dir", cwd=p)) != self.common:
            raise Stop("Git 共通 directory が一致しません")
        return p, matches[0]

    def external(self, filename, target=None):
        p = physical(filename)
        if not p.is_file() or (target and within(p, target)):
            raise Stop("根拠を対象 worktree 外の通常 file へ保存してください")
        # Hash evidence JSON only; no secret contents are examined.
        value = read_json(p)
        return {"path": str(p), "sha256": digest(value)}, value

    def check_external(self, evidence, target):
        actual, value = self.external(evidence["path"], target)
        if actual != evidence:
            raise Stop("保存済み根拠が変更されています")
        return value

    def capability(self, filename, role=None):
        p = physical(filename)
        if p.parent != self.state or not p.name.endswith(".cap.json"):
            raise Stop("この repo の session capability が必要です")
        if stat.S_IMODE(p.stat().st_mode) != 0o600:
            raise Stop("capability の permission は 0600 が必要です")
        cap = read_json(p)
        session = self.db["sessions"].get(cap.get("session"))
        if not session or session["token_hash"] != digest(cap.get("token")):
            raise Stop("session capability 不一致")
        if role and session["role"] != role:
            raise Stop("この操作の担当権限がありません")
        return cap["session"], session

    def new_session(self, session, role, pid, approval=None, parent=None):
        if session in self.db["sessions"] or not session or not alive(pid):
            raise Stop("session は一意の ID と稼働 PID が必要です")
        token = secrets.token_hex(32)
        filename = self.state / (secrets.token_hex(16) + ".cap.json")
        self.db["sessions"][session] = {"role": role, "pid": pid, "parent": parent,
                                       "approval": approval, "token_hash": digest(token)}
        write_json(filename, {"session": session, "token": token})
        return str(filename)

    def root_open(self, args):
        evidence, approval = self.external(args.approval)
        if (approval.get("kind") != "root-session" or approval.get("approved_by") != "user"
                or approval.get("session") != args.session or approval.get("repo") != str(self.common)
                or not approval.get("reason")):
            raise Stop("対象 repo/session のユーザー明示承認が必要です")
        return {"capability": self.new_session(args.session, "root", args.pid, approval=evidence)}

    def validate_placement(self, path, approval=None):
        p = physical(path)
        for temporary in ("/tmp", "/private/tmp", "/var/folders", os.environ.get("TMPDIR")):
            if temporary and within(p, Path(temporary).resolve()):
                raise Stop("一時領域に worktree は作れません")
        if not within(p, self.home) or p == self.home or within(p, self.state):
            raise Stop("home 配下 / 状態領域外へ配置してください")
        if not within(p, self.standard) or p == self.standard:
            if not approval:
                raise Stop("標準配置 ~/worktrees/<repo>/ 配下が必要です")
            evidence, value = self.external(approval)
            if (value.get("kind") != "placement" or value.get("approved_by") != "user"
                    or value.get("path") != str(p) or value.get("repo") != str(self.common)
                    or not value.get("reason")):
                raise Stop("配置例外のユーザー理由付き承認が必要です")
            return p, evidence
        return p, None

    def create(self, args):
        p, placement = self.validate_placement(args.path, args.placement_approval)
        if p.exists() or p.is_symlink() or str(p) in self.db["records"]:
            raise Stop("既存 path / 管理記録の上書きは禁止です")
        parent = None
        if args.child:
            parent, _ = self.capability(args.capability, "root")
            if not args.session or not args.pid:
                raise Stop("child の session / PID が必要です")
        owner_session = args.session or ("user-" + secrets.token_hex(12))
        owner_pid = args.pid or os.getppid()
        if owner_session in self.db["sessions"] or not alive(owner_pid):
            raise Stop("使用者 session は一意の ID と稼働管理 PID が必要です")
        if not args.child and args.capability:
            parent, _ = self.capability(args.capability)
        if args.branch:
            run(["bash", str(Path(__file__).resolve().parents[1] / "check-branch-name.sh"), args.branch])
        self.standard.mkdir(parents=True, exist_ok=True)
        marker = self.standard / ".repo-id.json"
        physical(marker)
        if marker.exists():
            if read_json(marker).get("common") != str(self.common):
                raise Stop("同名 repo の配置衝突")
        else:
            # Bootstrap only when every existing entry is a registered worktree of this repo.
            registered = {physical(r["worktree"]) for r in self.worktrees()}
            for existing in self.standard.iterdir():
                existing = physical(existing)
                if (existing not in registered or not existing.is_dir()
                        or physical(git("rev-parse", "--path-format=absolute", "--git-common-dir", cwd=existing)) != self.common):
                    raise Stop("標準 directory の所有 repo が不明です")
            # Exclusive creation coordinates different repos with different state locks.
            try:
                with marker.open("x", encoding="utf-8") as stream:
                    os.chmod(marker, 0o600)
                    json.dump({"common": str(self.common)}, stream)
                    stream.flush()
                    os.fsync(stream.fileno())
            except FileExistsError:
                if read_json(marker).get("common") != str(self.common):
                    raise Stop("同名 repo の配置衝突（並行作成）")
        if not p.parent.exists():
            p.parent.mkdir(parents=True, exist_ok=True)
        physical(p)
        cmd = ["git", "worktree", "add"]
        if args.branch:
            cmd += ["-b", args.branch]
        else:
            cmd += ["--detach"]
        cmd += [str(p), args.base]
        run(cmd, cwd=self.repo)
        owner_cap = self.new_session(owner_session, "child" if args.child else "human", owner_pid, parent=parent)
        owner = owner_session
        self.db["records"][str(p)] = {
            "path": str(p), "state": "active", "created": now(), "legacy": False,
            "owner": owner, "root": parent if args.child else None, "child": args.child,
            "purpose": args.purpose, "placement_approval": placement, "jobs": [],
        }
        return {"path": str(p), "owner_capability": owner_cap, "state": "active"}

    def record(self, path):
        p, row = self.row(path)
        record = self.db["records"].get(str(p))
        if not record:
            raise Stop("未管理の既存 worktree は child 例外へ昇格できません")
        return p, row, record

    def owned(self, args, record):
        session, actor = self.capability(args.capability)
        if session != record["owner"]:
            raise Stop("使用者の capability が必要です")
        return session, actor

    def hold(self, args):
        _, _, record = self.record(args.path)
        self.owned(args, record)
        if record["state"] == "reclaimed":
            raise Stop("回収済み")
        record.update(state="held", reason=args.reason)
        record.pop("end", None)
        return {"state": "held", "reason": args.reason}

    def job_add(self, args):
        _, _, record = self.record(args.path)
        self.owned(args, record)
        if record["state"] not in ("active", "held") or not alive(args.pid):
            raise Stop("稼働中の担当 job を登録してください")
        record["jobs"].append({"pid": args.pid, "description": args.reason})
        return {"jobs": record["jobs"]}

    def end(self, args):
        p, row, record = self.record(args.path)
        session, _ = self.owned(args, record)
        evidence, report = self.external(args.report, p)
        if (report.get("kind") != "end" or report.get("session") != session
                or report.get("path") != str(p) or report.get("head") != row["HEAD"]
                or report.get("jobs") != record["jobs"] or report.get("jobs_ended") is not True
                or report.get("work_ended") is not True):
            raise Stop("固定 head / 担当 / job を含む明示終了報告が必要です")
        if record["purpose"] == "review":
            if not report.get("review_result") or not report.get("reviewed_sha"):
                raise Stop("レビュー結果と対象 SHA の外部保存が必要です")
        artifacts = [self.external(evidence_file, p)[0] for evidence_file in report.get("evidence", [])]
        if any(alive(job["pid"]) for job in record["jobs"]):
            raise Stop("登録 job が稼働中です")
        record.update(state="ended", end={"at": now(), "head": row["HEAD"], "report": evidence, "artifacts": artifacts})
        return {"state": "ended", "head": row["HEAD"]}

    def file_protection(self, p):
        stages = run(["git", "ls-files", "--stage", "-z"], cwd=p).stdout.split(b"\0")
        if any(entry.startswith(b"160000 ") for entry in stages):
            raise Stop("tracked gitlink / nested Git repo を保護（内側成果物とcommit保持が不明）")
        tracked = run(["git", "status", "--porcelain=v1", "-z", "--untracked-files=no"], cwd=p).stdout
        if tracked:
            raise Stop("未コミット変更を保護")
        config = self.repo / "scripts/worktree-disposable.json"
        if git("status", "--porcelain", "--", str(config), cwd=self.repo):
            raise Stop("破棄可設定に未コミット変更があります")
        if not git("ls-files", "--", str(config), cwd=self.repo):
            raise Stop("破棄可設定の追跡正本がありません")
        policy = read_json(config)
        paths = policy.get("paths")
        if policy.get("version") != 1 or not isinstance(paths, list):
            raise Stop("未知の破棄可設定")
        for name in paths:
            if (not isinstance(name, str) or not name or name.startswith("/")
                    or ".." in Path(name).parts or any(c in name for c in "*?[]\n\r")):
                raise Stop("破棄可設定は相対 exact path / directory prefix のみ")
            physical(p / name)
        tracked_names = set(os.fsdecode(raw) for raw in run(["git", "ls-files", "-z"], cwd=p).stdout.split(b"\0") if raw)
        disposable = []
        for ignored in (False, True):
            cmd = ["git", "ls-files", "-z", "--others", "--exclude-standard"]
            if ignored:
                cmd.append("--ignored")
            for raw in run(cmd, cwd=p).stdout.split(b"\0"):
                if not raw:
                    continue
                name = os.fsdecode(raw)
                candidate = p / name
                if candidate.is_symlink() or not candidate.is_file():
                    raise Stop("symlink / 未分類 file を保護: " + name)
                physical(candidate)
                if not any(name == rule or (rule.endswith("/") and name.startswith(rule)) for rule in paths):
                    raise Stop("未追跡 / ignored file を保護: " + name)
                disposable.append(name)
        # Git does not report empty directories. Protect those too, and reject all symlinks.
        for directory, dirs, files in os.walk(p, followlinks=False):
            for name in list(dirs) + files:
                child = Path(directory) / name
                mode = child.lstat().st_mode
                if child.name == ".git" and child != p / ".git":
                    raise Stop("nested Git metadata を保護: " + str(child.relative_to(p)))
                if child == p / ".git":
                    if not stat.S_ISREG(mode):
                        raise Stop("Git metadata file の種類が不明です")
                    continue
                if stat.S_ISLNK(mode):
                    if str(child.relative_to(p)) not in tracked_names:
                        raise Stop("未追跡 symlink を保護: " + str(child.relative_to(p)))
                    continue
                if not (stat.S_ISREG(mode) or stat.S_ISDIR(mode)):
                    raise Stop("未分類の特殊 file を保護: " + str(child.relative_to(p)))
            dirs[:] = [d for d in dirs if Path(directory) / d != p / ".git"]
            if not dirs and not files and Path(directory) != p:
                name = str(Path(directory).relative_to(p)) + "/"
                if not any(name == rule or (rule.endswith("/") and name.startswith(rule)) for rule in paths):
                    raise Stop("空 directory の未分類成果物を保護: " + name)
        return sorted(disposable), digest(policy)

    def activity(self, p, record):
        # Root's external session-end confirmation is required separately; PID/lsof alone is insufficient.
        for job in record.get("jobs", []):
            if alive(job["pid"]):
                raise Stop("登録 job が稼働中です")
        owner = self.db["sessions"].get(record.get("owner"))
        if owner and alive(owner["pid"]) and record.get("child"):
            raise Stop("担当 process が稼働中です（session 終了も別途確認が必要）")
        lsof = shutil.which("lsof")
        if not lsof:
            raise Stop("lsof がないため活動不明")
        result = run([lsof, "-nP", "+D", str(p), "-Fpcfn"], allowed=(0, 1))
        if result.stderr or result.returncode == 0 or result.stdout.strip():
            raise Stop("open file / cwd / 活動不明を保護（lsof）")
        return "lsof:no-open-files;registered-jobs:ended"

    def snapshot(self, path, record):
        p, row = self.row(path)
        if "locked" in row or "prunable" in row or p == physical(self.worktrees()[0]["worktree"]):
            raise Stop("main / locked / prunable worktree を保護")
        if within(Path.cwd().resolve(), p) or within(self.repo, p):
            raise Stop("呼出元 / 管理コードの worktree を回収できません")
        if record.get("state") != "ended" or "end" not in record:
            raise Stop("明示終了記録なし / 保留中")
        if record["end"]["head"] != row["HEAD"]:
            raise Stop("終了後の HEAD 変更を保護")
        report = self.check_external(record["end"]["report"], p)
        for evidence in record["end"].get("artifacts", []):
            self.check_external(evidence, p)
        # Any ref containing the exact HEAD retains it, even for detached/squash workflows.
        refs = git("for-each-ref", "--contains", row["HEAD"], "--format=%(refname)", cwd=self.repo).splitlines()
        if not refs:
            raise Stop("detached commit の保持先 ref がありません")
        files, policy = self.file_protection(p)
        activity = self.activity(p, record)
        return {"path": str(p), "head": row["HEAD"], "branch": row.get("branch"),
                "retention_refs": sorted(refs), "disposable": files, "policy": policy,
                "activity": activity, "record": digest(record), "repo": str(self.common),
                "directory_identity": [p.stat().st_dev, p.stat().st_ino]}

    def inspect(self, args):
        p, _, record = self.record(args.path)
        actor, _ = self.capability(args.capability, "root")
        if record["child"] and actor != record["root"]:
            raise Stop("別 session の child を回収できません")
        snap = self.snapshot(p, record)
        return {"snapshot": snap, "snapshot_sha256": digest(snap)}

    def authorize_reclaim(self, args):
        p, _, record = self.record(args.path)
        actor, session = self.capability(args.capability, "root")
        self.check_external(session["approval"], p)
        snap = self.snapshot(p, record)
        evidence, confirmation = self.external(args.confirmation, p)
        if (confirmation.get("kind") != "root-confirmation" or confirmation.get("root_session") != actor
                or confirmation.get("path") != str(p) or confirmation.get("owner_session") != record["owner"]
                or confirmation.get("snapshot_sha256") != digest(snap)
                or confirmation.get("session_ended_observed") is not True
                or confirmation.get("jobs_ended_observed") is not True
                or confirmation.get("evidence_saved_verified") is not True
                or not confirmation.get("observation")):
            raise Stop("root の現物 / agent-session 終了 / 根拠退避の確認 report が必要です")
        if record["child"] and not record.get("legacy"):
            if actor != record["root"]:
                raise Stop("別 root / 他 session の child を保護")
            authority = "delegated-child"
        else:
            if not args.user_approval:
                raise Stop("通常 / 既存 worktree は対象固有のユーザー承認が必要です")
            _, approval = self.external(args.user_approval, p)
            if (approval.get("kind") != "reclaim" or approval.get("approved_by") != "user"
                    or approval.get("path") != str(p) or approval.get("snapshot_sha256") != digest(snap)
                    or not approval.get("reason")):
                raise Stop("対象と snapshot を特定したユーザー承認が必要です")
            authority = "user-approved"
        return p, record, snap, evidence, authority

    def reclaim(self, args, verify=False):
        p, record, snap, evidence, authority = self.authorize_reclaim(args)
        if verify:
            return {"authority": authority, "snapshot_sha256": digest(snap)}
        # Immediately before deletion, refresh files, refs, activity, evidence and registration under the lock.
        if self.snapshot(p, record) != snap:
            raise Stop("検査後の変更 / 競合を保護")
        self.check_external(evidence, p)
        cmd = ["git", "worktree", "remove"]
        if snap["disposable"]:
            cmd.append("--force")
        cmd.append(str(p))
        run(cmd, cwd=self.repo)
        if p.exists() or any(r["worktree"] == str(p) for r in self.worktrees()):
            raise Stop("回収後の現物 / 登録が残っています")
        record.update(state="reclaimed", reclaimed={"at": now(), "snapshot": snap,
                                                     "confirmation": evidence, "authority": authority})
        return {"state": "reclaimed", "path": str(p), "retention_refs": snap["retention_refs"]}

    def list(self, args):
        rows = []
        for row in self.worktrees():
            path = row["worktree"]
            record = self.db["records"].get(path)
            item = dict(row, state=record["state"] if record else "needs-confirmation",
                        managed=bool(record), child=bool(record and record["child"]))
            if args.command == "candidates":
                try:
                    item["snapshot"] = self.snapshot(path, record or {})
                    item["candidate"] = True
                    item["authority"] = "root-check-required" if record["child"] else "user-approval-required"
                except (Stop, OSError) as exc:
                    item.update(candidate=False, protection=str(exc))
            rows.append(item)
        return {"repo": str(self.common), "state_directory": str(self.state), "worktrees": rows}


def parser():
    p = argparse.ArgumentParser(description="repo 単位の worktree 状態・安全な回収（仕様: docs/process/worktree-lifecycle.md）")
    p.add_argument("--repo", default=".")
    sub = p.add_subparsers(dest="command", required=True)
    root = sub.add_parser("root-open", help="ユーザー承認付き root session capability を登録")
    root.add_argument("--session", required=True)
    root.add_argument("--pid", required=True, type=int)
    root.add_argument("--approval", required=True)
    create = sub.add_parser("create", help="標準配置で新規 worktree 作成")
    create.add_argument("path")
    create.add_argument("--base", default="HEAD")
    create.add_argument("--branch")
    create.add_argument("--purpose", choices=("implementation", "review", "other"), default="implementation")
    create.add_argument("--child", action="store_true")
    create.add_argument("--session")
    create.add_argument("--pid", type=int)
    create.add_argument("--capability")
    create.add_argument("--placement-approval")
    for name in ("list", "candidates"):
        sub.add_parser(name, help="登録一覧 / 回収候補と保護理由")
    for name in ("hold", "end", "job-add", "inspect", "reclaim", "verify-reclaim"):
        command = sub.add_parser(name)
        command.add_argument("path")
        command.add_argument("--capability", required=True)
        if name in ("hold", "job-add"):
            command.add_argument("--reason", required=True)
        if name == "job-add":
            command.add_argument("--pid", type=int, required=True)
        if name == "end":
            command.add_argument("--report", required=True)
        if name in ("reclaim", "verify-reclaim"):
            command.add_argument("--confirmation", required=True)
            command.add_argument("--user-approval")
    return p


def main():
    args = parser().parse_args()
    try:
        manager = Manager(args.repo)
        mutate = args.command in ("root-open", "create", "hold", "end", "job-add", "reclaim")
        with manager.locked(mutate):
            if args.command in ("list", "candidates"):
                result = manager.list(args)
            elif args.command == "verify-reclaim":
                result = manager.reclaim(args, verify=True)
            else:
                result = getattr(manager, args.command.replace("-", "_"))(args)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except (Stop, OSError, KeyError, TypeError) as exc:
        print("worktree: 停止: " + str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
