// 契約付録 §9（Web アプリ）。arXiv API（Atom）の検索。要求は 1 本ずつ、前の要求から 3 秒空けて送る。
import { isArxivId } from "../../../src/ingest/detect-input.js";

export const ARXIV_API = "https://export.arxiv.org/api/query";
export const ARXIV_INTERVAL_MS = 3000;
export const ARXIV_TIMEOUT_MS = 20_000;
export const ARXIV_MAX_RESULTS = 20;
const CACHE_MS = 10 * 60_000;
const CACHE_MAX = 50;
const MAX_TERMS = 8;

export interface ArxivEntry {
  // 版を除いた ID（例 2401.12345、hep-th/9901001）。
  id: string;
  version?: string;
  title: string;
  summary: string;
  authors: string[];
  published: string;
}

export interface ArxivSearchResult {
  total?: number;
  entries: ArxivEntry[];
}

export class ArxivError extends Error {}
export class ArxivQueryError extends Error {}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos);/gi, (m, e: string) => {
      const lower = e.toLowerCase();
      if (lower.startsWith("#x")) return safeCodePoint(parseInt(lower.slice(2), 16), m);
      if (lower.startsWith("#")) return safeCodePoint(parseInt(lower.slice(1), 10), m);
      return ENTITIES[lower] ?? m;
    });
}

function safeCodePoint(n: number, fallback: string): string {
  try {
    return String.fromCodePoint(n);
  } catch {
    return fallback;
  }
}

function clean(s: string): string {
  return decode(s).replace(/\s+/g, " ").trim();
}

function tag(xml: string, name: string): string | undefined {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(xml);
  return m?.[1];
}

function tags(xml: string, name: string): string[] {
  return [...xml.matchAll(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "g"))].map((m) => m[1] ?? "");
}

// Atom の feed から entry の id・title・summary・authors・published を取り出す。
// arXiv が誤りを返したとき（id が /api/errors）は ArxivError を投げる。
export function parseArxivAtom(xml: string): ArxivSearchResult {
  const totalRaw = tag(xml, "opensearch:totalResults");
  const total = totalRaw === undefined ? undefined : Number(clean(totalRaw));
  const entries: ArxivEntry[] = [];
  for (const body of tags(xml, "entry")) {
    const idUrl = clean(tag(body, "id") ?? "");
    if (idUrl.includes("/api/errors")) {
      throw new ArxivError(`arXiv が誤りを返しました: ${clean(tag(body, "summary") ?? idUrl)}`);
    }
    const m = /\/abs\/(.+?)(v\d+)?$/.exec(idUrl);
    if (!m || !isArxivId(m[1]!)) continue;
    entries.push({
      id: m[1]!,
      ...(m[2] === undefined ? {} : { version: m[2] }),
      title: clean(tag(body, "title") ?? ""),
      summary: clean(tag(body, "summary") ?? ""),
      authors: tags(body, "author")
        .map((a) => clean(tag(a, "name") ?? ""))
        .filter((a) => a !== ""),
      published: clean(tag(body, "published") ?? ""),
    });
  }
  return { ...(total === undefined || !Number.isFinite(total) ? {} : { total }), entries };
}

// 検索語を API の問い合わせにする。arXiv ID なら id_list、それ以外は語ごとの all: の AND。
export function arxivQuery(q: string, maxResults = ARXIV_MAX_RESULTS): URLSearchParams {
  const s = q.trim().replace(/^arxiv:/i, "");
  if (isArxivId(s)) return new URLSearchParams({ id_list: s, max_results: String(maxResults) });
  const terms = s
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}.\-]/gu, ""))
    .filter((t) => t !== "" && !/^(AND|OR|ANDNOT)$/.test(t))
    .slice(0, MAX_TERMS);
  if (terms.length === 0) throw new ArxivQueryError("検索語を入力してください");
  return new URLSearchParams({
    search_query: terms.map((t) => `all:${t}`).join(" AND "),
    start: "0",
    max_results: String(maxResults),
    sortBy: "relevance",
  });
}

export interface ArxivClientDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  intervalMs?: number;
  timeoutMs?: number;
  baseUrl?: string;
}

export class ArxivClient {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly intervalMs: number;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;
  private chain: Promise<unknown> = Promise.resolve();
  private lastAt = Number.NEGATIVE_INFINITY;
  private readonly cache = new Map<string, { at: number; result: ArxivSearchResult }>();

  constructor(deps: ArxivClientDeps = {}) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.intervalMs = deps.intervalMs ?? ARXIV_INTERVAL_MS;
    this.timeoutMs = deps.timeoutMs ?? ARXIV_TIMEOUT_MS;
    this.baseUrl = deps.baseUrl ?? ARXIV_API;
  }

  search(q: string): Promise<ArxivSearchResult> {
    const key = arxivQuery(q).toString();
    const hit = this.cache.get(key);
    if (hit !== undefined && this.now() - hit.at < CACHE_MS) return Promise.resolve(hit.result);
    const task = this.chain.then(() => this.request(key));
    this.chain = task.catch(() => undefined);
    return task;
  }

  private async request(key: string): Promise<ArxivSearchResult> {
    const wait = this.lastAt + this.intervalMs - this.now();
    if (wait > 0) await this.sleep(wait);
    this.lastAt = this.now();
    let status: number;
    let body = "";
    try {
      const res = await this.fetchImpl(`${this.baseUrl}?${key}`, { signal: AbortSignal.timeout(this.timeoutMs) });
      status = res.status;
      if (res.ok) body = await res.text();
    } catch (e) {
      const name = (e as { name?: string } | null)?.name;
      if (name === "TimeoutError" || name === "AbortError") {
        throw new ArxivError(`arXiv が ${String(Math.round(this.timeoutMs / 1000))} 秒以内に応答しませんでした`);
      }
      throw new ArxivError(`arXiv に接続できませんでした: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (status < 200 || status >= 300) throw new ArxivError(`arXiv が HTTP ${String(status)} を返しました`);
    const result = parseArxivAtom(body);
    this.cache.set(key, { at: this.now(), result });
    if (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value!);
    return result;
  }
}
