// 設定・パス解決（契約付録 §2・§4・§8）。
import os from "node:os";
import path from "node:path";

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

export interface OllamaConfig {
  model: string;
  contextWindow: number;
  keepAlive: string;
  port: number;
}

export const DEFAULT_OLLAMA: OllamaConfig = {
  model: "llama3.1:8b",
  contextWindow: 8192,
  keepAlive: "5m",
  port: 11434,
};

export function contextWindowFor(
  provider: "ollama" | "claude",
  ollama: OllamaConfig = DEFAULT_OLLAMA,
): number {
  return provider === "claude" ? DEFAULT_CLAUDE_CW : ollama.contextWindow;
}
