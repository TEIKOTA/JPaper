# 2026/08/15 検証の往復を縮めるために OpenRouter を第 3 のプロバイダにする

# Status
- accepted

# Situation
- ローカル LLM 単独で arXiv 論文を訳し切る運用を続けている。実行機は MacBook Air M4 24GB。
- 検証の往復が遅すぎる。実測（run3・2203.06060）で **論文 1 本 = 234 呼び出し / 入力 72.1 万 tok / 出力 22.7 万 tok / 累計 7.26 時間**。1 節を測り直すだけで 5〜10 分かかり、プロンプト規則の効果を確かめるサイクルが成立していなかった。
- 実際、`TRANSLATOR_MATH_BOUNDARY` の効果測定では 1 案あたり 10〜20 分を費やし、そのうち 1 案（改稿の文面）は**逆効果だったことが 2 稿目まで測って初めて分かった**。

# Context
- 測っているのは**モデルの能力**であって実行場所ではない。同じモデルがローカルとリモートの両方にあるなら、リモートで得た知見はそのままローカルへ移る。
- Ollama と OpenRouter の両方に存在する組み合わせを選べる。
  - ローカル: `gemma4:26b-a4b-it-qat`（15GB）
  - API: `google/gemma-4-26b-a4b-it`（`:free` もある）
- MoE で活性 4B なので Mac 24GB で動く。**論文固有の知識を足すわけではない**ので、「その論文でしか使わないカンニングペーパーは置かない」という測定条件は崩れない。
- 費用は無視できる。実測トークン数から換算して 1 本 $0.18（`gemma-4-26b-a4b-it`）。無料版なら $0。
- ただし**無料枠は 20 req/分・50 req/日**（累計 $10 未満の購入時）。1 本 234 呼び出しなので**通し実行はできない**。1 節の probe は 4〜8 呼び出しで収まる。
- 実測（本 ADR の作業中、`:free` で seg-0023 を通した）: 1 稿目 123 秒（出力 2,466 tok）、2 稿目 56 秒で形式検査を通過。ローカル 12B が改稿 4 回を使い切って落ちていた節が 2 稿で通った。

# Material for decision
- [Ollama へ format:"json" を送らない ADR](./20260815-drop-ollama-json-mode.md): 制約デコードは JSON 文字列中に `\c` を出せず LaTeX を壊す。**OpenRouter でも同じ理由で `response_format` を送らない**。
- [訳文は平文 ADR](./20260815-translator-returns-plain-text.md): 応答形式の契約はプロバイダに依らない。
- [LLM トレース ADR](./20260722-llm-call-trace-local-jsonl.md): 呼び出しごとの usage を JSONL へ落とす。OpenRouter は応答にコストを載せてくるので、`costUsd` が初めて実測値で埋まる。
- [構造化出力 ADR](./20260723-provider-branched-structured-output.md): プロバイダ能力で分岐する設計。第 3 のプロバイダもこの形に従う。
- [秘密は .env から受け取る ADR](./20260815-secrets-from-dotenv-at-process-entry.md): API キーの受け渡し。
- 実測（本 repo・ollama 側の先例）: まとめ受け（`stream:false`）だと生成が undici の既定タイムアウトを超えた時点で接続ごと落ち、`fetch failed` としか分からない。

# Decision
- **`Provider` に `openrouter` を足す**。正本は `src/providers/openrouter.ts`。OpenAI 互換の `/v1/chat/completions`。
- **SSE で逐次受ける**。ollama と同じ理由（無通信タイムアウトを避け、期限は `withCallTimeout` だけが持つ）。`stream_options.include_usage` を付けて最終チャンクに usage を載せさせる。
- **`response_format` を送らない**。制約デコードは LaTeX の綴りを壊す。プロバイダが変わっても理由は変わらない。
- **鍵は呼び出しのたびに読む**（`deps.apiKey` → 環境変数の順）。起動時に固めると、web でテナント別資格情報を差し替えられない。未設定は終了コード 2。
- **HTTP の分類を分ける**。429 と 5xx は `status` を載せた素の Error にして `isTransient` → `withRetry` に委ねる。401/403（鍵）・402（残高）・404（モデル）は再試行しても直らないので `JpaperError(2)` で即落とす。
- **既定モデルは `google/gemma-4-26b-a4b-it:free`**。ローカルの `gemma4:26b-a4b-it-qat` と同一モデルで、無料枠で probe が回せる。
- **`--model` / `--context-window` を openrouter でも受ける**。`--think` は ollama だけの口のまま（OpenRouter はモデル側の既定に委ねる）。
- **用途は検証の往復**。無料枠では通し実行できないので、**ベンチマークの通し実行はローカルで行う**。API は 1 節単位の切り分けに使う。

# Consequences
- 良い面
  - 1 案の検証が 10〜20 分から数分になる。逆効果の案を早く捨てられる（実測で 1 案が該当した）。
  - Mac の GPU を占有しないので、通し実行と切り分けを**同時に**進められる。
  - `costUsd` が実測値で埋まり、トレースが初めて課金相当の仕事量を示す。
  - 同一モデルがローカルにもあるため、API で確かめた規則をそのままベンチマークへ持ち込める。
- トレードオフ
  - **原稿が外部へ出る**。対象は公開 arXiv 論文なので実害は無いが、未公開原稿を扱うなら openrouter を選んではならない。この判断は利用者に委ねる（既定プロバイダにはしない）。
  - **無料枠は 50 req/日**。通し実行には足りず、$10 購入で 1000 req/日になる。枠切れは 429 として一時障害に落ちるので、再試行が枠の回復を待ち続ける形になる。
  - プロバイダが 3 つになり、`contextWindowFor` / `requestTimeoutMsFor` / `defaultConcurrencyFor` の分岐が増える。
  - リモートの速度はモデル提供元の混雑に左右される。実測でも 1 呼び出し 623ms〜123 秒と幅があった（出力長の差が大きいが、無料枠の待ちも含む）。
