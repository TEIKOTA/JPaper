#!/usr/bin/env python3
"""セッションごとのコンテナ隔離（#126）。起動・取り込み・片付けの正本.

守りの分担:
- 子のコンテナ: 専用 clone（~/agents/<repo>/<session>/）だけを mount し、GitHub は L2 トークン
  （読み取りと PR・issue へのコメント）だけを持つ。push・merge はホストの owner が行う。
- ホスト: 子の repo に対する git 操作は、ネットワーク・認証なしの検査コンテナに閉じる
  （子が .git/config に仕込んだ fsmonitor・filter 等をホストで実行しないため）。
  ホストは検査結果の JSON と bundle（データだけ）を受け取る。
- 片付け: コンテナが動いておらず、未コミットの変更が無く、全 ref の commit をホストの
  refs/agents/<session>/ に取り込んで一致を確かめた場合に限り、承認なしで消す。headless の結果と
  ~/.agent-box/artifacts/ の成果物（symlink 等は写さず skipped.txt に記録）は
  ~/agents/<repo>/.results/ へ写してから消す。
"""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
SESSION_PATTERN = re.compile(r"[a-z0-9][a-z0-9-]{0,39}")
GITHUB_URL = re.compile(r"(?:https://github\.com/|ssh://git@github\.com/|git@github\.com:)"
                        r"([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+?)(?:\.git)?/?")
DEFAULT_IMAGE = "agent-box:latest"
DEFAULT_LIMIT = 3
INSPECT = "/usr/local/lib/agent-box/inspect.sh"
ENTRYPOINT = "/usr/local/lib/agent-box/entrypoint.sh"
# 起動の直後に止まる失敗（エントリポイントの exec 前の失敗。#175）を見るための待ち。
# 2026-10-17 の事象は create → die が同じ秒だった。長いほど start が遅くなり、短いと取りこぼすので数秒に留める。
STARTUP_WAIT = 3
LABEL = "agent-box"

# コンテナの書き込み層と資源の制限（#133）。子と検査の `docker run` で共有する（正本は ADR 20261012-restrict-agent-container-writes-and-resources）。
# 子が /tmp に深い入れ子の dir を作り、片付けの snapshot 削除で containerd が止まった事故の再発防止:
# ルートは読み取り専用、書けるのは mount した /work・home・/cache と、overlayfs を通らない tmpfs の /tmp だけ。
# tmpfs は docker の既定が noexec なので exec を明示する（npm の build・Claude Code の一時 script が /tmp から実行する）。
# tmpfs の容量は cgroup の memory に数えられるので、size は memory の内側に収める。
HARDENING = ["--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges"]
# 対話モードの大量出力で VM のログが増え続けないよう、コンテナのログに上限を付ける（#137）
LOG_LIMITS = ["--log-opt", "max-size=10m", "--log-opt", "max-file=3"]
CHILD_LIMITS = {"memory": "3g", "pids": "1024", "tmp_size": "1g"}    # 同時 3 個 = 9 GiB（OrbStack の VM は約 11.7 GiB）
INSPECT_LIMITS = {"memory": "1g", "pids": "256", "tmp_size": "256m"}  # 子と同時に動くので小さくする
# 起動に要る空き。Docker の volume と、ホストの ~/agents/ の clone・home には容量の上限を付けられないので、
# 空きが下限を切ったら新しいセッションを始めない（作業中の子が使い切るのは防げない。ADR 20261014）。
MIN_FREE_BYTES = 5 * 1024 ** 3
UNITS = {"k": 1024, "m": 1024 ** 2, "g": 1024 ** 3}


def restrictions(limits):
    """`docker run` に足す制限の argv（swap は memory と同値にして無効化する）."""
    return [*HARDENING, *LOG_LIMITS, "--memory", limits["memory"], "--memory-swap", limits["memory"],
            "--pids-limit", limits["pids"],
            "--tmpfs", "/tmp:rw,exec,nosuid,nodev,mode=1777,size=%s,nr_inodes=200000" % limits["tmp_size"]]


def size_bytes(value):
    """"3g" 等の docker の容量表記を byte にする."""
    return int(value[:-1]) * UNITS[value[-1]]


def gib(value):
    return "%.1f GiB" % (value / 1024 ** 3)


# docker daemon に繋がらないときの stderr（OrbStack・Docker Desktop・素の docker）。起動は AI がしてよい（#160）。
DOCKER_DOWN = re.compile(r"failed to connect to the docker API|Cannot connect to the Docker daemon"
                         r"|Is the docker daemon running|error during connect", re.I)
DOCKER_DOWN_HINT = ("\n  Docker が止まっています。`orb start` で起動できます（数秒。起動してから再実行する）。"
                    "固まっているときの `orb restart` / `orb reset` は利用者の判断"
                    "（docs/process/agent-containers.md の「Docker が固まったとき」）")


class Stop(RuntimeError):
    pass


def run(argv, cwd=None, env=None, allowed=(0,), timeout=120, capture=True, stdin=None):
    try:
        result = subprocess.run(argv, cwd=cwd, env=env, timeout=timeout, input=stdin,
                                stdout=subprocess.PIPE if capture else None,
                                stderr=subprocess.PIPE if capture else None)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise Stop("コマンド失敗: %s (%s)" % (argv[0], exc)) from exc
    if result.returncode not in allowed:
        detail = result.stderr.decode(errors="replace").strip().splitlines()[-1:] if capture and result.stderr else []
        message = "コマンド失敗: %s %s exit=%d %s" % (argv[0], argv[1] if len(argv) > 1 else "",
                                                    result.returncode, " ".join(detail))
        if argv[0] == "docker" and DOCKER_DOWN.search(" ".join(detail)):
            message += DOCKER_DOWN_HINT
        raise Stop(message)
    return result


def git(*argv, cwd):
    return run(["git", *argv], cwd=cwd).stdout.decode().strip()


def physical(path):
    """symlink を含まない絶対 path だけを受け付ける（片付けで別の場所を消さないため）."""
    path = Path(path)
    if not path.is_absolute():
        raise Stop("絶対 path ではありません: %s" % path)
    current = Path(path.anchor)
    for part in path.parts[1:]:
        current = current / part
        if current.is_symlink():
            raise Stop("path に symlink が含まれます: %s" % current)
    return path


def keychain(service, prefixes):
    result = run(["security", "find-generic-password", "-s", service, "-w"], allowed=(0, 44))
    value = result.stdout.decode().strip()
    if result.returncode != 0 or not value:
        raise Stop("キーチェーンに %s がありません（docs/process/agent-containers.md の準備手順）" % service)
    # 値は表示しない。保存時の取り違え（コマンド文字列を貼った等）をコンテナ起動前に止める。
    if not value.startswith(prefixes) or any(char.isspace() for char in value):
        raise Stop("キーチェーンの %s がトークンの形ではありません（%s で始まり空白を含まない値を -U で保存し直す）"
                   % (service, " / ".join(prefixes)))
    return value


class Box:
    def __init__(self, repo=None):
        top = Path(git("rev-parse", "--show-toplevel", cwd=repo or os.getcwd()))
        common = Path(git("rev-parse", "--path-format=absolute", "--git-common-dir", cwd=top))
        self.host = common.parent if common.name == ".git" else top
        self.name = re.sub(r"[^a-z0-9_.-]", "-", self.host.name.lower())
        home = os.environ.get("AGENT_BOX_HOME") or str(Path.home() / "agents")
        self.base = physical(Path(home)) / self.host.name
        self.sessions = self.base / ".sessions"

    # ---- 状態 ----
    def check_session(self, session):
        if not SESSION_PATTERN.fullmatch(session or ""):
            raise Stop("session 名は英小文字・数字・ハイフン（40 字まで）: %r" % session)
        return session

    def state_path(self, session):
        return self.sessions / (self.check_session(session) + ".json")

    def load(self, session):
        path = physical(self.state_path(session))
        if not path.is_file():
            raise Stop("agent-box が作った session ではありません: %s" % session)
        state = json.loads(path.read_text())
        clone = physical(Path(state["clone"]))
        home = physical(Path(state["home"]))
        if clone != self.base / session or home != self.sessions / session / "home":
            raise Stop("state の path が規定の配置と一致しません")
        return state

    def container(self, session):
        return "agent-%s-%s" % (self.name, session)

    def running(self, name=None):
        argv = ["docker", "ps", "-q", "--filter", "label=%s=1" % LABEL]
        if name:
            argv += ["--filter", "name=^/%s$" % name]
        return [line for line in run(argv).stdout.decode().split() if line]

    def cache_volume(self):
        """npm・pip の cache は repo ごとの volume（repo をまたいで書き換えさせない。#137）."""
        return "agent-box-cache-" + self.name

    def check_capacity(self, image):
        """メモリと空き容量が足りなければ起動しない。--allow-over-limit でも外さない（外すのは個数の上限だけ）."""
        info = run(["docker", "info", "--format", "{{.MemTotal}}"]).stdout.decode().strip()
        if not info.isdigit():
            raise Stop("VM のメモリ量を読めません（docker info）")
        need = (len(self.running()) + 1) * size_bytes(CHILD_LIMITS["memory"]) + size_bytes(INSPECT_LIMITS["memory"])
        if need > int(info):
            raise Stop("メモリが足りません（動作中の子と新しい子・検査 1 つで %s、VM は %s）" % (gib(need), gib(int(info))))
        existing = self.base
        while not existing.exists():
            existing = existing.parent
        host_free = shutil.disk_usage(existing).free
        if host_free < MIN_FREE_BYTES:
            raise Stop("ホストのディスクの空きが %s です（%s 以上必要。~/agents/ の不要な session・.results を片付ける）"
                       % (gib(host_free), gib(MIN_FREE_BYTES)))
        probe = run(["docker", "run", "--rm", "--network", "none", *restrictions(INSPECT_LIMITS),
                     "--label", "%s.probe=1" % LABEL, "-v", "%s:/cache" % self.cache_volume(),
                     "--entrypoint", "df", image, "-Pk", "/cache"]).stdout.decode().splitlines()
        try:
            vm_free = int(probe[-1].split()[3]) * 1024
        except (IndexError, ValueError) as exc:
            raise Stop("VM のディスクの空きを読めません（df）") from exc
        if vm_free < MIN_FREE_BYTES:
            raise Stop("VM のディスクの空きが %s です（%s 以上必要。docker system df で image・volume を確かめる）"
                       % (gib(vm_free), gib(MIN_FREE_BYTES)))

    def github_url(self):
        origin = git("config", "--get", "remote.origin.url", cwd=self.host)
        match = GITHUB_URL.fullmatch(origin)
        if not match:
            raise Stop("origin が GitHub の repo ではありません")
        return "https://github.com/%s.git" % match.group(1)

    # ---- 起動 ----
    def prepare_home(self, home, state):
        """ユーザー設定を読み取り専用で写す（D15）。ログイン情報・会話記録・memory は写さない."""
        source = Path.home() / ".claude"
        claude = home / ".claude"
        claude.mkdir(parents=True, exist_ok=True)
        if (source / "CLAUDE.md").is_file():
            shutil.copyfile(source / "CLAUDE.md", claude / "CLAUDE.md")
        if (source / "skills").is_dir():
            shutil.copytree(source / "skills", claude / "skills", dirs_exist_ok=True)
        # ユーザーレベルの hook はホストの path を指すので写さない。品質 hook は repo 側の設定で動く（D16）。
        (claude / "settings.json").write_text(json.dumps({"permissions": {"defaultMode": "bypassPermissions"}}))
        (home / ".claude.json").write_text(json.dumps({
            "hasCompletedOnboarding": True, "bypassPermissionsModeAccepted": True,
            "projects": {"/work": {"hasTrustDialogAccepted": True}}}))
        codex = Path.home() / ".codex" / "AGENTS.md"
        if codex.is_file():
            (home / ".codex").mkdir(exist_ok=True)
            shutil.copyfile(codex, home / ".codex" / "AGENTS.md")
        (home / ".agent-box").mkdir(exist_ok=True)
        (home / ".agent-box" / "artifacts").mkdir(exist_ok=True)

    def start(self, args):
        session = self.check_session(args.session)
        clone, state_path = self.base / session, self.state_path(session)
        if any(path.exists() or path.is_symlink() for path in (state_path, clone)):
            raise Stop("session %s は既にあります（resume を使う）" % session)
        # collect は強制更新なので、同名で始めると片付け済みの session の成果（唯一の写し）を上書きする。
        if git("for-each-ref", "--count=1", "refs/agents/%s/" % session, cwd=self.host):
            raise Stop("refs/agents/%s/ に取り込み済みの ref が残っています（別の名前を使うか、"
                       "merge 済みなら agent-box.sh prune で整理する）" % session)
        image = args.image or DEFAULT_IMAGE
        run(["docker", "image", "inspect", image], allowed=(0,))
        if not args.allow_over_limit and len(self.running()) >= DEFAULT_LIMIT:
            raise Stop("子のコンテナが既に %d 個動いています（上限。--allow-over-limit で超えられる）" % DEFAULT_LIMIT)
        self.check_capacity(image)
        secrets = self.secrets(args.tool)
        base_ref = run(["git", "rev-parse", "--verify", "--symbolic-full-name", args.base],
                       cwd=self.host, allowed=(0, 128)).stdout.decode().strip()
        if not base_ref.startswith("refs/"):
            raise Stop("--base は ref 名で指定してください（commit SHA は不可）: %s" % args.base)
        if args.branch:
            run(["bash", str(ROOT / "scripts/check-branch-name.sh"), args.branch], cwd=self.host)
        url = self.github_url()
        box = self.sessions / session
        home = box / "home"
        self.sessions.mkdir(parents=True, exist_ok=True)
        physical(clone.parent)
        physical(box)
        # state file を書く前に失敗したら、この start が作った dir だけを消す（前から在るものは触らない）。
        created = []
        try:
            clone.mkdir()
            created.append(clone)
            if not box.exists() and not box.is_symlink():
                box.mkdir(mode=0o700)
                created.append(box)
            home.mkdir()
            created.append(home)
            os.chmod(box, 0o700)
            # 子の clone はホストが作った直後だけホストで git を操作する（子がまだ触れていない）。
            git("init", "-q", cwd=clone)
            git("remote", "add", "origin", url, cwd=clone)
            git("fetch", "-q", "--no-tags", str(self.host), "+refs/remotes/origin/*:refs/remotes/origin/*",
                "+%s:refs/agent-box/base" % base_ref, cwd=clone)
            sha = git("rev-parse", "refs/agent-box/base", cwd=clone)
            git("update-ref", "-d", "refs/agent-box/base", cwd=clone)
            if args.branch:
                git("checkout", "-q", "-b", args.branch, sha, cwd=clone)
            else:
                git("checkout", "-q", "--detach", sha, cwd=clone)
            self.prepare_home(home, None)
            state = {"session": session, "repo": str(self.host), "clone": str(clone), "home": str(home),
                     "container": self.container(session), "base": base_ref, "base_sha": sha,
                     "branch": args.branch, "tool": args.tool, "image": image, "created": time.strftime("%Y-%m-%dT%H:%M:%S%z")}
            created.append(state_path)
            state_path.write_text(json.dumps(state, ensure_ascii=False, indent=2))
        except BaseException:
            self.discard(created)
            raise
        return self.launch(state, secrets, args.prompt_file, resume=False)

    @staticmethod
    def discard(created):
        """start が作った path だけを新しい順に消す。消せなくても元の失敗を隠さない."""
        for path in reversed(created):
            try:
                if path.is_symlink() or path.is_file():
                    path.unlink()
                elif path.is_dir():
                    shutil.rmtree(path)
            except OSError:
                pass

    def resume(self, args):
        state = self.load(args.session)
        if self.running(state["container"]):
            raise Stop("session %s のコンテナは動作中です" % args.session)
        if not args.allow_over_limit and len(self.running()) >= DEFAULT_LIMIT:
            raise Stop("子のコンテナが既に %d 個動いています（上限。--allow-over-limit で超えられる）" % DEFAULT_LIMIT)
        self.check_capacity(state["image"])
        return self.launch(state, self.secrets(state["tool"]), args.prompt_file, resume=True)

    def secrets(self, tool):
        values = {"GH_TOKEN": keychain("agent-gh-token-%s" % self.host.name, ("github_pat_",))}
        if tool == "claude":
            values["CLAUDE_CODE_OAUTH_TOKEN"] = keychain("agent-claude-oauth-token", ("sk-ant-oat",))
        return values

    def launch(self, state, secrets, prompt_file, resume):
        env = dict(os.environ, **secrets)
        env["AGENT_GIT_NAME"] = run(["git", "config", "user.name"], cwd=self.host, allowed=(0, 1)).stdout.decode().strip()
        env["AGENT_GIT_EMAIL"] = run(["git", "config", "user.email"], cwd=self.host, allowed=(0, 1)).stdout.decode().strip()
        argv = ["docker", "run", "--rm", "--name", state["container"], "--hostname", "agent-" + state["session"],
                *restrictions(CHILD_LIMITS),
                "--label", "%s=1" % LABEL, "--label", "%s.repo=%s" % (LABEL, self.host.name),
                "--label", "%s.session=%s" % (LABEL, state["session"]),
                "-v", "%s:/work" % state["clone"], "-v", "%s:/home/node" % state["home"],
                "-v", "%s:/cache" % self.cache_volume(), "-e", "AGENT_BOX_SESSION=%s" % state["session"],
                "-e", "AGENT_GIT_NAME", "-e", "AGENT_GIT_EMAIL"]
        # 秘密は値を argv に載せず、docker CLI の環境変数から渡す。
        for name in sorted(secrets):
            argv += ["-e", name]
        tool = self.tool_command(state["tool"], resume)
        if prompt_file is None:
            argv += ["-it", state["image"], *tool]
            os.execvpe(argv[0], argv, env)
        box = Path(state["home"]) / ".agent-box"
        shutil.copyfile(prompt_file, box / "prompt.md")
        for leftover in ("output.log", "exit-code", "entrypoint.log"):
            (box / leftover).unlink(missing_ok=True)
        if state["tool"] == "claude":
            headless = " ".join(tool) + ' -p "$(cat ~/.agent-box/prompt.md)" --output-format text'
        else:
            headless = 'codex exec --dangerously-bypass-approvals-and-sandbox "$(cat ~/.agent-box/prompt.md)"'
        # エントリポイントは image のものを呼び直し（image の作り直しは要らない）、その stderr と exit code を残す。
        # --rm では docker logs も消えるため、exec の前に失敗しても session の home に手がかりが残るようにする。
        # 内側のコマンドは自分で output.log へ向けるので、entrypoint.log に入るのはエントリポイント自身の出力だけ。
        # 出力に secret が混ざる経路は無い（エントリポイントは固定の文言と git / gh の失敗しか出さず、gh の出力は捨てる）。
        wrapper = ('mkdir -p ~/.agent-box; %s bash -c "$1" 2> ~/.agent-box/entrypoint.log; rc=$?; '
                   '[ -e ~/.agent-box/exit-code ] || echo $rc > ~/.agent-box/exit-code; exit $rc' % ENTRYPOINT)
        argv += ["-d", "--entrypoint", "bash", state["image"], "-c", wrapper, "agent-box",
                 headless + " > ~/.agent-box/output.log 2>&1; echo $? > ~/.agent-box/exit-code"]
        run(argv, env=env)
        self.check_started(state, box)
        return {"session": state["session"], "container": state["container"], "clone": state["clone"],
                "output": str(box / "output.log"), "exit_code": str(box / "exit-code"),
                "entrypoint_log": str(box / "entrypoint.log"), "state": "running"}

    def check_started(self, state, box):
        """起動の直後に止まったコンテナは、残った stderr と exit code を添えて失敗にする（running と返さない）."""
        time.sleep(STARTUP_WAIT)
        if self.running(state["container"]):
            return
        code = (box / "exit-code").read_text().strip() if (box / "exit-code").is_file() else "不明"
        if code == "0":
            return  # 数秒で正常に終わった（失敗ではない）
        log = box / "entrypoint.log"
        tail = log.read_text(errors="replace").strip()[-2000:] if log.is_file() else ""
        raise Stop("session %s のコンテナが起動の直後に止まりました（exit code: %s）。\n%s\n詳細: %s と %s\n"
                   "次の一手: `resume %s --prompt-file <依頼>` で再試行、または `clean %s` で片付ける"
                   "（同じ名前の start は「既にある」で止まる）"
                   % (state["session"], code, tail or "(entrypoint.log は空)", log, box / "output.log",
                      state["session"], state["session"]))

    @staticmethod
    def tool_command(tool, resume):
        if tool == "claude":
            return ["claude", "--dangerously-skip-permissions"] + (["--continue"] if resume else [])
        return ["codex", "--dangerously-bypass-approvals-and-sandbox"] + (["resume", "--last"] if resume else [])

    # ---- 一覧 ----
    def list(self, args):
        running = set()
        for line in run(["docker", "ps", "--filter", "label=%s=1" % LABEL, "--format", "{{.Names}}"]).stdout.decode().split():
            running.add(line)
        rows = []
        if self.sessions.is_dir():
            for path in sorted(self.sessions.glob("*.json")):
                state = json.loads(path.read_text())
                rows.append({"session": state["session"], "branch": state.get("branch"), "tool": state.get("tool"),
                             "running": state["container"] in running, "clone": state["clone"]})
        return {"repo": str(self.host), "limit": DEFAULT_LIMIT, "running": len(running), "sessions": rows,
                "cache": {"volume": self.cache_volume(), "size": self.cache_size()}}

    def cache_size(self):
        """repo の cache volume の大きさ（docker の表記のまま）。読めなければ None（一覧は止めない）."""
        try:
            listed = run(["docker", "system", "df", "-v", "--format", "{{json .Volumes}}"], timeout=60).stdout
            volumes = json.loads(listed.decode() or "[]")
        except (Stop, ValueError):
            return None
        for volume in volumes or []:
            if isinstance(volume, dict) and volume.get("Name") == self.cache_volume():
                return volume.get("Size")
        return None

    # ---- 取り込みと片付け ----
    def inspect(self, state, out):
        """子の clone を読み取り専用で検査コンテナへ渡し、JSON と bundle だけを受け取る."""
        run(["docker", "run", "--rm", "--network", "none", *restrictions(INSPECT_LIMITS),
             "--label", "%s.inspect=1" % LABEL,
             "-v", "%s:/repo:ro" % state["clone"], "-v", "%s:/out" % out,
             "--entrypoint", INSPECT, state["image"]], timeout=300)
        try:
            result = json.loads((Path(out) / "inspect.json").read_text())
            if not isinstance(result.get("dirty"), list) or not isinstance(result.get("refs"), list):
                raise ValueError
            for item in result["refs"]:
                if not re.fullmatch(r"[0-9a-f]{40}", item["sha"]) or not item["ref"].startswith(("refs/", "HEAD")):
                    raise ValueError
        except (OSError, ValueError, KeyError, TypeError) as exc:
            raise Stop("検査結果を解釈できません") from exc
        return result

    def collect(self, args, inspected=None, out=None):
        state = self.load(args.session)
        own_out = out is None
        out = out or tempfile.mkdtemp(prefix="agent-box-")
        try:
            inspected = inspected or self.inspect(state, out)
            bundle = Path(out) / "refs.bundle"
            namespace = "refs/agents/%s" % state["session"]
            if inspected["refs"]:
                if not bundle.is_file():
                    raise Stop("ref があるのに bundle がありません")
                git("bundle", "verify", "-q", str(bundle), cwd=self.host)
                refspecs = ["+refs/*:%s/*" % namespace]
                if any(item["ref"] == "HEAD" for item in inspected["refs"]):
                    refspecs.append("+HEAD:%s/HEAD" % namespace)
                git("fetch", "-q", "--no-tags", str(bundle), *refspecs, cwd=self.host)
            retained = self.verify_retained(inspected, namespace)
            return {"session": state["session"], "namespace": namespace, "refs": retained, "dirty": inspected["dirty"]}
        finally:
            if own_out:
                shutil.rmtree(out, ignore_errors=True)

    def verify_retained(self, inspected, namespace):
        retained = []
        for item in inspected["refs"]:
            name = item["ref"]
            target = "%s/%s" % (namespace, "HEAD" if name == "HEAD" else name[len("refs/"):])
            got = run(["git", "rev-parse", "-q", "--verify", target], cwd=self.host, allowed=(0, 1)).stdout.decode().strip()
            if got != item["sha"]:
                raise Stop("ホストに取り込めていない ref があります: %s" % name)
            retained.append({"ref": name, "sha": item["sha"], "host_ref": target})
        return retained

    def keep_results(self, state):
        """headless の結果（依頼・出力・終了コード）を、片付けの前に session の外へ写す."""
        box = Path(state["home"]) / ".agent-box"
        if not box.exists() and not box.is_symlink():
            return None
        names = [name for name in ("prompt.md", "output.log", "exit-code")
                 if (box / name).exists() or (box / name).is_symlink()]
        if box.is_symlink() or not box.is_dir() or any(
                (box / name).is_symlink() or not (box / name).is_file() for name in names):
            raise Stop("headless の結果の置き場が通常のファイルではありません: %s" % box)
        artifacts = box / "artifacts"
        if artifacts.is_symlink() or (artifacts.exists() and not artifacts.is_dir()):
            raise Stop("成果物の置き場がディレクトリではありません: %s" % artifacts)
        has_artifacts = artifacts.is_dir() and any(artifacts.iterdir())
        if not names and not has_artifacts:
            return None
        dest = physical(self.base / ".results") / ("%s-%s" % (state["session"], time.strftime("%Y%m%dT%H%M%S")))
        dest.mkdir(parents=True)
        try:
            for name in names:
                shutil.copyfile(box / name, dest / name)
            if has_artifacts:
                skipped = self.copy_artifacts(artifacts, dest / "artifacts")
                if skipped:
                    (dest / "skipped.txt").write_text("".join(item + "\n" for item in skipped))
        except (OSError, shutil.Error, RecursionError) as error:
            shutil.rmtree(dest, ignore_errors=True)
            raise Stop("成果物を写せませんでした（何も消さずに止めます）: %s" % error)
        return str(dest)

    @staticmethod
    def copy_artifacts(source, dest):
        """通常のファイルと dir だけ写す。symlink・fifo 等は辿らず写さず、相対 path を返す.

        深い入れ子で再帰上限に当たらないよう、再帰せず stack で辿る。
        """
        skipped = []
        pending = [(source, dest, "")]
        while pending:
            src, dst, prefix = pending.pop()
            dst.mkdir()
            for entry in sorted(os.scandir(src), key=lambda item: item.name):
                rel = prefix + entry.name
                if entry.is_symlink():
                    skipped.append(rel)
                elif entry.is_dir(follow_symlinks=False):
                    pending.append((Path(entry.path), dst / entry.name, rel + "/"))
                elif entry.is_file(follow_symlinks=False):
                    shutil.copyfile(entry.path, dst / entry.name, follow_symlinks=False)
                else:
                    skipped.append(rel)
        return sorted(skipped)

    def clean(self, args):
        state = self.load(args.session)
        if self.running(state["container"]):
            raise Stop("コンテナが動作中です（停止してから片付ける）")
        out = tempfile.mkdtemp(prefix="agent-box-")
        try:
            inspected = self.inspect(state, out)
            if inspected["dirty"]:
                raise Stop("未コミットの変更があります（%d 件）" % len(inspected["dirty"]))
            collected = self.collect(args, inspected=inspected, out=out)
        finally:
            shutil.rmtree(out, ignore_errors=True)
        if self.running(state["container"]):
            raise Stop("検査中にコンテナが起動しました")
        clone, session_dir = physical(Path(state["clone"])), physical(self.sessions / state["session"])
        results = self.keep_results(state)
        shutil.rmtree(clone)
        shutil.rmtree(session_dir)
        self.state_path(state["session"]).unlink()
        return {"session": state["session"], "state": "cleaned", "retained": collected["refs"], "results": results}


    # ---- merge 済みの ref の整理（#136） ----
    def prune(self, args):
        """片付け済みの session の refs/agents/<session>/ のうち、merge 済みと確かめられたものだけを消す.

        条件の正本は ADR 20261014-prune-merged-agent-refs。1 つでも確かめられない ref があれば、
        その session の ref は全部残す（判定の失敗は残す側に倒す）。
        """
        listed = git("for-each-ref", "--format=%(refname) %(objectname)", "refs/agents/", cwd=self.host)
        sessions = {}
        for line in listed.splitlines():
            name, sha = line.split()
            session, _, rest = name[len("refs/agents/"):].partition("/")
            sessions.setdefault(session, []).append((name, rest, sha))
        main = run(["git", "rev-parse", "-q", "--verify", "refs/remotes/origin/main^{commit}"],
                   cwd=self.host, allowed=(0, 1)).stdout.decode().strip()
        remotes = git("for-each-ref", "--format=%(objectname)", "refs/remotes/origin/", cwd=self.host).split()
        pruned, kept = [], []
        for session, refs in sorted(sessions.items()):
            try:
                reason = self.prune_blocker(session, refs, main, remotes)
            except Stop as error:  # 判定の途中の失敗も残す側に倒し、それまでの結果を報告する
                reason = "判定できませんでした（%s）" % error
            if reason:
                kept.append({"session": session, "reason": reason})
                continue
            # 取り込み直し等で途中に変わった ref は消さない（旧値つきの delete を 1 つの transaction で行う）
            commands = "start\n" + "".join("delete %s %s\n" % (name, sha) for name, _, sha in refs) + "commit\n"
            try:
                run(["git", "update-ref", "--stdin"], cwd=self.host, stdin=commands.encode())
            except Stop as error:
                kept.append({"session": session, "reason": "消す途中で ref が変わりました（%s）" % error})
                continue
            pruned.append({"session": session, "refs": [name for name, _, _ in refs]})
        return {"pruned": pruned, "kept": kept}

    def prune_blocker(self, session, refs, main, remotes):
        """session の ref を消してはいけない理由を返す（消してよければ None）."""
        if not SESSION_PATTERN.fullmatch(session):
            return "agent-box の session 名ではありません"
        if (self.sessions / (session + ".json")).exists():
            return "片付け前の session です（clean してから）"
        heads = [(rest[len("heads/"):], sha) for _, rest, sha in refs if rest.startswith("heads/")]
        merged_tips = [main] if main else []
        for branch, sha in heads:
            if self.reachable(sha, [main]):
                continue
            tips, error = self.merged_pr_heads(branch)
            if error:
                return error
            if not self.reachable(sha, tips):
                return "branch %s が merge 済みと確かめられません（merge 済み PR の head が無いか、ホストに無い）" % branch
            merged_tips += tips
        for _, rest, sha in refs:
            if rest.startswith("heads/"):
                continue
            if rest == "HEAD":
                # detached のまま子が commit すると、その commit は HEAD にしか無い
                if self.reachable(sha, merged_tips + [tip for _, tip in heads]):
                    continue
                # branch を持たないレビューの子は、レビューした PR の head が HEAD に残る（#149）。
                # その commit を含む main への merge 済み PR を探し、その head から辿れるかで判定する
                tips, error = self.merged_pr_heads(search=sha)
                if error:
                    return error
                if not self.reachable(sha, tips):
                    return "HEAD が merge 済みと確かめられません"
            elif rest.startswith("remotes/"):
                if not self.reachable(sha, remotes):
                    return "%s がホストの origin から辿れません" % rest
            else:
                return "%s があるので残します" % rest
        return None

    def reachable(self, sha, tips):
        for tip in tips:
            if tip and run(["git", "merge-base", "--is-ancestor", sha, tip], cwd=self.host,
                           allowed=(0, 1, 128)).returncode == 0:
                return True
        return False

    def merged_pr_heads(self, branch=None, search=None):
        """main へ merge 済みの PR の head。branch 名で絞るか、commit の SHA で検索する（#149）."""
        selector = ["--head", branch] if branch else ["--search", search]
        try:
            listed = run(["gh", "pr", "list", "--state", "merged", "--base", "main", *selector,
                          "--json", "headRefOid,baseRefName", "--limit", "100"], cwd=self.host, timeout=60).stdout
            # stacked PR を親の branch へ merge しただけでは main に入っていないので数えない（base も確かめる）
            tips = [item["headRefOid"] for item in json.loads(listed.decode() or "[]") if item["baseRefName"] == "main"]
        except (Stop, ValueError, KeyError, TypeError):
            return [], "merge 済み PR を確かめられません（gh）"
        return [tip for tip in tips if isinstance(tip, str) and re.fullmatch(r"[0-9a-f]{40}", tip)], None


def main(argv=None):
    parser = argparse.ArgumentParser(prog="agent-box.sh", description="セッションごとのコンテナ隔離（#126）")
    parser.add_argument("--repo", help="対象 repo（既定は cwd）")
    sub = parser.add_subparsers(dest="command", required=True)
    start = sub.add_parser("start", help="専用 clone を作り、子のコンテナを起動する")
    start.add_argument("session")
    start.add_argument("--base", default="origin/main", help="分岐元の ref 名（既定 origin/main）")
    start.add_argument("--branch", help="clone 内で作る branch（省略時は detached）")
    start.add_argument("--tool", choices=("claude", "codex"), default="claude")
    start.add_argument("--prompt-file", help="指定すると headless で実行する（省略時は対話）")
    start.add_argument("--image")
    start.add_argument("--allow-over-limit", action="store_true")
    resume = sub.add_parser("resume", help="既存 session に新しいコンテナで入り直す")
    resume.add_argument("session")
    resume.add_argument("--prompt-file")
    resume.add_argument("--allow-over-limit", action="store_true")
    sub.add_parser("list", help="session と動作中のコンテナを一覧する")
    collect = sub.add_parser("collect", help="子の全 ref をホストの refs/agents/<session>/ に取り込む")
    collect.add_argument("session")
    clean = sub.add_parser("clean", help="条件を満たせば、コンテナ・clone・session を承認なしで消す")
    clean.add_argument("session")
    sub.add_parser("prune", help="片付け済みの session の refs/agents/ のうち、merge 済みのものを消す")
    args = parser.parse_args(argv)
    try:
        box = Box(args.repo)
        result = getattr(box, args.command)(args)
    except Stop as exc:
        print("agent-box: 停止: %s" % exc, file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
