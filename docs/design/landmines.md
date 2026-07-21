# 地雷登録簿（意図的な非自明箇所）

> 「一見おかしいが意図的」なコードの唯一の正本。コードが不自然に見えても、**直す前にここを確認する**。該当があれば意図的なので、そのまま維持する。
>
> 方針は [ソースコメント ADR](../adr/20260710-source-comments-facts-only-rationale-to-docs.md)。該当箇所にはソース側に中身ゼロの標識 `⚠ landmines.md` だけを置き、理由はここに書く。

## 記入ルール

- 1 エントリ 1 箇所。**行番号でなくシンボル名（path＋関数/定数名）で anchor** する（行移動で腐らせない）。
- 各エントリに書く: 「何がおかしく見えるか」「なぜ意図的か」「関連する正本ポインタ」。
- 該当コードを消す／意図が失効したら、このエントリも消す。

---

## `scripts/check-commit-msg.sh` — 日本語判定の `LC_ALL=C grep '[^ -~]'`

- **おかしく見える点**: 日本語を判定するのに、ひらがな/カタカナ等の文字クラス（`[ぁ-ん]` 等）ではなく「ASCII 印字可能文字 `0x20-0x7E` 以外のバイト」を見ている。一見すると日本語専用の判定に見えない。
- **なぜ意図的か**: 文字クラスの範囲指定は一部 locale で `Invalid collation character` になり、CI で誤判定して commit/PR タイトル検査を壊す。`LC_ALL=C` のバイト単位で非 ASCII の有無を見ることで、「英語のみの件名を拒否する」意図を保ちつつ macOS(BSD)/Linux/CI の移植性を確保している。素直に文字クラスへ戻すと CI が再び落ちる。
- **正本ポインタ**: [日本語 Conventional Commits ADR](../adr/20260706-adopt-commit-and-pr-message-convention.md)。self-test は `tests/run-tests.sh`。

## `src/terminology/db.ts` — `process.getBuiltinModule("node:sqlite")` で読み込む

- **おかしく見える点**: 他の組み込みは `import { X } from "node:..."` なのに、ここだけ `process.getBuiltinModule("node:sqlite")` で取得している。素直に `import { DatabaseSync } from "node:sqlite"` に直したくなる。
- **なぜ意図的か**: vitest/vite は新しい組み込み `node:sqlite` を内蔵リストに持たず、`node:` 接頭辞を剥がして `sqlite` を解決しようとして `Failed to load url sqlite` で落ちる（`test.server.deps.external` でも解決前に失敗）。`process.getBuiltinModule` はバンドラを迂回して Node の組み込みを直接得るため、prod・test の双方で安定する。型は `import type` と `typeof import("node:sqlite")`（いずれも erase される）で保つ。素直な import に戻すと `npm test` が db 系で全滅する。
- **正本ポインタ**: 契約付録 §2（node:sqlite・engines>=22.5）。`process.getBuiltinModule` は Node 22.3+。

## `src/workflows/quality-gate.ts` — `untranslatedHeadings` は全大文字語を見逃し・偽陽性は訳注に留める

- **おかしく見える点**: 未訳見出しの判定が `/[a-z]/`（小文字 Latin の有無）なので、`\section{INTRODUCTION}` や `\section{RELATED WORK}` のような全大文字の実語見出しを未訳として検出しない。素直に「Latin 文字があれば未訳」に広げたくなる。また可視テキスト抽出（`visibleText`）は既知コマンドの引数しか除去せず、未知コマンドの不可視引数は残す。
- **なぜ意図的か**: 全大文字を拾うと `BLEU`/`GPU`/`WMT` 等の略語が軒並み偽陽性になる。学術見出しは略語が多く、略語の偽陽性回避を優先して「全大文字の実語見出しは意図的に見逃す」を選んだ（偽陰性 < 偽陽性の害）。可視テキスト抽出も、任意 LaTeX から不可視テキストを決定的に判別しきるのは不可能なため完全網羅は狙わない。本検査は**非ブロッキング**（結果は `heading-untranslated` 訳注に流すだけで再訳ゲートには載せない）なので、残余の偽陽性は「無害な訳注1件」に、偽陰性は「見逃し」に留まり、いずれも論文全体を失敗させない。
- **正本ポインタ**: [見出し未訳検査 ADR](../adr/20260721-heading-untranslated-nonblocking-note.md)、契約付録 §1（`NoteTrigger`）・§8（訳注生成契約 ④）。
