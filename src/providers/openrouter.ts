// 契約付録 §5・§8。OpenRouter プロバイダ（OpenAI 互換 /v1/chat/completions）。
import type { LlmClient, LlmRequest, TraceSink } from "../types/contract.js";
import { MAX_RESPONSE_CHARS } from "../runtime/llm-client.js";
import type { OpenRouterConfig } from "../config.js";
import { JpaperError } from "../types/errors.js";
import { canceledError, throwIfAborted } from "../runtime/cancellation.js";

export interface OpenRouterDeps {
  fetchImpl?: typeof fetch;
  trace?: TraceSink;
  now?: () => number;
  apiKey?: string; // 未指定なら環境変数から取る（web のテナント別資格情報を注入できるように）
}

export const API_KEY_ENV = "OPENROUTER_API_KEY";

interface ChatResult {
  content: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

// SSE を逐次で受ける。まとめ受けだと、生成が undici の既定タイムアウトを超えた時点で
// 接続ごと落ちる（ollama で実測した現象と同じ）。逐次チャンクが流れていれば無通信
// タイムアウトに掛からず、期限は withCallTimeout だけが持つ。
// body を持たない Response（テストの偽物）はまとめ受けへ落とす。
async function readCappedStream(res: Response): Promise<ChatResult> {
  type Chunk = {
    choices?: { delta?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
    error?: { message?: string };
  };
  const out: ChatResult = { content: "" };
  const take = (d: Chunk): void => {
    if (d.error) throw new JpaperError(2, "provider", `openrouter: ${d.error.message ?? "不明"}`);
    out.content += d.choices?.[0]?.delta?.content ?? "";
    if (out.content.length > MAX_RESPONSE_CHARS) {
      throw new Error(`openrouter 応答が上限 ${MAX_RESPONSE_CHARS} 文字を超えています`);
    }
    // usage は最終チャンクにだけ載る。
    if (d.usage) {
      out.inputTokens = d.usage.prompt_tokens;
      out.outputTokens = d.usage.completion_tokens;
      out.costUsd = d.usage.cost;
    }
  };

  const body = res.body;
  if (!body) {
    const d = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
      error?: { message?: string };
    };
    if (d.error) throw new JpaperError(2, "provider", `openrouter: ${d.error.message ?? "不明"}`);
    return {
      content: d.choices?.[0]?.message?.content ?? "",
      inputTokens: d.usage?.prompt_tokens,
      outputTokens: d.usage?.completion_tokens,
      costUsd: d.usage?.cost,
    };
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const consume = (line: string): void => {
    const s = line.trim();
    // `: OPENROUTER PROCESSING` のようなコメント行が定期的に流れる（keep-alive）。
    if (s === "" || s.startsWith(":")) return;
    if (!s.startsWith("data:")) return;
    const payload = s.slice(5).trim();
    if (payload === "[DONE]") return;
    take(JSON.parse(payload) as Chunk);
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        consume(line);
      }
      // 改行が来ないまま膨らむ応答も止める（行単位の上限が無いと打ち切りが効かない）。
      if (buf.length > MAX_RESPONSE_CHARS) {
        throw new Error(`openrouter 応答が上限 ${MAX_RESPONSE_CHARS} 文字を超えています`);
      }
    }
    consume(buf);
  } catch (e) {
    await reader.cancel().catch(() => undefined);
    throw e;
  }
  return out;
}

export function makeOpenRouterClient(cfg: OpenRouterConfig, deps: OpenRouterDeps = {}): LlmClient {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;

  // 鍵は呼び出しのたびに読む。起動時に固めると、web で資格情報を差し替えられない。
  function apiKey(): string {
    const k = deps.apiKey ?? process.env[API_KEY_ENV];
    if (k === undefined || k.trim() === "") {
      throw new JpaperError(
        2,
        "provider",
        `${API_KEY_ENV} が設定されていません（.env に置くか環境変数で渡してください）`,
      );
    }
    return k;
  }

  return {
    async complete(req: LlmRequest): Promise<string> {
      const model = req.model ?? cfg.model;
      const key = apiKey();
      const startedAt = now();
      throwIfAborted(req.signal, "openrouter 呼び出し前");
      let res: Response;
      try {
        res = await fetchImpl(`${cfg.baseUrl}/chat/completions`, {
          method: "POST",
          signal: req.signal,
          headers: {
            authorization: `Bearer ${key}`,
            "content-type": "application/json",
            // OpenRouter のランキング表示用。付けないと "unknown app" 扱いになるだけ。
            "x-title": "JPaper",
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: req.system },
              { role: "user", content: req.user },
            ],
            stream: true,
            // 最終チャンクに usage を載せさせる（載らないとコストを記録できない）。
            stream_options: { include_usage: true },
            // format 強制は送らない。制約デコードは JSON の文字列中で \c を出せず、
            // LaTeX の綴りが壊れる。⚠ landmines.md
            // ADR 20260815-drop-ollama-json-mode
          }),
        });
      } catch (e) {
        if (req.signal?.aborted === true) throw canceledError("openrouter 呼び出し中");
        throw e;
      }

      if (res.ok) {
        try {
          const data = await readCappedStream(res);
          deps.trace?.({
            ts: new Date().toISOString(),
            provider: "openrouter",
            role: req.meta?.role,
            phase: req.meta?.phase,
            segmentId: req.meta?.segmentId,
            pass: req.meta?.pass,
            model,
            latencyMs: now() - startedAt,
            inputTokens: data.inputTokens,
            outputTokens: data.outputTokens,
            costUsd: data.costUsd,
          });
          return data.content;
        } catch (e) {
          if (req.signal?.aborted === true) throw canceledError("openrouter 呼び出し中");
          throw e;
        }
      }

      if (res.status === 429 || res.status >= 500) {
        // 一時障害。isTransient が status で拾えるようにして withRetry に委ねる。
        // 無料モデルは 20 req/分・50 req/日（$10 未満の購入時）で 429 を返す。
        throw Object.assign(new Error(`openrouter HTTP ${res.status}`), { status: res.status });
      }
      if (res.status === 401 || res.status === 403) {
        throw new JpaperError(2, "provider", `${API_KEY_ENV} が拒否されました (HTTP ${res.status})`);
      }
      if (res.status === 402) {
        throw new JpaperError(
          2,
          "provider",
          `openrouter の残高が不足しています。無料モデル（:free 付き）を使うか残高を足してください (HTTP 402)`,
        );
      }
      if (res.status === 404) {
        throw new JpaperError(2, "provider", `モデル ${model} が見つかりません (HTTP 404)`);
      }
      throw new JpaperError(2, "provider", `openrouter HTTP ${res.status}`);
    },
  };
}
