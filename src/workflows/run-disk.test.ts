import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(path.join(os.tmpdir(), "jpaper-disk-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe(".run の増え方", () => {
  it("論文を直して再投入しても steps が世代ぶん積み上がらない", async () => {
    const { translatePaper } = await import("./translate-paper.js");
    const { FakeLlmClient } = await import("../testing/fake-llm.js");
    const { GlossaryDb } = await import("../terminology/db.js");
    const { makeTar } = await import("../ingest/archive.fixtures.js");

    const work = tmp();
    const outDir = path.join(work, "out");
    const client = new FakeLlmClient((req) => {
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
    const db = new GlossaryDb();
    const counts: number[] = [];
    for (let gen = 0; gen < 4; gen++) {
      const tar = path.join(work, `p${gen}.tar`);
      writeFileSync(
        tar,
        makeTar([
          {
            name: "main.tex",
            content: `\\documentclass{a}\\begin{document}\\section{I}Alpha beta gamma 第${gen}版.\\end{document}`,
          },
        ]),
      );
      await translatePaper({ kind: "path", path: tar }, { provider: "ollama", outDir }, {
        client,
        db,
        latexRunner: (d) => {
          writeFileSync(path.join(d, "main.pdf"), "%PDF");
          return { code: 0, log: "Output written on main.pdf (1 page)." };
        },
      });
      counts.push(readdirSync(path.join(outDir, ".run", "steps")).length);
    }
    db.close();
    // 世代ごとに増えていれば 4 世代目は 1 世代目の 4 倍になる。
    expect(counts[3]).toBe(counts[0]);
  });
});
