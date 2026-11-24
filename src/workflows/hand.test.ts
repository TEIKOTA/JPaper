// 契約付録 §8（手で訳した節）。
import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { handResult } from "./section-loop.js";
import { translatePaper, type TranslateDeps, type TranslateOptions } from "./translate-paper.js";
import { rebuildKept } from "./rebuild.js";
import { GlossaryDb } from "../terminology/db.js";
import { FakeLlmClient } from "../testing/fake-llm.js";
import { makeTar } from "../ingest/archive.fixtures.js";
import type { LatexRunner } from "../tools/build-gate.js";
import type { Segment } from "../segment/segmenter.js";
import type { JpaperInput } from "../types/contract.js";

const okRunner: LatexRunner = (dir) => {
  writeFileSync(path.join(dir, "main.pdf"), "%PDF");
  return { code: 0, log: "Output written on main.pdf (1 page)." };
};

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), "jpaper-hand-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// Beta の節だけ、訳文に原文に無い数式を足して形式検査に落とす translator。
function mkClient(opts: { breakBeta?: boolean } = {}): FakeLlmClient {
  return new FakeLlmClient((req) => {
    if (req.system.includes("編纂者")) {
      return JSON.stringify({
        resolved: [{ src: "Alpha", form: "甲", class: "established", rendering: "translate" }],
        brief: { thesis: "核", sectionRoles: [], notationConventions: [] },
        style: { tensePolicy: "a", headingStyle: "b", numberStyle: "c" },
      });
    }
    if (req.system.includes("審査者")) return '{"verdict":"pass","issues":[]}';
    if (opts.breakBeta === true && req.user.includes("Beta")) return '{"segmentId":"x","ja":"訳文 $x$"}';
    return '{"segmentId":"x","ja":"訳文"}';
  });
}

function makePaperTar(): string {
  const p = path.join(tmp(), "p.tar");
  writeFileSync(
    p,
    makeTar([
      {
        name: "main.tex",
        content:
          "\\documentclass{a}\\begin{document}\\section{Intro}Alpha text.\\section{Body}Beta text.\\end{document}",
      },
    ]),
  );
  return p;
}

const run = (
  input: JpaperInput,
  opts: Partial<TranslateOptions> & { outDir: string },
  deps: TranslateDeps,
) => translatePaper(input, { provider: "claude", ...opts }, { latexRunner: okRunner, ...deps });

const translatorSaw = (c: FakeLlmClient, s: string): boolean =>
  c.calls.some((x) => !x.system.includes("編纂者") && !x.system.includes("審査者") && x.user.includes(s));

describe("handResult（手で訳した節の形式検査）", () => {
  const seg: Segment = { id: "seg-0000", latex: "Intro text $a$.", tokens: 100 };

  it("形式検査に通れば passed、evaluator を経ず revisions は 0", () => {
    const r = handResult(seg, [], "序論の文 $a$。");
    expect(r.passed).toBe(true);
    expect(r.ja).toBe("序論の文 $a$。");
    expect(r.usedRevisions).toBe(0);
  });

  it("数式を落とした訳は formal（failCode 3）で落ち、指摘を lastIssues に残す", () => {
    const r = handResult(seg, [], "序論の文。");
    expect(r.passed).toBe(false);
    expect(r.failCode).toBe(3);
    expect(r.lastIssues?.by).toBe("formal");
  });

  it("危険コマンドを持ち込んだ訳は unsafe-command で落ちる", () => {
    const r = handResult(seg, [], "序論の文 $a$。\\write18{rm -rf ~}");
    expect(r.passed).toBe(false);
    expect(r.failedKinds).toContain("unsafe-command");
  });

  describe("原文のまま残す区間", () => {
    const latex = "\\title{Alpha Study}\n\\author{Ann Lee \\\\ Nankai University}\n\nAlpha text is here.";
    const titleSeg: Segment = {
      id: "seg-0000",
      latex,
      tokens: 100,
      keep: { start: 0, end: "\\title{Alpha Study}".length },
    };

    it("\\title と \\author を原文のまま 1 回ずつ置けば通る", () => {
      const r = handResult(titleSeg, [], "\\title{Alpha Study}\n\\author{Ann Lee \\\\ Nankai University}\n\n甲の本文がここにある。");
      expect(r.passed).toBe(true);
    });

    it("\\title を訳すと title、\\author を落とすと author で落ちる", () => {
      const t = handResult(titleSeg, [], "\\title{甲の研究}\n\\author{Ann Lee \\\\ Nankai University}\n\n甲の本文がここにある。");
      expect(t.passed).toBe(false);
      expect(t.failedKinds).toContain("title");
      const a = handResult(titleSeg, [], "\\title{Alpha Study}\n\n甲の本文がここにある。");
      expect(a.passed).toBe(false);
      expect(a.failedKinds).toContain("author");
    });

    it("同じ文字列の所属が 2 つあれば、訳文にも 2 回置けば通り、1 回・3 回なら author で落ちる（#551）", () => {
      const aff = "\\affiliation{\\institution{MIT}}";
      const dupSeg: Segment = {
        id: "seg-0000",
        latex: `\\author{A}${aff}\\author{B}${aff}\n\n\\section{Intro}\nAlpha text is here.`,
        tokens: 100,
      };
      const body = "\n\n\\section{序論}\n甲の本文がここにある。";
      expect(handResult(dupSeg, [], `\\author{A}${aff}\\author{B}${aff}${body}`).passed).toBe(true);
      for (const ja of [`\\author{A}${aff}\\author{B}${body}`, `\\author{A}${aff}\\author{B}${aff}${aff}${body}`]) {
        const r = handResult(dupSeg, [], ja);
        expect(r.passed, ja).toBe(false);
        expect(r.failedKinds).toContain("author");
      }
    });
  });
});

describe("translatePaper の --hand", () => {
  it("落ちた節の原文を .run/hand に置き、手で訳した訳文を形式検査に通して使う。以後は checkpoint から使う", async () => {
    const outDir = path.join(tmp(), "out");
    const tar = makePaperTar();
    const db = new GlossaryDb();
    const first = await run({ kind: "path", path: tar }, { outDir }, { client: mkClient({ breakBeta: true }), db });
    expect(first.exitCode).toBe(3);
    const handDir = path.join(outDir, ".run", "hand");
    expect(readFileSync(path.join(handDir, "seg-0001.src.tex"), "utf8")).toContain("Beta text.");
    expect(existsSync(path.join(handDir, "seg-0000.src.tex"))).toBe(false);

    writeFileSync(path.join(handDir, "seg-0001.tex"), "手訳");
    const c2 = mkClient({ breakBeta: true });
    const second = await run({ kind: "path", path: tar }, { outDir, hand: handDir }, { client: c2, db });
    expect(second.exitCode).toBe(0);
    expect(second.summary.hand).toEqual(["seg-0001"]);
    expect(translatorSaw(c2, "Beta")).toBe(false);
    expect(readFileSync(path.join(outDir, "translation", "chapters", "seg-0001.tex"), "utf8")).toBe("手訳");
    expect(existsSync(path.join(handDir, "seg-0001.src.tex"))).toBe(false);
    expect(existsSync(path.join(handDir, "seg-0001.tex"))).toBe(true);

    rmSync(handDir, { recursive: true, force: true });
    const c3 = mkClient({ breakBeta: true });
    const third = await run({ kind: "path", path: tar }, { outDir }, { client: c3, db });
    expect(third.exitCode).toBe(0);
    expect(third.summary.hand).toEqual([]);
    expect(translatorSaw(c3, "Beta")).toBe(false);
    expect(readFileSync(path.join(outDir, "translation", "chapters", "seg-0001.tex"), "utf8")).toBe("手訳");
    db.close();
  });

  it("形式検査に通らない手訳は落ちた節のままで、checkpoint にも chapters にも残らない", async () => {
    const outDir = path.join(tmp(), "out");
    const handDir = tmp();
    writeFileSync(path.join(handDir, "seg-0001.tex"), "手訳 $y$");
    const db = new GlossaryDb();
    const r = await run({ kind: "path", path: makePaperTar() }, { outDir, hand: handDir }, { client: mkClient(), db });
    expect(r.exitCode).toBe(3);
    expect(r.summary.hand).toEqual([]);
    expect(existsSync(path.join(outDir, "translation", "chapters", "seg-0001.tex"))).toBe(false);
    const failed = JSON.parse(readFileSync(path.join(outDir, ".run", "failed-segments.json"), "utf8")) as {
      segments: { segmentId: string; lastIssues: { by: string } }[];
    };
    expect(failed.segments.map((s) => [s.segmentId, s.lastIssues.by])).toEqual([["seg-0001", "formal"]]);
    db.close();
  });

  it("通った節にも手訳を当てられ、その節は LLM を呼ばない。論文に無い節の手訳は使わずに知らせる", async () => {
    const outDir = path.join(tmp(), "out");
    const tar = makePaperTar();
    const db = new GlossaryDb();
    expect((await run({ kind: "path", path: tar }, { outDir }, { client: mkClient(), db })).exitCode).toBe(0);
    const handDir = tmp();
    writeFileSync(path.join(handDir, "seg-0000.tex"), "手で直した訳");
    writeFileSync(path.join(handDir, "seg-0099.tex"), "無い節");
    writeFileSync(path.join(handDir, "seg-0001.src.tex"), "原文の写し");
    const errs: string[] = [];
    const c2 = mkClient();
    const r = await run({ kind: "path", path: tar }, { outDir, hand: handDir }, { client: c2, db, onError: (m) => errs.push(m) });
    expect(r.exitCode).toBe(0);
    expect(r.summary.hand).toEqual(["seg-0000"]);
    expect(c2.calls.filter((x) => !x.system.includes("編纂者"))).toEqual([]);
    expect(readFileSync(path.join(outDir, "translation", "chapters", "seg-0000.tex"), "utf8")).toBe("手で直した訳");
    expect(errs.filter((e) => e.includes("この論文の節に無い"))).toEqual([
      "手で訳した訳文のうち、この論文の節に無いものは使いません: seg-0099",
    ]);
    db.close();
  });

  it("hand のディレクトリが無ければ入力エラー（exit 2）で LLM を呼ばない", async () => {
    const outDir = path.join(tmp(), "out");
    const c = mkClient();
    const db = new GlossaryDb();
    const r = await run({ kind: "path", path: makePaperTar() }, { outDir, hand: path.join(tmp(), "none") }, { client: c, db });
    expect(r.exitCode).toBe(2);
    expect(r.error?.kind).toBe("input");
    expect(c.calls).toEqual([]);
    db.close();
  });
});

describe("組版に失敗した build を残して --rebuild で組み直す", () => {
  const translationOf = (outDir: string) => path.join(outDir, "translation");

  it("翻訳起因で落ちたら build.failed/original と成果物の名前を残し、落ちた節の原文を .run/hand に置く", async () => {
    const outDir = path.join(tmp(), "out");
    const runner: LatexRunner = (dir) => {
      const tex = readFileSync(path.join(dir, "main.tex"), "utf8");
      const line = tex.split("\n").findIndex((l) => l.includes("訳文")) + 1;
      return { code: 1, log: `./main.tex:${line}: Missing $ inserted.` };
    };
    const db = new GlossaryDb();
    const r = await run({ kind: "path", path: makePaperTar() }, { outDir }, { client: mkClient(), db, latexRunner: runner });
    expect(r.exitCode).toBe(5);
    const failedRoot = path.join(translationOf(outDir), "build.failed");
    expect(readFileSync(path.join(failedRoot, "original", "main.tex"), "utf8")).toContain("訳文");
    expect(existsSync(path.join(failedRoot, "template"))).toBe(false);
    expect(JSON.parse(readFileSync(path.join(failedRoot, "deliverable.json"), "utf8"))).toEqual({ kind: "ja", name: "p-ja.pdf" });
    expect(existsSync(path.join(translationOf(outDir), "build.next"))).toBe(false);
    expect(readFileSync(path.join(outDir, ".run", "hand", "seg-0000.src.tex"), "utf8")).toContain("Alpha text.");
    db.close();
  });

  it("テンプレでも落ちたら両方を残し、直した template を --rebuild で組むと成果物 PDF を置いて失敗の build を消す", async () => {
    const outDir = path.join(tmp(), "out");
    const failing: LatexRunner = () => ({ code: 1, log: "! LaTeX Error: File `x.png' not found." });
    const db = new GlossaryDb();
    const r = await run({ kind: "path", path: makePaperTar() }, { outDir }, { client: mkClient(), db, latexRunner: failing });
    expect(r.exitCode).toBe(5);
    const failedRoot = path.join(translationOf(outDir), "build.failed");
    expect(existsSync(path.join(failedRoot, "original", "main.tex"))).toBe(true);
    expect(existsSync(path.join(failedRoot, "template", "main.tex"))).toBe(true);

    const bad = await rebuildKept(path.join(failedRoot, "template"), failing);
    expect(bad).toEqual({ exitCode: 5, kind: "ja", message: "! LaTeX Error: File `x.png' not found." });
    expect(existsSync(path.join(outDir, "p-ja.pdf"))).toBe(false);

    const ok = await rebuildKept(path.join(failedRoot, "template"), okRunner);
    expect(ok).toEqual({ exitCode: 0, kind: "ja", pdfPath: path.join(outDir, "p-ja.pdf") });
    expect(readFileSync(path.join(outDir, "p-ja.pdf"), "utf8")).toBe("%PDF");
    expect(existsSync(path.join(translationOf(outDir), "build", "main.tex"))).toBe(true);
    expect(existsSync(failedRoot)).toBe(false);
    db.close();
  });

  it("組版が通れば前の run の build.failed を消す", async () => {
    const outDir = path.join(tmp(), "out");
    const tar = makePaperTar();
    const db = new GlossaryDb();
    const failing: LatexRunner = () => ({ code: 1, log: "! LaTeX Error: File `x.png' not found." });
    await run({ kind: "path", path: tar }, { outDir }, { client: mkClient(), db, latexRunner: failing });
    expect(existsSync(path.join(translationOf(outDir), "build.failed"))).toBe(true);
    const r = await run({ kind: "path", path: tar }, { outDir }, { client: mkClient(), db });
    expect(r.exitCode).toBe(0);
    expect(existsSync(path.join(translationOf(outDir), "build.failed"))).toBe(false);
    db.close();
  });

  it("対訳が落ちたら bilingual.failed を残し、--rebuild で対訳の成果物 PDF を置く", async () => {
    const outDir = path.join(tmp(), "out");
    const runner: LatexRunner = (dir) =>
      dir.includes("bilingual") ? { code: 1, log: "! Undefined control sequence." } : okRunner(dir);
    const db = new GlossaryDb();
    const r = await run({ kind: "path", path: makePaperTar() }, { outDir }, { client: mkClient(), db, latexRunner: runner });
    expect(r.exitCode).toBe(0);
    expect(r.summary.bilingual.status).toBe("failed");
    const failedRoot = path.join(translationOf(outDir), "bilingual.failed");
    expect(JSON.parse(readFileSync(path.join(failedRoot, "deliverable.json"), "utf8"))).toEqual({
      kind: "bilingual",
      name: "p-bilingual.pdf",
    });
    const kept = existsSync(path.join(failedRoot, "template")) ? "template" : "original";
    const ok = await rebuildKept(path.join(failedRoot, kept), okRunner);
    expect(ok).toEqual({ exitCode: 0, kind: "bilingual", pdfPath: path.join(outDir, "p-bilingual.pdf") });
    expect(existsSync(path.join(outDir, "p-ja.pdf"))).toBe(true);
    expect(existsSync(failedRoot)).toBe(false);
    db.close();
  });

  it("危険なコマンドを含む build は組まない。build.failed の外は受け付けない", async () => {
    const outDir = path.join(tmp(), "out");
    const failing: LatexRunner = () => ({ code: 1, log: "! LaTeX Error: File `x.png' not found." });
    const db = new GlossaryDb();
    await run({ kind: "path", path: makePaperTar() }, { outDir }, { client: mkClient(), db, latexRunner: failing });
    const dir = path.join(translationOf(outDir), "build.failed", "template");
    mkdirSync(path.join(dir, "sub"), { recursive: true });
    writeFileSync(path.join(dir, "sub", "x.tex"), "\\immediate\\write18{touch pwned}");
    let ran = false;
    const r = await rebuildKept(dir, (d) => ((ran = true), okRunner(d)));
    expect(r.exitCode).toBe(5);
    expect(r.message).toContain("sub/x.tex");
    expect(ran).toBe(false);
    await expect(rebuildKept(path.join(outDir, "translation"), okRunner)).rejects.toMatchObject({ code: 2, kind: "input" });
    db.close();
  });
});
