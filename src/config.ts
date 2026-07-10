// 設定・パス解決（契約付録 §2・§4・§8）。
import os from "node:os";
import path from "node:path";

// グローバル状態の置き場。JPAPER_HOME で上書き可、既定は ~/.jpaper。
export function resolveJpaperHome(): string {
  const env = process.env.JPAPER_HOME;
  if (env && env.trim() !== "") return env;
  return path.join(os.homedir(), ".jpaper");
}

// 横断用語 DB の置き場（~/.jpaper/glossary.db）。
export function dbPath(): string {
  return path.join(resolveJpaperHome(), "glossary.db");
}

// 論文ごとの可視フォルダ（既定 ./<paperId>-ja、--out で上書き）。
export function paperOutDir(paperId: string, outOpt?: string): string {
  if (outOpt && outOpt.trim() !== "") return path.resolve(outOpt);
  return path.resolve(`${paperId}-ja`);
}

// claude(subprocess) はモデルを渡さないため保守的な既定コンテキスト窓。
export const DEFAULT_CLAUDE_CW = 200_000;

// Ollama 設定契約（§8）。
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

// プロバイダのコンテキスト窓 CW（§4）。トークン予算はここから逆算する。
export function contextWindowFor(
  provider: "ollama" | "claude",
  ollama: OllamaConfig = DEFAULT_OLLAMA,
): number {
  return provider === "claude" ? DEFAULT_CLAUDE_CW : ollama.contextWindow;
}
