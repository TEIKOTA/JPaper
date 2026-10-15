// 契約付録 §5。プロバイダ選択。
import type { LlmClient, Provider, TraceSink } from "../types/contract.js";
import { JpaperError } from "../types/errors.js";
import {
  DEFAULT_OLLAMA,
  DEFAULT_OPENROUTER,
  type ClaudeConfig,
  type CodexConfig,
  type OllamaConfig,
  type OpenRouterConfig,
} from "../config.js";
import { makeOllamaClient, type OllamaDeps } from "./ollama.js";
import { makeClaudeClient, type ClaudeDeps } from "./claude.js";
import { makeCodexClient, type CodexDeps } from "./codex.js";
import { makeOpenRouterClient, type OpenRouterDeps } from "./openrouter.js";

export interface MakeLlmClientOptions {
  ollama?: OllamaConfig;
  openrouter?: OpenRouterConfig;
  claude?: ClaudeConfig;
  codex?: CodexConfig;
  ollamaDeps?: OllamaDeps;
  claudeDeps?: ClaudeDeps;
  codexDeps?: CodexDeps;
  openrouterDeps?: OpenRouterDeps;
  trace?: TraceSink; // LLM トレース ADR。選択したプロバイダの deps に注入する。
}

// 画像を渡せるプロバイダ。契約付録 §8（PDF 入力）
export const IMAGE_PROVIDERS: readonly Provider[] = ["claude", "codex"];

function rejectImages(provider: Provider, client: LlmClient): LlmClient {
  return {
    complete(req) {
      if ((req.images?.length ?? 0) > 0) {
        return Promise.reject(new JpaperError(2, "provider", `${provider} には画像を渡せません`));
      }
      return client.complete(req);
    },
  };
}

export function makeLlmClient(
  provider: Provider,
  opts: MakeLlmClientOptions = {},
): LlmClient {
  // 同時実行ゲートはここでは掛けない。注入クライアント（web のテナント別資格情報など）にも
  // 効かせる必要があるため、run 層（translatePaper）で一律に掛ける。
  if (provider === "ollama") {
    return rejectImages(provider, makeOllamaClient(opts.ollama ?? DEFAULT_OLLAMA, { trace: opts.trace, ...opts.ollamaDeps }));
  }
  if (provider === "openrouter") {
    return rejectImages(
      provider,
      makeOpenRouterClient(opts.openrouter ?? DEFAULT_OPENROUTER, { trace: opts.trace, ...opts.openrouterDeps }),
    );
  }
  if (provider === "codex") {
    return makeCodexClient(opts.codex ?? {}, { trace: opts.trace, ...opts.codexDeps });
  }
  return makeClaudeClient(opts.claude ?? {}, { trace: opts.trace, ...opts.claudeDeps });
}
