import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { translatePaper } from "./translate-paper.js";
import { GlossaryDb } from "../terminology/db.js";
import { FakeLlmClient } from "../testing/fake-llm.js";
import { makeTar } from "../ingest/archive.fixtures.js";
import { readStep, writeStep } from "../durable/checkpoint.js";
import { FORMAL_GATE } from "./quality-gate.js";
import type { LatexRunner } from "../tools/build-gate.js";
import type { LlmClient } from "../types/contract.js";

const okRunner: LatexRunner = (dir) => {
  writeFileSync(path.join(dir, "main.pdf"), "%PDF");
  return { code: 0, log: "Output written on main.pdf (1 page)." };
};

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const GOOD = "\\section{A}アルファの訳文 〔1〕 である。";

function client(ja = GOOD): FakeLlmClient {
  return new FakeLlmClient((req) => {
    if (req.system.includes("編纂者")) {
      return JSON.stringify({
        resolved: [],
        brief: { thesis: "核", sectionRoles: [], notationConventions: [] },
        style: { tensePolicy: "a", headingStyle: "b", numberStyle: "c" },
      });
    }
    if (req.system.includes("審査者")) return '{"verdict":"pass","issues":[]}';
    return "```tex\n" + ja + "\n```";
  });
}

const throwing: LlmClient = {
  complete: () => Promise.reject(new Error("LLM を呼んではいけない")),
};

function setup(content = "\\documentclass{a}\\begin{document}\\section{A}Alpha text with $x = 1$ inside.\\end{document}", id = "seg-0000") {
  const d = mkdtempSync(path.join(os.tmpdir(), "jpaper-gate-"));
  dirs.push(d);
  const tar = path.join(d, "p.tar");
  writeFileSync(
    tar,
    makeTar([{ name: "main.tex", content }]),
  );
  const outDir = path.join(d, "out");
  const key = randomBytes(32);
  const run = async (c: LlmClient, errs: string[] = []) => {
    const db = new GlossaryDb();
    const r = await translatePaper({ kind: "path", path: tar }, { provider: "ollama", outDir, bilingual: false }, {
      client: c,
      db,
      latexRunner: okRunner,
      cacheKey: key,
      onError: (m) => errs.push(m),
    });
    db.close();
    return r;
  };
  const runDir = path.join(outDir, ".run");
  const step = () => readStep(runDir, id, key)!;
  const put = (value: unknown) => writeStep(runDir, id, value, { invalidation: step().invalidation, key });
  const rewrite = (patch: Record<string, unknown>) => put({ ...(step().value as object), ...patch });
  return { run, step, rewrite, put };
}

describe("形式検査の版（契約付録 §8・issue #254）", () => {
  it("通った節の checkpoint は印のままの訳文と今の形式検査の版を持つ", async () => {
    const { run, step } = setup();
    expect((await run(client())).exitCode).toBe(0);
    expect(step().value).toMatchObject({ passed: true, marked: GOOD, gate: FORMAL_GATE });
  });

  it("版が違っても今の検査に通れば LLM を呼ばずに使い、版を書き換える", async () => {
    const { run, step, rewrite } = setup();
    await run(client());
    rewrite({ gate: "0:old" });
    const r = await run(throwing);
    expect(r.exitCode).toBe(0);
    expect(step().value).toMatchObject({ gate: FORMAL_GATE });
  });

  it("版が違い今の検査に落ちれば、その節を訳し直して知らせる", async () => {
    const { run, step, rewrite } = setup();
    await run(client());
    // 数式の印を落とした訳文を、古い版の検査で通ったことにする。
    rewrite({ gate: "0:old", marked: "\\section{A}アルファの訳文である。", ja: "\\section{A}アルファの訳文である。" });
    const errs: string[] = [];
    const c = client();
    const r = await run(c, errs);
    expect(r.exitCode).toBe(0);
    expect(c.calls.some((q) => q.meta?.role === "translator" && q.meta.segmentId === "seg-0000")).toBe(true);
    expect(errs.some((m) => m.includes("形式検査が変わったため") && m.includes("seg-0000"))).toBe(true);
    expect(step().value).toMatchObject({ marked: GOOD, gate: FORMAL_GATE });
  });

  it("印のままの訳文を持たない旧版の checkpoint は再検査せずに使う", async () => {
    const { run, step, put } = setup();
    await run(client());
    const { marked: _m, gate: _g, ...old } = step().value as Record<string, unknown>;
    put({ ...old, ja: "\\section{A}アルファの訳文である。" });
    expect((await run(throwing)).exitCode).toBe(0);
    expect(step().value).not.toHaveProperty("gate");
  });

  it("印のままの訳文が checkpoint の訳文と対応しなければ再検査せずに使う", async () => {
    const { run, rewrite } = setup();
    await run(client());
    rewrite({ gate: "0:old", marked: "\\section{A}別の訳である。" });
    expect((await run(throwing)).exitCode).toBe(0);
  });

  it("タイトル節も再検査する: 通れば LLM なし、落ちれば訳し直す", async () => {
    const paper =
      "\\documentclass{a}\\title{Alpha Study}\\begin{document}\\maketitle\\section{A}Alpha text with $x = 1$ inside.\\end{document}";
    const titled = (ja: string) =>
      new FakeLlmClient((req) => {
        if (req.system.includes("編纂者")) {
          return JSON.stringify({
            resolved: [],
            brief: { thesis: "核", sectionRoles: [], notationConventions: [] },
            style: { tensePolicy: "a", headingStyle: "b", numberStyle: "c" },
          });
        }
        if (req.system.includes("審査者")) return '{"verdict":"pass","issues":[]}';
        return req.meta?.segmentId === "title" ? "```tex\n" + ja + "\n```" : "```tex\n" + GOOD + "\n```";
      });
    const ok = setup(paper, "title");
    expect((await ok.run(titled("\\title{甲の研究}"))).summary.title).toBe("translated");
    ok.rewrite({ gate: "0:old" });
    const r = await ok.run(throwing);
    expect(r.summary.title).toBe("translated");
    expect(ok.step().value).toMatchObject({ gate: FORMAL_GATE });

    const ng = setup(paper, "title");
    await ng.run(titled("\\title{甲の研究}"));
    // 文書構造を壊す綴りを持ち込んだタイトルを、古い版で通ったことにする。
    ng.rewrite({ gate: "0:old", marked: "\\title{甲の研究}\\end{document}", ja: "\\title{甲の研究}\\end{document}" });
    const errs: string[] = [];
    const c = titled("\\title{甲の研究}");
    await ng.run(c, errs);
    expect(errs.some((m) => m.includes("以前に通したタイトルを訳し直します"))).toBe(true);
    expect(ng.step().value).toMatchObject({ ja: "\\title{甲の研究}", gate: FORMAL_GATE });
  });

  it("著者を伏せた節の印のままの訳文も、今の検査に通る（節ループと同じ判定）", async () => {
    const paper =
      "\\documentclass{a}\\begin{document}\\section{A}\\author{Jane Doe}Alpha text with $x = 1$ inside.\\end{document}";
    const g = setup(paper);
    const c = new FakeLlmClient((req) => {
      if (req.system.includes("編纂者")) {
        return JSON.stringify({
          resolved: [],
          brief: { thesis: "核", sectionRoles: [], notationConventions: [] },
          style: { tensePolicy: "a", headingStyle: "b", numberStyle: "c" },
        });
      }
      if (req.system.includes("審査者")) return '{"verdict":"pass","issues":[]}';
      return "```tex\n\\section{A}〔1〕アルファの訳文 〔2〕 である。\n```";
    });
    expect((await g.run(c)).exitCode).toBe(0);
    g.rewrite({ gate: "0:old" });
    expect((await g.run(throwing)).exitCode).toBe(0);
    expect(g.step().value).toMatchObject({ gate: FORMAL_GATE });
  });
});
