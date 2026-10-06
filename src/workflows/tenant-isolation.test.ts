import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkpoint } from "../durable/checkpoint.js";
import { DEFAULT_LIMITS } from "../ingest/limits.js";
import { DEFAULT_WORK_LIMITS } from "../runtime/work-budget.js";
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

describe("取り込み上限の注入", () => {
  it("translatePaper に渡した limits が実際に効く（プラン別の上限を掛けられる）", async () => {
    const { translatePaper } = await import("./translate-paper.js");
    const { FakeLlmClient } = await import("../testing/fake-llm.js");
    const { GlossaryDb } = await import("../terminology/db.js");
    const { makeTar } = await import("../ingest/archive.fixtures.js");
    const { DEFAULT_LIMITS } = await import("../ingest/limits.js");
    const { writeFileSync } = await import("node:fs");

    const work = tmp();
    const tar = path.join(work, "p.tar");
    writeFileSync(
      tar,
      makeTar([
        {
          name: "main.tex",
          content: "\\documentclass{a}\\begin{document}\\section{I}Alpha.\\end{document}",
        },
      ]),
    );

    let calls = 0;
    const deps = () => ({
      client: new FakeLlmClient((req) => {
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
      }),
      db: new GlossaryDb(),
      // 実 latexmk を起動しない（この検査の対象は取り込み上限）。
      latexRunner: () => ({ code: 1, log: "" }),
    });

    // 既定の上限なら取り込みは通る（LLM まで到達する）。
    const ok = await translatePaper(
      { kind: "path", path: tar },
      { provider: "ollama", outDir: path.join(work, "out1") },
      deps(),
    );
    expect(ok.error?.kind).not.toBe("too-large");
    expect(calls).toBeGreaterThan(0);

    // 締めた上限では取り込み段で弾かれる。
    calls = 0;
    const tight = await translatePaper(
      { kind: "path", path: tar },
      { provider: "ollama", outDir: path.join(work, "out2") },
      { ...deps(), limits: { ...DEFAULT_LIMITS, maxArchiveBytes: 10 } },
    );
    expect(tight.error?.kind).toBe("too-large");
    expect(calls).toBe(0);
  });
});

describe("単一ユーザ既定の可視化", () => {
  const makeRun = async () => {
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
          content: "\\documentclass{a}\\begin{document}\\section{I}Alpha text.\\end{document}",
        },
      ]),
    );
    const client = () =>
      new FakeLlmClient((req) => {
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
    return { translatePaper, tar, client, GlossaryDb, work };
  };

  it("分離を渡していれば sharedDefaults は空になる", async () => {
    const { translatePaper, tar, client, GlossaryDb, work } = await makeRun();
    const warns: string[] = [];
    const r = await translatePaper(
      { kind: "path", path: tar },
      { provider: "ollama", outDir: path.join(work, "tenant-a") },
      {
        client: client(),
        db: new GlossaryDb(),
        cacheKey: Buffer.alloc(32, 7),
        limits: DEFAULT_LIMITS,
        work: DEFAULT_WORK_LIMITS,
        latexRunner: () => ({ code: 1, log: "" }),
        onError: (m) => warns.push(m),
      },
    );
    expect(r.summary.sharedDefaults).toEqual([]);
    expect(warns.filter((w) => w.includes("単一ユーザ既定"))).toEqual([]);
  });

  it("既定へ落ちた資源を summary と警告で観測できる", async () => {
    const { translatePaper, tar, client, GlossaryDb, work } = await makeRun();
    const warns: string[] = [];
    const r = await translatePaper(
      { kind: "path", path: tar },
      // outDir を渡さない＝cwd 直下の <paperId>-ja へ書く単一ユーザ既定。
      { provider: "ollama" },
      {
        client: client(),
        db: new GlossaryDb(), // db は注入済みなので shared に数えない
        latexRunner: () => ({ code: 1, log: "" }),
        onError: (m) => warns.push(m),
      },
    );
    expect(r.summary.sharedDefaults).toContain("cacheKey");
    expect(r.summary.sharedDefaults).toContain("outDir");
    expect(r.summary.sharedDefaults).not.toContain("db");
    // 既定の取り込み上限・仕事量上限も可視化する。実測では資源の分離より、こちらの
    // ほうがプロセスの生死を左右した（506KiB の .tar.gz が 508MiB に展開されて成功）。
    expect(r.summary.sharedDefaults).toContain("limits");
    expect(r.summary.sharedDefaults).toContain("work");
    expect(warns.some((w) => w.includes("単一ユーザ既定"))).toBe(true);
    // 既定の出力先は cwd 直下の <paperId>-ja＝作業用 tmp ではない、が「分離できていない」証拠。
    expect(existsSync(path.join(process.cwd(), `${r.summary.paperId}-ja`))).toBe(true);
    expect(existsSync(path.join(work, `${r.summary.paperId}-ja`))).toBe(false);
    rmSync(path.join(process.cwd(), `${r.summary.paperId}-ja`), {
      recursive: true,
      force: true,
    });
  });

  it("失敗して抜けた run でも sharedDefaults を返す", async () => {
    const { translatePaper } = await import("./translate-paper.js");
    const { FakeLlmClient } = await import("../testing/fake-llm.js");
    const { GlossaryDb } = await import("../terminology/db.js");
    const r = await translatePaper(
      { kind: "path", path: path.join(tmp(), "missing.tar") },
      { provider: "ollama", outDir: path.join(tmp(), "out") },
      { client: new FakeLlmClient(() => "{}"), db: new GlossaryDb() },
    );
    expect(r.status).toBe("failed");
    expect(r.summary.sharedDefaults).toContain("cacheKey");
  });
});

describe("注入クライアントにも同時実行ゲートが掛かる", () => {
  it("deps.client を渡してもプロセス上限を素通りしない", async () => {
    const { translatePaper } = await import("./translate-paper.js");
    const { FakeLlmClient } = await import("../testing/fake-llm.js");
    const { GlossaryDb } = await import("../terminology/db.js");
    const { makeTar } = await import("../ingest/archive.fixtures.js");
    const { makeGate } = await import("../runtime/concurrency.js");
    const { writeFileSync } = await import("node:fs");

    const work = tmp();
    const tar = path.join(work, "p.tar");
    const body = Array.from({ length: 8 }, (_, i) => `\\section{S${i}}Alpha beta gamma.`).join(
      "\n\n",
    );
    writeFileSync(
      tar,
      makeTar([
        { name: "main.tex", content: `\\documentclass{a}\\begin{document}${body}\\end{document}` },
      ]),
    );

    let inFlight = 0;
    let peak = 0;
    const client = new FakeLlmClient(async (req) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 3));
      inFlight--;
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

    await translatePaper(
      { kind: "path", path: tar },
      { provider: "ollama", outDir: path.join(work, "out"), concurrency: 8 },
      {
        client,
        db: new GlossaryDb(),
        gate: makeGate(2),
        latexRunner: () => ({ code: 1, log: "" }),
      },
    );
    expect(peak).toBeLessThanOrEqual(2);
  });
});

describe("空白のみの dbPath", () => {
  it("「未指定」として扱い、cwd に空白名の DB を作らない", async () => {
    const { translatePaper } = await import("./translate-paper.js");
    const { FakeLlmClient } = await import("../testing/fake-llm.js");
    const { readdirSync } = await import("node:fs");

    const before = new Set(readdirSync(process.cwd()));
    const r = await translatePaper(
      { kind: "path", path: path.join(tmp(), "missing.tar") },
      { provider: "ollama", outDir: path.join(tmp(), "out") },
      { client: new FakeLlmClient(() => "{}"), dbPath: "  " },
    );
    expect(r.status).toBe("failed");
    // 報告（sharedDefaults）と実挙動を一致させる。
    expect(r.summary.sharedDefaults).toContain("db");
    const added = readdirSync(process.cwd()).filter((f) => !before.has(f));
    expect(added).toEqual([]);
  });
});
