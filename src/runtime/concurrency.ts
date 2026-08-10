// 契約付録 §8。LLM 呼び出しのプロセス全体の同時実行上限。
// run 単位の上限（TranslateOptions.concurrency）だけでは、1 プロセスで複数リクエストを
// 捌く web ハンドラで上限が掛からない（リクエスト数 × セグメント並列だけ子プロセスが増える）。
import type { LlmClient } from "../types/contract.js";
import { canceledError, throwIfAborted } from "./cancellation.js";
import { JpaperError } from "../types/errors.js";

export interface Gate {
  run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T>;
  readonly limit: number;
  active(): number;
  waiting(): number;
}

interface Waiter {
  wake: () => void;
  canceled: boolean;
}

// 待ち行列の上限。無制限だと過負荷を busy（429）へ変換できず、返らないリクエストだけが
// 積み上がる（実測: makeGate(1) に 10 万件積めた）。arXiv 側の maxQueueWaitMs と同じ考え方。
export const DEFAULT_MAX_LLM_QUEUE = 256;
export const MAX_LLM_QUEUE_CAP = 4_096;

export function resolveMaxLlmQueue(env = process.env): number {
  const raw = env.JPAPER_MAX_LLM_QUEUE?.trim();
  if (raw === undefined || !/^\d+$/.test(raw)) return DEFAULT_MAX_LLM_QUEUE;
  return Math.min(MAX_LLM_QUEUE_CAP, Math.max(1, Number(raw)));
}

export function makeGate(limit: number, maxQueue = resolveMaxLlmQueue()): Gate {
  const max = Math.max(1, Math.floor(limit));
  const queueCap = Math.min(MAX_LLM_QUEUE_CAP, Math.max(1, Math.floor(maxQueue)));
  const queue: Waiter[] = [];
  let running = 0;
  // 中断済みの待機者は起こしても枠を使わないので、生きている先頭が出るまで捨てる。
  const wakeNext = (): void => {
    for (let w = queue.shift(); w !== undefined; w = queue.shift()) {
      if (!w.canceled) {
        w.wake();
        return;
      }
    }
  };
  const release = (): void => {
    running--;
    wakeNext();
  };
  return {
    limit: max,
    active: () => running,
    waiting: () => queue.filter((w) => !w.canceled).length,
    async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      // 起床後に必ず再検査する。release の running-- と待機者の再開（microtask）の間に
      // 新規呼び出しが枠を横取りすると、再検査しなければ待機者が上乗せして上限を破る。
      while (running >= max) {
        throwIfAborted(signal, "LLM 同時実行の待機");
        if (queue.length >= queueCap) {
          throw new JpaperError(
            2,
            "busy",
            `LLM 呼び出しの待ち行列が上限 ${queueCap} に達しています。時間をおいて再試行してください`,
          );
        }
        await new Promise<void>((resolve, reject) => {
          const waiter: Waiter = { wake: () => { cleanup(); resolve(); }, canceled: false };
          // 待機中も中断が効く。効かないと、枠を握った run が期限を持たない場合に
          // 期限を持つ他テナントの run まで返らなくなる。
          const onAbort = (): void => {
            waiter.canceled = true;
            cleanup();
            reject(canceledError("LLM 同時実行の待機"));
            // 自分の順番が回ってきていたぶんを次へ譲る。
            if (running < max) wakeNext();
          };
          const cleanup = (): void => signal?.removeEventListener("abort", onAbort);
          signal?.addEventListener("abort", onAbort, { once: true });
          queue.push(waiter);
        });
      }
      running++;
      try {
        return await fn();
      } finally {
        release();
      }
    },
  };
}

export const DEFAULT_MAX_LLM_CONCURRENCY = 8;
// 上限の上限。"1e9" のような値で事実上無制限にさせない。
export const MAX_LLM_CONCURRENCY_CAP = 64;

// 10 進整数だけを受け付ける（"1e9" / "0x10" は不正）。範囲外は既定ではなく端へ丸める。
// 既定へ黙って戻すと、絞ろうとした設定ミスが緩める方向に倒れるため。
export function resolveMaxLlmConcurrency(env = process.env): number {
  const raw = env.JPAPER_MAX_LLM_CONCURRENCY?.trim();
  if (raw === undefined || !/^\d+$/.test(raw)) return DEFAULT_MAX_LLM_CONCURRENCY;
  return Math.min(MAX_LLM_CONCURRENCY_CAP, Math.max(1, Number(raw)));
}

// プロセス全体で 1 つ。リクエストをまたいで効かせるため module スコープに置く。
let processGate: Gate | undefined;
export function llmGate(): Gate {
  processGate ??= makeGate(resolveMaxLlmConcurrency());
  return processGate;
}

// テスト用。上限を差し替えて検査できるようにする。
export function setLlmGate(gate: Gate | undefined): void {
  processGate = gate;
}

export function withGate(client: LlmClient, gate: Gate, signal?: AbortSignal): LlmClient {
  return { complete: (req) => gate.run(() => client.complete(req), signal) };
}
