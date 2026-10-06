---
name: delegate-work
description: Use BEFORE delegating work to subagents or parallel agent sessions - isolates child worktrees and scratchpads, bounds concurrency and workflow size, checkpoints writable work, and supplies the five-element prompt contract with standard safety constraints.
---

# Delegate Work

サブエージェント・並列セッションへ作業を委譲するときの規律。実測事故が根拠:
5 並列委譲が約 70 分で usage limit に激突し修正ラウンド 2 件が未コミットのまま残置 /
制約の無い subagent が本物の API を呼び実費が発生。

## 並列度

- 並列は**既定 2・上限 3**。usage limit は全並列の合計で消費される。
- 委譲前に、その実行環境が表示する利用可能枠も確認し、repo 上限と実行環境上限の
  小さい方に従う。2026-09-20 時点の Codex Team 実行環境は **4 slot（親を含むため
  子は同時 3）**だが、これは Codex 固有の当該環境上限であり、製品横断の一般上限ではない。
- [OpenAI 公式の Codex subagents 文書](https://developers.openai.com/ja-JP/docs/agent-configuration/subagents)
  は `agents.max_concurrent_threads_per_session` を親を除く同時 open thread 数の設定とし、
  未設定時の値は Codex が選ぶとしている。固定値を tool-neutral な規則へ一般化しない。
- レビュー・修正ループの終端までを 1 枠と数える。子の初回出力が返っても、
  その修正ラウンドが終わるまで枠は空かない。
- limit 逼迫の兆候が出たら新規委譲を止め、実行中の子の回収と commit を優先する
  （未コミット差分を残したまま limit に当たるのが最悪ケース）。

## 委譲プロンプト必須 5 要素

1. **役割**: 何の専門家として、何を成果物にするか
2. **スコープ境界**: 触ってよいファイル・ディレクトリの列挙（それ以外は read-only）
3. **禁止事項**: 下の標準制約ブロック＋タスク固有の禁止
4. **入力自己完結**: 子は親の会話を読めない前提で、必要な文脈・パス・引用を本文に含める
5. **出力の型**: 返すべき構造（結論先頭・根拠・変更ファイル一覧など）を指定する

## 作業場所と checkpoint

- 子は read-only の調査・review を含め、親の checkout や他 session の checkout を共有しない。
  `scripts/new-branch.sh ... --worktree <~/worktrees/<repo>/ 配下の専用 path>` を使い、子ごとに専用
  worktree を割り当てる。配置・物理 path 検査は同 script と AGENTS.md の worktree 規律を正本とする。
- 編集を任せた子は、報告前と 30 分ごとに追跡済みの部分成果を WIP checkpoint として
  通常 commit する。commit は履歴に追加し、amend・rebase・force push で書き換えない。
- 一時ファイルは共有 scratchpad へ置かず、子ごとのサブディレクトリへ隔離する。
  引き継ぐ調査結果・レポート・生成物は scratchpad だけに残さず、repo 内か home 配下の永続位置へ保存する。

## 標準制約ブロック（委譲プロンプトへ転記する雛形）

- repo は read-only。変更が必要なら diff 案を返す（直接編集しない。編集を任せる場合は
  スコープ境界のファイルに限定する）
- 親の checkout を共有せず、`scripts/new-branch.sh --worktree` で作った home 配下の専用
  worktree だけを使う
- 一時ファイルは子ごとの scratchpad に隔離し、引き継ぐ成果物は永続位置へ保存する
- 子は本物の外部 API を呼び出さない。検証は fake / dry-run で行う
- 親と子の双方で、有料外部 API の呼び出し・provider の変更・クレジット消費を行わない。
  必要性が生じたら [`decide-or-proceed`](../decide-or-proceed/SKILL.md) の停止条件として親へ返す
- secret ファイル（`.env` 系・鍵）を読まない
- writer / reviewer は merge しない。権限判定は下記 Merge authority の正本へ返す
- 報告では「実行して再現できた事実」と「推測」を区別して明記する

## Workflow の分割

- 1 Workflow の構成は、親を含む同時・逐次の合計で 8 エージェント以下にする。
  これは usage limit 事故を小さくする repo の分割上限であり、上記の同時並列上限とは別物。
- 8 を超える作業は複数 Workflow に分け、各段階の部分成果を repo 内か home 配下の
  永続ファイルへ保存してから次へ渡す。
- JavaScript の command・tool snippet・生成コードでは文字列にバッククォートを使わず、
  single / double quote またはデータオブジェクトで表す。

## 回収

- 作成時に root session / child ownership を管理コマンドへ登録する。正本は
  [`worktree lifecycle`](../../../docs/process/worktree-lifecycle.md)。既存の未管理 worktree を子専用へ昇格しない。
- 子は修正ラウンドの終端まで終了記録を出さない。終了時は結果・対象 SHA・根拠を worktree 外へ保存し、
  `scripts/worktree.sh end` で明示報告する。登録 job の終了も確認する。
- root は実際の agent session 終了・job 終了・現物・退避根拠を確認し、`inspect` の snapshot に対応する
  confirmation を外部保存して `reclaim` する。子は回収しない。通常・他 session・未管理分はユーザー承認が必要。
- 区切りに `scripts/worktree.sh candidates` の候補と保護理由を提示する。PR merge/close や clean だけで終了・回収を推定しない。


- 委譲結果を鵜呑みにしない。重要な結論は根拠（コマンド・出力・パス）まで遡って確認する。
- 大きな委譲には「過程の自己申告」（見なかった観点・自信のない判断）を出力の型に含めさせる。

## Merge authority の適用

- merge authority の正本は [`docs/adr/20260918-adopt-ai-merge-authority.md`](../../../docs/adr/20260918-adopt-ai-merge-authority.md)。
- writer は scope 内の実装・検証・commit / push / PR 作成までを担い、merge しない。
- reviewer は writer と別 context で fixed head SHA と根拠を確認し、blocking finding の有無を返すが、merge しない。AI reviewer を HUMAN 判断の代替にしない。
- root orchestrator だけが正本の AUTO / HUMAN 条件を判定し、AUTO の全条件を満たす場合だけ squash merge できる。HUMAN 条件を含む場合は人間の判断を待つ。
- HUMAN 判断は可能なら issue / ADR の scope 確定時に前倒しする。未解決の意味判断を writer / reviewer に委ねず root orchestrator へ返す。
- stacked child の reviewer には immediate-base の fixed parent head SHA と fixed child head SHA を渡し、その差分だけを対象にさせる。親の squash merge 後は正本の手順で child を再検証する。

## 関連

- `.claude/skills/decide-or-proceed/SKILL.md` — 委譲中に止まるか進むかの判定
- `scripts/new-branch.sh` — home 配下の専用 worktree 作成と path 検査
- `docs/adr/20260905-adopt-session-audit-guards-round2.md` — #55〜#60 に分割した是正方針
- AGENTS.md 編集ガードレール — 破壊的操作・secrets の正本（子にも適用される）
