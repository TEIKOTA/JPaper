#!/usr/bin/env bash
# git post-checkout hook: 一時領域（/tmp・/private/tmp・/var/folders・$TMPDIR）に作られた linked worktree を
# 作成直後に取り消し、`git worktree add` を失敗させる。macOS の一時領域掃除で未 push の成果物ごと消えるため。
# Bash 文字列 guard（guard-bash.py）を通らない経路（Codex・スクリプト・python subprocess・人の手操作）の最終防衛線。
#
# 配線: scripts/setup-user-hooks.sh --git（グローバル git 設定の hook.<name>.event=post-checkout）。
# 判定: 旧 HEAD が null（新規 checkout）かつ git-dir != git-common-dir（clone ではなく linked worktree）。
# 取り消し: worktree 登録と作業ディレクトリだけを除去する（-b で作った branch は残す）。
#   unborn branch からの checkout も旧 HEAD が null になるため、既存の一時領域 worktree でも発火しうる。
#   そこで作業ツリーに変更・未追跡・ignore 対象のファイルが 1 つでもあれば除去せず警告だけ出す
#   （`git worktree remove` は ignore 対象を確認せず消すため事前に status --ignored で確かめる）。--force は使わない。
# 例外: test 等の正当用途は PROJECT_TEMPLATE_ALLOW_TMP_WORKTREE=1 で明示的に許可する。
# 限界: `git worktree add --no-checkout` / `--orphan` は post-checkout が走らないため防げない。`--lock` 付きは取り消せない。
set -u

[ "${PROJECT_TEMPLATE_ALLOW_TMP_WORKTREE:-0}" = "1" ] && exit 0
case "${1:-}" in
  ''|*[!0]*) exit 0 ;;
esac

gitdir="$(git rev-parse --path-format=absolute --git-dir 2>/dev/null)" || exit 0
common="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || exit 0
[ "$gitdir" != "$common" ] || exit 0
top="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
real="$(cd "$top" 2>/dev/null && pwd -P)" || exit 0

is_temp=0
case "$real/" in
  /tmp/*|/private/tmp/*|/var/folders/*|/private/var/folders/*) is_temp=1 ;;
esac
if [ "$is_temp" = 0 ] && [ -n "${TMPDIR:-}" ] && [ -d "$TMPDIR" ]; then
  tmp_real="$(cd "$TMPDIR" && pwd -P)"
  case "$real/" in "${tmp_real%/}/"*) is_temp=1 ;; esac
fi
[ "$is_temp" = 1 ] || exit 0

printf '✖ git worktree を一時領域に作らない（%s）。macOS の一時領域掃除で未 push の成果物ごと消える。\n' "$real" >&2
printf '  標準配置 ~/worktrees/<repo>/ を使う。test 等で意図的に必要なら PROJECT_TEMPLATE_ALLOW_TMP_WORKTREE=1 を付ける。\n' >&2
dirty="$(git -C "$real" status --porcelain --ignored --untracked-files=all 2>/dev/null)" || dirty="(status 取得失敗)"
if [ -n "$dirty" ]; then
  printf '  作業ツリーにファイル（変更・未追跡・ignore 対象）があるため取り消さなかった。退避してから標準配置へ移す。\n' >&2
elif (
  unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX GIT_COMMON_DIR GIT_OBJECT_DIRECTORY
  cd "$common" && git worktree remove "$real"
) >/dev/null 2>&1; then
  printf '  作成直後の worktree を取り消した（branch は残る）。\n' >&2
else
  printf '  取り消せなかった（lock・submodule 等）。git worktree list で確認する。\n' >&2
fi
exit 1
