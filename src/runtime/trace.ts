// LLM トレース ADR（20260722）。LlmCallEvent を runId 付き 1 行 JSON で追記する local シンク。
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type {
  LlmCallEvent,
  LlmCallRecord,
  LlmClient,
  Provider,
  TraceSink,
} from "../types/contract.js";

export const nullTrace: TraceSink = () => {};

// filePath へ 1 呼び出し=1 行で追記する（並行呼び出しでも appendFileSync は行単位で安全）。
// mkdir は初回 emit まで遅延し、I/O 失敗は握り潰す（ベストエフォート）。⚠ landmines.md
export function makeJsonlTrace(filePath: string, runId: string): TraceSink {
  let ready = false;
  return (ev: LlmCallEvent) => {
    const record: LlmCallRecord = { runId, ...ev };
    try {
      if (!ready) {
        mkdirSync(path.dirname(filePath), { recursive: true });
        ready = true;
      }
      appendFileSync(filePath, JSON.stringify(record) + "\n");
    } catch {
      // トレース書き込み失敗は無視（run は継続）。
    }
  };
}

// 注入クライアント（web のテナント別資格情報）にもトレースを掛ける。
// プロバイダ生成側にだけ配線すると、注入した瞬間に課金の記録が消える。
// usage/コストは注入クライアントの内部にしか無いので、ここでは回数と latency だけを残す。
export function withTrace(
  client: LlmClient,
  trace: TraceSink,
  provider: Provider,
  now: () => number = Date.now,
): LlmClient {
  return {
    async complete(req) {
      const started = now();
      let failed = false;
      try {
        return await client.complete(req);
      } catch (e) {
        failed = true;
        throw e;
      } finally {
        // 失敗した呼び出しも課金されるので記録する（RunSummary.llmCalls と行数を揃える）。
        trace({
          ts: new Date().toISOString(),
          provider,
          role: req.meta?.role,
          phase: req.meta?.phase,
          segmentId: req.meta?.segmentId,
          pass: req.meta?.pass,
          latencyMs: now() - started,
          ...(failed ? { failed: true } : {}),
        });
      }
    },
  };
}
