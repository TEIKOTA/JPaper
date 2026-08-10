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
      // 起床後に必ず再検査する。release の running-- と待機者の再開（microtask）の間に
      // 新規呼び出しが枠を横取りすると、再検査しなければ待機者が上乗せして上限を破る。
      while (running >= max) await new Promise<void>((r) => queue.push(r));
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

export function withGate(client: LlmClient, gate: Gate): LlmClient {
  return { complete: (req) => gate.run(() => client.complete(req)) };
}
