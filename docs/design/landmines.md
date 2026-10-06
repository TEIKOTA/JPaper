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

## `src/runtime/trace.ts` — `makeJsonlTrace` の空 catch（I/O エラーを握り潰す）

- **おかしく見える点**: append/mkdir を囲む `catch {}` が空でエラーを完全に無視する。ログも再送も無く、素直に「握り潰しはバグ」と直したくなる。
- **なぜ意図的か**: これはコスト観測用の**副作用チャネル**であり、翻訳本体の成否とは独立。トレース書き込みが失敗（書込不可 CWD・パス衝突・容量不足）しても run の主成果物（PDF）を落としてはならない。throw を伝播させると `complete` の純変換器契約を壊し、観測の都合で翻訳が失敗するという本末転倒になる。ゆえにベストエフォートで黙って捨てる。mkdir を初回 emit まで遅延するのも、構築時 throw が `translatePaper` の try/catch を素通りして終了コードを誤分類するのを防ぐため。
- **正本ポインタ**: [LLM トレース ADR](../adr/20260722-llm-call-trace-local-jsonl.md)、契約付録 §8（トレースは副作用チャネル・`complete` 契約は不変）。

## `src/workflows/translate-paper.ts` — `translateTitle` の catch が中断以外の例外を握り潰す

- **おかしく見える点**: タイトルの節ループが投げた例外（プロバイダ障害・呼び出し上限など）を、`signal` が中断済みのとき以外は警告だけ出して捨て、run を続ける。本文セグメントの例外は run を落とすのに、ここだけ扱いが違う。
- **なぜ意図的か**: タイトルだけの失敗は原題のまま組版して run を落とさない契約（タイトルは成果物の一部ではあるが、訳せなくても論文本体の和訳は成立する）。プロバイダ障害が本物なら同じ例外が本文セグメントから出て run は従来どおり落ちるので、ここで捨てても失敗は隠れない。中断だけは run 全体の取り消しなので rethrow する（捨てると `exitCode 6` にならず組版まで進む）。素直に rethrow すると、タイトル 1 行の失敗で論文全体が exit 2 になる。
- **正本ポインタ**: 契約付録 §8（論文タイトルの翻訳「失敗の扱い」）、issue #294。

## `src/providers/claude.ts` — `--max-turns` が 1 でなく 3

- **おかしく見える点**: `--tools none` で 1 回しか答えさせないはずなのに、`--max-turns` が `1` ではなく `3`。「1 回きり」なら 1 に締めたくなる。
- **なぜ意図的か**: claude CLI 2.1.291 は、用語集構築のような長い入力で内部的に 2 ターンを使う（実測: `num_turns: 2`）。`--max-turns 1` だと `subtype: error_max_turns`（「Reached maximum number of turns (1)」）で exit 1 になり、応答が正常でも run が `claude exited 1` で失敗する。`--tools none` でツールは使えないので、ターン上限は安全境界ではない（安全は `--tools none` が担う）。1 に戻すと該当呼び出しが全て落ちる。
- **正本ポインタ**: [LLM プロバイダ抽象化 ADR](../adr/20260709-llm-provider-abstraction-local-ollama-and-cloud-cli.md)。回帰テストは `src/providers/claude.test.ts`。

## `src/providers/claude.ts` — プロンプト本文を `-p` の引数でなく stdin で渡し、stdin のエラーを捨てる

- **おかしく見える点**: `claude -p` は位置引数でプロンプトを受け取れるのに、本文（`req.user`）を stdin へ書いている。さらに `child.stdin` の `error` を空のハンドラで捨てている。
- **なぜ意図的か**: 本文を引数で渡すと、論文によっては引数長の上限を超えて起動できない（実測: PATH 上の `claude` が cmux のシムで `cmux: argument too large (maximum 122880 bytes)` → exit 2、UNI 2308.15474 の用語集構築）。stdin なら上限は無い（80KB で確認）。stdin へ書く以上、子プロセスが本文を読まずに終了すると書き込みが `EPIPE` になり、`error` を聞いていないと未処理例外で JPaper のプロセスごと落ちる（実測: 読まずに `exit 3` する子へ 5MB を書くと Node が `write EPIPE` で終了）。失敗は `close` の終了コードで provider エラーとして返るので、stdin 側のエラーは捨ててよい。ハンドラを外すと、claude が起動直後に失敗しただけで run 全体がクラッシュする。
- **正本ポインタ**: 契約付録 §5（claude CLI の呼び出し）。回帰テストは `src/providers/claude.test.ts`（既定の run の節）。
