// 終了コードとエラー分類（契約付録 §6・§8）。

export type FailureCode = 2 | 3 | 4 | 5;

export class JpaperError extends Error {
  constructor(
    public readonly code: FailureCode | 1,
    public readonly kind: string,
    message: string,
  ) {
    super(message);
    this.name = "JpaperError";
  }
}

// 優先順位は契約付録 §8。
export function resolveExitCode(codes: readonly number[]): number {
  const priority = [2, 3, 4, 5, 1];
  for (const p of priority) {
    if (codes.includes(p)) return p;
  }
  return 0;
}

// 分類は契約付録 §8。
const TRANSIENT_SYSCODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "EPIPE",
]);

export function isTransient(e: unknown, depth = 3): boolean {
  if (e == null || depth < 0) return false;
  const err = e as {
    code?: unknown;
    status?: unknown;
    statusCode?: unknown;
    message?: unknown;
    cause?: unknown;
  };

  const sysCode = typeof err.code === "string" ? err.code : "";
  if (TRANSIENT_SYSCODES.has(sysCode)) return true;

  const status = Number(err.status ?? err.statusCode ?? NaN);
  if (status === 429 || (status >= 500 && status <= 599)) return true;

  const msg = String(err.message ?? err).toLowerCase();
  if (
    /(^|[^0-9])429([^0-9]|$)|timeout|timed out|socket hang up|econnreset|econnrefused|etimedout|eai_again|temporarily|rate limit/.test(
      msg,
    )
  ) {
    return true;
  }

  if (err.cause != null && err.cause !== e) return isTransient(err.cause, depth - 1);
  return false;
}
