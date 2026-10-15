import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { translatePaper, type TranslateDeps, type TranslateOptions } from "./translate-paper.js";
import { GlossaryDb } from "../terminology/db.js";
import { FakeLlmClient } from "../testing/fake-llm.js";
import type { LatexRunner } from "../tools/build-gate.js";
import type { LlmRequest } from "../types/contract.js";
import type { PdfTools } from "../ingest/pdf/poppler.js";
import { pdfStepId } from "../ingest/pdf/index.js";

const okRunner: LatexRunner = (dir) => {
  writeFileSync(path.join(dir, "main.pdf"), "%PDF");
  return { code: 0, log: "Output written on main.pdf (1 page)." };
};

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(path.join(os.tmpdir(), "jpaper-pdfin-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const PAGES = [
  "Introduction to alpha methods. We study alpha estimators in the plain setting",
  "carefully and report bravo results for charlie problems in this short paper.",
];

const tools: PdfTools = {
  pageCount: () => Promise.resolve(PAGES.length),
  pageText: (_p, page) => Promise.resolve(PAGES[page - 1]!),
  renderPage: (_p, _page, prefix) => {
    writeFileSync(`${prefix}.png`, "png");
    return Promise.resolve(`${prefix}.png`);
  },
  pageLayout: () => Promise.resolve(""),
  renderRegion: (_p, _page, _box, prefix) => {
    writeFileSync(`${prefix}.png`, "png");
    return Promise.resolve(`${prefix}.png`);
  },
};

function makePdf(): string {
  const p = path.join(tmp(), "my paper.pdf");
  writeFileSync(p, "%PDF-1.4\n% fake\n");
  return p;
}

function client(): FakeLlmClient {
  return new FakeLlmClient((req: LlmRequest) => {
    if (req.meta?.role === "pdf-reader") {
      const text = /<text_layer>\n([\s\S]*?)\n<\/text_layer>/.exec(req.user)![1]!;
      return text.startsWith("carefully") ? `% jpaper-continues\n${text}` : `\\section*{1. Introduction}\n${text}`;
    }
    if (req.system.includes("編纂者")) {
      return JSON.stringify({
        resolved: [],
        brief: { thesis: "核", sectionRoles: [], notationConventions: [] },
        style: { tensePolicy: "a", headingStyle: "b", numberStyle: "c" },
      });
    }
    if (req.system.includes("審査者")) return '{"verdict":"pass","issues":[]}';
    return JSON.stringify({ segmentId: "x", ja: "\\section*{1. はじめに}\nアルファ推定量を丁寧に調べ、チャーリー問題についてブラボーの結果を報告する訳文。" });
  });
}

const run = (input: string, opts: Partial<TranslateOptions>, deps: TranslateDeps = {}) =>
  translatePaper(
    { kind: "path", path: input },
    { provider: "claude", outDir: path.join(tmp(), "out"), bilingual: false, verifyTerms: false, ...opts },
    { latexRunner: okRunner, db: new GlossaryDb(), cacheKey: Buffer.alloc(32, 1), pdfTools: tools, images: true, ...deps },
  );

describe("PDF 入力（契約付録 §8）", () => {
  it("ページを読んで main.tex を起こし、ページをまたぐ段落をつないで和訳 PDF まで作る", async () => {
    const c = client();
    const r = await run(makePdf(), {}, { client: c });
    expect(r.exitCode).toBe(0);
    expect(r.summary.pdf).toEqual({ pages: 2, fallbackPages: [], figures: 0 });
    // 拡張子 .pdf を落とし、空白を潰した名前にダイジェストを付ける（paperId の単射）。
    expect(r.summary.paperId).toMatch(/^my_paper-[0-9a-f]{8}$/);
    const main = readFileSync(path.join(r.summary.outDir, ".run", "pdf-source", "main.tex"), "utf8");
    expect(main).toContain("in the plain setting\ncarefully and report");
    expect(c.calls.filter((x) => x.meta?.role === "pdf-reader")).toHaveLength(2);
    expect(c.calls.find((x) => x.meta?.role === "pdf-reader")!.images).toHaveLength(1);
  });

  it("画像を渡せないプロバイダ・注入クライアントは、LLM を呼ぶ前に exit 2", async () => {
    const c = client();
    const ollama = await run(makePdf(), { provider: "ollama" }, { client: c, images: false });
    expect(ollama.exitCode).toBe(2);
    expect(ollama.error?.message).toContain("claude|codex");
    expect(c.calls).toHaveLength(0);
  });

  it("--pages は PDF 以外の入力では exit 2", async () => {
    const tex = path.join(tmp(), "a.tex");
    writeFileSync(tex, "\\documentclass{article}\\begin{document}Alpha text.\\end{document}");
    const r = await run(tex, { pages: "1" }, { client: client() });
    expect(r.exitCode).toBe(2);
    expect(r.error?.message).toContain("--pages");
  });

  it("ページの checkpoint を残し、再実行では読み直さない", async () => {
    const pdf = makePdf();
    const out = path.join(tmp(), "out");
    const c1 = client();
    await run(pdf, { outDir: out }, { client: c1 });
    const c2 = client();
    const r = await run(pdf, { outDir: out }, { client: c2 });
    expect(r.exitCode).toBe(0);
    expect(c2.calls.filter((x) => x.meta?.role === "pdf-reader")).toHaveLength(0);
    const steps = readdirSync(path.join(out, ".run", "steps"));
    expect(steps.some((f) => f.startsWith(`${pdfStepId(1)}.`))).toBe(true);
    expect(steps.some((f) => f.startsWith(`${pdfStepId(2)}.`))).toBe(true);
  });
});
