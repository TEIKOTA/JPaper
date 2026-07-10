// 契約付録 §8。arXiv ソース tarball を取得（UA 明示・3秒間隔・429/5xx/瞬断は指数バックオフ再試行）。
import { JpaperError, isTransient } from "../types/errors.js";

export interface ArxivDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  userAgent?: string;
  minIntervalMs?: number;
  endpoint?: string;
  retries?: number;
  state?: { lastRequestAt: number };
}

const DEFAULT_UA =
  "JPaper/0.1 (+https://github.com/TEIKOTA/JPaper; academic paper translation)";
const MIN_INTERVAL_MS = 3000;
const DEFAULT_ENDPOINT = "https://export.arxiv.org/e-print/";
const MAX_RETRIES = 3;
const globalState = { lastRequestAt: 0 };

function isTransientStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
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
  const state = deps.state ?? globalState;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(Math.min(10000, 1000 * 2 ** (attempt - 1)));
    // await 前に次スロットを予約し、並行呼び出しでも 3秒間隔を直列化する。
    const target = Math.max(now(), state.lastRequestAt + minInterval);
    state.lastRequestAt = target;
    const wait = target - now();
    if (wait > 0) await sleep(wait);
    state.lastRequestAt = Math.max(state.lastRequestAt, now()); // 発火遅延時は実時刻へ補正

    try {
      const res = await fetchImpl(`${endpoint}${id}`, {
        headers: { "User-Agent": ua },
      });
      if (res.ok) return Buffer.from(await res.arrayBuffer());
      if (isTransientStatus(res.status)) {
        lastErr = new Error(`HTTP ${res.status}`);
        continue;
      }
      throw new JpaperError(2, "input", `arXiv 取得に失敗: HTTP ${res.status}`);
    } catch (e) {
      if (e instanceof JpaperError) throw e;
      if (isTransient(e)) {
        lastErr = e;
        continue;
      }
      throw new JpaperError(
        2,
        "input",
        `arXiv 取得に失敗: ${String((e as Error)?.message ?? e)}`,
      );
    }
  }
  throw new JpaperError(
    2,
    "input",
    `arXiv 取得に失敗（リトライ上限）: ${String((lastErr as Error)?.message ?? lastErr)}`,
  );
}
