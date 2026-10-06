// 設定・パス解決（契約付録 §2・§4・§8）。
import os from "node:os";
import path from "node:path";
import type { Provider } from "./types/contract.js";

type ProviderName = Provider;

export function resolveJpaperHome(): string {
  const env = process.env.JPAPER_HOME;
  if (env && env.trim() !== "") return env;
  return path.join(os.homedir(), ".jpaper");
}

export function dbPath(): string {
  return path.join(resolveJpaperHome(), "glossary.db");
}

export function paperOutDir(paperId: string, outOpt?: string): string {
  if (outOpt && outOpt.trim() !== "") return path.resolve(outOpt);
  return path.resolve(`${paperId}-ja`);
}

export const DEFAULT_CLAUDE_CW = 200_000; // 契約付録 §4

// 契約付録 §5。OpenRouter（OpenAI 互換）。同一モデルを Ollama とどちらでも回せる
// 組み合わせを既定に置く。ADR 20260815-openrouter-for-fast-iteration。
export interface OpenRouterConfig {
  model: string;
  contextWindow: number;
  baseUrl: string;
  requestTimeoutMs?: number;
}

export const DEFAULT_OPENROUTER: OpenRouterConfig = {
  model: "google/gemma-4-26b-a4b-it:free",
  contextWindow: 262_144,
  baseUrl: "https://openrouter.ai/api/v1",
};

export interface OllamaConfig {
  model: string;
  contextWindow: number;
  keepAlive: string;
  port: number;
  // 契約付録 §5。undefined はモデル既定に委ねる（think を送らない）。
  think?: boolean;
  // 契約付録 §8。呼び出し 1 本の期限。
  requestTimeoutMs?: number;
}

// 契約付録 §8。ローカルは 1 呼び出しが 100〜250 秒かかる（実測）ので、cloud と同じ物差しでは
// 正常な生成を切ってしまう。逆に無期限だと、返らない 1 本で run が黙って止まる。
export const DEFAULT_OLLAMA_REQUEST_TIMEOUT_MS = 600_000;
export const DEFAULT_CLAUDE_REQUEST_TIMEOUT_MS = 300_000;
// 同じモデルでもリモートは桁で速い（実測: 26b-a4b の 1 呼び出しが 623ms）。
// ローカルの物差しを当てると、詰まった呼び出しを何分も待つことになる。
export const DEFAULT_OPENROUTER_REQUEST_TIMEOUT_MS = 180_000;

export function requestTimeoutMsFor(
  provider: ProviderName,
  ollama: OllamaConfig = DEFAULT_OLLAMA,
  openrouter: OpenRouterConfig = DEFAULT_OPENROUTER,
): number {
  if (provider === "claude") return DEFAULT_CLAUDE_REQUEST_TIMEOUT_MS;
  if (provider === "openrouter") {
    return openrouter.requestTimeoutMs ?? DEFAULT_OPENROUTER_REQUEST_TIMEOUT_MS;
  }
  return ollama.requestTimeoutMs ?? DEFAULT_OLLAMA_REQUEST_TIMEOUT_MS;
}

export const DEFAULT_OLLAMA: OllamaConfig = {
  model: "llama3.1:8b",
  contextWindow: 8192,
  keepAlive: "5m",
  port: 11434,
  // 契約付録 §5。思考は message.thinking へ出て content には入らない＝払って捨てる。
  think: false,
};

// 契約付録 §5。セグメント予算は 0.3×CW なので、小さすぎる CW は本文を刻み切れず
// maxSegments で落ちるだけになる。大きすぎる側は上限の意味を失う。
export const MIN_CONTEXT_WINDOW = 1024;
export const MAX_CONTEXT_WINDOW = 1_000_000;

// 契約付録 §8。claude は 1 呼び出し = 1 子プロセスで互いに独立だが、ollama は 1 プロセスの
// GPU メモリ（KV キャッシュ）を共有するため、並列にすると窓の数だけ実効予算を食う。
export const MAX_CONCURRENCY = 64;

export function defaultConcurrencyFor(provider: ProviderName): number {
  return provider === "ollama" ? 1 : 4;
}

export function contextWindowFor(
  provider: ProviderName,
  ollama: OllamaConfig = DEFAULT_OLLAMA,
  openrouter: OpenRouterConfig = DEFAULT_OPENROUTER,
): number {
  if (provider === "claude") return DEFAULT_CLAUDE_CW;
  if (provider === "openrouter") return openrouter.contextWindow;
  return ollama.contextWindow;
}
