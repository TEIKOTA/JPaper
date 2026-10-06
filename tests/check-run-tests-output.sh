#!/usr/bin/env bash
# Reporting contract fixture. This is separate from run-tests.sh, so its checks
# do not alter the 593-case count of the main self-test (including issues #78 and #94).
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fixture_dir="$(mktemp -d)" || exit 1
trap 'rm -rf "$fixture_dir"' EXIT

if ! bash "$ROOT/tests/run-tests.sh" > "$fixture_dir/green" 2> "$fixture_dir/green.err"; then
  printf 'FAIL: main self-test exited nonzero\n' >&2
  sed -n '1,4p' "$fixture_dir/green" >&2
  sed -n '1,4p' "$fixture_dir/green.err" >&2
  exit 1
fi
printf 'PASS: 593 tests\n' > "$fixture_dir/green.expected"
if ! cmp -s "$fixture_dir/green.expected" "$fixture_dir/green"; then
  printf 'FAIL: green stdout must be exactly one PASS count line\n' >&2
  sed -n '1,3p' "$fixture_dir/green" >&2
  exit 1
fi

controlled_failure() {
  PASS=0 FAIL=0
  . "$ROOT/tests/reporting.sh"
  report 0 0 'successful case'
  report 0 1 'exit mismatch'
  expect_out 'output mismatch' 'wanted' printf 'got'
  finish
}
if controlled_failure > "$fixture_dir/failure"; then
  printf 'FAIL: controlled failure exited zero\n' >&2
  exit 1
fi
printf '%s\n' \
  'FAIL: exit mismatch (exit=1 expected=0)' \
  'FAIL: output mismatch (got=[got] want=[wanted])' \
  'passed: 1 / failed: 2' > "$fixture_dir/failure.expected"
if ! cmp -s "$fixture_dir/failure.expected" "$fixture_dir/failure"; then
  printf 'FAIL: controlled failure stdout differs from failure-only details and totals\n' >&2
  sed -n '1,5p' "$fixture_dir/failure" >&2
  exit 1
fi

printf 'PASS: reporting output fixture\n'
