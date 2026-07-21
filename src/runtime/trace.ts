// LLM トレース ADR（20260722）。LlmCallEvent を runId 付き 1 行 JSON で追記する local シンク。
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { LlmCallEvent, LlmCallRecord, TraceSink } from "../types/contract.js";

export const nullTrace: TraceSink = () => {};

// filePath へ 1 呼び出し=1 行で追記する。並行呼び出し（mapLimit）でも appendFileSync は行単位で安全。
export function makeJsonlTrace(filePath: string, runId: string): TraceSink {
  mkdirSync(path.dirname(filePath), { recursive: true });
  return (ev: LlmCallEvent) => {
    const record: LlmCallRecord = { runId, ...ev };
    appendFileSync(filePath, JSON.stringify(record) + "\n");
  };
}
