# 2026/10/13 claude・codex の既定を最新の中位モデル（Sonnet・Sol）と effort medium にする

# Status
- accepted

# Situation
- claude・codex は、model・effort を指定されたときだけ CLI に渡し、JPaper は既定値を持たないと決めていた（[claude のモデル・推論強度 ADR](./20261007-pass-claude-model-and-effort-via-cli-args.md)、[codex プロバイダ ADR](./20261008-add-codex-provider-isolated-from-user-config.md)）。
- 利用者は「既定は最新の Sol・Sonnet の medium。モデルが更新されたら中位モデルの最新版・medium に追従するのが理想」と決めた（2026-10-13、issue #345）。

# Context
- codex は利用者の設定を読まずに起動するので、未指定だと CLI 組み込みの既定で動く。2026-10-13 の実測で gpt-6.1-sol・**reasoning effort none**（推論なし）だった。claude は未指定だとログイン設定（アカウントしだい）になる。
- 新しいモデルが出るたびに ID を書き換える運用は続かない。モデル ID を JPaper に固定すると、その日から古くなる。
- claude CLI の `--model` は別名（`sonnet`・`opus` 等）を受け、最新の版に解決する（`claude --help`。実測で `sonnet` → claude-sonnet-5-5）。
- codex CLI には別名が無い。codex は自身が取得したモデル一覧を `$CODEX_HOME/models_cache.json`（既定 `~/.codex`）に保存しており、Sol・Astra・Luna の系列と版が slug（`gpt-6.1-sol` 等）に出る。Sol は「workhorse」と説明される中位の系列。

# Material for decision
- `claude --help` の `--model` の説明、`codex exec --ignore-user-config` の起動時の表示（model・reasoning effort）。
- 2026-10-13 の `~/.codex/models_cache.json`: gpt-6.1-sol（Latest workhorse）・gpt-6-astra（Frontier）・gpt-6-sol（Previous generation workhorse）・gpt-6-luna（Fast and affordable）・gpt-5.6-sol ほか。
- 案: ①JPaper にモデル ID を固定する（更新のたびに書き換え）②codex は CLI の既定に任せる（中位とは限らず、effort は none）③別名・モデル一覧から中位の最新を選ぶ。

# Decision
- **model・effort が未指定なら、translatePaper が既定で埋める**。claude は model に別名 `sonnet`、codex は model にモデル一覧の Sol 系で版が最も新しいもの（隠されたものを除く。版は数値で比べる）、effort はどちらも `medium`。
- 明示した値（CLI の `--model` / `--effort`、Web のジョブ・設定の初期値）はこれまでどおり優先する。
- codex のモデル一覧が読めない・Sol が無いときは model を渡さず（codex の既定）、effort は `medium` を渡し、警告を出す。
- claude のトレースの `model` には、応答の `modelUsage` の鍵（実際に使われたモデル）を記録する（別名のままでは後から確かめられない）。
- 上の 2 つの ADR のうち「JPaper は既定値を持たない」点だけを置き換える。指定されたときに CLI 引数で渡すこと、利用者の設定を読まずに codex を起動することは存続する。

# Consequences
- 未指定の実行は、モデルの更新に合わせて中位の最新版・medium に自動で移る。JPaper の側で ID を書き換えなくてよい。
- 同じ指定で走らせても、CLI・codex の更新で使うモデルが変わる。何で訳したかはトレースの `model` で確かめる。checkpoint の鍵に model を含めない既存の決定（契約付録 §5）により、同じ出力先の再実行では未通過の節だけが新しいモデルで訳される。
- codex のモデル一覧のファイルは codex 内部のもので、形式が変わりうる。読めなくなったら CLI の既定（警告つき）に戻る。系列名が Sol から変われば、この規則の見直しが要る。
