#!/usr/bin/env bash
# 片付け前の検査（#126）。子の clone を読み取り専用（/repo）で受け、ネットワークなし・認証なしのコンテナで実行する。
# 子が .git/config に仕込んだ fsmonitor や filter をホストで実行しないため、子の repo への git 操作はここに閉じる。
# 出力: /out/inspect.json（作業状態と ref 一覧）、/out/refs.bundle（ref があれば全 commit）。
set -euo pipefail
# REPO / OUT は検査コンテナ内の mount 先（test の fake docker だけが別 path を渡す）。
REPO="${INSPECT_REPO:-/repo}" OUT="${INSPECT_OUT:-/out}"
export GIT_OPTIONAL_LOCKS=0 HOME="$(mktemp -d)"
git config --global --replace-all safe.directory "$REPO"
cd "$REPO"
status="$(git status --porcelain=v1 -z --untracked-files=all --ignore-submodules=none | tr '\0' '\n')"
git for-each-ref --format='%(objectname) %(refname)' | grep -v -E ' refs/remotes/' > "$HOME/refs" || true
# detached HEAD の commit も保全の対象にする（どの branch にも無い場合がある）。
if head="$(git rev-parse -q --verify HEAD)"; then echo "$head HEAD" >> "$HOME/refs"; fi
python3 - "$status" "$HOME/refs" > "$OUT/inspect.json" <<'PY'
import json, sys
status = [line for line in sys.argv[1].split("\n") if line]
refs = []
for line in open(sys.argv[2]).read().splitlines():
    sha, name = line.split(" ", 1)
    refs.append({"sha": sha, "ref": name})
json.dump({"dirty": status, "refs": refs}, sys.stdout)
PY
if [ -s "$HOME/refs" ]; then
  cut -d' ' -f2 "$HOME/refs" | git bundle create "$OUT/refs.bundle" --stdin >/dev/null 2>&1
fi
