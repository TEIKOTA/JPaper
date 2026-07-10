// 契約付録 §5・§8。Ollama プロバイダ（オンデマンド daemon 起動・/api/chat）。
import { spawn } from "node:child_process";
import type { LlmClient, LlmRequest } from "../types/contract.js";
import type { OllamaConfig } from "../config.js";
import { JpaperError } from "../types/errors.js";

export interface OllamaDeps {
  fetchImpl?: typeof fetch;
  ensureDaemon?: () => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  spawnImpl?: typeof spawn;
}

function isConnRefused(e: unknown): boolean {
  const err = e as { code?: unknown; cause?: { code?: unknown } };
  return err?.code === "ECONNREFUSED" || err?.cause?.code === "ECONNREFUSED";
}

async function defaultEnsureDaemon(
  cfg: OllamaConfig,
  fetchImpl: typeof fetch,
  sleep: (ms: number) => Promise<void>,
  spawnImpl: typeof spawn,
): Promise<void> {
  const err: { current: Error | null } = { current: null };
  const child = spawnImpl("ollama", ["serve"], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, OLLAMA_HOST: `127.0.0.1:${cfg.port}` },
  });
  // 実行ファイル欠如の 'error' に listener を付けないと Node が落ちる。
  child.on("error", (e) => {
    err.current = e;
  });
  child.unref();
  for (let i = 0; i < 30; i++) {
    if (err.current) {
      throw new JpaperError(2, "provider", `ollama を起動できません: ${err.current.message}`);
    }
    try {
      const r = await fetchImpl(`http://127.0.0.1:${cfg.port}/api/tags`);
      if (r.ok) return;
    } catch {
      // まだ起動していない
    }
    await sleep(500);
  }
  throw new JpaperError(2, "provider", "ollama serve を起動できません");
}

export function makeOllamaClient(cfg: OllamaConfig, deps: OllamaDeps = {}): LlmClient {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const ensureDaemon =
    deps.ensureDaemon ??
    (() => defaultEnsureDaemon(cfg, fetchImpl, sleep, deps.spawnImpl ?? spawn));
  let started = false;

  async function call(req: LlmRequest): Promise<string> {
    const model = req.model ?? cfg.model;
    const res = await fetchImpl(`http://127.0.0.1:${cfg.port}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.user },
        ],
        stream: false,
        keep_alive: cfg.keepAlive,
        options: { num_ctx: cfg.contextWindow },
      }),
    });
    if (res.ok) {
      const data = (await res.json()) as { message?: { content?: string } };
      return data.message?.content ?? "";
    }
    if (res.status === 429 || res.status >= 500) {
      // 一時障害。isTransient が status で拾えるようにして withRetry に委ねる。
      throw Object.assign(new Error(`ollama HTTP ${res.status}`), { status: res.status });
    }
    if (res.status === 404) {
      throw new JpaperError(
        2,
        "provider",
        `モデル ${model} が見つかりません（未 pull の可能性）。'ollama pull ${model}' を実行してください (HTTP 404)`,
      );
    }
    throw new JpaperError(2, "provider", `ollama HTTP ${res.status}`);
  }

  return {
    async complete(req) {
      try {
        return await call(req);
      } catch (e) {
        if (!started && isConnRefused(e)) {
          started = true;
          await ensureDaemon();
          return await call(req);
        }
        throw e;
      }
    },
  };
}
