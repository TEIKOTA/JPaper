# 2026/08/15 秘密は .env から受け取る（読むのはプロセス入口だけ）

# Status
- accepted

# Situation
- 外部 API プロバイダ（OpenRouter）の導入を検討している。ローカル LLM の検証ループが遅すぎるためで、API キーが必要になる。
- いま repo には `.env` を読む仕組みが無い。`process.env` を読むのは `JPAPER_HOME` と `JPAPER_DUMP_RAW` の 2 つだけで、どちらもシェルから渡す前提だった。
- `.gitignore` は既に `.env` / `.env.*` を除外し `!.env.example` だけ通す設定になっており、**受け皿だけが先に用意されていた**。

# Context
- キーを毎回シェルで `export` するのは事故りやすい。シェル履歴に残り、別セッションへは引き継がれず、`~/.zshrc` へ書けば全プロセスに漏れる。
- 一方で「設定ファイルを暗黙に読むライブラリ」は再現性を壊す。同じ引数で呼んでも、マシンに何が置いてあるかで結果が変わる。テストも開発者のホーム環境に依存しはじめる。
- 本 repo の中核（`translatePaper`）は決定的な純変換の配線として設計されている（[決定的エージェント構成 ADR](./20260708-adopt-deterministic-agent-architecture.md)）。ここに暗黙のファイル読み込みを混ぜたくない。
- Node 26 には `process.loadEnvFile()` が同梱されている。依存を増やさずに済む。実測で 2 点を確認した。
  - **既存の環境変数が優先される**（`A=fromenv node -e "process.loadEnvFile(...)"` で `A` は `fromenv` のまま）。
  - ファイルが無ければ `ENOENT` を throw する。中身が壊れていても parser は素通しする（`A=1\n\x00\xff bad\n` で例外は出ず `A=1` が載る）。

# Material for decision
- [決定的エージェント構成 ADR](./20260708-adopt-deterministic-agent-architecture.md): ワークフローはコードで決まり、隠れた入力を持たない。
- [プロンプト注入 ADR](./20260811-preamble-is-untrusted-code-not-just-layout.md): 外から来るものは「データ」として扱い、暗黙に効かせない。`.env` も同じ系統の入力にあたる。
- `.gitignore` の既存行（`.env` / `.env.*` 除外、`!.env.example` 通し）。命名はこれに従う。
- 実測（本 repo・Node v26.5.0）: 上記 `process.loadEnvFile` の 2 点。

# Decision
- **`.env` を読むのはプロセス入口だけ**にする。正本は `src/runtime/env-file.ts` の `loadDotEnv`、呼ぶのは `src/cli.ts` の `import.meta.url` ガード内 1 か所。`runCli` やライブラリ経路（`translatePaper`）からは呼ばない。テストも `loadDotEnv` を直接呼んで検証し、暗黙には読ませない。
- **依存は足さない**。`process.loadEnvFile()` を使う。
- **既存の環境変数を上書きしない**（`process.loadEnvFile` の既定のまま）。シェルや CI の明示指定が常に勝ち、`.env` は「何も指定しなかったときの既定」として働く。切り分けのために渡した値が黙って無視される事故を防ぐ。
- **`.env` が無いのは正常**として扱い、`ENOENT` だけ握る。それ以外の I/O 失敗（ディレクトリを置いてしまった等）は終了コード 2 の明示的失敗にする。鍵が載らない理由が遠くの「認証エラー」として出るのを避ける。
- **ひな形は `.env.example`** とする。`.env.sample` は `.gitignore` の `.env.*` に食われてコミットされない。値は空にし、キー名と用途のコメントだけを置く。

# Consequences
- 良い面
  - 秘密がシェル履歴に残らず、リポジトリ単位で閉じる。`.gitignore` 済みなので誤コミットの経路も無い。
  - ライブラリ経路は今までどおり隠れた入力を持たない。テストの決定性が保たれる。
  - 依存が増えない。Node のバージョン要件（26 系）は既に前提。
- トレードオフ
  - **`.env` は cwd から読む**。信頼できないディレクトリで `jpaper` を実行すると、そこに置かれた `.env` が効く。実行場所を選ぶ運用が前提になる。
  - **中身の壊れは検出できない**。Node の parser が素通しするため、`KEY = value` のような書き損じは黙って無視される。捕まえられるのは I/O 側の失敗だけ。
  - 環境変数の出どころが 2 系統（シェルと `.env`）になる。優先順位を知らないと「`.env` を直したのに効かない」に見える。優先順位はテストで固定し、`.env.example` の冒頭にも書く。
