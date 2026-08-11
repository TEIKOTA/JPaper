import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(path.join(os.tmpdir(), "jpaper-ghost-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// 4 節。1 節目だけ即座に provider エラーになり、残りは遅い。
const TEX = [
  "\\documentclass{a}\\begin{document}",
  "\\section{Alpha}Alpha text here.",
  "\\section{Bravo}Bravo text here.",
  "\\section{Delta}Delta text here.",
  "\\section{Echo}Echo text here.",
  "\\end{document}",
].join("");

const steps = (outDir: string): string[] =>
  existsSync(path.join(outDir, ".run", "steps"))
    ? readdirSync(path.join(outDir, ".run", "steps")).sort()
    : [];

async function run(outDir: string) {
  const { translatePaper } = await import("./translate-paper.js");
  const { FakeLlmClient } = await import("../testing/fake-llm.js");
  const { GlossaryDb } = await import("../terminology/db.js");
  const { makeTar } = await import("../ingest/archive.fixtures.js");

  const work = tmp();
  const tar = path.join(work, "p.tar");
  writeFileSync(tar, makeTar([{ name: "main.tex", content: TEX }]));

  const client = new FakeLlmClient(async (req) => {
    if (req.system.includes("編纂者")) {
      return JSON.stringify({
        resolved: [],
        brief: { thesis: "核", sectionRoles: [], notationConventions: [] },
        style: { tensePolicy: "a", headingStyle: "b", numberStyle: "c" },
      });
    }
    if (req.user.includes("Alpha")) {
      await new Promise((r) => setTimeout(r, 5));
      throw new Error("provider down");
    }
    // 残りの節は失敗より十分に遅い。修正前はここが返却後に checkpoint を書いていた。
    await new Promise((r) => setTimeout(r, 200));
    if (req.system.includes("審査者")) return '{"verdict":"pass","issues":[]}';
    return JSON.stringify({ segmentId: "x", ja: "これは訳文である。" });
  });

  return translatePaper(
    { kind: "path", path: tar },
    { provider: "ollama", outDir, concurrency: 4 },
    {
      client,
      db: new GlossaryDb(),
      latexRunner: (dir) => {
        writeFileSync(path.join(dir, "main.pdf"), "%PDF");
        return { code: 0, log: "Output written on main.pdf (1 page)." };
      },
    },
  );
}

describe("失敗した run の亡霊セグメント", () => {
  it("返却後に .run/steps へ書き込まない（ロック解放後の checkpoint 汚染）", async () => {
    const outDir = path.join(tmp(), "out");
    const result = await run(outDir);
    expect(result.status).toBe("failed");

    const atReturn = steps(outDir);
    // ロックは返却時点で解放済み＝以後どの書き手も保護されていない。
    expect(existsSync(path.join(outDir, ".run", "run.lock"))).toBe(false);

    await new Promise((r) => setTimeout(r, 600));
    expect(steps(outDir)).toEqual(atReturn);
  });

  it("返却後に進捗を通知しない", async () => {
    const outDir = path.join(tmp(), "out");
    const { translatePaper } = await import("./translate-paper.js");
    const { FakeLlmClient } = await import("../testing/fake-llm.js");
    const { GlossaryDb } = await import("../terminology/db.js");
    const { makeTar } = await import("../ingest/archive.fixtures.js");

    const work = tmp();
    const tar = path.join(work, "p.tar");
    writeFileSync(tar, makeTar([{ name: "main.tex", content: TEX }]));

    let returned = false;
    const late: string[] = [];
    const client = new FakeLlmClient(async (req) => {
      if (req.system.includes("編纂者")) {
        return JSON.stringify({
          resolved: [],
          brief: { thesis: "核", sectionRoles: [], notationConventions: [] },
          style: { tensePolicy: "a", headingStyle: "b", numberStyle: "c" },
        });
      }
      if (req.user.includes("Alpha")) {
        await new Promise((r) => setTimeout(r, 5));
        throw new Error("provider down");
      }
      await new Promise((r) => setTimeout(r, 200));
      if (req.system.includes("審査者")) return '{"verdict":"pass","issues":[]}';
      return JSON.stringify({ segmentId: "x", ja: "これは訳文である。" });
    });

    await translatePaper(
      { kind: "path", path: tar },
      { provider: "ollama", outDir: path.join(tmp(), "out2"), concurrency: 4 },
      {
        client,
        db: new GlossaryDb(),
        onProgress: (p) => {
          if (returned) late.push(`${p.phase} ${p.segmentId ?? ""}`);
        },
        latexRunner: (dir) => {
          writeFileSync(path.join(dir, "main.pdf"), "%PDF");
          return { code: 0, log: "Output written on main.pdf (1 page)." };
        },
      },
    );
    returned = true;
    await new Promise((r) => setTimeout(r, 600));
    expect(late).toEqual([]);
    expect(outDir).toBeTruthy();
  });
});
