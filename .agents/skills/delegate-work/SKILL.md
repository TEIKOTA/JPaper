---
name: delegate-work
description: Use BEFORE delegating work to subagents or parallel agent sessions - sets concurrency limits, the five required elements of a delegation prompt, and a standard constraint block that prevents real API spend and repo mutation by children.
---

# Delegate Work

サブエージェント・並列セッションへ作業を委譲するときの規律。実測事故が根拠:
5 並列委譲が約 70 分で usage limit に激突し修正ラウンド 2 件が未コミットのまま残置 /
制約の無い subagent が本物の API を呼び実費が発生。

## 並列度

- 並列は**既定 2・上限 3**。usage limit は全並列の合計で消費される。
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

## 標準制約ブロック（委譲プロンプトへ転記する雛形）

- repo は read-only。変更が必要なら diff 案を返す（直接編集しない。編集を任せる場合は
  スコープ境界のファイルに限定する）
- 一時ファイルは自分の scratchpad に隔離し、repo 内へ生成物を残さない
- 本物の外部 API・課金を伴う呼び出しを実行しない（検証は fake / dry-run で行う）
- secret ファイル（`.env` 系・鍵）を読まない
- 報告では「実行して再現できた事実」と「推測」を区別して明記する

## 回収

- 委譲結果を鵜呑みにしない。重要な結論は根拠（コマンド・出力・パス）まで遡って確認する。
- 大きな委譲には「過程の自己申告」（見なかった観点・自信のない判断）を出力の型に含めさせる。

## 関連

- `.agents/skills/decide-or-proceed/SKILL.md` — 委譲中に止まるか進むかの判定
- AGENTS.md 編集ガードレール — 破壊的操作・secrets の正本（子にも適用される）
