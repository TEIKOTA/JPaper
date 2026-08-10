// 終了コードとエラー分類（契約付録 §6・§8）。

export type FailureCode = 2 | 3 | 4 | 5 | 6;

// 失敗の分類。exitCode（§6）より細かく、呼び出し側が応答を出し分けるための軸。
// input=入力が不正 / conflict=出力先が使用中 / too-large=サイズ上限超過 /
// provider=LLM プロバイダ利用不能 / formal=形式検査不通過 / quality=品質未達 /
// typeset=全文組版失敗 / canceled=呼び出し側の中断 / busy=一時的な過負荷（後で再試行可）/
// upstream=外部サービス側の障害 / infra=実行環境の障害（権限・容量・パス）/ internal=想定外。
export type ErrorKind =
  | "input"
  | "conflict"
  | "too-large"
  | "provider"
  | "formal"
  | "quality"
  | "typeset"
  | "canceled"
  | "busy"
  | "upstream"
  | "infra"
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

// 実行環境の障害（権限・容量・パス衝突）。コードのバグと区別できないと運用で切り分けられない。
const INFRA_SYSCODES = new Set([
  "ENOENT",
  "EEXIST",
  "EBUSY",
  "ENOTEMPTY",
  "EACCES",
  "EPERM",
  "ENOTDIR",
  "EISDIR",
  "ENOSPC",
  "EROFS",
  "EMFILE",
  "ENFILE",
  "EDQUOT",
  "ENAMETOOLONG",
  "ELOOP",
  "EXDEV",
]);

// 外部サービス側の障害。JPaper のバグ（internal）でも実行環境の障害（infra）でもない。
const NETWORK_SYSCODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
]);

// ライブラリは fs エラーを cause で包むことがある。isTransient と同じ深さまで辿る。
function syscodeOf(e: unknown, depth = 3): string {
  const err = e as (NodeJS.ErrnoException & { cause?: unknown }) | undefined;
  const code = err?.code;
  if (typeof code === "string") return code;
  if (depth > 0 && err?.cause !== undefined) return syscodeOf(err.cause, depth - 1);
  return "";
}

export function isInfraError(e: unknown): boolean {
  return INFRA_SYSCODES.has(syscodeOf(e));
}

// 外向きメッセージから制御文字を落とす。論文由来の文字列や外部プロセスの出力が
// そのまま端末・HTTP 応答へ流れるため（表示の偽装を防ぐ）。長さも抑える。
const MAX_MESSAGE_CHARS = 500;
// 双方向制御・行区切り・ゼロ幅も落とす。表示順を反転させて偽の成功文言を見せられるため。
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g;

// ホストの絶対パスは運用者にしか意味がなく、外へ出すと配置が漏れる。detail 側にだけ残す。
const ABSOLUTE_PATH = /(?:[A-Za-z]:)?(?:~|\/)[^\s'"`,;)\]]*\/[^\s'"`,;)\]]*/g;
export function redactPaths(s: string): string {
  return s.replace(ABSOLUTE_PATH, "<path>");
}

export function safeMessage(s: string): string {
  const flat = s.replace(UNSAFE_CHARS, " ").replace(/\s+/g, " ").trim();
  return flat.length > MAX_MESSAGE_CHARS ? `${flat.slice(0, MAX_MESSAGE_CHARS)}…` : flat;
}

// 外向きに出す文字列の唯一の出口。制御文字を落とし、絶対パスを伏せ、長さを切る。
export function outwardMessage(s: string): string {
  return safeMessage(redactPaths(s));
}

// 想定外の例外も分類済みの形に落とす。原因の型名は detail に残す（web のログ用）。
export function toRunError(e: unknown): RunError {
  if (e instanceof JpaperError) {
    const message = outwardMessage(e.message);
    // 伏せた情報はサーバ側ログでは要る（どの出力先が衝突したのか等）。
    const detail = message === safeMessage(e.message) ? undefined : safeMessage(e.message);
    return { kind: e.kind, code: e.code, message, detail };
  }
  const err = e as Error | undefined;
  if (NETWORK_SYSCODES.has(syscodeOf(e))) {
    return {
      kind: "upstream",
      code: 2,
      message: `外部サービスに到達できません（${syscodeOf(e)}）`,
      detail: err?.stack ?? String(err?.message ?? e),
    };
  }
  if (isInfraError(e)) {
    // 生の errno と絶対パスは detail（サーバ側ログ用）に留め、message には出さない。
    return {
      kind: "infra",
      code: 1,
      message: `実行環境の障害です（${syscodeOf(e)}）。出力先・DB の権限と空き容量を確認してください`,
      detail: err?.stack ?? String(err?.message ?? e),
    };
  }
  // internal は JPaper のバグ。生の例外文には絶対パスが混ざるので伏せてから出す。
  return {
    kind: "internal",
    code: 1,
    message: outwardMessage(String(err?.message ?? e)),
    detail: err?.stack ?? err?.name ?? typeof e,
  };
}

// 優先順位は契約付録 §8。
export function resolveExitCode(codes: readonly number[]): number {
  const priority = [6, 2, 3, 4, 5, 1]; // 中断は他の失敗より優先して報告する
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
