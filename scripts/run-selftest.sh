#!/usr/bin/env bash
# repo の self-test を 1 回流す。lefthook の pre-push（lefthook.yml）から呼ばれ、失敗なら exit 1 で push を止める。
# usage: scripts/run-selftest.sh [--stdin]   （手で流してもよい）
# --stdin: pre-push の ref 一覧（local-ref local-sha remote-ref remote-sha）を stdin から読む。push する commit が
#   どれも作業ツリー（HEAD）と違う（checkout 中でない branch の push。owner が子の成果を push する流れ）ときは、
#   作業ツリーの全件は push する中身の検査にならないので、流さない旨を表示して exit 0 で通す（#177）。
#   HEAD と同じ commit を push するものが 1 つでもあれば今どおり流す。ref が読めなければ流す。
#   push する ref がすべて削除（local sha が 0 の列。`git push origin --delete <branch>`）のときも、検査する中身が無い
#   ので流さない旨を表示して exit 0 で通す（#182）。削除と通常の ref が混ざれば、通常の ref の側で上の判定をする。
# test の見つけ方（先に当たったものを使う。派生 repo もここで上書き・自動検出する）:
#   1. SELFTEST_CMD（設定されていれば `bash -c` で実行。空文字は「test なし」）
#   2. tests/run-tests.sh
#   3. scripts/tests/*.test.sh（名前順に全件。1 つでも失敗なら失敗）
#   4. pytest（PATH にあれば）
# 見つからなければ何もせず exit 0（test の無い派生 repo の push を止めない）。
# macOS の Bash 3.2 での全件（/bin/bash tests/run-tests.sh）はここでは流さない。PR の前に owner が流す（AGENTS.md）。
# 一時的に外す: LEFTHOOK_EXCLUDE=selftest git push（lefthook の機能。常用しない）
# git の repo を指す環境変数（GIT_DIR など。git rev-parse --local-env-vars）は test の実行前に外す（#451）。
# 入れ子の拒否: 実行中は PROJECT_TEMPLATE_SELFTEST_RUNNING=1 を export する（tests/run-tests.sh も同じ印を立てる）。
# 印がある中から呼ばれたら全件を流さず exit 2 で止まる（self-test が scripts/ の全 script を -h で呼ぶため、
# -h を受けず全件を始めると無限に再帰してプロセスが尽きる。#161）。黙って 0 で通さないのは、再帰の混入に気づくため。
set -u

from_stdin=0
case "${1:-}" in
  -h|--help) sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  --stdin) from_stdin=1 ;;
esac

if [ "${PROJECT_TEMPLATE_SELFTEST_RUNNING:-}" = "1" ]; then
  echo "✖ self-test の中から run-selftest.sh が呼ばれた。入れ子の全件実行は再帰になるため止める（-h は可）" >&2
  exit 2
fi
export PROJECT_TEMPLATE_SELFTEST_RUNNING=1

# root を実在の表記に揃える（#200）。大文字小文字を区別しない FS（macOS）で呼び出した表記（`~/PROJECT-TEMPLATE`）が残ると、
# test が実在の表記（`~/project-template`。fake git の getcwd 等）と文字列で比べて落ちる。
# bash の組み込み `pwd -P` は symlink を解くだけで大文字小文字は揃えない（macOS の /bin/bash 3.2.57 で実測。入力の表記のまま）。
# 外部の pwd（`env pwd -P`）は getcwd(3) の結果を返し、実在の表記になる。`env` 経由にするのは、組み込みを避けつつ
# /bin/pwd の絶対 path に依存しない（Linux・macOS のどちらでも PATH から引ける。/bin/pwd の無い環境もある）ため。
root="$(cd "$(dirname "$0")/.." && env pwd -P)"

# push する commit が HEAD と違うとき、または削除だけのときは流さない（--stdin のとき）。ref の列が読めないときは判断せず流す
if [ "$from_stdin" = "1" ] && [ ! -t 0 ]; then
  push_refs="$(cat)"
  head_sha="$(git -C "$root" rev-parse HEAD 2>/dev/null || true)"
  pushed=0
  deleted=0
  same=0
  while read -r _local_ref local_sha _remote_ref _remote_sha; do
    [ -n "$local_sha" ] || continue
    case "$local_sha" in *[!0]*) ;; *) deleted=$((deleted + 1)); continue ;; esac # 全桁 0 は削除
    pushed=$((pushed + 1))
    [ "$local_sha" = "$head_sha" ] && same=$((same + 1))
  done <<< "$push_refs"
  if [ "$pushed" -eq 0 ] && [ "$deleted" -gt 0 ]; then
    echo "self-test: 削除だけの push なので流さない（検査する中身が無い）"
    exit 0
  fi
  if [ "$pushed" -gt 0 ] && [ "$same" -eq 0 ] && [ -n "$head_sha" ]; then
    echo "self-test: push する commit が作業ツリー（HEAD）と違うため流さない（全件の検証は PR の前のホストでの両方の Bash と merge-pr.sh の記録に任せる）"
    exit 0
  fi
fi

# git が hook に渡す repo を指す環境変数を外す（linked worktree では GIT_DIR が絶対パスで、test の一時 repo への git 操作が
# 呼び出し元の repo に効く。#451）。上の push 対象の判定は外す前に済ませる。
unset $(git rev-parse --local-env-vars 2>/dev/null) GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY \
  GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_PREFIX GIT_NAMESPACE

mode=""
if [ "${SELFTEST_CMD+x}" = "x" ]; then
  [ -n "$SELFTEST_CMD" ] && mode="command"
elif [ -f "$root/tests/run-tests.sh" ]; then
  mode="run-tests"
else
  set -- "$root"/scripts/tests/*.test.sh
  if [ -f "$1" ]; then
    mode="script-tests"
  elif command -v pytest >/dev/null 2>&1; then
    mode="pytest"
  fi
fi
if [ -z "$mode" ]; then
  echo "self-test: 実行する test が見つからない（skip）"
  exit 0
fi

run_selftest() {
  case "$mode" in
    command) bash -c "$SELFTEST_CMD" ;;
    run-tests) bash tests/run-tests.sh ;;
    script-tests)
      rc=0
      for test_script in scripts/tests/*.test.sh; do
        bash "$test_script" || rc=$?
      done
      return "$rc"
      ;;
    pytest) pytest ;;
  esac
}

out="$(cd "$root" && run_selftest 2>&1)"
rc=$?
if [ "$rc" -ne 0 ]; then
  {
    printf '✖ self-test が失敗した（%s、exit %s）。直してから push する:\n' "$mode" "$rc"
    printf '%s\n' "$out" | grep -E '^(FAIL|FAILED|ERROR|passed|failed)' || printf '%s\n' "$out" | tail -n 20
  } >&2
  exit 1
fi
printf 'self-test: %s\n' "$(printf '%s\n' "$out" | tail -n 1)"
exit 0
