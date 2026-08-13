import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { translatePaper } from "./translate-paper.js";
import { GlossaryDb } from "../terminology/db.js";
import { makeTar } from "../ingest/archive.fixtures.js";
import type { LatexRunner } from "../tools/build-gate.js";
import type { LlmClient } from "../types/contract.js";

const okRunner: LatexRunner = (dir) => {
  writeFileSync(path.join(dir, "main.pdf"), "%PDF");
  return { code: 0, log: "Output written on main.pdf (1 page)." };
};

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), "jpaper-conc-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// 翻訳呼び出しの同時実行数を実測するクライアント（応答は待ってから返す）。
function measuringClient(): { client: LlmClient; peak: () => number } {
  let active = 0;
  let peak = 0;
  const client: LlmClient = {
    async complete(req) {
      const translating = req.meta?.role === "translator";
      if (translating) {
        active++;
        peak = Math.max(peak, active);
      }
      await new Promise((r) => setTimeout(r, 20));
      if (translating) active--;
      if (req.system.includes("編纂者")) {
        return JSON.stringify({
          resolved: [],
          brief: { thesis: "核", sectionRoles: [], notationConventions: [] },
          style: { tensePolicy: "a", headingStyle: "b", numberStyle: "c" },
        });
      }
      if (req.system.includes("審査者")) return '{"verdict":"pass","issues":[]}';
      return '{"segmentId":"x","ja":"訳文"}';
    },
  };
  return { client, peak: () => peak };
}

function paperWithSections(n: number): string {
  const body = Array.from({ length: n }, (_, i) => `\\section{S${String(i)}}Alpha ${String(i)}.`).join(
    "",
  );
  const p = path.join(tmp(), "p.tar");
  writeFileSync(
    p,
    makeTar([{ name: "main.tex", content: `\\documentclass{a}\\begin{document}${body}\\end{document}` }]),
  );
  return p;
}

describe("プロバイダ別の既定並列度", () => {
  it("ollama は 1 本ずつ（GPU メモリを共有する相手に並列で窓を積まない）", async () => {
    const m = measuringClient();
    const r = await translatePaper(
      { kind: "path", path: paperWithSections(4) },
      { provider: "ollama", outDir: path.join(tmp(), "out") },
      { client: m.client, db: new GlossaryDb(), latexRunner: okRunner },
    );
    expect(r.summary.segments.total).toBe(4);
    expect(m.peak()).toBe(1);
  });

  it("claude は独立した子プロセスなので従来どおり並列に出す", async () => {
    const m = measuringClient();
    await translatePaper(
      { kind: "path", path: paperWithSections(4) },
      { provider: "claude", outDir: path.join(tmp(), "out") },
      { client: m.client, db: new GlossaryDb(), latexRunner: okRunner },
    );
    expect(m.peak()).toBe(4);
  });

  it("明示指定は provider 別の既定より優先される", async () => {
    const m = measuringClient();
    await translatePaper(
      { kind: "path", path: paperWithSections(4) },
      { provider: "ollama", outDir: path.join(tmp(), "out"), concurrency: 3 },
      { client: m.client, db: new GlossaryDb(), latexRunner: okRunner },
    );
    expect(m.peak()).toBe(3);
  });
});
