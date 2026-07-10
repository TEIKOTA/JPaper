// 契約付録 §8。一時エラーのみのリトライ（3回・初期1s×2・上限10s）。
import { isTransient } from "../types/errors.js";

export interface RetryOptions {
  retries?: number;
  baseMs?: number;
  capMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const retries = opts.retries ?? 3;
  const base = opts.baseMs ?? 1000;
  const cap = opts.capMs ?? 10000;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt === retries || !isTransient(e)) throw e;
      await sleep(Math.min(cap, base * 2 ** attempt));
    }
  }
  throw lastErr;
}
