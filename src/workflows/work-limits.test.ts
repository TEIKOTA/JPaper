import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(path.join(os.tmpdir(), "jpaper-work-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// 節を大量に含む「小さいが呼び出し回数が爆発する」入力。サイズ上限は全て満たす。
async function manySections(n: number): Promise<string> {
  const { makeTar } = await import("../ingest/archive.fixtures.js");
  const body = Array.from(
    { length: n },
    (_, i) => `\\section{S${i}}Alpha beta gamma delta epsilon zeta.`,
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

async function makeClient(count: { n: number }) {
  const { FakeLlmClient } = await import("../testing/fake-llm.js");
  return new FakeLlmClient((req) => {
    count.n++;
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

describe("1 run の仕事量の上限", () => {
  it("セグメント数超過は節ループを 1 本も回さずに too-large で落ちる", async () => {
    const { translatePaper } = await import("./translate-paper.js");
    const { GlossaryDb } = await import("../terminology/db.js");
    const tar = await manySections(12);
    const outDir = path.join(tmp(), "out");
    const count = { n: 0 };

    const r = await translatePaper(
      { kind: "path", path: tar },
      { provider: "ollama", outDir, concurrency: 1 },
      {
        client: await makeClient(count),
        db: new GlossaryDb(),
        latexRunner: okBuild,
        work: { maxSegments: 3 },
      },
    );
    expect(r.status).toBe("failed");
    expect(r.error?.kind).toBe("too-large");
    expect(r.error?.message).toContain("セグメント");
    // 節ループのチェックポイントが 1 つも作られていない＝翻訳に課金していない。
    const steps = readdirSync(path.join(outDir, ".run", "steps"));
    expect(steps.filter((f) => f.startsWith("seg-"))).toEqual([]);
    // glossary も呼ばない。run 中で最大コンテキストの呼び出しなので、落ちると
    // 分かっている入力に一番高い 1 回を払わない（契約付録 §8）。
    expect(count.n).toBe(0);
    expect(r.summary.llmCalls).toBe(0);
  });

  it("呼び出し回数超過は too-large で落ちる（サイズ上限は全て満たしていても止まる）", async () => {
    const { translatePaper } = await import("./translate-paper.js");
    const { GlossaryDb } = await import("../terminology/db.js");
    const tar = await manySections(8);
    const count = { n: 0 };

    const r = await translatePaper(
      { kind: "path", path: tar },
      { provider: "ollama", outDir: path.join(tmp(), "out"), concurrency: 1 },
      {
        client: await makeClient(count),
        db: new GlossaryDb(),
        latexRunner: okBuild,
        work: { maxSegments: 100, maxLlmCalls: 3 },
      },
    );
    expect(r.status).toBe("failed");
    expect(r.error?.kind).toBe("too-large");
    expect(count.n).toBe(3); // 上限を超えた呼び出しは下位クライアントへ届かない
  });

  it("既定値では通常規模の論文が通る", async () => {
    const { translatePaper } = await import("./translate-paper.js");
    const { GlossaryDb } = await import("../terminology/db.js");
    const tar = await manySections(3);
    const count = { n: 0 };

    const r = await translatePaper(
      { kind: "path", path: tar },
      { provider: "ollama", outDir: path.join(tmp(), "out"), concurrency: 2 },
      { client: await makeClient(count), db: new GlossaryDb(), latexRunner: okBuild },
    );
    expect(r.error?.kind).not.toBe("too-large");
    expect(r.status).toBe("ok");
  });
});
