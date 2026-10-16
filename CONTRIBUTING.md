# JPaper への貢献

issue と PR を歓迎します。この repo は、PR のタイトルなどの規約を CI で機械的に検査しています。規約に合わない PR はチェックで落ちるので、出す前にこのページを読んでください。

## issue を立てる

- 先に [既存の issue と PR](https://github.com/TEIKOTA/JPaper/issues?q=is%3Aissue) を検索し、同じ話題が無いかを確かめてください。
- 空の issue は作れません。テンプレートを選んでください。
  - **Bug Report**: 期待と違う動きをした。再現の手順と、使った論文（arXiv ID など）・LLM プロバイダ・OS を書いてください
  - **Feature / Improvement**: 機能の追加・変更の提案
- ログや設定を貼るときは、API キーなどの秘密情報が入っていないかを確かめてください。

## PR を出す

### 流れ

1. 変更の内容について issue を立てるか、既存の issue を選ぶ（小さな誤字の修正などは issue なしでもよい。下の「issue なしの PR」）
2. repo を fork し、branch を作って変更する
3. テストを足し、ローカルで検証する（下の「ローカルでの検証」）
4. PR を出す。本文はテンプレートに沿って日本語で書く

初めて PR を出す人の場合、GitHub Actions は管理者が承認するまで走りません。しばらく待ってください。

### PR のタイトル

日本語の Conventional Commits の形式にします。

```
<type>(任意のscope): 日本語の説明
```

- 例: `fix(bilingual): 二段組の論文でも対訳 PDF を組めるようにする`、`docs: README の誤字を直す`
- type は `feat` `fix` `docs` `style` `refactor` `perf` `test` `build` `ci` `chore` `revert` のどれか（正本は [`scripts/check-commit-msg.sh`](./scripts/check-commit-msg.sh)）
- 説明に日本語（ASCII 以外の文字）が含まれている必要があります

PR は squash merge し、main に残る commit の件名は PR のタイトルになります。個々の commit も同じ形式にすることを勧めますが、必須ではありません。

### PR の本文

- 閉じる issue を `Closes #<番号>` で書いてください。
- **issue なしの PR**: type が `chore` なら不要です。それ以外の type で issue が無い場合は、`例外理由: <具体的な理由>` を書いてください。

### merge の条件

次の 4 つのチェックがすべて通る必要があります。

| チェック | 内容 |
|---|---|
| `pr-check` | PR のタイトルと本文の規約（[`scripts/check-pr.sh`](./scripts/check-pr.sh)） |
| `node` | `pnpm test`（vitest）と `pnpm typecheck` |
| `test (ubuntu-latest)`・`test (macos-latest)` | 規約検査スクリプトの self-test（`bash tests/run-tests.sh`） |

## ローカルでの検証

前提のツールは README の「[セットアップ](./README.md#セットアップ)」にあります。PR を出すなら「開発するときだけ要るもの」も入れてください。

```sh
pnpm install
pnpm test                  # 単体テスト（LLM を呼ばない）
pnpm typecheck             # 型チェック
bash tests/run-tests.sh    # scripts/ や tests/ を変えたとき
lefthook install           # commit メッセージの検査をローカルでも効かせる（任意）
```

PR を出した後、`gh` が使えるなら `scripts/check-pr.sh <PR番号>` で、CI の `pr-check` と同じ検査を手元で流せます。

## 変更の書き方

- バグを直すときは、直す前に落ちるテストを足してください。
- 設計の判断の背景は [`docs/adr/`](./docs/adr/) にあります。設計に関わる変更は、関連する ADR を読んでから始めてください。
- コードのコメントには事実だけを書き、理由は ADR や設計文書に書きます（[ソースコメント ADR](./docs/adr/20260710-source-comments-facts-only-rationale-to-docs.md)）。
- 不自然に見えるコードは、直す前に [`docs/design/landmines.md`](./docs/design/landmines.md) を確認してください。載っていれば意図的な書き方です。
- 開発ルールの全体は [`AGENTS.md`](./AGENTS.md) にあります。AI のコーディングエージェントを使う場合も、このファイルに従います。

## 秘密情報

`.env` や API キーを commit しないでください。設定の例を足すときは `.env.example` に書きます。

## ライセンス

貢献したコードは、この repo と同じ [MIT License](./LICENSE) で公開されます。
