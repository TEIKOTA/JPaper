# 2026/10/08 Web アプリで arXiv を検索し、翻訳は CLI の子プロセスをメモリ上のキューで回す

# Status
- accepted

# Situation
- 個人利用のローカル環境。論文を訳すには CLI（`pnpm dev <ID> --provider … --model … --effort …`）を打つ必要があり、訳したい論文を探す手段も無かった（issue #328）。
- 用語集の Web アプリ（[用語集 Web アプリ ADR](./20261007-glossary-web-app-replace-and-retypeset-without-llm.md)）は 127.0.0.1 だけで待ち受け、認証を持たない。利用者は 1 人。
- 翻訳 1 本は数分〜数十分かかり、claude は 1 呼び出しごとに子プロセスを起こす。ローカル（ollama）は GPU を 1 本で使い切る。

# Context
- Web アプリから翻訳を始めるには、(1) 論文の探し方、(2) provider・model・effort の決め方、(3) 長い実行の進め方・止め方・見せ方、を決める必要がある。
- [claude のモデルと推論強度の ADR](./20261007-pass-claude-model-and-effort-via-cli-args.md) により、JPaper はモデル・推論強度の既定値をコードに持たない。Web アプリでもこれを崩せない。
- 外部 API への問い合わせ（arXiv）、子プロセスの起動、設定の保存先は repo-wide に効く判断（issue #328 の Scope）。

# Material for decision
- 要件の合意（2026-10-08、issue #328）: 検索は手元の訳済み論文＋arXiv。設定は毎回フォームで指定し、初期値は設定画面で決める。実行は既定 1 本ずつのキューで、設定画面から並行に切り替えられる。進捗（段階・節 n/m・費用）とログの末尾を見せ、失敗の理由を表示し、待機中・実行中を取り消せる。本文の全文検索・費用の上限・複数利用者・訳済み論文の削除は扱わない。
- arXiv API の利用条件: 連続する要求は 3 秒空ける（1 本ずつ）。応答は Atom XML。
- 比較した代替（翻訳の起動）:
  - `translatePaper` を API のプロセス内で呼ぶ: 進捗をイベントで受けられるが、取り消しは `AbortSignal` 任せで claude の子プロセスまで確実に止める保証が要る。API の再起動（`tsx watch`）で実行中の翻訳が巻き添えになり、例外やメモリの扱いも API と共有になる。
  - **CLI を子プロセスで起動する**（採用）: CLI と同じ入口・同じ検査・同じ `.run/run.lock` を通る。プロセスグループごと止めれば claude の子プロセスまで止まる。進捗は CLI が既に stderr に出す行（契約付録 §5）を読むだけで済む。
- 比較した代替（ジョブの保持）: ファイルに永続化すると、再起動後に「実行中」だったジョブの扱い（再開・失敗扱い）を決める必要があり、CLI の checkpoint と二重管理になる。翻訳の再開は CLI の checkpoint が既に担っている（同じ ID で始め直せば通過済みの節は再利用される）。
- 実測（2026-10-08、一時ディレクトリ）: arXiv API の検索は約 0.6 秒で応答。OPENROUTER_API_KEY 無しの openrouter で始めると `失敗[provider]: …` が理由として表示される。実行中の取り消しと API の終了（`pnpm --filter @jpaper/web run server` に SIGTERM）で、tsx と CLI のプロセスがすべて止まる。

# Decision
- **検索**: 1 つの検索欄で、手元の論文（`listPapers` のタイトル・ID を画面で絞り込む）と arXiv（`/api/arxiv` が `export.arxiv.org/api/query` を問い合わせる）を出す。arXiv への要求は API のプロセス内で 1 本ずつ直列にし、前の要求から 3 秒空ける。同じ問い合わせは 10 分キャッシュする。XML の解析は依存を足さず、entry の id・title・summary・author・published だけを取り出す最小限の実装にする。arXiv の結果は手元の出力（`derivePaperId` で決まる `<paperId>-ja/`）とキューの状態で印を付ける。
- **翻訳の起動**: repo のルートで `node <tsx の cli> src/cli.ts <arXiv ID> --provider … [--model …] [--effort …] --out <articleDir>/<paperId>-ja` を、引数の配列で（シェルを通さず）、独立したプロセスグループとして起動する。provider は `Provider` の列挙、model・effort は CLI と同じ `modelConfigFrom` で検査する（先頭 `-`・制御文字は Web 側でも拒む）。arXiv ID は `detectInput`＋`isArxivId` で検査する。
- **キュー**: ジョブは API のメモリだけに持つ（再起動で消える）。並行数は設定（1〜4、既定 1）。同じ論文（版違いを含む `paperId`）が待機中・実行中なら 409 で拒む。取り消しは、待機中なら起動せずに取り消し、実行中ならプロセスグループに SIGTERM（5 秒で SIGKILL）。API の終了時は待機中を取り消し、実行中を止める。終わったジョブは 50 件まで残す。
- **進捗**: CLI の stderr の行（`[取り込み] 完了`・`[文脈] 完了`・`[翻訳 n/m] …`・`[組版] 完了`・`失敗[kind]: …`）から段階・節 n/m・失敗の理由を作る。費用は `<outDir>/.run/llm-trace.jsonl`（と退避した `.1`）の `costUsd` のうち、起動前に無かった runId の記録の合計。ログは末尾 200 行を持ち、画面には 30 行まで返す。
- **設定**: 翻訳フォームの初期値（既定の provider と、provider ごとの model・effort）と並行数を `JPAPER_HOME/web-settings.json` に保存する。コードには provider・model・effort の既定値を持たず、未設定ならフォームも空で、provider を選ぶまで始められない。
- **API の入口は既存のまま**: Host・Origin・`content-type: application/json` の検査（契約付録 §9）を新しい API にもそのまま掛ける。書き込みはすべて POST にする。

# Consequences
- 良い面: CLI と Web アプリで入口・検査・排他（`.run/run.lock`）が 1 つになり、Web から始めた翻訳と CLI の再実行・用語集の編集が矛盾しない。訳し終えた論文はそのまま一覧と用語集の編集の対象になる。JPaper に既定のモデルを持たない方針を保てる。
- トレードオフ: ジョブはメモリだけなので、API を再起動すると一覧が消え、実行中の翻訳は止まる（`pnpm dev:web` は API を `tsx watch` で動かすので、サーバのコードを変えると止まる）。止まった翻訳は同じ ID で始め直せば checkpoint から再開する。API が SIGKILL などで落ちると、子プロセスが残ることがある。
- トレードオフ: 進捗は CLI の stderr の文言に依存する。文言を変えるときは `apps/web/server/jobs.ts` の解析も直す（契約付録 §5・§9）。
- トレードオフ: 翻訳は CLI として動くので、全体の用語 DB は `JPAPER_HOME/glossary.db` を使う（Web アプリの `JPAPER_GLOSSARY_DB` は翻訳には効かない）。
- トレードオフ: arXiv の問い合わせは 3 秒に 1 本なので、続けて検索すると待たされる。検索は Enter（ボタン）で送り、入力のたびには送らない。
- トレードオフ: 費用の上限は持たない（スコープ外）。並行数を上げると費用と provider の負荷がその分増える。
