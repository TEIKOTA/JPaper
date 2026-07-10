// 契約付録 §8。arXiv ソース tarball を取得（User-Agent 明示・3秒以上間隔）。
import { JpaperError } from "../types/errors.js";

export interface ArxivDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  userAgent?: string;
  minIntervalMs?: number;
  endpoint?: string;
  state?: { lastRequestAt: number };
}

const DEFAULT_UA =
  "JPaper/0.1 (+https://github.com/TEIKOTA/JPaper; academic paper translation)";
const MIN_INTERVAL_MS = 3000;
const DEFAULT_ENDPOINT = "https://export.arxiv.org/e-print/";
const globalState = { lastRequestAt: 0 };

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
  const state = deps.state ?? globalState;

  const wait = state.lastRequestAt + minInterval - now();
  if (wait > 0) await sleep(wait);
  state.lastRequestAt = now();

  let res: Response;
  try {
    res = await fetchImpl(`${endpoint}${id}`, { headers: { "User-Agent": ua } });
  } catch (e) {
    throw new JpaperError(
      2,
      "input",
      `arXiv 取得に失敗: ${String((e as Error)?.message ?? e)}`,
    );
  }
  if (!res.ok) {
    throw new JpaperError(2, "input", `arXiv 取得に失敗: HTTP ${res.status}`);
  }
  return Buffer.from(await res.arrayBuffer());
}
