// 契約付録 §5・§8。Ollama プロバイダ（オンデマンド daemon 起動・/api/chat）。
import { spawn } from "node:child_process";
import type { LlmClient, LlmRequest, TraceSink } from "../types/contract.js";
import { MAX_RESPONSE_CHARS } from "../runtime/llm-client.js";
import type { OllamaConfig } from "../config.js";
import { JpaperError } from "../types/errors.js";
import { canceledError, throwIfAborted } from "../runtime/cancellation.js";

export interface OllamaDeps {
  fetchImpl?: typeof fetch;
  ensureDaemon?: () => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  spawnImpl?: typeof spawn;
  trace?: TraceSink; // LLM トレース ADR。local なのでコストは無く token 数・latency のみ記録。
  now?: () => number;
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

// 上限を超えたら受信を打ち切る。res.json() は本文を丸ごと載せるので、応答を誘導できる
// 相手にワーカーのメモリを食わせられる。body が無い（テストの偽 Response）場合は json() へ戻る。
async function readCappedJson(res: Response): Promise<unknown> {
  const body = res.body;
  if (!body) return res.json();
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    if (text.length > MAX_RESPONSE_CHARS) {
      await reader.cancel();
      throw new Error(`ollama 応答が上限 ${MAX_RESPONSE_CHARS} 文字を超えています`);
    }
  }
  return JSON.parse(text);
}

export function makeOllamaClient(cfg: OllamaConfig, deps: OllamaDeps = {}): LlmClient {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const ensureDaemon =
    deps.ensureDaemon ??
    (() => defaultEnsureDaemon(cfg, fetchImpl, sleep, deps.spawnImpl ?? spawn));
  let started = false;

  const now = deps.now ?? Date.now;

  async function call(req: LlmRequest): Promise<string> {
    const model = req.model ?? cfg.model;
    const startedAt = now();
    throwIfAborted(req.signal, "ollama 呼び出し前");
    const res = await fetchImpl(`http://127.0.0.1:${cfg.port}/api/chat`, {
      method: "POST",
      signal: req.signal,
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
        // ネイティブ JSON モードで構文的に妥当な JSON を強制（parse 失敗を撲滅）。構造化出力 ADR。
        ...(req.jsonMode ? { format: "json" } : {}),
      }),
    });
    if (res.ok) {
      const data = (await readCappedJson(res)) as {
        message?: { content?: string };
        prompt_eval_count?: number;
        eval_count?: number;
      };
      deps.trace?.({
        ts: new Date().toISOString(),
        provider: "ollama",
        role: req.meta?.role,
        phase: req.meta?.phase,
        segmentId: req.meta?.segmentId,
        pass: req.meta?.pass,
        model,
        latencyMs: now() - startedAt,
        inputTokens: data.prompt_eval_count,
        outputTokens: data.eval_count,
      });
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
        // fetch の中断は AbortError で来る。分類済みの中断へ写して retry 対象から外す。
        if (req.signal?.aborted === true) throw canceledError("ollama 呼び出し中");
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
