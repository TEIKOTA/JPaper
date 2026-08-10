// 契約付録 §8。中断（AbortSignal）を run 全体へ伝えるための最小の道具立て。
import type { LlmClient } from "../types/contract.js";
import { JpaperError } from "../types/errors.js";

// 中断は終了コード 6。retry の対象にしない（transient を付けない）。
export function canceledError(where: string): JpaperError {
  return new JpaperError(6, "canceled", `実行が中断されました（${where}）`);
}

export function throwIfAborted(signal: AbortSignal | undefined, where: string): void {
  if (signal?.aborted === true) throw canceledError(where);
}

// abort を待つ Promise。fetch のように signal を直接扱えない待ち（sleep 等）と race させる。
export function abortPromise(signal: AbortSignal, where: string): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(canceledError(where));
      return;
    }
    signal.addEventListener("abort", () => reject(canceledError(where)), { once: true });
  });
}

// 全ての LLM 呼び出しに signal を載せる薄いラッパ。
// エージェント側の関数シグネチャを増やさずに、run 単位の中断を境界 1 箇所で効かせる。
export function withSignal(client: LlmClient, signal: AbortSignal | undefined): LlmClient {
  if (signal === undefined) return client;
  return {
    async complete(req) {
      throwIfAborted(signal, "LLM 呼び出し");
      return client.complete({ ...req, signal });
    },
  };
}

// 注入クライアント（web のテナント別資格情報など）が投げた素の例外を provider ドメインへ写す。
// internal（＝JPaper のバグ）に落とすと、401 やクォータ超過が 500 として出てしまう。
export function withProviderErrors(client: LlmClient): LlmClient {
  return {
    async complete(req) {
      try {
        return await client.complete(req);
      } catch (e) {
        if (e instanceof JpaperError) throw e;
        const err = new JpaperError(
          2,
          "provider",
          `LLM クライアントが失敗しました: ${String((e as Error)?.message ?? e)}`,
        );
        // 呼び出し側が transient を主張していれば尊重する（リトライ判定を壊さない）。
        if ((e as { transient?: unknown }).transient === true) Object.assign(err, { transient: true });
        return Promise.reject(err);
      }
    },
  };
}
