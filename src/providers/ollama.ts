// 契約付録 §5・§8。Ollama プロバイダ（オンデマンド daemon・/api/chat）。
import type { LlmClient } from "../types/contract.js";
import type { OllamaConfig } from "../config.js";
import { JpaperError } from "../types/errors.js";

export interface OllamaDeps {
  fetchImpl?: typeof fetch;
}

export function makeOllamaClient(cfg: OllamaConfig, deps: OllamaDeps = {}): LlmClient {
  const fetchImpl = deps.fetchImpl ?? fetch;
  return {
    async complete(req) {
      let res: Response;
      try {
        res = await fetchImpl(`http://127.0.0.1:${cfg.port}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: req.model ?? cfg.model,
            messages: [
              { role: "system", content: req.system },
              { role: "user", content: req.user },
            ],
            stream: false,
            keep_alive: cfg.keepAlive,
            options: { num_ctx: cfg.contextWindow },
          }),
        });
      } catch (e) {
        throw new JpaperError(2, "provider", `ollama 接続に失敗: ${String((e as Error)?.message ?? e)}`);
      }
      if (!res.ok) {
        throw new JpaperError(2, "provider", `ollama HTTP ${res.status}`);
      }
      const data = (await res.json()) as { message?: { content?: string } };
      return data.message?.content ?? "";
    },
  };
}
