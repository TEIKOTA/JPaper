// 終了コードとエラー分類（契約付録 §6・§8）。
// 例外は core 境界で握って Result（status/exitCode）へ変換する。

// 失敗を表す終了コード。0=成功 / 1=想定外 は別扱い。
export type FailureCode = 2 | 3 | 4 | 5;

export class JpaperError extends Error {
  constructor(
    public readonly code: FailureCode | 1,
    public readonly kind: string, // 例: "input" | "provider" | "formal" | "quality"
    message: string,
  ) {
    super(message);
    this.name = "JpaperError";
  }
}

// 単一終了コード決定規則（1 run で複数原因が混在時・§8）:
// 2（入力/プロバイダ）> 3（形式失敗）> 4（品質失敗）> 5（全文ゲート=(B)）、
// 次いで 1（想定外）。いずれも無ければ 0（成功）。
export function resolveExitCode(codes: readonly number[]): number {
  const priority = [2, 3, 4, 5, 1];
  for (const p of priority) {
    if (codes.includes(p)) return p;
  }
  return 0;
}

// リトライしてよい一時的インフラ障害か（§8）:
// ネットワーク瞬断・タイムアウト・HTTP 429/5xx・Ollama 一時的接続不可。
// タスク自体の失敗（ビルド失敗・欠図・品質未達）は含めない。
const TRANSIENT_SYSCODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "EPIPE",
]);

export function isTransient(e: unknown): boolean {
  if (e == null) return false;
  const err = e as {
    code?: unknown;
    status?: unknown;
    statusCode?: unknown;
    message?: unknown;
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

  return false;
}
