#!/usr/bin/env python3
"""guard-bash.py の ask の絞り込み（#158）の test。

- 一時領域の中の rm -rf は確認なしで通り、ルート・展開・..・外・symlink 越しは確認になる
- `cd <別の checkout> && git push` は、移動先の branch で判定する（移動先が main でなければ確認にならない）

guard を実プロセスで起こし、hook の入力 JSON を stdin へ渡して判定（ask / allow / deny）を見る。
HOME は存在しない dir に差し替え、実際の ~/.trashable・実 repo には触れない。

--mutation は保護を 1 つ外した guard をコピーして作り、対応する --case が red になることを示す。
実装ファイルは変更しない。注入先が 1 か所に決まらなければ exit 3（保護の喪失の red = exit 1 と区別する）。
"""
import argparse
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
GUARD = ROOT / "scripts/hooks/guard-bash.py"
FAKE_HOME = "/nonexistent-guard-home"
OUTSIDE_TEMP = Path("/usr")  # 一時領域の外の実在 dir。相対 path の rm -rf を ask にしたい test の基準（#170）

MUTATIONS = {
    "root": [("path.startswith(root.rstrip(os.sep) + os.sep)", "path.startswith(root.rstrip(os.sep))")],
    "expansion": [('if not target or "\\0" in target or any(char in target for char in EXPANSION_CHARS):', "if not target:")],
    "dotdot": [('".." in path.split("/")', "False")],
    "parentreal": [('if not inside_temp(parent.rstrip("/") + "/x", [real for _, real in rm_temp_roots()]):', "if False:")],
    "trailing": [("return not (trailing and os.path.islink(path))", "return True")],
    "realroot": [("if real == os.sep or home == real or home.startswith(real + os.sep):", "if False:")],
    "longopt": [("            if arg not in RM_LONG_OPTIONS:\n                return None\n", "            pass\n")],
    "shortopt": [("            if not set(arg[1:]) <= RM_SHORT_OPTIONS:\n                return None\n", "            pass\n")],
    "notes": [("base = None if notes else followed", "base = followed")],
    "tilde": [('tilde_ok = "HOME" not in folded', "tilde_ok = True")],
    "quoted": [("tilde_ok and not quoted", "tilde_ok")],
    "hint": [("~/.trashable/<repo>/", "")],
    "cdfollow": [("followed = leading_cwd(command, start_cwd)", "followed = start_cwd")],
    "cdcount": [("followed != total or ", "")],
    "cdisdir": [("followed != total or not cwd or not os.path.isdir(cwd)", "followed != total or not cwd")],
    "cdpipe": [("or has_non_sequential_operator(outer)", "")],
    "cdsubst": [("outer.strip() != text.strip() or ", "")],
    "subst": [("not any(mark in folded for mark in (\"$(\", \"`\", \"<(\", \">(\"))", "True")],
    "lnmv": [(" and not LN_MV_RE.search(folded)", "")],
    "except": [("            except Exception:\n                pass  # 判定できない", "            except ZeroDivisionError:\n                pass  # 判定できない")],
    "fold": [("    text = fold_continuations(mask_heredoc_bodies(text))\n", "    text = mask_heredoc_bodies(text)\n")],
    "foldmain": [("    folded = fold_continuations(command)\n", "    folded = command\n")],
    "foldquote": [('            if not quote and text[index + 1 : index + 2] == "\\n":', '            if text[index + 1 : index + 2] == "\\n":')],
    "ansic": [("            ansi_c = char == \"'\" and folded[-1:] == [\"$\"]\n", "")],
    "gitcwd": [("git_cwd = cwd if notes or not followed or followed == start_cwd else followed", "git_cwd = cwd")],
}
CASES = {
    "root": "test_rm_root_itself_asks",
    "expansion": "test_rm_expansion_asks",
    "dotdot": "test_rm_dotdot_asks",
    "parentreal": "test_rm_symlinked_parent_asks",
    "trailing": "test_rm_trailing_slash_symlink_asks",
    "realroot": "test_rm_wide_tmpdir_is_not_a_root",
    "longopt": "test_rm_unknown_option_asks",
    "shortopt": "test_rm_unknown_option_asks",
    "notes": "test_rm_relative_with_chdir_wrapper_asks",
    "tilde": "test_rm_tilde_with_home_override_asks",
    "quoted": "test_rm_quoted_tilde_asks",
    "hint": "test_rm_ask_points_to_trashable",
    "cdfollow": "test_push_follows_cd_to_non_main",
    "cdcount": "test_push_unfollowable_cd_falls_back",
    "cdisdir": "test_push_unfollowable_cd_falls_back",
    "cdpipe": "test_push_unfollowable_cd_falls_back",
    "cdsubst": "test_push_cd_target_substitution_falls_back",
    "subst": "test_rm_with_substitution_asks",
    "lnmv": "test_rm_with_ln_or_mv_asks",
    "except": "test_rm_judgement_error_asks",
    "gitcwd": "test_push_follows_cd_to_non_main",
    "fold": "test_continuation_is_folded",
    "foldmain": "test_continuation_splitting_ln_or_mv_asks",
    "foldquote": "test_continuation_inside_quotes_is_kept",
    "ansic": "test_continuation_after_ansi_c_quote_is_kept",
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

WORK = Path(tempfile.mkdtemp(prefix="guard-ask-"))
(WORK / "guard-bash.py").write_text(source)
# 判定の関数が例外を出す guard（N3 の確認用。注入済みの source から作る）。注入先が 1 か所でなければ exit 3
_fault_re = re.compile(r"^    if not target", re.M)
if len(_fault_re.findall(source)) != 1:
    print("fault injection target changed", file=sys.stderr)
    sys.exit(3)
(WORK / "guard-fault.py").write_text(_fault_re.sub('    raise ValueError("fault")\n    if not target', source, count=1))
FX = WORK / "fx"
MAIN = WORK / "main-repo"
FEAT = WORK / "feat-repo"
FX.mkdir()
(FX / "link").symlink_to("/usr")
(FX / "plain").mkdir()
for repo, branch in ((MAIN, "main"), (FEAT, "feat/1-x")):
    subprocess.run(["git", "init", "-q", "-b", branch, str(repo)], check=True)


def decide(command, cwd=None, env=None, script="guard-bash.py"):
    """guard の判定: deny（exit 2）/ ask / allow。理由の文面も返す。"""
    environment = {key: value for key, value in os.environ.items() if key != "TMPDIR"}
    environment.update({"HOME": FAKE_HOME, "PYTHONDONTWRITEBYTECODE": "1"})
    environment.update(env or {})
    payload = {"tool_input": {"command": command}, "cwd": str(cwd or ROOT)}
    done = subprocess.run(
        [sys.executable, str(WORK / script)], input=json.dumps(payload),
        text=True, capture_output=True, env=environment, check=False,
    )
    if done.returncode == 2:
        return "deny", done.stderr
    if done.stdout.strip():
        output = json.loads(done.stdout)["hookSpecificOutput"]
        return output["permissionDecision"], output["permissionDecisionReason"]
    return "allow", ""


class Base(unittest.TestCase):
    def allows(self, command, cwd=None, env=None):
        self.assertEqual(decide(command, cwd, env)[0], "allow", command)

    def asks(self, command, cwd=None, env=None):
        self.assertEqual(decide(command, cwd, env)[0], "ask", command)


class RmTemporary(Base):
    def test_rm_inside_temporary_roots_is_allowed(self):
        tmpdir = {"TMPDIR": "/nonexistent-guard-tmp/T"}
        for command in (
            "rm -rf /tmp/x", "rm -rf /private/tmp/x/y", "rm -fr /tmp/x", "rm -r -f /tmp/x", "rm --recursive --force /tmp/x",
            "rm -rfv /tmp/x", "rm -rf -- /tmp/x", "rm -rf /tmp/x /tmp/y", "rm -rf /tmp/x/", "rm -rf ~/.trashable/repo/x",
            "rm -rf ~/.trashable/x", "rm -rf /nonexistent-guard-tmp/T/x", "rm -rf /var/folders/ab/cd/T/x",
            "rm -rf /private/var/folders/ab/cd/T/x/y", "sudo rm -rf /tmp/x", "env FOO=1 rm -rf /tmp/x", "rm /tmp/x -rf",
            "bash -c 'rm -rf /tmp/x'", "ls && rm -rf /tmp/x 2>&1", "rm -rf /tmp/with\\ space/x", f"rm -rf {FX}/link",
        ):
            self.allows(command, env=tmpdir)

    def test_rm_relative_is_judged_by_cwd(self):
        self.allows("rm -rf plain", cwd=FX)
        self.allows(f"cd {FX} && rm -rf plain")
        self.allows(f"cd {FX}; cd plain; rm -rf x")
        # repo が一時領域の下にあっても ask を確かめられるよう、一時領域の外の実在 dir を基準にする（#170）
        self.asks("rm -rf plain", cwd=OUTSIDE_TEMP)

    def test_rm_root_itself_asks(self):
        tmpdir = {"TMPDIR": "/nonexistent-guard-tmp/T"}
        for command in (
            "rm -rf /tmp", "rm -rf /tmp/", "rm -rf /tmp/.", "rm -rf /private/tmp", "rm -rf ~/.trashable", "rm -rf ~/.trashable/",
            # /tmpfoo/x は macOS では /tmp の実体が /private/tmp のため親の実体の判定でも止まる。字面の判定だけを
            # 確かめる /private/tmpfoo/x を併せて置く（どちらの OS でも root の保護を外すと red になる）
            "rm -rf ~", "rm -rf /tmpfoo/x", "rm -rf /private/tmpfoo/x", "rm -rf /nonexistent-guard-tmp/T", "rm -rf /nonexistent-guard-tmp",
            "rm -rf /var/folders/ab/cd/T", "rm -rf /private/var/folders/ab/cd/T/", "rm -rf /var/folders/ab/cd",
        ):
            self.asks(command, env=tmpdir)

    def test_rm_outside_asks(self):
        for command in ("rm -rf /etc/x", "rm -rf /", "rm -rf /home/x", "rm -rf /tmp/x /etc/x", "rm -rf /etc/x /tmp/x",
                        "rm -rf", "bash -c 'rm -rf /etc/x'", "eval 'rm -rf /etc/x'", "rm -Rf /etc/x", "rm -rf /tmp/x; rm -rf /etc/x"):
            self.asks(command)

    def test_rm_expansion_asks(self):
        for command in ("rm -rf /tmp/*", "rm -rf /tmp/x*", "rm -rf /tmp/?", "rm -rf /tmp/[ab]", "rm -rf /tmp/{a,b}",
                        "rm -rf /tmp/$X", "rm -rf $TMPDIR/x", "rm -rf ${TMPDIR}/x", "rm -rf /tmp/$(echo a)", "rm -rf /tmp/`echo a`",
                        "rm -rf ~root/x", "rm -rf ~+/x", "rm -rf ~/.trashable/*"):
            self.asks(command, env={"TMPDIR": "/nonexistent-guard-tmp/T"})

    def test_rm_dotdot_asks(self):
        for command in ("rm -rf /tmp/../tmp/x", "rm -rf /tmp/x/../y", "rm -rf /tmp/x/..", "rm -rf /tmp/../etc", "rm -rf ~/.trashable/../x",
                        "rm -rf ~/../tmp/x"):
            self.asks(command)
        self.asks("rm -rf ../x", cwd=FX / "plain")

    def test_rm_symlinked_parent_asks(self):
        self.asks(f"rm -rf {FX}/link/bin")
        self.asks(f"rm -rf {FX}/link/bin/x")
        self.asks(f"rm -rf {FX}/link/*")
        self.asks(f"cd {FX} && rm -rf link/bin")

    def test_rm_trailing_slash_symlink_asks(self):
        self.asks(f"rm -rf {FX}/link/")
        self.asks(f"rm -rf {FX}/link/.")
        self.allows(f"rm -rf {FX}/plain/")

    def test_rm_wide_tmpdir_is_not_a_root(self):
        # TMPDIR が / や HOME を覆う dir だと、一時領域の外まで通ってしまう
        self.asks("rm -rf /etc/x", env={"TMPDIR": "/"})
        self.asks("rm -rf /nonexistent-guard-home/x", env={"TMPDIR": FAKE_HOME})
        self.asks("rm -rf /nonexistent-guard-home/x", env={"TMPDIR": "/nonexistent-guard-home"})
        self.asks("rm -rf /nonexistent-guard-home/x", env={"TMPDIR": "/"})

    def test_rm_unknown_option_asks(self):
        for command in ("rm -rf --no-preserve-root /tmp/x", "rm -rfi /tmp/x", "rm -rf -P /tmp/x", "rm -rf --interactive /tmp/x",
                        "rm -rf --bogus /tmp/x"):
            self.asks(command)

    def test_rm_relative_with_chdir_wrapper_asks(self):
        self.asks("env -C /etc rm -rf plain", cwd=FX)
        self.asks("sudo -D /etc rm -rf plain", cwd=FX)

    def test_rm_relative_after_unfollowed_cd_asks(self):
        for command in ("echo a; cd /etc; rm -rf plain", "if true; then cd /etc; rm -rf plain; fi", "cd /etc | rm -rf plain",
                        "(cd /etc; rm -rf plain)", "eval 'cd /etc'; rm -rf plain", "cd $X && rm -rf plain", "cd - && rm -rf plain",
                        "cd /nonexistent-guard-dir && rm -rf plain"):
            self.asks(command, cwd=FX)

    def test_rm_tilde_with_home_override_asks(self):
        self.asks("export HOME=/etc; rm -rf ~/.trashable/x")
        self.asks("HOME=/etc rm -rf ~/.trashable/x")

    def test_rm_quoted_tilde_asks(self):
        # 引用符の中の ~ は展開されず、cwd 直下の "~" という名前の dir になる
        self.asks('rm -rf "~/.trashable/x"')
        self.asks("rm -rf '~/.trashable/x'")
        self.asks("rm -rf ~/.trashable/x\\ y")

    def test_rm_with_substitution_asks(self):
        for command in ("rm -rf $(echo /etc) /tmp/x", "rm -rf /tmp/x/$(echo ../../etc)", "rm -rf /tmp/x <(echo /etc)", "rm -rf /tmp/x `pwd`",
                        "rm -rf /tmp/x >(cat)", "bash -c 'rm -rf /tmp/x $(echo /etc)'", "eval 'rm -rf /tmp/x `pwd`'", "rm -rf /tmp/x$(echo)",
                        "echo $(true); rm -rf /tmp/x"):
            self.asks(command)

    def test_rm_with_ln_or_mv_asks(self):
        for command in ("ln -s / /tmp/l && rm -rf /tmp/l/etc", "mv /tmp/a /tmp/b; rm -rf /tmp/b/x", "ln -sfn /etc /tmp/l; rm -rf /tmp/l/x"):
            self.asks(command)

    def test_continuation_is_folded(self):
        # 行末の backslash＋改行（引用の外）は shell が読む前に畳む。path の直後・名前の途中・sudo / bash -c の中でも確認になる（#166）
        for command in ("rm -rf /etc\\\n", "rm -rf /etc/x\\\n", "r\\\nm -rf /etc", "rm\\\n -rf /etc", "rm -rf /e\\\ntc",
                        "sudo rm -rf /etc\\\n", "sudo r\\\nm -rf /etc", "bash -c 'rm -rf /etc\\\n'", "bash -c 'r\\\nm -rf /etc'",
                        "eval 'r\\\nm -rf /etc'", "echo a; r\\\nm -rf /etc", "rm -rf \\\n/etc/x", "rm -rf /tmp/x /etc\\\n"):
            self.asks(command)
        # 継続で割っても一時領域の中は通る。backslash 自身の後の改行は継続でなく、別の command になる
        self.allows("rm -rf /tmp/x\\\n", env={"TMPDIR": "/nonexistent-guard-tmp/T"})
        self.allows("r\\\nm -rf /tmp/x")
        self.asks("echo a\\\\\nrm -rf /etc")

    def test_continuation_splitting_ln_or_mv_asks(self):
        for command in ("l\\\nn -s / /tmp/l && rm -rf /tmp/l/etc", "ln -s / /tmp/l && r\\\nm -rf /tmp/l/etc", "m\\\nv /tmp/a /tmp/b; rm -rf /tmp/b/x",
                        "echo $\\\n(true); rm -rf /tmp/x"):
            self.asks(command)

    def test_continuation_inside_quotes_is_kept(self):
        # 引用の中の backslash＋改行は文字列の一部。畳まない（畳むと path が /tmp/x に変わり確認が消える）
        self.asks("rm -rf '/tm\\\np/x'")
        self.asks("rm -rf \"/tm\\\np/x\"")
        # 引用の中の継続があっても、ほかの判定（secret・worktree・polling・ask）は変わらない
        for command in ("echo 'cat .env\\\n'", "git commit -m 'a\\\nb'", "echo 'while true; do sleep 1; done\\\n'",
                        "echo 'git worktree add /tmp/wt x\\\n'", "echo 'rm -rf /etc\\\n'", "echo \"git push --force\\\n\"",
                        "# note \\\nx"):
            self.allows(command, cwd=FEAT)
        for command in ("cat .env 'a\\\nb'", "git worktree add /tmp/wt 'a\\\nb'", "cat\\\n .env", "while true; do sleep\\\n 1; done"):
            self.assertEqual(decide(command, cwd=FEAT)[0], "deny", command)
        self.asks("git push --force 'a\\\nb'", cwd=FEAT)

    def test_continuation_after_ansi_c_quote_is_kept(self):
        # $'it\\'s' は \\' で閉じない。閉じたと取り違えると後ろの引用の開閉が反転し、引用の中の継続が畳まれて確認が消える（#166 の review B1）
        for command in ("echo $'it\\'s' ; rm -rf '/tm\\\np/x'", "echo $'it\\'s'; rm -rf '/tm\\\np/x'", "echo $'a\\\\'; rm -rf '/tm\\\np/x'",
                        "echo $'x\\\ny'; rm -rf /etc\\\n"):
            self.asks(command)
        self.allows("echo $'a\\\nb' ; echo 'x'", cwd=FEAT)
        self.allows("echo \"$'\" ; rm -rf /tmp/x\\\n")

    def test_rm_judgement_error_asks(self):
        # 判定の関数が例外を出しても落ちずに確認する（静的な規則を外したので、判定できなければ確認、の前提）
        self.assertEqual(decide("rm -rf /tmp/x", script="guard-fault.py")[0], "ask")
        self.assertEqual(decide("rm -rf /tmp/x /etc/x", script="guard-fault.py")[0], "ask")
        self.asks("rm -rf '/tmp/a\x00b'")

    def test_rm_ask_points_to_trashable(self):
        decision, reason = decide("rm -rf /etc/x")
        self.assertEqual(decision, "ask")
        self.assertIn("~/.trashable/<repo>/", reason)
        self.assertIn("確認なしで消せる", reason)

    def test_other_asks_are_kept(self):
        for command in ("git push --force", "git push origin main", "git push origin HEAD:main", "git reset --hard", "git clean -fd",
                        "git checkout -- .", "git branch -D topic", "git worktree remove x", "git worktree prune", "git worktree move a b",
                        "gh pr close 1", "gh repo delete o/r", "ssh host ls"):
            self.asks(command, cwd=FEAT)

    def test_deny_is_unchanged(self):
        for command in ("cat .env", "git worktree add /tmp/wt x", "while true; do sleep 1; done"):
            self.assertEqual(decide(command, cwd=FEAT)[0], "deny", command)


class PushCd(Base):
    def test_push_without_cd_judges_by_cwd(self):
        self.asks("git push", cwd=MAIN)
        self.allows("git push", cwd=FEAT)
        self.allows(f"git -C {FEAT} push", cwd=MAIN)
        self.asks(f"git -C {MAIN} push", cwd=FEAT)

    def test_push_follows_cd_to_non_main(self):
        for command in (f"cd {FEAT} && git push", f"cd {FEAT}; git push origin", f"cd {FEAT} && git add . && git push",
                        f"cd {FEAT} && bash -c 'git push'", f"cd {WORK} && cd feat-repo && git push"):
            self.allows(command, cwd=MAIN)

    def test_push_follows_cd_to_main(self):
        self.asks(f"cd {MAIN} && git push", cwd=FEAT)
        self.asks(f"cd {FEAT} && cd {MAIN} && git push", cwd=FEAT)

    def test_push_after_cd_keeps_other_asks(self):
        self.asks(f"cd {FEAT} && git push origin main", cwd=MAIN)
        self.asks(f"cd {FEAT} && git push --force", cwd=MAIN)
        self.asks(f"cd {FEAT} && git push origin HEAD:refs/heads/main", cwd=MAIN)

    def test_push_unfollowable_cd_falls_back(self):
        # 追い切れない形は旧来どおり hook 入力の cwd（main）で判定し、確認になる
        for command in (
            f"cd {FEAT} | git push", f"(cd {FEAT} && git push)", f"cd {FEAT} & git push", f"echo a; cd {FEAT} && git push",
            f"cd {FEAT} && if true; then cd {MAIN}; fi; git push", f"cd {FEAT} || git push", "cd /nonexistent-guard-dir; git push",
            f"cd {FEAT} && bash -c 'cd {MAIN} && git push'", "cd $X && git push", "cd - && git push", "cd && git push",
        ):
            self.asks(command, cwd=MAIN)

    def test_push_cd_target_substitution_falls_back(self):
        # cd $(…) は置換が消えて引数なしの cd（HOME）に見える。HOME が feat でも、実際の行き先は main
        self.asks(f"cd $(echo {MAIN}) && git push", cwd=MAIN, env={"HOME": str(FEAT)})
        self.asks(f"cd `echo {MAIN}` && git push", cwd=MAIN, env={"HOME": str(FEAT)})

    def test_push_with_chdir_wrapper_uses_hook_cwd(self):
        self.asks(f"cd {FEAT} && env -C {MAIN} git push", cwd=MAIN)


if __name__ == "__main__":
    selected = unittest.TestSuite()
    loader = unittest.defaultTestLoader
    if arguments.case:
        name = CASES[arguments.case]
        for cls in (RmTemporary, PushCd):
            if hasattr(cls, name):
                selected.addTest(cls(name))
    else:
        selected.addTests(loader.loadTestsFromTestCase(RmTemporary))
        selected.addTests(loader.loadTestsFromTestCase(PushCd))
    result = unittest.TextTestRunner(verbosity=0, stream=sys.stderr).run(selected)
    sys.exit(0 if result.wasSuccessful() else 1)
