# 2026/10/07 claude のモデルと推論強度を CLI 引数で渡す（JPaper は既定値を持たない）

# Status
- accepted

# Situation
- 個人利用で、cloud の翻訳は claude プロバイダ（公式 claude CLI の subprocess）で回している。
- 論文や用途によって、モデルと推論強度を切り替えたい場面が出た（例: sonnet の medium で回す）。
- これまで claude プロバイダは CLI のログインセッションの既定でしか動かず、切り替えるにはログイン設定そのものを変える必要があった。

# Context
- [LLM プロバイダ抽象化 ADR](./20260709-llm-provider-abstraction-local-ollama-and-cloud-cli.md) は、cloud を「公式 CLI を subprocess として叩き、ユーザーのログインセッションでそのまま動かす」と決めた。契約付録 §5 はこれを受けて「claude(subprocess) は CLI のログインセッションのモデルを使うため JPaper から渡さない」「`--model` は ollama 専用（後に openrouter も）、claude と併用したら入力エラー」と運用してきた。
- claude CLI 自体は `--model` と `--effort` を受け付ける（実測 2026-10-07: `claude -p --model sonnet --effort medium` が claude-sonnet-5-5 で応答）。指定しても subprocess・ログインセッションでの認証という前提は変わらない。
- JPaper 側に既定のモデル・推論強度を書くと、モデルの世代交代や CLI の水準名の変更のたびに JPaper の保守が要る。

# Material for decision
- ユーザー指示（2026-10-07）:「claude は sonnet medium を引数とかで指定できたらいい。デフォルトをハードコードするとメンテする必要があるので引数で渡す」
- 統合 worktree での検証実装（コミット a0019a3）。
- 比較した代替:
  - JPaper に既定（例 sonnet / medium）を持つ: 指定なしでも挙動が固定されるが、モデルの世代交代のたびに保守が要る。ユーザー指示で不採用。
  - 推論強度の水準を列挙して検証する: 綴り違いを JPaper 側で弾けるが、claude CLI の受理値に追随する保守が要る。英小文字の水準名という形だけを検査し、未知の水準は claude CLI のエラーとして返す。
  - ログイン設定の変更に任せる（現状維持）: run ごとに切り替えられず、並行する別作業の設定まで変わる。

# Decision
- **claude プロバイダは、指定されたときだけ `--model` / `--effort` を claude CLI へ渡す**。未指定の項目は渡さず、ログイン設定の既定に委ねる。**JPaper 側にモデル・推論強度の既定値を持たない**。
- jpaper CLI は `--provider claude` で `--model ID` を受け、`--effort LEVEL` を新設する。`--effort` は claude 専用で、他の provider と併用したら入力エラー（終了コード 2）。
- 値の検査は形だけにする（推論強度は英小文字の水準名、モデル ID は空・先頭 `-` を拒否）。水準・モデルの列挙はしない。
- checkpoint の無効化キーには model / effort を含めない（理由は契約付録 §5）。
- [LLM プロバイダ抽象化 ADR](./20260709-llm-provider-abstraction-local-ollama-and-cloud-cli.md) のうち、claude で使うモデルをログインセッションの設定にそのまま委ねる点だけを置き換える。公式 CLI を subprocess として叩くこと、ログインセッションで認証すること、OAuth トークン抽出を採らないことは存続する。

# Consequences
- 良い面
  - run ごとに claude のモデルと推論強度を切り替えられる。ログイン設定を変えずに済む。
  - JPaper に既定値が無いので、モデルの世代交代で JPaper を直す必要が無い。
  - 未指定時の挙動は従来どおり（claude CLI に何も渡さない）。
- トレードオフ
  - 未指定時に使われるモデルは JPaper から見えない。
  - 未知の水準名や存在しないモデル ID は入口で弾けず、claude CLI の起動後に provider 失敗として返る。
  - 同じ `--out` で model / effort を変えて再実行すると、通過済みの節は前の設定の訳文のまま残る。全体を訳し直すには `--out` を変える。
