#!/usr/bin/env bash
set -euo pipefail

# detached に起動した長時間ジョブ(レビュー・ビルド・テストなど)の完了を、
# log への完了 marker 出現で待つ正本 waiter。
#
# 背景: agent セッションが `until grep …; do sleep …; done` waiter を短い自前 cap 付きで
# 即興実装し、cap のたびに同じ waiter を再発行してモデル往復と待機時間を浪費する失敗が
# 母体プロジェクトで実測された。待機ループをこのスクリプト内へ閉じ、agent 側の呼び出しを
# 1 ジョブ 1 回にするのが目的(採用判断: docs/adr/20260729-adopt-ai-session-operational-guards.md)。
#
# 使い方:
#   scripts/wait-for-marker.sh --log <path> --marker <ERE> \
#     [--timeout <sec>] [--interval <sec>] [--tail <lines>]
#
# 挙動:
#   - log に marker(grep -aE)が現れたら、marker 行(末尾 5 件)と log 末尾を出力して exit 0。
#   - --timeout(既定 540 秒)までに現れなければ log 末尾を出力して exit 124。
#   - log が未作成でも timeout まで待つ(detached ジョブの起動直後を許容)。
#
# 呼び出し側の契約:
#   - AI ハーネスの Bash tool から呼ぶ場合、tool の timeout は必ず --timeout より長く
#     明示する(tool 既定のまま呼ぶと、こちらの待機中に tool 側が先に落ちる)。
#   - 10 分を超えるジョブは、このスクリプトをフォアグラウンドで再発行せず、
#     background 実行で 1 回起動して完了通知を受ける。
#
# ジョブ投入前チェックリスト(待機側でなく投入側の規律。実測事故が根拠:
# GPU を取れず CPU で黙走して丸 1 日損失 / プロンプト文字列のエコーに marker が
# 誤一致 / 監視プロセスの停止がジョブ本体を巻き添え):
#   1. 計装: 進捗・ETA が定期的に log へ出る構成にする(Python は PYTHONUNBUFFERED=1
#      等でバッファを切る)。進捗の出ないジョブを投入しない。
#   2. 前提資源: GPU 等の必須資源は取得失敗で即エラー終了させる。黙って劣化
#      フォールバックする設定で投入しない。
#   3. 完了 marker: 今回の実行が新規に作る出力だけを marker にする。否定形・
#      前回実行の残骸・投入コマンド自身にエコーされる文字列を使わない。
#   4. デタッチ: `claude -p` の child は完走を保証しない。外側の独立 supervisor から
#      起動し、nohup だけでは独立を保証しない
#      (詳細: .claude/skills/headless-run/SKILL.md)。
#   5. 監視分離: 監視・待機のプロセスを止めてもジョブ本体が死なない構成にする。

LOG=""
MARKER=""
TIMEOUT=540
INTERVAL=2
TAIL_LINES=40

usage() {
  cat <<'EOF'
Usage:
  scripts/wait-for-marker.sh --log <path> --marker <ERE> [options]

log ファイルに完了 marker(拡張正規表現)が現れるまで待つ。
現れたら marker 行と log 末尾を出力して exit 0、timeout なら exit 124。

Options:
  --log <path>       監視する log ファイル(必須。未作成でも timeout まで待つ)
  --marker <ERE>     完了 marker の拡張正規表現(必須。grep -aE で照合)
  --timeout <sec>    最大待機秒数(既定 540)
  --interval <sec>   照合間隔秒数(既定 2)
  --tail <lines>     終了時に出力する log 末尾行数(既定 40)
  --help             このヘルプ

例:
  scripts/wait-for-marker.sh --log /tmp/build.log --marker 'BUILD_EXIT=' --timeout 540
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --log) LOG="${2:?--log には値が必要です}"; shift 2 ;;
    --marker) MARKER="${2:?--marker には値が必要です}"; shift 2 ;;
    --timeout) TIMEOUT="${2:?--timeout には値が必要です}"; shift 2 ;;
    --interval) INTERVAL="${2:?--interval には値が必要です}"; shift 2 ;;
    --tail) TAIL_LINES="${2:?--tail には値が必要です}"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "error: 不明な引数: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ -z "$LOG" || -z "$MARKER" ]]; then
  echo "error: --log と --marker は必須です" >&2
  usage >&2
  exit 2
fi
for v in "$TIMEOUT" "$INTERVAL" "$TAIL_LINES"; do
  if ! [[ "$v" =~ ^[0-9]+$ ]]; then
    echo "error: --timeout / --interval / --tail は非負整数で指定してください: $v" >&2
    exit 2
  fi
done
if [[ "$INTERVAL" -lt 1 ]]; then
  INTERVAL=1
fi

print_tail() {
  if [[ -f "$LOG" ]]; then
    echo "--- tail -${TAIL_LINES} ${LOG} ---"
    tail -n "$TAIL_LINES" "$LOG" || true
  else
    echo "--- log 未作成: ${LOG} ---"
  fi
}

SECONDS=0
while true; do
  if [[ -f "$LOG" ]] && grep -qaE "$MARKER" "$LOG" 2>/dev/null; then
    echo "WAIT_FOR_MARKER=ok elapsed=${SECONDS}s log=${LOG}"
    echo "--- marker 行(末尾 5 件) ---"
    grep -aE "$MARKER" "$LOG" | tail -n 5 || true
    print_tail
    exit 0
  fi
  if [[ "$SECONDS" -ge "$TIMEOUT" ]]; then
    echo "WAIT_FOR_MARKER=timeout elapsed=${SECONDS}s log=${LOG} marker=${MARKER}" >&2
    print_tail >&2
    exit 124
  fi
  sleep "$INTERVAL"
done
