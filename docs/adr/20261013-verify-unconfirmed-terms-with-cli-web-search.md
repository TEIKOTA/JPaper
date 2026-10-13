# 2026/10/13 承認済みの訳が無い用語は、翻訳の前に CLI 自身の Web 検索で用例を確かめる

# Status
- accepted

# Situation
- DIVERSE（arXiv:2601.20627）の和訳で、中心概念の `Rashomon set` が「ラショモン集合」と訳された。研究者による既存の日本語の用例は「羅生門集合」（富士通研究所の技術ブログ・NTT の展示資料・JSAI2025 の予稿）。用語集の生成が `class: established` と分類し、その訳が translator と evaluator の両方に確定用語として渡って 19 節すべてが通った（issue #309）。
- 用語 ADR（[20260709](./20260709-terminology-architecture-two-tier-classified-glossary.md)）は決定 4 でネット検索を v1 の対象外とし、入れるときも「LLM にツールを持たせず、ワークフローが決定的に検索して候補を注入する」としていた。codex ADR（[20261008](./20261008-add-codex-provider-isolated-from-user-config.md)）は codex の Web 検索を止めている。claude は `--tools none` で起動している。
- 利用者は「怪しい用語は Web 検索で調べる」想定だった。2026-10-13 の認識合わせで、検索の手段・対象・既定・差し替えの規則を決めた（issue #309 本文の「決定」）。

# Context
- 外部の検索 API（キーと課金）を足すと、利用者が既に持っている claude・GPT のサブスクリプションとは別の資格情報が要る。claude・codex の CLI は Web 検索を内蔵している。
- 検索結果は信頼できない文字列で、用語集は全節のプロンプトに載る。採否をモデルに任せると、検索で読んだページの指示や誤りがそのまま確定用語になる。
- 実測（2026-10-13、Rashomon set、各 1 回の呼び出し）:
  - codex（`web_search="live"`、effort low）: 「羅生門集合」を出典 3 件で見つけた。
  - claude（`--tools WebSearch` のみ、Sonnet low）: 3 回の試行すべて not-found。検索結果は英語の論文が中心で、要約文に「羅生門集合」が出ても出典のページに無いので採らなかった。1 回 約 $0.06。

# Material for decision
- issue #309（問題・期待・範囲）、本文の「決定（2026-10-13）」2 回分（認識合わせと実装計画の grill-spec）。
- 用語 ADR（20260709）決定 4、codex ADR（20261008）、[信頼しない文字列 ADR](./20260811-untrusted-text-never-becomes-instructions.md)。
- 上の実測。

# Decision
- **検索の手段**: 翻訳に使う LLM の CLI 自身の Web 検索を、用語の検証の専用の呼び出し 1 回だけで許す（`LlmRequest.webSearch`）。claude は `--tools WebSearch`（ターン上限 12、`--safe-mode` のまま）、codex は `-c web_search="live"`（シェル等の機能は止めたまま）。外部の検索 API と API キーは使わない。検証は翻訳と同じ CLI で行い、claude で訳すなら claude の検索を使う。
- **対象**: プロバイダが claude・codex の run だけ。ollama・openrouter は検索も追加の文脈も無く従来どおり。注入した client は、扱えると宣言したとき（`TranslateDeps.webSearch`）だけ。
- **既定で動かす**。CLI の `--no-verify-terms`、`TranslateOptions.verifyTerms: false`、Web の設定「用語を Web 検索で確かめる（claude・GPT）」で止める。
- **対象語**: 新しく作った用語集のうち、全体の用語 DB に承認済みの訳が無く、訳す（translate・bilingual）established・paper-defined の語。本文の抜粋に多く出る語から 10 語まで。出力先に残っている glossary.md を使う run は検証しない（人の編集を尊重する）。
- **採否は決定的**: 応答の `found` のうち、https の出典の引用に用例の表記がそのまま含まれるものが 1 件以上あれば採る。表記は 1 行・80 字以内・日本語を含み・マークアップの文字を含まないものだけ。用語集の訳と違えば翻訳の前に差し替え、glossary.md の「検証」の欄に元の訳と出典 URL を残す。それ以外（not-found・conflicting・条件を満たさない・呼び出しの失敗）は差し替えず「未確認」として訳注・実行結果（`RunSummary.terms`）・通知に出す。
- **全体の用語 DB**: confirmed へは自動で登録しない。差し替えた訳も、他の語と同じく承認待ち（proposed）として書き戻す。
- **部分 supersede**:
  - 用語 ADR（20260709）: 置換された条項＝決定 4「ネット検索は defer。入れるときも LLM にツールを持たせない」／存続する条項＝2 層辞書・4 クラス分類・表記方針・proposed 書き戻し・事前注入。
  - codex ADR（20261008）: 置換された条項＝「`-c web_search="disabled"` を付ける」を、用語の検証の呼び出しに限って `live` にする／存続する条項＝それ以外の呼び出しで Web 検索を止めること、利用者の設定を読まずにツールを止めて一時ディレクトリで起動すること。

# Consequences
- 良い面: 根拠の無い音写が、出典付きの用例で直る経路ができる（2601.20627 を GPT で訳すと「羅生門集合」を採る）。採否と差し替えはコードが決めるので、検索で読んだページの指示は用語集の 1 語の表記にしか届かず、その表記も文字の制限と出典の引用で縛られる。未確認の語は読者に未確認と分かる訳注になる。
- 受け入れたトレードオフ:
  - claude の検索は日本語の用例を見つけにくい（実測で 3 回とも not-found）。claude で訳した論文では未確認で終わる語が多い。
  - 用語と abstract の冒頭が検索の問い合わせとして外部の検索に出る。arXiv の公開論文なら問題ないが、手元の未公開の原稿を訳すときは `--no-verify-terms` で止める。
  - run ごとに検証の呼び出しが 1 回増える（claude Sonnet low で 約 $0.06。検索の回数で変わる）。結果は checkpoint（`term-verify`）に残り、用語集を作り直しても再検索しない。呼び出しが失敗したときは checkpoint に残さず、次の run でやり直す。
  - 出力先に残っている glossary.md を検証しないので、既に訳した論文を直すには glossary.md を消して再実行する。
