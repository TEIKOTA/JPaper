// 契約付録 §5。プロバイダ選択。
import type { LlmClient, Provider, TraceSink } from "../types/contract.js";
import { DEFAULT_OLLAMA, type OllamaConfig } from "../config.js";
import { makeOllamaClient, type OllamaDeps } from "./ollama.js";
import { makeClaudeClient, type ClaudeDeps } from "./claude.js";
import { llmGate, withGate, type Gate } from "../runtime/concurrency.js";

export interface MakeLlmClientOptions {
  ollama?: OllamaConfig;
  ollamaDeps?: OllamaDeps;
  claudeDeps?: ClaudeDeps;
  trace?: TraceSink; // LLM トレース ADR。選択したプロバイダの deps に注入する。
  // プロセス全体の同時実行ゲート。既定は module スコープの共有ゲート（リクエストをまたいで効く）。
  gate?: Gate;
}

export function makeLlmClient(
  provider: Provider,
  opts: MakeLlmClientOptions = {},
): LlmClient {
  const client =
    provider === "ollama"
      ? makeOllamaClient(opts.ollama ?? DEFAULT_OLLAMA, { trace: opts.trace, ...opts.ollamaDeps })
      : makeClaudeClient({ trace: opts.trace, ...opts.claudeDeps });
  return withGate(client, opts.gate ?? llmGate());
}
