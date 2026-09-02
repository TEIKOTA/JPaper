---
name: git-commit
description: "Use when a commit message is needed for the current diff — on explicit request, or immediately before an authorized commit. Generate the message suggestion only. Do NOT execute commit."
---

# Git Commit Message

Generate commit message

## General Rules
- ALWAYS write commit message in Japanese
- ALWAYS assume 1 commit = 1 semantic unit

## Hard Requirements
- MUST execute the workflow commands on every invocation of this skill
- NEVER reuse git diff results from a previous turn
- ALWAYS inspect the current repository state in the same turn before generating a commit message
- MUST prefer staged changes when staged changes exist
- If no staged changes exist, MUST inspect unstaged changes instead of staging files automatically
- If neither staged nor unstaged changes exist, MUST say that there is no diff to describe
- MUST check whether the inspected diff is a single semantic unit before generating a commit message
- MUST NOT generate one commit message for a diff that contains multiple unrelated change reasons
- If the diff is multi-concern, MUST tell the user/agent to split the diff first and rerun the skill
- Do not generate a commit message from memory, prior outputs, or earlier inspections

## Trigger Conditions
- When user explicitly asks to create a commit message
- When an authorized commit is about to be made — invoke immediately before each
  commit. Task completion alone (e.g., after read-only work with nothing to
  commit) does not trigger this skill.

## Workflow

### 1. Check Changes

Run these commands on every invocation.

```bash
git diff --cached --stat
```

If the staged diff is non-empty, use staged changes for the rest of the workflow.

If the staged diff is empty, run:

```bash
git diff --stat
```

Use unstaged changes for the rest of the workflow.

### 2. Analyze Diff

- If using staged changes:

```bash
git diff --cached
```

- If using unstaged changes:

```bash
git diff
```

For large diffs (>500 lines), check `--stat` first, then view key files selectively.

If needed for context:
- Read full file for new files
- Check `git log --oneline -5`

### 3. Check Commit Cohesion

- Decide whether the inspected diff is one semantic unit.
- Treat these as split-required signals:
  - unrelated directories or subsystems changed for different reasons
  - docs/process change and runtime/rule change mixed without a single change reason
  - one part could be reverted independently from another part
  - the body would need to describe multiple separate intents
- If split is required, do not invent a single commit message.
- Instead, return a short Japanese split recommendation and 2-4 suggested commit slices.

### 4. Generate Commit Message

Conventional Commits format:

```
<type>[(<scope>)]: <subject>

[<body>]
```

**Types:** `scripts/check-commit-msg.sh` の `types` 一覧が正本。生成前に一覧を確認する。

**Scope:** optional

**Rules:**
- Type: select the option that best describes the changes.
- Subject: 日本語で書く。末尾ピリオドなし、50 字以内。
- Body: optional. Add it when the subject alone cannot explain what/why; wrap at 72 chars and keep it concise.
- 機械検査の正本は `scripts/check-commit-msg.sh`(lefthook commit-msg で強制)。
  強制されるのは type prefix の形式と件名に日本語を含むことまでで、字数や
  分割判定は検査されない — そこはこの skill の生成規約が担う。

**Output Suggestion**

- If the diff is one semantic unit, present the generated commit message to the user. Do not execute the `git commit` command automatically. The final output should be just the commit message string.
- If split is required, do not output a commit message string. Output only the split recommendation.

## Output Guardrails

- The commit message MUST reflect only the diff inspected in the current turn
- If staged changes exist, the commit message MUST reflect only the staged diff
- If staged changes do not exist, the commit message MUST reflect only the unstaged diff
- If the diff spans multiple semantic units, do not invent a single message
- If there is no diff, do not invent a commit message
- Do not answer until the current-turn inspection steps have completed

## Execution Hygiene（commit を実行する側の規律）

生成した message を使って commit / PR / issue を作る側は、次を守る
（根拠: 複数行日本語や制御文字の argv 直渡しによる gh / git 失敗、
編集スクリプトの失敗を検知せず commit だけ成功して amend + force-push を
強いられた事故の反復）:

- commit message は必ずファイル経由で渡す（`git commit -F <file>`）。PR / issue の
  body も同様に `--body-file` を使い、複数行テキストを argv に直接書かない。
- ファイルを変更するスクリプトと `git commit` を同一のシェル行で連結しない。
  commit の前に `git status` / `git diff --stat` で変更が適用されたことを確認する。
- issue / PR にラベルを指定するときは `.github/labels.yml` に実在するものだけを使う。

## Examples

**Simple commit message:**
```
fix(auth): トークンの有効期限チェックを修正
```

**Commit message with body:**
```
feat(api): ユーザー検索エンドポイントを追加

ユーザー名とメールアドレスに対する曖昧検索を実装
```

**Split required:**
```text
split required: staged diff を先に分割してください

- docs(process): process 文書と ADR を分ける
- chore(agent): worker / rule / skill の強制を分ける
```
