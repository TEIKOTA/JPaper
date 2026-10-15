// 契約付録 §5・§8。claude プロバイダ（純変換器化した公式 CLI subprocess）。
import { spawn } from "node:child_process";
import os from "node:os";
import type { ClaudeConfig } from "../config.js";
import type { LlmClient, LlmCallEvent, LlmCallMeta, LlmImage, TraceSink } from "../types/contract.js";
import { JpaperError } from "../types/errors.js";
import { canceledError } from "../runtime/cancellation.js";
import { MAX_RESPONSE_CHARS } from "../runtime/llm-client.js";

export const MAX_TURNS = 3;
// Web 検索を許す呼び出しのターン上限（検索 1 回で 1 ターン使う）。契約付録 §4
export const WEB_SEARCH_MAX_TURNS = 12;

export interface ClaudeDeps {
  run?: (args: string[], input: string, signal?: AbortSignal) => Promise<string>;
  trace?: TraceSink; // LLM トレース ADR。成功呼び出しの usage/コストを emit する副作用チャネル。
  now?: () => number; // latency 計測（テスト用に注入可能）。
}

// 別名（sonnet 等）で呼んだときに実際に使われたモデル。modelUsage のうち出力トークン（無ければ費用）が最大の鍵。
export function usedModel(v: unknown): string | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const weight = (u: unknown): number => {
    const o = (typeof u === "object" && u !== null ? u : {}) as { outputTokens?: unknown; costUSD?: unknown };
    if (typeof o.outputTokens === "number") return o.outputTokens;
    return typeof o.costUSD === "number" ? o.costUSD : 0;
  };
  let best: { key: string; w: number } | undefined;
  for (const [key, u] of Object.entries(v)) {
    const w = weight(u);
    if (best === undefined || w > best.w) best = { key, w };
  }
  return best?.key;
}

// claude CLI の JSON 応答から usage/コストを取り出す（欠損に頑健＝フィールドは全て optional）。
function toEvent(raw: string, latencyMs: number, meta?: LlmCallMeta): LlmCallEvent {
  let j: Record<string, unknown> = {};
  try {
    j = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // 応答が JSON でない場合は usage 不明のイベントを返す（呼び出し側で JSON 検査は別途行う）。
  }
  const usage = (j.usage ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
  return {
    ts: new Date().toISOString(),
    provider: "claude",
    role: meta?.role,
    phase: meta?.phase,
    segmentId: meta?.segmentId,
    pass: meta?.pass,
    model: typeof j.model === "string" ? j.model : usedModel(j.modelUsage),
    latencyMs,
    numTurns: num(j.num_turns),
    inputTokens: num(usage.input_tokens),
    outputTokens: num(usage.output_tokens),
    cacheReadTokens: num(usage.cache_read_input_tokens),
    cacheCreationTokens: num(usage.cache_creation_input_tokens),
    costUsd: num(j.total_cost_usd),
  };
}

async function defaultRun(args: string[], input: string, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted === true) throw canceledError("claude 起動前");
  return new Promise((resolve, reject) => {
    // ⚠ landmines.md
    const child = spawn("claude", args, { cwd: os.tmpdir(), stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let canceled = false;
    // 中断されたら子プロセスを落とす。放置すると web でクライアント切断後も課金が続く。
    const onAbort = (): void => {
      canceled = true;
      child.kill("SIGKILL");
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const done = (): void => signal?.removeEventListener("abort", onAbort);
    // 上限を超えたら受信を打ち切って子プロセスを落とす。無制限に連結すると、
    // 応答を誘導できる相手にワーカーのメモリを食わせられる。
    let overflowed = false;
    const overflow = (): void => {
      overflowed = true;
      child.kill("SIGKILL");
    };
    child.stdout.on("data", (d) => {
      if (overflowed) return;
      out += d;
      if (out.length > MAX_RESPONSE_CHARS) overflow();
    });
    child.stderr.on("data", (d) => {
      if (overflowed) return;
      err += d;
      if (err.length > MAX_RESPONSE_CHARS) overflow();
    });
    child.on("error", (e) => {
      done();
      reject(e);
    });
    child.on("close", (code) => {
      done();
      if (overflowed) {
        reject(new Error(`claude 応答が上限 ${MAX_RESPONSE_CHARS} 文字を超えています`));
      } else if (canceled) reject(canceledError("claude 実行中"));
      else if (code === 0) resolve(out);
      else {
        const detail = (err || out).slice(0, 800);
        reject(Object.assign(new Error(`claude exited ${code}: ${detail}`), { code }));
      }
    });
    // ⚠ landmines.md
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

// 画像と本文を 1 つの user メッセージにした stream-json の入力（1 行）。
export function streamJsonInput(user: string, images: readonly LlmImage[]): string {
  const content = [
    ...images.map((im) => ({
      type: "image",
      source: { type: "base64", media_type: im.mediaType, data: im.data.toString("base64") },
    })),
    { type: "text", text: user },
  ];
  return `${JSON.stringify({ type: "user", message: { role: "user", content } })}\n`;
}

// stream-json の出力のうち、最後の type="result" の行（--output-format json の応答と同じ形）。
export function resultLine(stdout: string): string {
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line.startsWith("{")) continue;
    try {
      if ((JSON.parse(line) as { type?: unknown }).type === "result") return line;
    } catch {
      // 壊れた行は飛ばす。
    }
  }
  return "";
}

export function makeClaudeClient(cfg: ClaudeConfig = {}, deps: ClaudeDeps = {}): LlmClient {
  const run = deps.run ?? defaultRun;
  const now = deps.now ?? Date.now;
  return {
    async complete(req) {
      let stdout: string;
      const started = now();
      const images = req.images ?? [];
      try {
        stdout = await run(
          [
            "-p",
            // 画像は stream-json の入力でしか渡せず、その出力も stream-json に限られる。契約付録 §8（PDF 入力）
            ...(images.length === 0
              ? ["--output-format", "json"]
              : ["--input-format", "stream-json", "--output-format", "stream-json", "--verbose"]),
            "--append-system-prompt",
            req.system,
            // ⚠ landmines.md
            "--max-turns",
            String(req.webSearch === true ? WEB_SEARCH_MAX_TURNS : MAX_TURNS),
            "--tools",
            req.webSearch === true ? "WebSearch" : "none",
            // 利用者の権限設定によらず、WebSearch を確認なしで使わせる。
            ...(req.webSearch === true ? ["--allowedTools", "WebSearch"] : []),
            // ⚠ landmines.md
            "--safe-mode",
            ...(cfg.model === undefined ? [] : ["--model", cfg.model]),
            ...(cfg.effort === undefined ? [] : ["--effort", cfg.effort]),
          ],
          images.length === 0 ? req.user : streamJsonInput(req.user, images),
          req.signal,
        );
        if (images.length > 0) stdout = resultLine(stdout);
      } catch (e) {
        if (e instanceof JpaperError && e.kind === "canceled") throw e;
        if ((e as { code?: unknown }).code === "ENOENT") {
          throw new JpaperError(2, "provider", "claude が見つかりません（未インストール/PATH 外）");
        }
        // 非ゼロ終了・タイムアウトは API 側の一時障害が多い → transient にして withRetry へ委ねる。
        const err = new JpaperError(
          2,
          "provider",
          `claude 実行に失敗: ${String((e as Error)?.message ?? e)}`,
        );
        Object.assign(err, { transient: true });
        throw err;
      }
      let parsed: { result?: unknown };
      try {
        parsed = JSON.parse(stdout) as { result?: unknown };
      } catch {
        // 構文不正な JSON は切れ/破損＝一時障害が多い → transient にして withRetry へ委ねる。
        throw Object.assign(new JpaperError(2, "provider", "claude 応答が JSON でない"), {
          transient: true,
        });
      }
      // JSON は正常なのに result が無いのは契約不一致（CLI 仕様変更等）＝決定的。retry せず即 surface する。
      if (typeof parsed.result !== "string") {
        throw new JpaperError(2, "provider", "claude 応答に result 文字列が無い");
      }
      // result が取れた成功呼び出しのみトレースへ emit（usage/コストは stdout から再取得）。
      deps.trace?.(toEvent(stdout, now() - started, req.meta));
      return parsed.result;
    },
  };
}
