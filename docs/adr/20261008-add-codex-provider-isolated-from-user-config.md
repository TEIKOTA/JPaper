# 2026/10/08 codex をプロバイダとして入れ、利用者の設定を読まずに起動する

# Status
- accepted
- 2026-10-13 に部分 supersede: 置換された条項＝「model・effort は指定されたときだけ渡し、JPaper は既定値を持たない」（→ 未指定なら最新の Sol・effort medium で埋める）／存続する条項＝codex をプロバイダに加えること、利用者の設定・ルールを読まずにツールを止めて一時ディレクトリで起動すること、Web の表示名「GPT」／後継 ADR＝[20261013-default-to-latest-mid-tier-models-at-medium-effort](./20261013-default-to-latest-mid-tier-models-at-medium-effort.md)

# Situation
- [LLM プロバイダ抽象 ADR](./20260709-llm-provider-abstraction-local-ollama-and-cloud-cli.md) は cloud を公式 CLI の subprocess（`claude -p` / `codex exec`）で叩くと決めていたが、main には claude と openrouter しか無かった。codex の実装は main checkout に未コミットの変更として残り、10/6〜10/7 にはそのコードで論文を訳していた（#340）。
- Web アプリ（#328）の provider の選択欄は `Provider` の列挙から作るので、codex が出なかった。利用者から「GPT として選べるように」と依頼があった（2026-10-08）。

# Context
- 未コミットの実装は `codex exec --ephemeral --sandbox read-only [--model M] -` を JPaper の作業ディレクトリで起動し、標準出力を訳文としていた。claude は #306・#307 で「利用者・プロジェクトの文脈を毎回の呼び出しに混ぜない」ように `--safe-mode` と `os.tmpdir()` で起動している。codex には同じ手当てが無かった。
- 実測（codex-cli 0.161.0、1 文の翻訳）: 利用者の設定ありで 11,458 トークン、`--ignore-user-config --ignore-rules` で 2,003 トークン。どちらも同じモデル（`gpt-6.1-sol`）・同じ訳文。起動用のシムが付ける `--dangerously-bypass-hook-trust` の警告が出るので、利用者の設定を読むと hook も毎回動きうる。
- claude は model・effort を指定されたときだけ CLI に渡し、JPaper は既定値を持たない（[claude のモデル・推論強度 ADR](./20261007-pass-claude-model-and-effort-via-cli-args.md)）。codex CLI には `--effort` が無く、推論強度は設定値 `model_reasoning_effort` で渡す。

# Material for decision
- 上記 2 ADR、契約付録 §5、landmines.md（claude の `--safe-mode`）
- `codex exec --help`（0.161.0）: `--ignore-user-config`・`--ignore-rules`・`--skip-git-repo-check`・`-C`・`-o/--output-last-message`・`-c key=value`

# Decision
- **`codex` を `Provider` に加え、CLI・`translatePaper`・Web から選べるようにする**。Web の表示名は「GPT」。
- **利用者の設定・ルールを読まずに、呼び出しごとの一時ディレクトリで起動する**（`--ignore-user-config --ignore-rules --skip-git-repo-check -C <dir>`、`--sandbox read-only`、`--ephemeral`）。最終メッセージは `-o` のファイルから読む。
- **ツールを止める**: シェル・画像の閲覧・apps・plugins・hook・memories・複数エージェント・ブラウザ・computer use などを `-c features.<名前>=false` で切り、`-c web_search="disabled"` を付ける。`--sandbox read-only` だけではツールが残り、論文の本文に誘導されて手元のファイルを読める（実測: 止めない codex は `ls ~` を実行して答え、止めると「実行不可」と返した）。`--disable` は知らない機能名でエラーになるので使わない（`-c` は無視される）。
- **環境変数 `CMUX_*` を渡さない**。cmux の codex ラッパーは `CMUX_SURFACE_ID` があると `exec` にも hook と computer use の引数を差し込む。
- **model・effort は claude と同じく指定されたときだけ渡す**（`--model ID`、`-c model_reasoning_effort="LEVEL"`）。[claude のモデル・推論強度 ADR](./20261007-pass-claude-model-and-effort-via-cli-args.md) で claude 専用とした `--effort` を codex にも広げる。JPaper は既定値を持たない。effort は TOML の文字列に埋め込むので英小文字だけを受ける。
- コンテキスト窓 200,000・呼び出しの期限 300 秒は claude と同じ。usage・費用はトレースに残さない。

# Consequences
- 良い面
  - 1 呼び出しあたり約 9,000 トークンの無駄が消え、利用者の `config.toml`・`.rules` を読まず、hook とツールも動かない。
  - Web と CLI の両方で codex を選べる。
- トレードオフ
  - 利用者が `~/.codex/config.toml` に置いた既定モデル・推論強度・プロバイダ設定は効かない（未指定なら codex CLI 組み込みの既定）。使いたいモデルは毎回 `--model` で指定する（Web では入力履歴 #339 で補う）。
  - 費用・トークン数がトレースに出ないので、Web のジョブの費用は「—」のまま。
  - codex CLI の版によって引数が変わると起動に失敗する（provider エラーとして返る）。
