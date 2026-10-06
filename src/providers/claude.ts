// 契約付録 §5・§8。claude プロバイダ（純変換器化した公式 CLI subprocess）。
import { spawn } from "node:child_process";
import type { LlmClient, LlmCallEvent, LlmCallMeta, TraceSink } from "../types/contract.js";
import { JpaperError } from "../types/errors.js";
import { canceledError } from "../runtime/cancellation.js";
import { MAX_RESPONSE_CHARS } from "../runtime/llm-client.js";

export const MAX_TURNS = 3;

export interface ClaudeDeps {
  run?: (args: string[], input: string, signal?: AbortSignal) => Promise<string>;
  trace?: TraceSink; // LLM トレース ADR。成功呼び出しの usage/コストを emit する副作用チャネル。
  now?: () => number; // latency 計測（テスト用に注入可能）。
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
    model: typeof j.model === "string" ? j.model : undefined,
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
    const child = spawn("claude", args, { stdio: ["pipe", "pipe", "pipe"] });
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

export function makeClaudeClient(deps: ClaudeDeps = {}): LlmClient {
  const run = deps.run ?? defaultRun;
  const now = deps.now ?? Date.now;
  return {
    async complete(req) {
      // model は渡さない（CLI ログインセッションのモデルを使う）。
      let stdout: string;
      const started = now();
      try {
        stdout = await run(
          [
            "-p",
            "--output-format",
            "json",
            "--append-system-prompt",
            req.system,
            // ⚠ landmines.md
            "--max-turns",
            String(MAX_TURNS),
            "--tools",
            "none",
          ],
          req.user,
          req.signal,
        );
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
