// 契約付録 §8。arXiv ソース tarball を取得（UA 明示・3秒間隔・429/5xx/瞬断は指数バックオフ再試行）。
import { JpaperError, isTransient } from "../types/errors.js";
import { DEFAULT_LIMITS, type IngestLimits } from "./limits.js";
import { isArxivId } from "./detect-input.js";
import { abortPromise, throwIfAborted } from "../runtime/cancellation.js";

export interface ArxivDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  userAgent?: string;
  minIntervalMs?: number;
  endpoint?: string;
  retries?: number;
  limits?: IngestLimits;
  state?: { lastRequestAt: number };
  maxQueueWaitMs?: number;
  signal?: AbortSignal;
}

const DEFAULT_UA =
  "JPaper/0.1 (+https://github.com/TEIKOTA/JPaper; academic paper translation)";
const MIN_INTERVAL_MS = 3000;
// 3秒間隔を守ると同時要求は直列に待つ。無言で数分待たせず、待ち時間が上限を超えるなら即座に断る。
const MAX_QUEUE_WAIT_MS = 30_000;
const DEFAULT_ENDPOINT = "https://export.arxiv.org/e-print/";
const MAX_RETRIES = 3;
// 続きが進んだ試行は再試行に数えないが、無限に続けないための上限。
const MAX_RESUMES = 20;
const globalState = { lastRequestAt: 0 };

function isTransientStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

interface Received {
  chunks: Buffer[];
  total: number;
}

function tooLarge(maxBytes: number): JpaperError {
  return new JpaperError(2, "too-large", `arXiv 応答が上限 ${maxBytes} バイトを超えています`);
}

// Content-Length は自己申告なので、実際に読んだ累積バイト数でも上限を掛ける。
// 受け取った分は途中で切れても acc に残る（続きの要求に使う）。上限は acc との合計で検査する。
async function readCapped(res: Response, maxBytes: number, acc: Received): Promise<void> {
  const declared = Number(res.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && acc.total + declared > maxBytes) throw tooLarge(maxBytes);
  const body = res.body;
  if (!body) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (acc.total + buf.byteLength > maxBytes) throw tooLarge(maxBytes);
    acc.chunks.push(buf);
    acc.total += buf.byteLength;
    return;
  }
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (acc.total + value.byteLength > maxBytes) {
      await reader.cancel();
      throw tooLarge(maxBytes);
    }
    acc.chunks.push(Buffer.from(value));
    acc.total += value.byteLength;
  }
}

// `Content-Range: bytes <start>-<end>/<size>` の start。読めなければ null。
function contentRangeStart(res: Response): number | null {
  const m = /^bytes\s+(\d+)-/i.exec(res.headers?.get?.("content-range") ?? "");
  return m ? Number(m[1]) : null;
}

export async function fetchArxivSource(
  id: string,
  deps: ArxivDeps = {},
): Promise<Buffer> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const ua = deps.userAgent ?? DEFAULT_UA;
  const minInterval = deps.minIntervalMs ?? MIN_INTERVAL_MS;
  const endpoint = deps.endpoint ?? DEFAULT_ENDPOINT;
  const retries = deps.retries ?? MAX_RETRIES;
  const limits = deps.limits ?? DEFAULT_LIMITS;
  const state = deps.state ?? globalState;
  const maxQueueWait = deps.maxQueueWaitMs ?? MAX_QUEUE_WAIT_MS;
  const signal = deps.signal;

  // 旧形式 ID は `/` を含み endpoint のパス構造の一部なので、エンコードではなく形式検査で守る。
  if (!isArxivId(id)) {
    throw new JpaperError(2, "input", `arXiv ID の形式が不正です: ${id}`);
  }

  const waitFor = async (ms: number): Promise<void> => {
    if (ms <= 0) return;
    if (signal === undefined) return sleep(ms);
    await Promise.race([sleep(ms), abortPromise(signal, "arXiv 取得の待機中")]);
  };

  const acc: Received = { chunks: [], total: 0 };
  let lastErr: unknown;
  // failures は進まなかった試行の連続数。続きが進んだ試行は 0 に戻す（resumes が上限）。
  let failures = 0;
  let resumes = 0;
  for (let attempt = 0; failures <= retries; attempt++) {
    throwIfAborted(signal, "arXiv 取得前");
    if (attempt > 0) await waitFor(Math.min(10000, 1000 * 2 ** Math.max(0, failures - 1)));
    // await 前に次スロットを予約し、並行呼び出しでも 3秒間隔を直列化する。
    const target = Math.max(now(), state.lastRequestAt + minInterval);
    const wait0 = target - now();
    if (wait0 > maxQueueWait) {
      // 予約せずに抜ける（自分のぶんで待ち行列をさらに伸ばさない）。
      throw new JpaperError(
        2,
        "busy",
        `arXiv 取得の待ち行列が長すぎます（推定 ${Math.round(wait0 / 1000)} 秒 > 上限 ${Math.round(maxQueueWait / 1000)} 秒）。時間をおいて再実行してください`,
      );
    }
    const prevReservation = state.lastRequestAt;
    state.lastRequestAt = target;
    const wait = target - now();
    if (wait > 0) {
      try {
        await waitFor(wait);
      } catch (e) {
        // 中断された分の予約は返す。返さないと、接続してすぐ切るだけで（fetch を 1 度も
        // 発生させずに）待ち行列を伸ばし、他の全リクエストを conflict で拒否させられる。
        if (state.lastRequestAt === target) state.lastRequestAt = prevReservation;
        throw e;
      }
    }
    state.lastRequestAt = Math.max(state.lastRequestAt, now()); // 発火遅延時は実時刻へ補正

    const before = acc.total;
    const noteFailure = (err: unknown): void => {
      lastErr = err;
      if (acc.total > before && resumes < MAX_RESUMES) {
        resumes++;
        failures = 0;
      } else {
        failures++;
      }
    };

    try {
      const headers: Record<string, string> = { "User-Agent": ua };
      if (acc.total > 0) headers["Range"] = `bytes=${acc.total}-`;
      const res = await fetchImpl(`${endpoint}${id}`, { headers, signal });
      if (res.ok) {
        // 続きを求めたときは、開始位置が受け取った長さと一致する 206 だけを足す。
        // それ以外（200・不一致）は受け取った分を捨てて初めから取る。
        const partial = res.status === 206;
        if (acc.total > 0 && !(partial && contentRangeStart(res) === acc.total)) {
          acc.chunks = [];
          acc.total = 0;
          if (partial) {
            await res.body?.cancel();
            noteFailure(new Error("HTTP 206 の Content-Range が不一致"));
            continue;
          }
        } else if (acc.total === 0 && partial) {
          await res.body?.cancel();
          noteFailure(new Error("要求していない HTTP 206"));
          continue;
        }
        await readCapped(res, limits.maxArchiveBytes, acc);
        return Buffer.concat(acc.chunks);
      }
      if (isTransientStatus(res.status)) {
        noteFailure(new Error(`HTTP ${res.status}`));
        continue;
      }
      // 404 等は入力（存在しない ID）、それ以外の 4xx/5xx は上流側の問題。
      const kind = res.status === 404 ? "input" : "upstream";
      throw new JpaperError(2, kind, `arXiv 取得に失敗: HTTP ${res.status}`);
    } catch (e) {
      if (e instanceof JpaperError) throw e;
      throwIfAborted(signal, "arXiv 取得中");
      if (isTransient(e)) {
        noteFailure(e);
        continue;
      }
      // ネットワーク到達不能は利用者の入力ミスではない。監視で 5xx として見えるようにする。
      throw new JpaperError(
        2,
        "upstream",
        `arXiv 取得に失敗: ${String((e as Error)?.message ?? e)}`,
      );
    }
  }
  throw new JpaperError(
    2,
    "upstream",
    `arXiv 取得に失敗（リトライ上限）: ${String((lastErr as Error)?.message ?? lastErr)}`,
  );
}
