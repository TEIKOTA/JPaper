// LLM トレース ADR（20260722）。LlmCallEvent を runId 付き 1 行 JSON で追記する local シンク。
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { LlmCallEvent, LlmCallRecord, TraceSink } from "../types/contract.js";

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
