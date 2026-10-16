# 2026/10/06 claude / codex プロバイダは論文 1 本ごとに CLI セッションを再利用する

# Status
- rejected（2026-10-06。A/B 実測でコストが増え、品質も安定しなかったため。使い捨て方式を維持する）

# Situation
- 実行機は個人利用の MacBook Air。cloud 側（claude / codex）は公式 CLI をログインセッションのまま subprocess として叩く（[20260709](./20260709-llm-provider-abstraction-local-ollama-and-cloud-cli.md)）。
- 直近の claude / codex は高性能で、文脈を持たせたまま複数の節をまとめて訳せる。タスクを細かく分割しすぎる必要は小さくなった。
- 本 ADR は実装前の提案であり、A/B 計測の結果が出るまで `accepted` にしない。

# Context
- 現状の claude / codex プロバイダは、`complete(req)` ごとに CLI を新規起動して終了させる。`claude -p ... --max-turns 3 --tools none`、`codex exec --ephemeral --sandbox read-only -`。会話状態は一切持たない。これは 20260709 の明示的な決定ではなく、subprocess 方式の帰結である。
- 毎回プロンプトへ詰め直しているもの: brief / style / glossary スライス、改稿時の前稿と指摘。節ごとに最悪 (translate + evaluate) × (1 + 改稿回数) 回、独立した CLI 起動が走る。
- 起動のたびに Claude Code の基本プロンプト（実測で約 5k トークン）が載る。論文全体の訳語・文体の一貫性は、glossary という外部メモにのみ依存している。

# Material for decision
- 実機確認（2026-10-06、claude 2.1.291 / codex-cli 0.160.0）。
  - claude: `--session-id <uuid>` で初回、`--resume <uuid>` で 2 回目以降。`--tools none --max-turns 3` のまま使える。記憶は保持される。`--append-system-prompt` は初回に付ければ resume 後も有効（2 回目の返答にも指示した語尾が付いた）。2 回目の usage は cache_read 5,467 / cache_creation 241 トークンで、キャッシュが効く。
  - codex: `exec --json` の `thread.started.thread_id` を取り、`exec resume <id> -` で続ける。記憶は保持される。usage に `cached_input_tokens` が出る（27,392 / 42,915）。
  - **codex の `resume` は `--sandbox` を受け付けない**（`unexpected argument '--sandbox'`）。追加指定なしの resume はユーザー config の `sandbox_mode`（実測では `workspace-write`）で動き、ファイルを書けた。`-c 'sandbox_mode="read-only"'` を付けた resume では書き込みが失敗した。
  - codex の `--json` 出力にはユーザー config 由来の `error` item（設定警告・hook-trust 警告）が混ざる。応答は `agent_message` item から取る必要がある。
  - claude で、原因不明の「JSON が空」が 1 回あった。再実行では再現しなかった。
  - claude 2.1.291 は、用語集構築のような長い入力で内部的に 2 ターンを使う。`--max-turns 1` では `error_max_turns`（exit 1）で落ち、セッションの有無によらず run が失敗する（実測: A/B の両モードが用語集構築で失敗）。`--tools none` がツール禁止を担うので、上限を 3 に上げて解消した（[地雷登録簿](../design/landmines.md)）。
- 関連: [20260722 プロンプトキャッシュ再利用](./20260722-prompt-cache-reuse-stable-system-prompt.md)、[20260722 LLM 呼び出しトレース](./20260722-llm-call-trace-local-jsonl.md)。
- 検討した代替案:
  - 現状維持（使い捨て）: 最も単純で、評価の独立性も高い。一貫性とコストの改善余地を残す。
  - 節ごとに 1 セッション: 並列度は保てるが、節をまたぐ一貫性は glossary 頼みのまま。
  - 常駐プロセス（stream-json の入出力）: 起動コストは最小だが、実装と障害時の扱いが重い。今回は見送る。

# Decision
- **結論: 不採用。claude / codex は呼び出しごとの使い捨てを維持する。** 以下は不採用になった提案の内容で、実測結果は末尾の「Consequences」に記す。
- claude / codex プロバイダは、**translator を論文 1 本につき 1 セッション**で回す。節は直列に処理する。
- **evaluator は translator と別セッション**にし、論文 1 本につき 1 本を再利用する。自分の訳を自分で採点する偏りを避ける。
- 改稿は**差分指示だけ**を送る（前稿はセッションにあるので再送しない）。指示文は「前稿を土台にした最小差分」を保つ（契約付録 §1 の seg-0023 の知見）。再現しない場合の扱いは計測で決める。
- brief / style / glossary はセッション冒頭に 1 回だけ注入し、節ごとには「初出の用語」だけを送る。
- 失敗した節のやり取りもセッションに残す。計測で後続の節への悪影響が見えたら、fork による切り離しへ切り替える。
- 文脈があふれたときは CLI の自動 compact に任せ、不安定なら新規セッションへ切り替える。glossary / style の再注入間隔は設定にする。
- セッション ID は `runDir` に保存する。再開できない場合は、その節に必要な情報を完全に詰め直した使い捨て呼び出しへフォールバックし、次の節から新しいセッションを始める。
- 同一セッションへの同時リクエストは 1 本に制限する。translator(節 N+1) と evaluator(節 N) は別セッションなので重ねて実行する。
- 安全性は維持する。claude は `--tools none --max-turns 3` を、codex は resume でも `-c 'sandbox_mode="read-only"'` を必ず付ける。「resume の引数に read-only 指定が入る」ことを単体テストで固定する。
- `LlmRequest` に任意の `session` を足し、指定が無ければ従来どおり使い捨てとする。セッション管理は run 層、provider は ID の受け渡しだけを担う。ollama / lmstudio / openrouter は対象外。
- checkpoint の無効化キーにセッション方式を含める。使い捨てとセッションの結果が混ざらないようにする。
- 採否は、現行方式との A/B（合格率・改稿回数・入出力トークン・所要時間。1810.11953 など既存の論文）で判断する。論文専用の補助資料は作らない。

# Consequences
- 良い面:
  - 訳語・文体の一貫性が、節をまたいでセッション文脈にも乗る。
  - 毎回の基本プロンプトと詰め直しの入力が、キャッシュ読み込みに置き換わる。
  - 評価の独立性は維持される。
- トレードオフ:
  - translator の並列度が 4 から 1 になる。evaluator との重ねで一部を取り戻すが、総時間は延びうる。
  - 前稿をセッションに残すと「同じ訳を返す」現象が戻る可能性がある（契約付録 §1）。
  - 失敗した訳が文脈に残り、後続の節へ影響しうる。compact で用語が落ちる可能性もある。
  - codex の resume は sandbox の指定方法が初回と異なり、指定を忘れると書き込み可能になる。CLI の更新で挙動が変わりうるため、統合テストで検知する。
  - セッション ID と CLI のセッション保存先（ディスク）への依存が増える。
- 未確認:
  - 同一セッションへ並行して resume した場合の挙動（設計上は直列にするので回避する）。
  - claude の原因不明の空出力の根本原因。既存の `transient` + `withRetry` で扱う。

# 実測結果（2026-10-06・不採用の根拠）
- 条件: claude 2.1.291、5 節の合成論文。off（使い捨て）と paper（セッション）を**直列**に paper→off→off→paper の順で各 2 回。
  - 使い捨て: 平均 $1.53 / 42s。2 回とも完走・改稿 0 回。
  - セッション: 平均 $2.31 / 67s（約 1.5 倍のコスト・約 1.6 倍の時間）。2 回のうち 1 回は seg-0001 が文書構造の破壊と判定されて失敗した（使い捨ては 0 回）。
  - 同時に走らせた最初の計測（$3.30 対 $2.15）は、同じ接頭辞のキャッシュを取り合うため偏りがあり、結論には使わない。直列にした本計測でも向きは変わらなかった。
- 切り分け（コスト増の原因はセッション自体か、実装の都合か）:
  - 再開時に `--append-system-prompt` を毎回送っても費用は同じ（$0.2409 対 $0.2427）。system を送らない実装の都合ではない。system 自体は resume 後も保持される（履歴から推測できないルールで確認）。
  - system を毎回変えて冷えた状態にすると、再開のたびに約 8,600 トークンのキャッシュ書き込みが発生した。4 呼び出しの合計はセッション $0.726、使い捨て $0.706 で、節約にならない。CLI 2.1.291 の `--resume` の性質であり、本リポジトリの実装では変えられない。
  - 同じ system を直前に使って暖めた状態では再開が約 9 倍安かった（$0.034 対 $0.30）が、実際の run では再現しなかった。
- 再検討するなら、長い論文（数十節以上）で同じ直列 A/B を取り直したときだけ。claude の `--exclude-dynamic-system-prompt-sections` は効果を確認できなかった。

