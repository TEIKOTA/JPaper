#!/usr/bin/env bash
# tests/run-tests.sh の結果表示。呼び出し元が PASS / FAIL を初期化する。

report() { # report <want-rc> <got-rc> <desc>
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
  if [ "$FAIL" -eq 0 ]; then
    printf 'PASS: %s tests\n' "$PASS"
  else
    printf 'passed: %s / failed: %s\n' "$PASS" "$FAIL"
    return 1
  fi
}
