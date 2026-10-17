#!/usr/bin/env bash
# tests/run-tests.sh の結果表示。呼び出し元が PASS / FAIL を初期化する。

: "${SKIP:=0}"
SKIP_REASON=
SKIP_BLOCK=0

# 前提（macOS の Bash 3.2 等）が無い環境では、skip_begin から skip_end までの判定を合否に数えず skip に数える。
# 子のコンテナ（Linux）でも残りを全件確かめられるようにするため（#135）。
skip_begin() { # skip_begin <理由>
  SKIP_REASON="$1"
  SKIP_BLOCK=0
}

skip_end() {
  if [ -n "$SKIP_REASON" ]; then
    printf 'SKIP: %s（%s 件）\n' "$SKIP_REASON" "$SKIP_BLOCK"
  fi
  SKIP_REASON=
  SKIP_BLOCK=0
}

skipped() { # 判定を skip に数えたら 0 を返す
  [ -n "$SKIP_REASON" ] || return 1
  SKIP=$((SKIP + 1))
  SKIP_BLOCK=$((SKIP_BLOCK + 1))
}

report() { # report <want-rc> <got-rc> <desc>
  skipped && return 0
  if [ "$1" -eq "$2" ]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL: %s (exit=%s expected=%s)\n' "$3" "$2" "$1"
  fi
  if [ "${SELFTEST_PROGRESS:-0}" = 1 ] && [ "$(((PASS + FAIL) % 50))" -eq 0 ]; then
    printf 'SELFTEST_PROGRESS checked=%s failed=%s\n' "$((PASS + FAIL))" "$FAIL"
  fi
}

expect() { # expect <0|1> <desc> <cmd...>
  local want="$1" desc="$2" rc=0
  shift 2
  "$@" >/dev/null 2>&1 || rc=1
  report "$want" "$rc" "$desc"
}

expect_code() { # expect_code <exit-code> <desc> <cmd...>
  local want="$1" desc="$2" rc=0
  shift 2
  "$@" >/dev/null 2>&1 || rc=$?
  report "$want" "$rc" "$desc"
}

expect_out() { # expect_out <desc> <expected-output> <cmd...>
  local desc="$1" wantout="$2" out
  shift 2
  out="$("$@" 2>/dev/null)"
  skipped && return 0
  if [ "$out" = "$wantout" ]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL: %s (got=[%s] want=[%s])\n' "$desc" "$out" "$wantout"
  fi
}

finish() {
  if [ -n "${SELFTEST_SUMMARY_PATH:-}" ]; then
    printf '{"passed":%s,"failed":%s,"total":%s}\n' "$PASS" "$FAIL" "$((PASS + FAIL))" > "$SELFTEST_SUMMARY_PATH" || return 1
  fi
  if [ "$FAIL" -eq 0 ] && [ "$SKIP" -gt 0 ]; then
    printf 'PASS: %s tests (skipped: %s)\n' "$PASS" "$SKIP"
  elif [ "$FAIL" -eq 0 ]; then
    printf 'PASS: %s tests\n' "$PASS"
  else
    printf 'passed: %s / failed: %s\n' "$PASS" "$FAIL"
    return 1
  fi
}
