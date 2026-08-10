// LLM トレース ADR（20260722）。LlmCallEvent を runId 付き 1 行 JSON で追記する local シンク。
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
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
// 1 ファイルの上限。超えたら 1 世代だけ退避して切り替える（合計は上限の 2 倍で有界）。
// checkpoint を GC しても、ローテーションが無ければ .run は投入のたびに増え続ける。
export const TRACE_MAX_BYTES = 5 * 1024 * 1024;

export function makeJsonlTrace(
  filePath: string,
  runId: string,
  maxBytes = TRACE_MAX_BYTES,
): TraceSink {
  let ready = false;
  return (ev: LlmCallEvent) => {
    const record: LlmCallRecord = { runId, ...ev };
    const line = JSON.stringify(record) + "\n";
    try {
      if (!ready) {
        mkdirSync(path.dirname(filePath), { recursive: true });
        ready = true;
      }
      // 判定は実ファイルのサイズで行う。シンクごとのカウンタだと、同じファイルへ複数の
      // シンクを向けた瞬間に上限が壊れる（実測 8 シンクで宣言上限の 3.9 倍）。
      let size = 0;
      try {
        size = statSync(filePath).size;
      } catch {
        size = 0; // まだ無い。
      }
      if (size + line.length > maxBytes) renameSync(filePath, `${filePath}.1`);
      appendFileSync(filePath, line);
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
