---
name: headless-run
description: Use when running Claude Code non-interactively with `claude -p` from a script, CI job, or other unattended host that must fail closed on missing isolation or permission controls.
---

# Headless Run

Claude Code 専用の non-interactive 実行規律。Codex や Docker Agent の似た名前の
flag へは一般化せず、それらは対象外とする。

## 実行前ゲート

実行 host で `claude --version` と `claude --help` を読み、必要な flag がすべて
存在することを確認する。基準環境は Claude Code 2.1.263。特に `--restricted` は
v2.1.248 以降、`--permission-prompts none` は v2.1.259 以降である。未対応の
version や flag があれば fail closed とし、flag を落として silent weaken しない。

## ロックダウンした標準呼び出し

必要な tool と context は呼び出し側で明示する。次は read-only の例なので、task に
必要な最小 tool、prompt、context path に置き換える。

```bash
claude -p "$prompt" \
  --bare \
  --restricted \
  --permission-mode dontAsk \
  --permission-prompts none \
  --tools "Read" \
  --add-dir "$context_dir" \
  --output-format json
```

`--dangerously-skip-permissions` はこの locked-down path では使わない。

## Discovery と tool 境界

- `--bare` は hooks / skills / custom commands / subagents / plugins / MCP servers /
  auto memory / `CLAUDE.md` の自動 discovery を省略する。必要な context や設定は
  flag で明示する。Anthropic API では API key が必要で、subscription login は
  利用しない。再現可能な script / SDK 呼び出しには `--bare` が推奨される。
- `--restricted` は command / code-running tools と WebFetch を除去する。必要な tool
  だけを `--tools` で個別指定し、file tools は working directories 内に閉じる。
  user / project / local settings は読まず、managed settings と明示した `--settings`
  だけが残る。
- `--permission-mode dontAsk` は通常なら prompt を要する tool call を deny する。
  allow 済みの tool と read-only 操作は実行できる。
- `--permission-prompts none` は unresolved prompt を host へ送らず deny し、Claude に
  retry しないよう伝える。既存の permission rule、hook、mode による解決を上書きする
  flag ではない。

## Structured output

機械処理する通常の結果は `--output-format json` にする。特定 schema が必要なら
`--json-schema` を併用する。逐次 event を消費する場合だけ `stream-json` を選び、
単一結果の consumer に streaming protocol を持ち込まない。

## 長時間ジョブ

`claude -p` が起動した background Bash child は、final result の返却と stdin close の
およそ 5 秒後に terminate される。したがって job 本体を `claude -p` の子として
detach せず、外側の独立 supervisor（tmux や launchd など）から起動する。`nohup`
だけを process-tree からの独立保証として扱わない。

投入前に今回の実行だけが新規に書く肯定的 marker と log を決め、監視は
`scripts/wait-for-marker.sh` を 1 回だけ呼ぶ。waiter の停止が job 本体を止めない構成にし、
投入前チェックリストは同 script の header を正本とする。

## 公式参照

- [Run Claude Code programmatically](https://code.claude.com/docs/en/headless)
- [CLI reference](https://code.claude.com/docs/en/cli-reference)
