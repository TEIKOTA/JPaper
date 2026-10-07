// 契約付録 §5。プロバイダ選択。
import type { LlmClient, Provider, TraceSink } from "../types/contract.js";
import {
  DEFAULT_OLLAMA,
  DEFAULT_OPENROUTER,
  type ClaudeConfig,
  type OllamaConfig,
  type OpenRouterConfig,
} from "../config.js";
import { makeOllamaClient, type OllamaDeps } from "./ollama.js";
import { makeClaudeClient, type ClaudeDeps } from "./claude.js";
import { makeOpenRouterClient, type OpenRouterDeps } from "./openrouter.js";

export interface MakeLlmClientOptions {
  ollama?: OllamaConfig;
  openrouter?: OpenRouterConfig;
  claude?: ClaudeConfig;
  ollamaDeps?: OllamaDeps;
  claudeDeps?: ClaudeDeps;
  openrouterDeps?: OpenRouterDeps;
  trace?: TraceSink; // LLM トレース ADR。選択したプロバイダの deps に注入する。
}

export function makeLlmClient(
  provider: Provider,
  opts: MakeLlmClientOptions = {},
): LlmClient {
  // 同時実行ゲートはここでは掛けない。注入クライアント（web のテナント別資格情報など）にも
  // 効かせる必要があるため、run 層（translatePaper）で一律に掛ける。
  if (provider === "ollama") {
    return makeOllamaClient(opts.ollama ?? DEFAULT_OLLAMA, { trace: opts.trace, ...opts.ollamaDeps });
  }
  if (provider === "openrouter") {
    return makeOpenRouterClient(opts.openrouter ?? DEFAULT_OPENROUTER, {
      trace: opts.trace,
      ...opts.openrouterDeps,
    });
  }
  return makeClaudeClient(opts.claude ?? {}, { trace: opts.trace, ...opts.claudeDeps });
}
