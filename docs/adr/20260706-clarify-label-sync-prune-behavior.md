# 2026/07/06 ラベル同期の削除を --prune オプトインに限定する

# Status
- accepted

# Situation
- カスタムラベル ADR（`20260706-adopt-custom-github-labels.md`）は「labels.yml に無い既存ラベルを削除し、定義どおり作成・更新する」を適用機構として定めた。
- レビューで、この機構を再実行すると**チームが後から手動で作った運用ラベルも無条件に消える**ことが指摘された。初回セットアップの「デフォルトラベル削除」と、運用中の再同期では、安全な既定が異なる。

# Context
- 3 軸のカスタムラベル体系・labels.yml 正本・デフォルトラベル削除という**採用済みの決定は変えない**。変えるのは適用スクリプトの削除タイミングの既定だけであり、既存 ADR の clarify として扱う。
- 破壊的操作は明示フラグに載せるのが CLI の一般則であり、`github-label-sync --allow-added-labels` など同種ツールも追加ラベル温存を選べる設計を持つ。

# Material for decision
- `docs/adr/20260706-adopt-custom-github-labels.md`（本 ADR が clarify する対象。Status は accepted のまま）
- github-label-sync の `--allow-added-labels` オプション
- レビュー指摘: 「ラベル同期は依然として定義外ラベルを削除する」

# Decision
- `scripts/setup-github-repo.sh` のラベル同期は、既定では **upsert のみ**とし、labels.yml に無いラベルは `info:` として一覧表示に留める。
- 定義外ラベルの削除は明示的な **`--prune`** フラグ指定時のみ行う。
- **初回セットアップは `--prune` 付きで実行**し、GitHub デフォルトラベルを入れ替える。これによりカスタムラベル ADR の「デフォルトラベル削除」の意図は維持される（README / new-project の手順に明記）。
- 運用中にラベルを整理したい場合は、labels.yml を正本として更新してから `--prune` を実行する。

# Consequences
- 再実行してもチームの手動ラベルが温存され、同期スクリプトを安心して冪等に実行できる。
- 初回セットアップで `--prune` を付け忘れるとデフォルトラベルが残る。`info:` 表示で気づける。
- 「labels.yml が常に完全な正本」という強い規律は、`--prune` 実行時のみ強制される緩い規律に変わる。
