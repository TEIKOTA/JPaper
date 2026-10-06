import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LlmCallEvent } from "../types/contract.js";
import type { RunProgress } from "./translate-paper.js";

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(path.join(os.tmpdir(), "jpaper-obs-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function paper(sections: number): Promise<string> {
  const { makeTar } = await import("../ingest/archive.fixtures.js");
  const body = Array.from(
    { length: sections },
    (_, i) => `\\section{S${i}}Alpha beta gamma delta epsilon.`,
  ).join("\n");
  const work = tmp();
  const tar = path.join(work, "p.tar");
  writeFileSync(
    tar,
    makeTar([
      { name: "main.tex", content: `\\documentclass{a}\\begin{document}${body}\\end{document}` },
    ]),
  );
  return tar;
}

async function fakeClient() {
  const { FakeLlmClient } = await import("../testing/fake-llm.js");
  return new FakeLlmClient((req) => {
    if (req.system.includes("編纂者")) {
      return JSON.stringify({
        resolved: [],
        brief: { thesis: "テーゼX", sectionRoles: [], notationConventions: [] },
        style: { tensePolicy: "a", headingStyle: "b", numberStyle: "c" },
      });
    }
    if (req.system.includes("審査者")) return '{"verdict":"pass","issues":[]}';
    return '{"segmentId":"x","ja":"これは訳文である。"}';
  });
}

const okBuild = (d: string) => {
  writeFileSync(path.join(d, "main.pdf"), "%PDF");
  return { code: 0, log: "Output written on main.pdf (1 page)." };
};

describe("注入クライアントの観測", () => {
  it("トレースが書かれ、呼び出し回数が RunSummary に載る", async () => {
    const { translatePaper } = await import("./translate-paper.js");
    const { GlossaryDb } = await import("../terminology/db.js");
    const outDir = path.join(tmp(), "out");
    const r = await translatePaper(
      { kind: "path", path: await paper(2) },
      { provider: "ollama", outDir, concurrency: 1 },
      { client: await fakeClient(), db: new GlossaryDb(), latexRunner: okBuild },
    );
    expect(r.status).toBe("ok");
    expect(r.summary.llmCalls).toBeGreaterThan(0);
    const traceFile = path.join(outDir, ".run", "llm-trace.jsonl");
    expect(existsSync(traceFile)).toBe(true);
    const lines = readFileSync(traceFile, "utf8").trim().split("\n");
    expect(lines).toHaveLength(r.summary.llmCalls);
    const first = JSON.parse(lines[0]!) as LlmCallEvent & { runId: string };
    expect(first.runId).toContain("-");
    expect(first.provider).toBe("ollama");
  });

  it("注入した TraceSink が使われる（web が自前の収集先を持てる）", async () => {
    const { translatePaper } = await import("./translate-paper.js");
    const { GlossaryDb } = await import("../terminology/db.js");
    const events: LlmCallEvent[] = [];
    await translatePaper(
      { kind: "path", path: await paper(1) },
      { provider: "ollama", outDir: path.join(tmp(), "out"), concurrency: 1 },
      {
        client: await fakeClient(),
        db: new GlossaryDb(),
        latexRunner: okBuild,
        trace: (e) => events.push(e),
      },
    );
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => e.role === "translator")).toBe(true);
  });

  it("失敗した run でも呼び出し回数が返る（どこまで課金したか）", async () => {
    const { translatePaper } = await import("./translate-paper.js");
    const { GlossaryDb } = await import("../terminology/db.js");
    const r = await translatePaper(
      { kind: "path", path: await paper(4) },
      { provider: "ollama", outDir: path.join(tmp(), "out"), concurrency: 1 },
      {
        client: await fakeClient(),
        db: new GlossaryDb(),
        latexRunner: okBuild,
        work: { maxLlmCalls: 2 },
      },
    );
    expect(r.status).toBe("failed");
    expect(r.error?.kind).toBe("too-large");
    expect(r.summary.llmCalls).toBe(2);
  });

  it("節ごとに進捗が通知される", async () => {
    const { translatePaper } = await import("./translate-paper.js");
    const { GlossaryDb } = await import("../terminology/db.js");
    const seen: RunProgress[] = [];
    const r = await translatePaper(
      { kind: "path", path: await paper(3) },
      { provider: "ollama", outDir: path.join(tmp(), "out"), concurrency: 1 },
      {
        client: await fakeClient(),
        db: new GlossaryDb(),
        latexRunner: okBuild,
        onProgress: (e) => seen.push(e),
      },
    );
    expect(r.status).toBe("ok");
    const translate = seen.filter((e) => e.phase === "translate" && e.segmentId !== undefined);
    expect(translate).toHaveLength(r.summary.segments.total);
    expect(translate.at(-1)?.done).toBe(r.summary.segments.total);
    expect(seen.some((e) => e.phase === "context")).toBe(true);
    // 合否を載せないと、失敗した節は checkpoint に残らないので実行中に観測できない。
    expect(translate.every((e) => e.passed === true)).toBe(true);
    expect(translate.every((e) => typeof e.maxRevisions === "number")).toBe(true);
  });

  it("落ちた節の進捗には合否と検査の種別が載る", async () => {
    const { translatePaper } = await import("./translate-paper.js");
    const { GlossaryDb } = await import("../terminology/db.js");
    const { FakeLlmClient } = await import("../testing/fake-llm.js");
    const seen: RunProgress[] = [];
    // 数式を落とす訳文を返す＝ formalCheck の math で落ちる。
    const client = new FakeLlmClient((req) => {
      if (req.system.includes("編纂者")) {
        return JSON.stringify({
          resolved: [],
          brief: { thesis: "核", sectionRoles: [], notationConventions: [] },
          style: { tensePolicy: "a", headingStyle: "b", numberStyle: "c" },
        });
      }
      if (req.system.includes("審査者")) return '{"verdict":"pass","issues":[]}';
      return JSON.stringify({ segmentId: "x", ja: "訳文である。" });
    });
    const { makeTar } = await import("../ingest/archive.fixtures.js");
    const tar = path.join(tmp(), "p.tar");
    writeFileSync(
      tar,
      makeTar([
        {
          name: "main.tex",
          content:
            "\\documentclass{a}\\begin{document}\\section{S}Alpha with $x = 1$ inside.\\end{document}",
        },
      ]),
    );
    await translatePaper(
      { kind: "path", path: tar },
      { provider: "ollama", outDir: path.join(tmp(), "out"), concurrency: 1 },
      { client, db: new GlossaryDb(), latexRunner: okBuild, onProgress: (e) => seen.push(e) },
    );
    const failed = seen.filter((e) => e.phase === "translate" && e.passed === false);
    expect(failed.length).toBeGreaterThan(0);
    expect(failed[0]?.failedKinds).toContain("math");
  });
});

describe("失敗した呼び出しの記録", () => {
  it("失敗もトレースに残る（課金は成功回数ではなく試行回数）", async () => {
    const { withTrace } = await import("../runtime/trace.js");
    const events: LlmCallEvent[] = [];
    const client = withTrace(
      { complete: () => Promise.reject(new Error("boom")) },
      (e) => events.push(e),
      "ollama",
    );
    await client.complete({ system: "s", user: "u" }).catch(() => undefined);
    expect(events).toHaveLength(1);
    expect(events[0]!.failed).toBe(true);
  });
});
