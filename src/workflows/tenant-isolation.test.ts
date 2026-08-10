import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkpoint } from "../durable/checkpoint.js";
import { z } from "zod";

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(path.join(os.tmpdir(), "jpaper-tenant-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const S = z.object({ v: z.number() });
const KEY_A = Buffer.alloc(32, 1);
const KEY_B = Buffer.alloc(32, 2);

const sigOf = (dir: string): string => {
  const f = readdirSync(path.join(dir, "steps"))[0]!;
  return (JSON.parse(readFileSync(path.join(dir, "steps", f), "utf8")) as { sig: string }).sig;
};

describe("checkpoint 鍵のリクエスト単位の分離", () => {
  it("await を跨いで並行実行しても、それぞれ渡した鍵で署名される", async () => {
    const dirA = tmp();
    const dirB = tmp();
    // A が await で手放している間に B が走る配置。env 方式だとここで鍵が混ざる。
    const a = checkpoint(
      dirA,
      "step",
      S,
      async () => {
        await new Promise((r) => setTimeout(r, 20));
        return { v: 1 };
      },
      { key: KEY_A },
    );
    const b = checkpoint(dirB, "step", S, async () => ({ v: 2 }), { key: KEY_B });
    await Promise.all([a, b]);

    // A の署名は KEY_A でのみ検証できる＝B の鍵に化けていない。
    let usedA = false;
    await checkpoint(dirA, "step", S, async () => {
      usedA = true;
      return { v: 9 };
    }, { key: KEY_A });
    expect(usedA).toBe(false);

    let usedWrongKey = false;
    await checkpoint(dirA, "step", S, async () => {
      usedWrongKey = true;
      return { v: 9 };
    }, { key: KEY_B });
    expect(usedWrongKey).toBe(true);

    expect(sigOf(dirA)).not.toBe(sigOf(dirB));
  });
});

describe("translatePaper への鍵の貫通", () => {
  it("同じ鍵ならキャッシュが効き、別の鍵なら再計算する", async () => {
    const { translatePaper } = await import("./translate-paper.js");
    const { FakeLlmClient } = await import("../testing/fake-llm.js");
    const { GlossaryDb } = await import("../terminology/db.js");
    const { makeTar } = await import("../ingest/archive.fixtures.js");
    const { writeFileSync } = await import("node:fs");

    const work = tmp();
    const tar = path.join(work, "p.tar");
    writeFileSync(
      tar,
      makeTar([
        {
          name: "main.tex",
          content:
            "\\documentclass{a}\\begin{document}\\section{Intro}Alpha text.\\end{document}",
        },
      ]),
    );

    let calls = 0;
    const client = () =>
      new FakeLlmClient((req) => {
        calls++;
        if (req.system.includes("編纂者")) {
          return JSON.stringify({
            resolved: [],
            brief: { thesis: "核", sectionRoles: [], notationConventions: [] },
            style: { tensePolicy: "a", headingStyle: "b", numberStyle: "c" },
          });
        }
        if (req.system.includes("審査者")) return '{"verdict":"pass","issues":[]}';
        return '{"segmentId":"x","ja":"これは訳文である。"}';
      });

    const outDir = path.join(work, "out");
    const runner = (dir: string) => {
      writeFileSync(path.join(dir, "main.pdf"), "%PDF");
      return { code: 0, log: "Output written on main.pdf (1 page)." };
    };
    const run = (key: Buffer) =>
      translatePaper(
        { kind: "path", path: tar },
        { provider: "ollama", outDir },
        {
          client: client(),
          db: new GlossaryDb(),
          latexRunner: runner,
          cacheKey: key,
        },
      );

    await run(KEY_A);
    const afterFirst = calls;
    expect(afterFirst).toBeGreaterThan(0);

    await run(KEY_A); // 同じ鍵＝キャッシュが効く
    expect(calls).toBe(afterFirst);

    await run(KEY_B); // 別の鍵＝署名が合わず再計算
    expect(calls).toBeGreaterThan(afterFirst);
  });
});
