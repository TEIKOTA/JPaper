# Decisions（ユーザー決定レジスタ）

## 目的

ADR にするほど重くない「ユーザーの確定済み決定」を 1 行ずつ記録する append-only のレジスタ。対象は、理由付きで却下された案（同じ提案を繰り返さないため）、成果物や進め方の確定済み嗜好、軽量な設計判断。compact・セッション・ツールを跨いで決定が揮発し、**却下済みの案が後から再導入される**事故を防ぐ。

採用判断は [`docs/adr/20260901-adopt-session-audit-guards-v2.md`](../adr/20260901-adopt-session-audit-guards-v2.md) を参照。

## 使い方

- ユーザーから嗜好・却下・軽量決定の訂正を受けたら、**その場で**下の表へ 1 行追記する。事前の承認は不要。根拠（発話の要旨と日付、issue / PR）を必ず添える。
- 記録先ルーティング: architecture / repo-wide ルールに効く決定は ADR（`manage-adrs` skill）。このレジスタは ADR 未満の決定の受け皿。ツール付属の memory 機能は個人の振る舞いメモに留め、今後の判断に効く決定はここか ADR に置く。
- 決定が変わっても行を消さず、「撤回（日付・理由）」を同じ行に追記する。
- 着手前と compact 後の再開時に、作業に関連する行を確認する。

## ログ

| 日付 | 決定 | 背景 | 却下した選択肢（理由） |
|---|---|---|---|
| 2026-09-01 | bridge-session / 遠隔運転の報告規約は共通化を見送る | 横断監査で候補になったが、証拠が散在しており別途集計が必要だった（#61 の監査記録） | 即座に template の報告規約へ入れる（根拠不足の一般化になるため） |
| 2026-09-01 | headless（`-p`）運用規約は共通化を見送る。2026-09-05 撤回: #63 で再採択 | 横断監査で将来候補としたが、当初の見送り理由の詳細は一次記録に残っていない（#61 の監査記録） | 理由を推測して標準手順へ入れる（当時の判断を再構成できないため） |
| 2026-09-01 | 外部 LLM 併用時の受け渡し規約は共通化を見送る | 横断監査で将来候補としたが、見送り理由の詳細は一次記録に残っていない（#61 の監査記録） | 理由を推測して共通 handoff 契約を作る（当時の判断を再構成できないため） |
| 2026-09-01 | memory 運用の標準化を見送る | auto-memory はプロジェクト・ツール間で伝播せず、repo 正本の代替にならなかった（#61 の監査記録） | memory を repo-wide な決定の正本にする（共有・追跡可能な正本にならないため） |
| 2026-09-01 | `check-branch-topology.sh` の template 移植を見送る。2026-09-05 撤回: #53 で再採択 | postmarket 固有色が強く、必要になった時点で別 issue とする判断だった（#61 の監査記録） | 当時そのまま移植する（template 共通契約としての実証が無かったため） |
| 2026-09-01 | main 直コミット禁止 hook の導入を見送る | 初期化フロー・chore の直接 commit と衝突した（#61 の監査記録） | 全 repo で hook により禁止する（既存の例外フローを壊すため） |
| 2026-09-05 | hook は project-level に加えて user-level にも配線する | 古い branch・未 pull checkout では project-level hook が届かないため（R1 / #47） | project-level だけに置く（導入前 checkout のガード欠落が残るため） |
| 2026-09-05 | 配布形式は Agent Skills のまま維持する | round 2 の時点では hook を含む package 化を必要とする派生 repo が 2 件未満だった | Agent Plugins として今すぐ package 化する（採用実績が閾値に達していないため） |
| 2026-09-17 | stacked PR を使い、ユーザー判断が不要で AUTO 条件を満たす PR だけを root orchestrator が squash merge する。writer / reviewer は merge しない | 人間の merge 待ちを減らしつつ、意味判断と trust boundary は人間に残す（#56・[`merge authority ADR`](../adr/20260918-adopt-ai-merge-authority.md)） | AI reviewer を HUMAN 判断の代替にする／個別 issue に恒久 AUTO / HUMAN label を付ける（意味判断を取り逃し、live scope での判定を固定化するため） |
| 2026-09-23 | 自然文の訂正を検知する hook は Claude / Codex とも導入せず、既存 AGENTS.md の意味判断と decisions.md / ADR ルーティングを共通正本にする | 記録対象は稀で、自動検知の複雑さ・ノイズに見合わない（#59 / PR #90） | Claudeだけ／両方への UserPromptSubmit hook、専用 skill、hook 不在の hard gate（過剰な自動化・強制になるため） |
| 2026-09-23 | self-testは全green時に最終PASS件数の1行だけを出し、失敗時だけ失敗詳細と最終集計を出す | 個別PASS 500件超がエージェントのcontext/inputを浪費するため（#97） | section見出しや個別PASSの常時表示、--verbose追加（現段階では不要） |
| 2026-09-27 | 未解決事項の issue checkpoint を維持し、再開先は最新の本文・関連コメントとユーザー回答を照合して、必要な未解決判断を現在の会話へ戻す | ユーザーは引き継ぎ記録を妥当とし、再開先が Codex 内で議論することを希望した（[#102](https://github.com/TEIKOTA/project-template/issues/102)）。再開手順の正本は [`grill-me`](../../.claude/skills/grill-me/SKILL.md#中断引き継ぎ後の再開) | 未解決の GitHub 記録を禁止する／保存を回答・承認の代わりにする／承認済みの質問を繰り返す（記録と対話の役割を混同するため） |
| 2026-10-06 | guard-bash の `-c` 再帰検査は、最初に現れる c を含む option より後ろを常に検査し、スクリプト名の後ろの `-c` を引数とみなす例外を持たない（`bash script.sh -c x` の誤検知は旧来どおり受容） | PR #113 の独立 review 7 回すべてで旧版からの退行が見つかり、ユーザーが例外の廃止に同意した（#112） | option 解釈のシェル別の再現、スクリプト名の例外（展開・リダイレクト等の表記ですり抜けられ、旧版より緩くなる） |
| 2026-10-14 | `jpaper` コマンドは build した `dist/cli.js` ではなく、`src/cli.ts` を tsx で直接動かす起動用のファイル（`bin/jpaper.mjs`）にする。導入は `pnpm link --global` | 利用者が選んだ（#367）。`git pull` の後に build せずに最新で動く。起動が約 1 秒になることは受け入れた | build した `dist/cli.js` を bin にする（pull のたびに `pnpm build` が要り、古い版が動きやすい） |
