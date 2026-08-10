// 契約付録 §8。LLM 呼び出しのプロセス全体の同時実行上限。
// run 単位の上限（TranslateOptions.concurrency）だけでは、1 プロセスで複数リクエストを
// 捌く web ハンドラで上限が掛からない（リクエスト数 × セグメント並列だけ子プロセスが増える）。
import type { LlmClient } from "../types/contract.js";

export interface Gate {
  run<T>(fn: () => Promise<T>): Promise<T>;
  readonly limit: number;
  active(): number;
  waiting(): number;
}

export function makeGate(limit: number): Gate {
  const max = Math.max(1, Math.floor(limit));
  const queue: (() => void)[] = [];
  let running = 0;
  const release = (): void => {
    running--;
    queue.shift()?.();
  };
  return {
    limit: max,
    active: () => running,
    waiting: () => queue.length,
    async run<T>(fn: () => Promise<T>): Promise<T> {
      if (running >= max) await new Promise<void>((r) => queue.push(r));
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

export function resolveMaxLlmConcurrency(env = process.env): number {
  const raw = Number(env.JPAPER_MAX_LLM_CONCURRENCY);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : DEFAULT_MAX_LLM_CONCURRENCY;
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

export function withGate(client: LlmClient, gate: Gate): LlmClient {
  return { complete: (req) => gate.run(() => client.complete(req)) };
}
