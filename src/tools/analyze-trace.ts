// LLM トレース ADR（20260722）。llm-trace.jsonl（LlmCallRecord[]）をコスト内訳へ集計する純関数。
import type { LlmCallRecord } from "../types/contract.js";

export interface GroupStat {
  key: string;
  calls: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  latencyMsTotal: number;
}

export interface TraceSummary {
  totalCalls: number;
  totalCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  latencyMsTotal: number;
  byRole: GroupStat[]; // コスト降順
  byPass: { pass: number; calls: number; costUsd: number }[]; // 昇順（0=初回, >0=再訳）
  reviseCalls: number; // pass>0 の呼び出し数
  reviseCostUsd: number; // 再訳に費やしたコスト
  // キャッシュ書き込み/読み出し比。≈1 は毎回同じ前置きを再キャッシュ（cache_write を払い続けている）兆候。
  cacheWriteReadRatio: number | null;
}

const n = (v: number | undefined): number => v ?? 0;

function emptyGroup(key: string): GroupStat {
  return {
    key,
    calls: 0,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    latencyMsTotal: 0,
  };
}

function add(g: GroupStat, r: LlmCallRecord): void {
  g.calls += 1;
  g.costUsd += n(r.costUsd);
  g.inputTokens += n(r.inputTokens);
  g.outputTokens += n(r.outputTokens);
  g.cacheReadTokens += n(r.cacheReadTokens);
  g.cacheCreationTokens += n(r.cacheCreationTokens);
  g.latencyMsTotal += n(r.latencyMs);
}

export function summarizeTrace(records: LlmCallRecord[]): TraceSummary {
  const total = emptyGroup("total");
  const roles = new Map<string, GroupStat>();
  const passes = new Map<number, { pass: number; calls: number; costUsd: number }>();
  let reviseCalls = 0;
  let reviseCostUsd = 0;

  for (const r of records) {
    add(total, r);

    const roleKey = r.role ?? "unknown";
    const g = roles.get(roleKey) ?? emptyGroup(roleKey);
    add(g, r);
    roles.set(roleKey, g);

    const pass = r.pass ?? 0;
    const p = passes.get(pass) ?? { pass, calls: 0, costUsd: 0 };
    p.calls += 1;
    p.costUsd += n(r.costUsd);
    passes.set(pass, p);
    if (pass > 0) {
      reviseCalls += 1;
      reviseCostUsd += n(r.costUsd);
    }
  }

  return {
    totalCalls: total.calls,
    totalCostUsd: total.costUsd,
    inputTokens: total.inputTokens,
    outputTokens: total.outputTokens,
    cacheReadTokens: total.cacheReadTokens,
    cacheCreationTokens: total.cacheCreationTokens,
    latencyMsTotal: total.latencyMsTotal,
    byRole: [...roles.values()].sort((a, b) => b.costUsd - a.costUsd),
    byPass: [...passes.values()].sort((a, b) => a.pass - b.pass),
    reviseCalls,
    reviseCostUsd,
    cacheWriteReadRatio:
      total.cacheReadTokens > 0 ? total.cacheCreationTokens / total.cacheReadTokens : null,
  };
}
