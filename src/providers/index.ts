// 契約付録 §5。プロバイダ選択。
import type { LlmClient, Provider } from "../types/contract.js";
import { DEFAULT_OLLAMA, type OllamaConfig } from "../config.js";
import { makeOllamaClient, type OllamaDeps } from "./ollama.js";
import { makeClaudeClient, type ClaudeDeps } from "./claude.js";

export interface MakeLlmClientOptions {
  ollama?: OllamaConfig;
  ollamaDeps?: OllamaDeps;
  claudeDeps?: ClaudeDeps;
}

export function makeLlmClient(
  provider: Provider,
  opts: MakeLlmClientOptions = {},
): LlmClient {
  return provider === "ollama"
    ? makeOllamaClient(opts.ollama ?? DEFAULT_OLLAMA, opts.ollamaDeps)
    : makeClaudeClient(opts.claudeDeps);
}
