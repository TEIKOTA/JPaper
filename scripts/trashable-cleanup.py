#!/usr/bin/env python3
"""~/.trashable（作業・test 用の一時物の置き場。#146）を定期的に掃除する。標準ライブラリだけで動く。

掃除の単位は ~/.trashable/<project>/ 直下の項目。古さは項目の中で一番新しい更新時刻（lstat）で測る。
  - 最後の更新から --max-age-days（既定 7 日）を超えた項目は消す。
  - 残った項目の合計が --max-total-bytes（既定 10 GiB）を超えたら、古い順に消して下回らせる。
    ただし直近 --protect-hours（既定 24 時間）に更新した項目は消さない。それでも超えるなら警告を出す。
安全条件:
  - root が symlink、または通常の dir でなければ、何もせずに理由を出す（exit 1）。root が無ければ何もしない（exit 0）。
  - symlink は辿らない。<project> が symlink ならその symlink 自体を 1 項目として扱い、消すのも symlink 自体だけ。
  - 消すときは root を O_NOFOLLOW で開いた fd から <project> を O_NOFOLLOW で開き直し、その dir_fd で消す
    （path を辿り直さないので、判定と削除の間に途中の dir を symlink へ差し替えられても外を消さない）。
  - root が / か、ホームかその祖先なら何もしない（--root の誤用で全部を掃除対象にしない）。
  - dir_fd 付きの rmtree が要るので Python 3.11 以上で動く。それより古ければ何もしない（exit 1）。
  - 計測・削除に失敗した項目は残して警告を出す（exit 1）。
出力は 1 項目 1 行（削除・残す・警告）と、最後の要約。判断の正本: docs/adr/20261014-add-trashable-workspace.md
"""
import argparse
import os
import shutil
import stat
import sys
import time

DAY = 86400
GIB = 1024 ** 3


class Refused(Exception):
    """root の外を消そうとした等、消してはならない対象。"""


class Item(object):
    def __init__(self, path, project, name, mtime, size):
        self.path = path        # 表示用
        self.project = project  # root 直下の <project> の名前（root 直下の項目なら None）
        self.name = name        # <project>（または root）直下の名前
        self.mtime = mtime
        self.size = size


def build_parser():
    parser = argparse.ArgumentParser(
        prog="trashable-cleanup.py",
        description="~/.trashable の項目を、古さと合計の大きさで掃除する（条件は本ファイルの docstring と ADR）")
    parser.add_argument("--root", default="~/.trashable", help="掃除する置き場（既定 ~/.trashable）")
    parser.add_argument("--now", type=float, default=None, help="現在時刻の epoch 秒（test 用。既定は実時刻）")
    parser.add_argument("--dry-run", action="store_true", help="何も消さず、消す項目を表示する")
    parser.add_argument("--max-age-days", type=float, default=7.0, help="これより古い項目を消す（既定 7）")
    parser.add_argument("--max-total-bytes", type=int, default=10 * GIB, help="合計の上限（既定 10 GiB）")
    parser.add_argument("--protect-hours", type=float, default=24.0,
                        help="合計の上限による削除から守る、直近の更新の長さ（既定 24）")
    return parser


def human(size):
    value = float(size)
    for unit in ("B", "KiB", "MiB", "GiB"):
        if value < 1024 or unit == "GiB":
            return ("%d %s" % (value, unit)) if unit == "B" else ("%.1f %s" % (value, unit))
        value /= 1024


NOFOLLOW_DIR = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW


def covers_home(root_real):
    """root がホームか、その祖先。HOME と passwd の両方のホームで、実体の同一性（大文字小文字によらない FS でも）で見る."""
    homes = {os.path.realpath(os.path.expanduser("~"))}
    try:
        import pwd
        homes.add(os.path.realpath(pwd.getpwuid(os.getuid()).pw_dir))
    except (ImportError, KeyError):
        pass
    for home in homes:
        current = home
        while True:
            try:
                if os.path.samefile(current, root_real):
                    return True
            except OSError:
                pass
            parent = os.path.dirname(current)
            if parent == current:
                break
            current = parent
    return False


def measure(path):
    """項目の (中で一番新しい更新時刻, 通常 file の合計 byte)。symlink は辿らず、辿れない dir があれば OSError。"""
    st = os.lstat(path)
    newest, size = st.st_mtime, 0
    if stat.S_ISREG(st.st_mode):
        size += st.st_size
    stack = [path] if stat.S_ISDIR(st.st_mode) else []
    while stack:
        with os.scandir(stack.pop()) as entries:
            for entry in entries:
                st = entry.stat(follow_symlinks=False)
                if st.st_mtime > newest:
                    newest = st.st_mtime
                if stat.S_ISREG(st.st_mode):
                    size += st.st_size
                elif stat.S_ISDIR(st.st_mode):
                    stack.append(entry.path)
    return newest, size


def remove(root_fd, project, name):
    """root の fd から辿って項目を 1 つ消す。symlink は symlink 自体だけを消す。

    <project> は O_NOFOLLOW で開くので、symlink に差し替えられていれば OSError（ELOOP 等）で消さない。
    rmtree(dir_fd=…) は対象を開き直して lstat と一致するかを確かめるので、項目の差し替えでも外を辿らない。
    """
    for part in (project, name):
        if part is not None and (part in ("", ".", "..") or os.sep in part):
            raise Refused("名前が不正: %r" % part)
    parent = os.dup(root_fd) if project is None else os.open(project, NOFOLLOW_DIR, dir_fd=root_fd)
    try:
        st = os.stat(name, dir_fd=parent, follow_symlinks=False)
        if stat.S_ISDIR(st.st_mode):
            shutil.rmtree(name, dir_fd=parent)
        else:
            os.unlink(name, dir_fd=parent)
    finally:
        os.close(parent)


def list_paths(root, warn):
    """root 直下の項目の (path, project, name)。<project> が dir なら直下の各項目、symlink や file ならそれ自体。"""
    paths = []
    with os.scandir(root) as top:
        for entry in sorted(top, key=lambda e: e.name):
            if entry.is_dir(follow_symlinks=False):
                try:
                    with os.scandir(entry.path) as children:
                        paths.extend(sorted((child.path, entry.name, child.name) for child in children))
                except OSError as error:
                    warn("%s を読めないので飛ばす: %s" % (entry.path, error), True)
            else:
                paths.append((entry.path, None, entry.name))
    return paths


def main(argv=None):
    args = build_parser().parse_args(argv)
    now = time.time() if args.now is None else args.now
    max_age = args.max_age_days * DAY
    protect = args.protect_hours * 3600
    cap = args.max_total_bytes
    root = os.path.expanduser(args.root)
    tag = "[dry-run] " if args.dry_run else ""
    counts = {"warn": 0, "fail": 0}

    def warn(message, failed=False):
        counts["warn"] += 1
        counts["fail"] += 1 if failed else 0
        print("警告: %s" % message)

    if sys.version_info < (3, 11) or not shutil.rmtree.avoids_symlink_attacks:
        print("中止: Python 3.11 以上（symlink を辿らない dir_fd 付きの rmtree）が必要（%s）" % sys.version.split()[0])
        return 1
    try:
        root_st = os.lstat(root)
    except FileNotFoundError:
        print("対象なし: %s が無いので何もしない" % root)
        return 0
    if stat.S_ISLNK(root_st.st_mode):
        print("中止: %s は symlink なので何もしない（実体を辿らない）" % root)
        return 1
    if not stat.S_ISDIR(root_st.st_mode):
        print("中止: %s は通常の dir ではないので何もしない" % root)
        return 1
    root_real = os.path.realpath(root)
    if root_real == os.sep or covers_home(root_real):
        print("中止: %s は / かホームかその祖先なので何もしない（--root の誤用）" % root)
        return 1
    try:
        root_fd = os.open(root, NOFOLLOW_DIR)
    except OSError as error:
        print("中止: %s を開けない（%s）" % (root, error))
        return 1

    items = []
    for path, project, name in list_paths(root, warn):
        try:
            mtime, size = measure(path)
        except OSError as error:
            warn("%s を計測できないので残す: %s" % (path, error), True)
            continue
        items.append(Item(path, project, name, mtime, size))
    total = sum(item.size for item in items)
    total_before = total

    removed, removed_bytes, kept = [], 0, {}

    def delete(item, reason):
        if not args.dry_run:
            try:
                remove(root_fd, item.project, item.name)
            except (OSError, Refused, RecursionError) as error:
                warn("%s を消せなかったので残す: %s" % (item.path, error), True)
                kept[item.path] = (item, "削除に失敗")
                return False
        print("%s削除: %s（%s。経過 %.1f 日・%s）" % (tag, item.path, reason, (now - item.mtime) / DAY, human(item.size)))
        removed.append(item)
        return True

    remaining = []
    for item in items:
        if now - item.mtime > max_age:
            if delete(item, "%g 日超" % args.max_age_days):
                total -= item.size
                removed_bytes += item.size
                continue
        else:
            kept[item.path] = (item, "%g 日以内" % args.max_age_days)
        remaining.append(item)

    if total > cap:
        for item in sorted(remaining, key=lambda i: (i.mtime, i.path)):
            if total <= cap:
                break
            if now - item.mtime < protect:
                kept[item.path] = (item, "直近 %g 時間以内なので守る" % args.protect_hours)
                continue
            if delete(item, "合計が上限 %s を超えた" % human(cap)):
                del kept[item.path]
                total -= item.size
                removed_bytes += item.size
        if total > cap:
            warn("合計 %s が上限 %s を超えたまま（直近 %g 時間の更新は消さない）" % (human(total), human(cap), args.protect_hours))

    for path in sorted(kept):
        item, reason = kept[path]
        print("残す: %s（%s。経過 %.1f 日・%s）" % (path, reason, (now - item.mtime) / DAY, human(item.size)))
    print("%s要約: 削除 %d 件（%s）・残す %d 件・警告 %d 件・合計 %s → %s" % (
        tag, len(removed), human(removed_bytes), len(kept), counts["warn"], human(total_before), human(total)))
    os.close(root_fd)
    return 1 if counts["fail"] else 0


if __name__ == "__main__":
    sys.exit(main())
