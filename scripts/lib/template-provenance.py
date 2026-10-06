"""Explicit commit snapshots and offline provenance comparison (schema v1)."""

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import tempfile
from urllib.parse import urlsplit


class Invalid(Exception):
    pass


def git(repo, *args):
    env = os.environ.copy()
    # A caller's enclosing checkout must not redirect operations on --source-repo.
    for key in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR",
                "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"):
        env.pop(key, None)
    env.update(GIT_NO_LAZY_FETCH="1", GIT_NO_REPLACE_OBJECTS="1",
               GIT_OPTIONAL_LOCKS="0", GIT_TERMINAL_PROMPT="0")
    command = ["git", "--no-pager", "-c", "protocol.allow=never", "-c", "core.fsmonitor=false",
               "-c", "core.hooksPath=/dev/null", "-C", str(repo), *args]
    result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
    if result.returncode:
        # Do not echo remote URLs or arbitrary Git diagnostics (credentials).
        raise Invalid("Git 操作に失敗: " + args[0] + "（repo・commit・取得権限を確認）")
    return result.stdout


def commit(repo, revision):
    if not revision or revision.startswith("-"):
        raise Invalid("commit 指定が不正")
    resolved = git(repo, "rev-parse", "--verify", revision + "^{commit}").decode().strip()
    if not re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", resolved):
        raise Invalid("commit SHA を解決できない")
    return resolved


def metadata(project):
    path = Path(project) / ".template-version"
    if path.is_symlink() or not path.is_file():
        raise Invalid("由来不明: .template-version が無い、または通常ファイルではない")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (ValueError, UnicodeError) as exc:
        raise Invalid(".template-version が JSON 形式ではない") from exc
    if not isinstance(data, dict) or type(data.get("schema_version")) is not int or data["schema_version"] != 1:
        raise Invalid("未対応の schema_version（1 が必要）")
    for field in ("source", "revision", "fetched_at"):
        if not isinstance(data.get(field), str) or not data[field].strip():
            raise Invalid("metadata 必須 field の不備: " + field)
    if not re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", data["revision"]):
        raise Invalid("revision は完全な commit SHA が必要")
    try:
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})", data["fetched_at"]):
            raise ValueError()
        datetime.fromisoformat(data["fetched_at"].replace("Z", "+00:00"))
    except ValueError as exc:
        raise Invalid("fetched_at は timezone 付き ISO 8601 日時が必要") from exc
    return data


def snapshot(repo, revision, output, source):
    revision = commit(repo, revision)
    entries = []
    # Read committed blobs directly: archive export-ignore/export-subst attributes
    # and a dirty working tree must not change the recorded commit's snapshot.
    for record in git(repo, "ls-tree", "--full-tree", "-rz", revision).split(b"\0"):
        if not record:
            continue
        header, raw_path = record.split(b"\t", 1)
        mode, kind, oid = header.decode().split()
        name = os.fsdecode(raw_path)
        parts = PurePosixPath(name).parts
        if not parts or name.startswith("/") or any(p == ".." or p.casefold() == ".git" for p in parts):
            raise Invalid("snapshot に安全でない path がある")
        if parts[0].casefold() == ".template-version":
            # Never follow a snapshot's metadata symlink or directory.
            continue
        if kind != "blob" or mode not in ("100644", "100755", "120000"):
            raise Invalid("snapshot に未対応の entry がある（submodule 等）")
        entries.append((name, mode, oid))
    # Stage all blobs before creating the destination. No partial project on a
    # missing object / unsupported tree. mkdtemp owns only its new temporary dir.
    with tempfile.TemporaryDirectory(prefix="template-snapshot-") as staging:
        root = Path(staging)
        for name, mode, oid in entries:
            path = root / name
            parent = root
            for component in PurePosixPath(name).parts[:-1]:
                parent = parent / component
                if parent.is_symlink():
                    raise Invalid("snapshot の親 path が symlink と衝突する")
                parent.mkdir(exist_ok=True)
            content = git(repo, "cat-file", "blob", oid)
            if mode == "120000":
                path.symlink_to(os.fsdecode(content))
            else:
                # Exclusive creation also rejects case/normalization aliases on
                # filesystems where two Git paths name the same file.
                with path.open("xb") as handle:
                    handle.write(content)
                path.chmod(0o755 if mode == "100755" else 0o644)
        data = dict(schema_version=1, source=source, revision=revision,
                    fetched_at=datetime.now(timezone.utc).isoformat(timespec="seconds"))
        (root / ".template-version").write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        # mkdir is the exclusive claim: existing files, directories and even
        # dangling symlinks are rejected. Copy never traverses source symlinks.
        output.mkdir()
        for path in root.iterdir():
            target = output / path.name
            if path.is_symlink():
                target.symlink_to(os.readlink(path))
            elif path.is_dir():
                shutil.copytree(path, target, symlinks=True)
            else:
                shutil.copy2(path, target)
    print("作成済み: " + str(output) + " (" + revision + ")")


def create(args):
    output = Path(os.path.abspath(args.output))
    if os.path.lexists(output):
        raise Invalid("出力先が既に存在するため上書きしない")
    if not output.parent.is_dir():
        raise Invalid("出力先の親ディレクトリが無い")
    if args.source_repo:
        repo = Path(args.source_repo).resolve()
        snapshot(repo, args.revision, output, str(repo))
    else:
        url = urlsplit(args.source_url)
        if url.scheme not in ("https", "http", "ssh", "git", "file") or url.password:
            raise Invalid("明示 URL は https/http/ssh/git/file を使用し、password を含めない")
        if args.revision.startswith("-") or not args.revision:
            raise Invalid("commit 指定が不正")
        with tempfile.TemporaryDirectory(prefix="template-fetch-") as repo:
            git(repo, "init", "--bare", "--quiet")
            git(repo, "-c", "protocol.allow=never", "-c", "protocol." + url.scheme + ".allow=always",
                "fetch", "--no-tags", "--", args.source_url, args.revision)
            snapshot(repo, "FETCH_HEAD", output, args.source_url)


def compare(args):
    data = metadata(args.project)
    repo = Path(args.source_repo).resolve()
    try:
        old = commit(repo, data["revision"])
        target = commit(repo, args.to)
        patch = git(repo, "diff", "--no-ext-diff", "--no-textconv", "--no-color",
                    "--no-renames", "--binary", old, target, "--")
    except Invalid as exc:
        raise Invalid("ローカル取得元に必要な commit / object が無い、または読めない: " + str(exc)) from exc
    print("比較可能: " + old + " -> " + target, file=sys.stderr)
    print("取得元 commit 間の差分（派生先への適用状態は判定しない）", file=sys.stderr)
    sys.stdout.buffer.write(patch)


def main():
    operation = sys.argv[1]
    parser = argparse.ArgumentParser(prog="scripts/" + ("new-project.sh" if operation == "create" else "template-diff.sh"),
        description="指定 commit の追跡済み snapshot と由来記録を新規作成" if operation == "create" else "ローカル取得元のみで記録 SHA からの差分を表示（fetch・適用なし）")
    if operation == "create":
        source = parser.add_mutually_exclusive_group(required=True)
        source.add_argument("--source-repo", help="ローカル Git repo")
        source.add_argument("--source-url", help="明示的に取得する URL")
        parser.add_argument("--revision", required=True, help="生成元 commit（SHA / ref）")
        parser.add_argument("--output", required=True, help="存在しない生成先 directory")
    else:
        parser.add_argument("--project", required=True, help=".template-version を持つ project")
        parser.add_argument("--source-repo", required=True, help="利用者が用意したローカル Git repo")
        parser.add_argument("--to", default="HEAD", help="比較先 commit（既定: ローカル HEAD）")
    args = parser.parse_args(sys.argv[2:])
    try:
        (create if operation == "create" else compare)(args)
    except (Invalid, OSError, ValueError) as exc:
        print(("作成失敗: " if operation == "create" else "比較不能: ") + str(exc), file=sys.stderr)
        return 1 if operation == "create" else 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
