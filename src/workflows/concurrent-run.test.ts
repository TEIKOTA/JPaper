import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(path.join(os.tmpdir(), "jpaper-concurrent-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const TEX =
  "\\documentclass{a}\\begin{document}\\section{Intro}Alpha text.\\end{document}";

async function harness(outDir: string) {
  const { translatePaper } = await import("./translate-paper.js");
  const { FakeLlmClient } = await import("../testing/fake-llm.js");
  const { GlossaryDb } = await import("../terminology/db.js");
  const { makeTar } = await import("../ingest/archive.fixtures.js");

  const work = tmp();
  const tar = path.join(work, "p.tar");
  writeFileSync(tar, makeTar([{ name: "main.tex", content: TEX }]));

  const client = (ja: string) =>
    new FakeLlmClient(async (req) => {
      await new Promise((r) => setTimeout(r, 5));
      if (req.system.includes("編纂者")) {
        return JSON.stringify({
          resolved: [],
          brief: { thesis: "核", sectionRoles: [], notationConventions: [] },
          style: { tensePolicy: "a", headingStyle: "b", numberStyle: "c" },
        });
      }
      if (req.system.includes("審査者")) return '{"verdict":"pass","issues":[]}';
      return JSON.stringify({ segmentId: "x", ja });
    });

  const runner = (dir: string) => {
    writeFileSync(path.join(dir, "main.pdf"), "%PDF");
    return { code: 0, log: "Output written on main.pdf (1 page)." };
  };

  return (ja: string) =>
    translatePaper(
      { kind: "path", path: tar },
      { provider: "ollama", outDir },
      { client: client(ja), db: new GlossaryDb(), latexRunner: runner },
    );
}

describe("同一 outDir の並行実行", () => {
  it("2 本目は成功を返さず、入力エラーとして明示的に失敗する", async () => {
    const outDir = path.join(tmp(), "out");
    const run = await harness(outDir);

    // await を挟まずに 2 本起動する＝web ハンドラで同時リクエストが来た状況。
    const a = run("これは A の訳文である。");
    const b = run("これは B の訳文である。");
    const [ra, rb] = await Promise.all([a, b]);

    const ok = [ra, rb].filter((r) => r.status === "ok");
    const failed = [ra, rb].filter((r) => r.status === "failed");
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.exitCode).toBe(2);
  });

  it("完了後はロックが残らず、逐次の再実行ができる", async () => {
    const outDir = path.join(tmp(), "out");
    const run = await harness(outDir);

    const first = await run("これは訳文である。");
    expect(first.status).toBe("ok");
    expect(existsSync(path.join(outDir, ".run", "run.lock"))).toBe(false);

    const second = await run("これは訳文である。");
    expect(second.status).toBe("ok");
  });

  it("失敗して抜けてもロックを解放する", async () => {
    const outDir = path.join(tmp(), "out");
    const { translatePaper } = await import("./translate-paper.js");
    const { FakeLlmClient } = await import("../testing/fake-llm.js");
    const { GlossaryDb } = await import("../terminology/db.js");

    const r = await translatePaper(
      { kind: "path", path: path.join(tmp(), "missing.tar") },
      { provider: "ollama", outDir },
      { client: new FakeLlmClient(() => "{}"), db: new GlossaryDb() },
    );
    expect(r.status).toBe("failed");
    expect(existsSync(path.join(outDir, ".run", "run.lock"))).toBe(false);
  });
});

describe("プロセスゲートを deps.gate に渡しても自己デッドロックしない", () => {
  it("limit 1 のプロセスゲートを渡した run が期限切れにならない", async () => {
    const { setLlmGate, llmGate, makeGate } = await import("../runtime/concurrency.js");
    setLlmGate(makeGate(1));
    try {
      const outDir = path.join(tmp(), "out");
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
        if (req.system.includes("審査者")) return '{"verdict":"pass","issues":[]}';
        return JSON.stringify({ segmentId: "x", ja: "これは訳文である。" });
      });

      const r = await translatePaper(
        { kind: "path", path: tar },
        { provider: "ollama", outDir, timeoutMs: 10_000 },
        {
          client,
          db: new GlossaryDb(),
          gate: llmGate(),
          latexRunner: (dir) => {
            writeFileSync(path.join(dir, "main.pdf"), "%PDF");
            return { code: 0, log: "Output written on main.pdf (1 page)." };
          },
        },
      );
      expect(r.status).toBe("ok");
    } finally {
      setLlmGate(undefined);
    }
  });
});
