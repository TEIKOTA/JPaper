import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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

  it("書き込み不能でも throw しない（ベストエフォート）", () => {
    // dirname が既存ファイル → mkdir が ENOTDIR で失敗するが握り潰す。
    const blocker = path.join(dir, "blocker");
    writeFileSync(blocker, "x");
    const sink = makeJsonlTrace(path.join(blocker, "trace.jsonl"), "run-1");
    expect(() => sink(ev())).not.toThrow();
  });
});

describe("nullTrace", () => {
  it("何もしない（例外を投げない）", () => {
    expect(() => nullTrace(ev())).not.toThrow();
  });
});

describe("トレースのローテーション", () => {
  it("上限を超えたら 1 世代退避して切り替える（.run が増え続けない）", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "jpaper-trace-"));
    try {
      const file = path.join(dir, "llm-trace.jsonl");
      const sink = makeJsonlTrace(file, "run-1", 300);
      for (let i = 0; i < 50; i++) {
        sink({ ts: new Date().toISOString(), provider: "ollama", latencyMs: i });
      }
      const files = readdirSync(dir).sort();
      expect(files).toEqual(["llm-trace.jsonl", "llm-trace.jsonl.1"]);
      const total = files.reduce((a, f) => a + statSync(path.join(dir, f)).size, 0);
      expect(total).toBeLessThanOrEqual(600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("ローテーションはファイル単位", () => {
  it("同じファイルへ複数のシンクを向けても上限を超えない", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "jpaper-trace-multi-"));
    try {
      const file = path.join(dir, "llm-trace.jsonl");
      const sinks = Array.from({ length: 8 }, (_, i) => makeJsonlTrace(file, `run-${String(i)}`, 4096));
      for (let i = 0; i < 200; i++) {
        sinks[i % sinks.length]!({ ts: new Date().toISOString(), provider: "ollama", latencyMs: i });
      }
      const total = readdirSync(dir).reduce((a, f) => a + statSync(path.join(dir, f)).size, 0);
      expect(total).toBeLessThanOrEqual(4096 * 2 + 512);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("観測チャネルの故障は run を壊さない", () => {
  it("TraceSink が投げても LLM 呼び出しは成功する", async () => {
    const { withTrace } = await import("./trace.js");
    const { FakeLlmClient } = await import("../testing/fake-llm.js");
    const client = withTrace(
      new FakeLlmClient(async () => "ok"),
      () => {
        throw new Error("SSE stream already closed");
      },
      "ollama",
    );
    await expect(client.complete({ system: "s", user: "u" })).resolves.toBe("ok");
  });

  it("失敗した呼び出しでも TraceSink の例外を握り潰す（元の例外を保つ）", async () => {
    const { withTrace } = await import("./trace.js");
    const { FakeLlmClient } = await import("../testing/fake-llm.js");
    const client = withTrace(
      new FakeLlmClient(async () => {
        throw new Error("provider down");
      }),
      () => {
        throw new Error("trace sink down");
      },
      "ollama",
    );
    await expect(client.complete({ system: "s", user: "u" })).rejects.toThrow("provider down");
  });
});
