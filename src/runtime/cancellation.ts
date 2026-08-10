// 契約付録 §8。中断（AbortSignal）を run 全体へ伝えるための最小の道具立て。
import type { LlmClient } from "../types/contract.js";
import { JpaperError } from "../types/errors.js";

// 期限超過の目印。abort の reason に載せて、切断（499）と期限超過（504）を区別する。
interface DeadlineReason {
  jpaperDeadlineMs: number;
}
function deadlineMsOf(signal?: AbortSignal): number | undefined {
  const r = signal?.reason as DeadlineReason | undefined;
  return typeof r?.jpaperDeadlineMs === "number" ? r.jpaperDeadlineMs : undefined;
}

// 中断は終了コード 6。retry の対象にしない（transient を付けない）。
// 期限超過だけ kind を分ける。web が 504 と 499 を出し分けられないと、過負荷で
// テナントが飢えた結果の期限超過が「利用者が切った」と同じに見えてしまう。
export function canceledError(where: string, signal?: AbortSignal): JpaperError {
  const ms = deadlineMsOf(signal);
  if (ms !== undefined) {
    return new JpaperError(6, "timeout", `実行が期限 ${ms}ms を超えました（${where}）`);
  }
  return new JpaperError(6, "canceled", `実行が中断されました（${where}）`);
}

export function throwIfAborted(signal: AbortSignal | undefined, where: string): void {
  if (signal?.aborted === true) throw canceledError(where, signal);
}

// abort を待つ Promise。fetch のように signal を直接扱えない待ち（sleep 等）と race させる。
export function abortPromise(signal: AbortSignal, where: string): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(canceledError(where, signal));
      return;
    }
    signal.addEventListener("abort", () => reject(canceledError(where, signal)), { once: true });
  });
}

// 中断されたら、下位の promise が決着しなくても抜ける。
// 注入クライアント（契約は signal の尊重を強制できない）が中断を無視した場合、
// await し続けると同時実行ゲートの枠が永久に返らず、プロセス全体の枠が枯れる。
// 漏れた呼び出し自体は止められないので、枠だけ返して未処理 rejection を握り潰す。
export function raceAbort<T>(p: Promise<T>, signal: AbortSignal, where: string): Promise<T> {
  if (signal.aborted) {
    void p.catch(() => undefined);
    return Promise.reject(canceledError(where, signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      void p.catch(() => undefined);
      reject(canceledError(where, signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    // listener を必ず外す（run が長い間、呼び出しごとに溜まると leak になる）。
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

// 全ての LLM 呼び出しに signal を載せる薄いラッパ。
// エージェント側の関数シグネチャを増やさずに、run 単位の中断を境界 1 箇所で効かせる。
export function withSignal(client: LlmClient, signal: AbortSignal | undefined): LlmClient {
  if (signal === undefined) return client;
  return {
    async complete(req) {
      throwIfAborted(signal, "LLM 呼び出し");
      return raceAbort(client.complete({ ...req, signal }), signal, "LLM 呼び出し");
    },
  };
}

export interface Deadline {
  signal: AbortSignal | undefined;
  dispose: () => void;
}

// run 全体の期限。呼び出し側の signal と OR で合流させる。
// web ハンドラごとに setTimeout を書かせないため、run 層で 1 度だけ用意する。
// setTimeout は 2^31-1 を超えると 1ms に丸められる（＝指定した瞬間に abort される）。
const MAX_TIMEOUT_MS = 2_147_483_647;

export function withDeadline(signal: AbortSignal | undefined, timeoutMs?: number): Deadline {
  if (timeoutMs === undefined) return { signal, dispose: () => undefined };
  // 不正値を黙って「期限なし」にしない。文字列や NaN が素通りすると、期限を設定した
  // つもりの run が無期限になり、同時実行の枠を握ったまま他テナントを止める。
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs < 1) {
    throw new JpaperError(2, "input", `timeoutMs が不正です: ${String(timeoutMs)}`);
  }
  const ms = Math.min(MAX_TIMEOUT_MS, Math.floor(timeoutMs));
  const ctl = new AbortController();
  // unref しない。ref された handle が無い実行形（キュー worker 等）で期限が黙って
  // 無効になるため。dispose で必ず clearTimeout するので run の寿命は伸びない。
  const timer = setTimeout(() => ctl.abort({ jpaperDeadlineMs: ms } as DeadlineReason), ms);
  const onParent = (): void => ctl.abort(signal?.reason);
  signal?.addEventListener("abort", onParent, { once: true });
  return {
    signal: ctl.signal,
    dispose: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onParent);
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
