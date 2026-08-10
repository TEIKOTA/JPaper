#!/usr/bin/env tsx
// llm-trace.jsonl を読んでコスト内訳を表示する（LLM トレース ADR 20260722）。
// 使い方: npx tsx scripts/analyze-trace.mts <path/to/llm-trace.jsonl>
import { existsSync, readFileSync } from "node:fs";
import { summarizeTrace } from "../src/tools/analyze-trace.js";
import type { LlmCallRecord } from "../src/types/contract.js";

const file = process.argv[2];
if (!file) {
  console.error("usage: tsx scripts/analyze-trace.mts <llm-trace.jsonl>");
  process.exit(2);
}

// 退避ファイル（.1）も読む。読まないとローテーション後の集計が黙って過少になる。
const sources = [`${file}.1`, file].filter((f) => existsSync(f));
const records: LlmCallRecord[] = sources
  .flatMap((f) => readFileSync(f, "utf8").split("\n"))
  .filter((l) => l.trim() !== "")
  .map((l) => JSON.parse(l) as LlmCallRecord);

const s = summarizeTrace(records);
const usd = (v: number) => `$${v.toFixed(4)}`;
const pct = (v: number, total: number) => (total > 0 ? `${((v / total) * 100).toFixed(1)}%` : "-");
const k = (v: number) => `${(v / 1000).toFixed(1)}k`;

console.log(`\n=== LLM トレース集計 (${records.length} calls) ===`);
console.log(`総コスト: ${usd(s.totalCostUsd)}  総時間: ${(s.latencyMsTotal / 1000).toFixed(1)}s`);
console.log(
  `トークン: in=${k(s.inputTokens)} out=${k(s.outputTokens)} cacheRead=${k(s.cacheReadTokens)} cacheWrite=${k(s.cacheCreationTokens)}`,
);
console.log(
  `cache書込/読出比: ${s.cacheWriteReadRatio === null ? "-" : s.cacheWriteReadRatio.toFixed(2)}（≈1 は毎回再キャッシュの兆候）`,
);

console.log(`\n--- role 別（コスト降順）---`);
console.log("role".padEnd(18) + "calls".padStart(7) + "cost".padStart(11) + "  %" + "  out(tok)".padStart(11));
for (const g of s.byRole) {
  console.log(
    g.key.padEnd(18) +
      String(g.calls).padStart(7) +
      usd(g.costUsd).padStart(11) +
      pct(g.costUsd, s.totalCostUsd).padStart(6) +
      k(g.outputTokens).padStart(11),
  );
}

console.log(`\n--- pass 別（0=初回, >0=再訳）---`);
for (const p of s.byPass) {
  console.log(
    `pass ${p.pass}`.padEnd(18) +
      String(p.calls).padStart(7) +
      usd(p.costUsd).padStart(11) +
      pct(p.costUsd, s.totalCostUsd).padStart(6),
  );
}
console.log(
  `\n再訳（pass>0）: ${s.reviseCalls} calls / ${usd(s.reviseCostUsd)}（総コストの ${pct(s.reviseCostUsd, s.totalCostUsd)}）\n`,
);
