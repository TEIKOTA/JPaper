# Architecture Decision Records (ADR)

このディレクトリには、本プロジェクトのアーキテクチャやチーム運用に関する重要な意思決定を「決定のログ」として記録する。

## なぜ ADR を書くのか

- 過去の意思決定の背景・動機が暗黙知になるのを防ぐ
- 非同期コミュニケーションでの前提・背景の認識合わせを速くする
- 「なぜそうしたか」を誰でも後から振り返れるようにする

採用の経緯そのものは [`20260701-adopt-adr-format.md`](./20260701-adopt-adr-format.md) を参照。

## 運用ルール

- 重要な意思決定を行ったら、このディレクトリに Markdown で 1 ファイル 1 決定として記録する。
- ファイル名は **`YYYYMMDD-title.md`**（例: `20260701-adopt-adr-format.md`）。`title` は内容がわかる kebab-case。
- 仕様書ではなく「決定のログ」として、小さくモジュール化して書く。
- フォーマットは [`template.md`](./template.md) に従う。
- 過去 ADR で変更してよいのは `Status` セクションだけとする。supersede の有無にかかわらず `Situation` 以降の本文は書き換えず、過去 ADR を削除しない。過去の内容を現在の理解で書き直さず、判断の変遷自体を資産として扱う。
- 決定が変わった場合は新しい ADR を追加し、古い方の Status を `deprecated` または `superseded`（後継 ADR を明記）に更新する。
- 部分 supersede（旧 ADR の一部の決定だけを置き換える場合）は、旧 ADR を `accepted` のまま残し、`Status` に 1 行で「置換された条項 / 存続する条項 / 後継 ADR」を追記する。索引には何が上書きされたかを 1 行注記する。

## セクション構成

| セクション | 内容 |
|---|---|
| Status | `proposed` / `accepted` / `rejected` / `deprecated` / `superseded` |
| Situation | 決定時のビジネス上の制約や、会社・チームの状況 |
| Context | 決定が必要になった背後の動機・理由 |
| Material for decision | 決定時に参照した材料（記事・比較資料など） |
| Decision | 最終的な決定内容とその理由 |
| Consequences | 決定によって生じる結果（良い面・トレードオフ） |

## 索引

| 日付 | タイトル | Status |
|---|---|---|
| 2026-07-01 | [ADRフォーマットの採用](./20260701-adopt-adr-format.md) | accepted |
| 2026-07-06 | [issue 駆動・PR 必須の開発ワークフローの採用](./20260706-adopt-issue-driven-pr-workflow.md) | accepted |
| 2026-07-06 | [日本語 Conventional Commits を commit と PR タイトルに適用](./20260706-adopt-commit-and-pr-message-convention.md) | accepted（CI 検査条項のみ 2026-09-01 に部分 supersede） |
| 2026-07-06 | [GitHub デフォルトラベルを廃止しカスタムラベル体系を採用](./20260706-adopt-custom-github-labels.md) | accepted |
| 2026-07-06 | [server-side branch protection の導入を見送る](./20260706-defer-server-side-branch-protection.md) | accepted（CI 強制手段の条項のみ 2026-09-01 に部分 supersede） |
| 2026-07-06 | [テンプレート版数の記録と手動更新戦略の採用](./20260706-adopt-template-versioning-and-update-strategy.md) | accepted（生成経路・形式・保証・metadata コメントを 2026-09-26 に部分 supersede） |
| 2026-07-06 | [ラベル同期の削除を --prune オプトインに限定する](./20260706-clarify-label-sync-prune-behavior.md) | accepted |
| 2026-07-08 | [エージェント基盤: 素の TS ワークフロー＋薄い自作ランタイム（Flue 設計準拠）](./20260708-adopt-deterministic-agent-architecture.md) | accepted |
| 2026-07-08 | [翻訳パイプライン: ソース優先取り込み・図はベクタ優先・決定的処理のツール化](./20260708-translation-pipeline-ingestion-and-figures.md) | accepted |
| 2026-07-08 | [品質ゲートの二層分離（形式=機械判定 / 品質=LLM）と明示的失敗](./20260708-quality-gate-machine-vs-llm-and-explicit-failure.md) | accepted |
| 2026-07-09 | [品質ゲートの2層化・再訳契約・組版エラー分類](./20260709-quality-gate-two-layer-and-build-error-triage.md) | accepted |
| 2026-07-09 | [LLM プロバイダ抽象化: ローカル(Ollama) と cloud(公式 CLI subprocess) を使い分け](./20260709-llm-provider-abstraction-local-ollama-and-cloud-cli.md) | accepted（claude のモデルをログインセッションに委ねる点のみ 2026-10-07 に部分 supersede） |
| 2026-07-09 | [用語アーキテクチャ: 2層辞書・4クラス分類・表記方針・proposed 書き戻し](./20260709-terminology-architecture-two-tier-classified-glossary.md) | accepted |
| 2026-07-09 | [ユーザーインターフェース: ファイル配置・jpaper CLI・GUI は core の薄い皮](./20260709-user-interface-file-layout-and-cli.md) | accepted（論文ごと成果物の既定の置き場所と成果物名 `main.pdf` のみ 2026-10-07 に部分 supersede） |
| 2026-07-10 | [翻訳一貫性: 文書ブリーフ＋文体契約・evaluator 軸の明文化・訳注 surface](./20260710-translation-consistency-brief-style-and-annotations.md) | accepted |
| 2026-07-10 | [組版レイアウト方針: 原プリアンブル温存を既定・共通テンプレへ明示的フォールバック](./20260710-typesetting-layout-original-first-hybrid.md) | accepted |
| 2026-07-10 | [ソースコメント方針: コードは事実のみ・why は正本・地雷は登録簿＋標識](./20260710-source-comments-facts-only-rationale-to-docs.md) | accepted |
| 2026-07-21 | [見出し未訳検査は非ブロッキングの訳注に留める（第4の trigger 追加）](./20260721-heading-untranslated-nonblocking-note.md) | accepted |
| 2026-07-22 | [LLM 呼び出しトレースは local-first JSONL・メタのみ（Langfuse は将来の opt-in exporter）](./20260722-llm-call-trace-local-jsonl.md) | accepted |
| 2026-07-22 | [プロンプトキャッシュ再利用: system prompt を role ごとに安定化し用語スライスを user へ移す](./20260722-prompt-cache-reuse-stable-system-prompt.md) | accepted |
| 2026-07-23 | [構造化出力をプロバイダ能力で分岐（Ollama ネイティブ JSON モード・claude プロンプト維持）](./20260723-provider-branched-structured-output.md) | superseded |
| 2026-07-29 | [AI セッション運用ガード（重複確認・失敗ログ・worktree/待機規律）の採用](./20260729-adopt-ai-session-operational-guards.md) | accepted（新規 worktree の標準配置・例外規約のみ 2026-10-02 に部分 supersede） |
| 2026-08-09 | [組版の堅牢化: LuaTeX 互換 shim の注入と共通テンプレによる原前文の吸収](./20260809-typesetting-shims-luatex-compat-and-class-absorption.md) | accepted |
| 2026-08-11 | [組版サンドボックス: shell escape 明示禁止と同梱パッケージの探索順後置](./20260811-typesetting-sandbox-and-package-precedence.md) | accepted |
| 2026-08-11 | [プロンプト注入対策: 論文・LLM 由来のテキストを指示面へ載せない](./20260811-untrusted-text-never-becomes-instructions.md) | accepted |
| 2026-08-11 | [プリアンブルを「レイアウト設定」ではなく「攻撃者が書いた実行コード」として扱う](./20260811-preamble-is-untrusted-code-not-just-layout.md) | accepted |
| 2026-08-11 | [検査面に同梱支援ファイルを含める（狭い denylist を分ける）](./20260811-support-files-are-part-of-the-inspection-surface.md) | accepted |
| 2026-08-11 | [読み込みコマンドは名前ではなく引数の形で判定する](./20260811-read-commands-judged-by-argument-not-name.md) | accepted |
| 2026-08-11 | [読み込みコマンドの引数は静的に検証できなければ拒否する（main.tex のみ）](./20260811-read-arguments-must-be-statically-verifiable.md) | accepted |
| 2026-08-11 | [綴りが実行時に決まる \csname は main.tex では拒否する](./20260811-dynamic-csname-is-unsafe-in-main-tex.md) | accepted |
| 2026-08-11 | [出力先を決める paperId は単射でなければならない](./20260811-paper-id-must-be-injective.md) | accepted |
| 2026-08-11 | [文脈の持ち越しは名前ではなく内容で判定する](./20260811-context-carry-over-keys-on-content-not-name.md) | accepted |
| 2026-08-11 | [パス引数はコマンド名によらず危険として扱う](./20260811-path-arguments-are-unsafe-regardless-of-command-name.md) | accepted |
| 2026-08-14 | [数式は翻訳前に保護区間へ差し替え、モデルに触らせない](./20260814-protect-math-spans-before-translation.md) | superseded |
| 2026-08-15 | [エスケープした特殊文字も保護区間に含める](./20260815-protect-escaped-specials-too.md) | superseded |
| 2026-08-15 | [改稿予算を形式検査と品質評価で分け、fail verdict にも再訳を与える](./20260815-split-revision-budget-by-checker.md) | accepted |
| 2026-08-15 | [Ollama へ format:"json" を送らない（制約デコードが LaTeX の綴りを壊す）](./20260815-drop-ollama-json-mode.md) | accepted |
| 2026-08-15 | [保護区間は既定で切る（壊していたのは符号化であって、モデルではなかった）](./20260815-protection-was-compensating-for-encoding.md) | superseded |
| 2026-08-15 | [訳文は JSON 文字列で運ばない（区切り付きの平文で返す）](./20260815-translator-returns-plain-text.md) | accepted |
| 2026-08-15 | [検証の往復を縮めるために OpenRouter を第 3 のプロバイダにする](./20260815-openrouter-provider-for-fast-iteration.md) | accepted |
| 2026-08-16 | [保護区間の要否はモデルの能力で決まる（26B では既定へ戻す）](./20260816-protection-depends-on-model-capability.md) | accepted |
| 2026-09-01 | [セッション横断監査に基づく運用ガード第 2 弾の採用](./20260901-adopt-session-audit-guards-v2.md) | accepted（PR 滞留の単一閾値条項のみ 2026-09-26 に部分 supersede） |
| 2026-09-01 | [GitHub Actions を既定オフにしローカル検証を正とする](./20260901-disable-github-actions-by-default.md) | accepted |
| 2026-09-05 | [運用ガード第 2 弾の是正（第 2 ラウンド監査の反映）](./20260905-adopt-session-audit-guards-round2.md) | accepted |
| 2026-09-18 | [AI の merge authority と human review boundary の採用](./20260918-adopt-ai-merge-authority.md) | accepted |
| 2026-09-26 | [repo 内 producer による template provenance の採用](./20260926-adopt-repo-owned-template-provenance.md) | accepted |
| 2026-09-26 | [二段 PR backlog policy の採用](./20260926-adopt-two-stage-pr-backlog.md) | accepted |
| 2026-10-02 | [worktree の標準配置・終了記録・安全な回収の採用](./20261002-adopt-worktree-lifecycle-management.md) | accepted（管理機能の実装は後続） |
| 2026-10-06 | [worktree 標準配置へのエージェント作業許可の採用](./20261006-allow-agent-access-to-worktree-root.md) | accepted |
| 2026-10-06 | [横長の対訳 PDF（A4 縦 2 枚分・左=原文／右=和訳）を標準の出力にする](./20261006-bilingual-side-by-side-pdf.md) | accepted |
| 2026-10-07 | [図表のキャプションは全プロバイダの翻訳指示で訳す](./20261007-translate-captions-in-all-prompt-profiles.md) | accepted |
| 2026-10-07 | [論文ごとの既定の出力先を CWD 配下の article/ にまとめる](./20261007-default-output-under-article-dir.md) | accepted |
| 2026-10-07 | [claude のモデルと推論強度を CLI 引数で渡す（JPaper は既定値を持たない）](./20261007-pass-claude-model-and-effort-via-cli-args.md) | accepted（既定値を持たない点のみ 2026-10-13 に部分 supersede） |
| 2026-10-07 | [成果物 PDF の名前を「ID＋短い英語名」にし、短い英語名はタイトルの翻訳と同時に決めさせる](./20261007-name-deliverable-pdfs-by-id-and-slug.md) | accepted |
| 2026-10-07 | [パッケージ管理を npm から pnpm に移す](./20261007-adopt-pnpm-for-package-management.md) | accepted |
| 2026-10-07 | [節の予算を 0.30×CW に加えて 8,000 トークンで頭打ちにする](./20261007-cap-segment-budget-by-output-time.md) | accepted |
| 2026-10-07 | [用語集の Web アプリ: 訳語の編集はコードの置換で反映し、checkpoint を署名し直して LLM なしで組み直す](./20261007-glossary-web-app-replace-and-retypeset-without-llm.md) | accepted |
| 2026-10-08 | [codex をプロバイダとして入れ、利用者の設定を読まずに起動する](./20261008-add-codex-provider-isolated-from-user-config.md) | accepted（既定値を持たない点のみ 2026-10-13 に部分 supersede） |
| 2026-10-08 | [Web アプリで arXiv を検索し、翻訳は CLI の子プロセスをメモリ上のキューで回す](./20261008-web-app-arxiv-search-and-translate-job-queue.md) | accepted |
| 2026-10-08 | [本文中の \author は訳さず印で伏せ、伏せた区間の用語は節の用語に数えない](./20261008-keep-author-block-untranslated.md) | accepted |
| 2026-10-11 | [前付け（タイトル・組む位置・原文のまま残す命令）を論文テンプレートの型の表で決める](./20261011-drive-frontmatter-by-template-profile-table.md) | accepted |
| 2026-10-12 | [落ちた節の最後の指摘を出力先の .run に既定で残す](./20261012-keep-last-issues-of-failed-segments.md) | accepted |
| 2026-10-13 | [claude・codex の既定を最新の中位モデル（Sonnet・Sol）と effort medium にする](./20261013-default-to-latest-mid-tier-models-at-medium-effort.md) | accepted |
