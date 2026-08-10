// 終了コードとエラー分類（契約付録 §6・§8）。

export type FailureCode = 2 | 3 | 4 | 5;

// 失敗の分類。exitCode（§6）より細かく、呼び出し側が応答を出し分けるための軸。
// input=入力が不正 / conflict=出力先が使用中 / too-large=サイズ上限超過 /
// provider=LLM プロバイダ利用不能 / formal=形式検査不通過 / quality=品質未達 /
// typeset=全文組版失敗 / internal=想定外。
export type ErrorKind =
  | "input"
  | "conflict"
  | "too-large"
  | "provider"
  | "formal"
  | "quality"
  | "typeset"
  | "internal";

export class JpaperError extends Error {
  constructor(
    public readonly code: FailureCode | 1,
    public readonly kind: ErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "JpaperError";
  }
}

// 失敗を戻り値へ載せる形（契約付録 §8）。例外は境界の外へ出さない。
export interface RunError {
  kind: ErrorKind;
  code: number;
  message: string;
  detail?: string;
}

// 想定外の例外も分類済みの形に落とす。原因の型名は detail に残す（web のログ用）。
export function toRunError(e: unknown): RunError {
  if (e instanceof JpaperError) {
    return { kind: e.kind, code: e.code, message: e.message };
  }
  const err = e as Error | undefined;
  return {
    kind: "internal",
    code: 1,
    message: String(err?.message ?? e),
    detail: err?.stack ?? err?.name ?? typeof e,
  };
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
    transient?: unknown;
  };

  if (err.transient === true) return true;

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
