import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RunProgress } from "./translate-paper.js";

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(path.join(os.tmpdir(), "jpaper-notify-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function fixture(): Promise<string> {
  const { makeTar } = await import("../ingest/archive.fixtures.js");
  const work = tmp();
  const tar = path.join(work, "p.tar");
  writeFileSync(
    tar,
    makeTar([
      {
        name: "main.tex",
        content:
          "\\documentclass{a}\\begin{document}\\section{I}Alpha beta.\\section{II}Gamma delta.\\end{document}",
      },
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

describe("通知チャネルの分離", () => {
  it("onProgress が投げても run の結果は変わらない", async () => {
    const { translatePaper } = await import("./translate-paper.js");
    const { GlossaryDb } = await import("../terminology/db.js");
    const r = await translatePaper(
      { kind: "path", path: await fixture() },
      { provider: "ollama", outDir: path.join(tmp(), "out"), concurrency: 1 },
      {
        client: await fakeClient(),
        db: new GlossaryDb(),
        latexRunner: okBuild,
        onProgress: () => {
          throw new Error("SSE 切断");
        },
      },
    );
    expect(r.status).toBe("ok");
    expect(r.summary.llmCalls).toBeGreaterThan(0);
  });

  it("onError が投げても例外は外へ出ない", async () => {
    const { translatePaper } = await import("./translate-paper.js");
    const { GlossaryDb } = await import("../terminology/db.js");
    const r = await translatePaper(
      { kind: "path", path: await fixture() },
      { provider: "ollama", outDir: path.join(tmp(), "out"), concurrency: 1 },
      {
        client: { complete: () => Promise.reject(new Error("provider down")) },
        db: new GlossaryDb(),
        onError: () => {
          throw new Error("logger down");
        },
      },
    );
    expect(r.status).toBe("failed");
    expect(r.error?.kind).toBe("provider");
  });

  it("onError も外向き検疫を通る", async () => {
    const { translatePaper } = await import("./translate-paper.js");
    const { GlossaryDb } = await import("../terminology/db.js");
    const esc = "";
    const seen: string[] = [];
    await translatePaper(
      { kind: "path", path: await fixture() },
      { provider: "ollama", outDir: path.join(tmp(), "out"), concurrency: 1 },
      {
        client: await fakeClient(),
        db: new GlossaryDb(),
        latexRunner: () => ({
          code: 1,
          log: `! LaTeX Error: File \`fig${esc}[2J' not found. /Users/victim/.ssh/id_rsa`,
        }),
        onError: (m) => seen.push(m),
      },
    );
    expect(seen.length).toBeGreaterThan(0);
    for (const m of seen) {
      expect(m).not.toContain(esc);
      expect(m).not.toContain("/Users/victim");
    }
  });

  it("4 フェーズすべての進捗が飛ぶ", async () => {
    const { translatePaper } = await import("./translate-paper.js");
    const { GlossaryDb } = await import("../terminology/db.js");
    const seen: RunProgress[] = [];
    const r = await translatePaper(
      { kind: "path", path: await fixture() },
      { provider: "ollama", outDir: path.join(tmp(), "out"), concurrency: 1 },
      {
        client: await fakeClient(),
        db: new GlossaryDb(),
        latexRunner: okBuild,
        onProgress: (e) => seen.push(e),
      },
    );
    expect(r.status).toBe("ok");
    for (const phase of ["ingest", "context", "translate", "typeset"]) {
      expect(seen.some((e) => e.phase === phase)).toBe(true);
    }
    expect(seen.some((e) => e.phase === "context" && e.done === 1)).toBe(true);
  });
});

describe("素の .tex 入力の上限", () => {
  it("上限超過は LLM を呼ぶ前に too-large で落ち、本文を .run へ残さない", async () => {
    const { translatePaper } = await import("./translate-paper.js");
    const { GlossaryDb } = await import("../terminology/db.js");
    const work = tmp();
    const tex = path.join(work, "main.tex");
    writeFileSync(
      tex,
      `\\documentclass{a}\\begin{document}\\section{I}${"Alpha beta gamma. ".repeat(2000)}\\end{document}`,
    );
    const outDir = path.join(work, "out");
    const r = await translatePaper(
      { kind: "path", path: tex },
      { provider: "ollama", outDir },
      {
        client: await fakeClient(),
        db: new GlossaryDb(),
        limits: { maxArchiveBytes: 1024, maxTotalBytes: 1024, maxEntryBytes: 1024, maxEntries: 10 },
      },
    );
    expect(r.status).toBe("failed");
    expect(r.error?.kind).toBe("too-large");
    expect(r.summary.llmCalls).toBe(0);
    const steps = path.join(outDir, ".run", "steps");
    expect(existsSync(steps) ? readdirSync(steps) : []).toEqual([]);
  });
});
