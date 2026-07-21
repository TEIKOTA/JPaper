import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeJsonlTrace, nullTrace } from "./trace.js";
import type { LlmCallEvent } from "../types/contract.js";

const ev = (over: Partial<LlmCallEvent> = {}): LlmCallEvent => ({
  ts: "2026-07-22T00:00:00.000Z",
  provider: "claude",
  latencyMs: 12,
  ...over,
});

describe("makeJsonlTrace", () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(path.join(tmpdir(), "jp-trace-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("runId を stamp し 1 呼び出し=1 行の JSON で追記する", () => {
    const file = path.join(dir, "sub", "llm-trace.jsonl"); // 親ディレクトリは自動生成
    const sink = makeJsonlTrace(file, "run-42");
    sink(ev({ role: "translator", segmentId: "s1", costUsd: 0.01 }));
    sink(ev({ role: "evaluator", segmentId: "s1", pass: 1 }));

    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!);
    expect(first).toMatchObject({ runId: "run-42", role: "translator", segmentId: "s1", costUsd: 0.01 });
    expect(JSON.parse(lines[1]!)).toMatchObject({ runId: "run-42", role: "evaluator", pass: 1 });
  });
});

describe("nullTrace", () => {
  it("何もしない（例外を投げない）", () => {
    expect(() => nullTrace(ev())).not.toThrow();
  });
});
