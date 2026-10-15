import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { translatePaper, type TranslateDeps, type TranslateOptions } from "./translate-paper.js";
import { GlossaryDb } from "../terminology/db.js";
import { FakeLlmClient } from "../testing/fake-llm.js";
import type { LatexRunner } from "../tools/build-gate.js";
import type { LlmRequest } from "../types/contract.js";
import type { Box, PdfTools } from "../ingest/pdf/poppler.js";

const okRunner: LatexRunner = (dir) => {
  writeFileSync(path.join(dir, "main.pdf"), "%PDF");
  return { code: 0, log: "Output written on main.pdf (1 page)." };
};

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(path.join(os.tmpdir(), "jpaper-redact-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const NAME = "Hanako Yamada";
const TERMS = [NAME, "Yamada"];

function client(): FakeLlmClient {
  return new FakeLlmClient((req: LlmRequest) => {
    if (req.meta?.role === "pdf-reader") {
      const text = /<text_layer>\n([\s\S]*?)\n<\/text_layer>/.exec(req.user)![1]!;
      return `\\section*{1. Introduction}\n${text}`;
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

// 出力先の下のすべてのファイル（バイナリも latin1 で読む）の中身と名前。
function everything(dir: string): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d)) {
      const abs = path.join(d, e);
      if (statSync(abs).isDirectory()) walk(abs);
      else out.push({ file: path.relative(dir, abs), text: readFileSync(abs).toString("utf8") });
    }
  };
  walk(dir);
  return out;
}

function expectNoTerm(c: FakeLlmClient, outDir: string, summary: unknown): void {
  for (const req of c.calls) {
    expect(`${req.system}\n${req.user}`).not.toContain("Yamada");
  }
  for (const f of everything(outDir)) {
    expect(f.file).not.toContain("Yamada");
    expect(f.text, f.file).not.toContain("Yamada");
  }
  expect(JSON.stringify(summary)).not.toContain("Yamada");
}

const run = (input: string, opts: Partial<TranslateOptions>, deps: TranslateDeps = {}) =>
  translatePaper(
    { kind: "path", path: input },
    { provider: "claude", outDir: path.join(tmp(), "out"), verifyTerms: false, ...opts },
    { latexRunner: okRunner, db: new GlossaryDb(), cacheKey: Buffer.alloc(32, 1), images: true, ...deps },
  );

const TEX = [
  "\\documentclass{article}",
  "\\title{Alpha Estimators}",
  `\\author{${NAME}}`,
  "\\begin{document}",
  "\\maketitle",
  "\\section{Introduction}",
  `We study alpha estimators carefully. This work was done by Hanako`,
  "Yamada in the plain setting, following Yamada's earlier report on bravo results.",
  "\\end{document}",
].join("\n");

describe("伏せ字（契約付録 §8）: LaTeX 入力", () => {
  it("語はどの LLM 呼び出しにも、出力先のどのファイルにも、実行の要約にも残らない", async () => {
    const dir = tmp();
    const tex = path.join(dir, "paper.tex");
    writeFileSync(tex, TEX);
    const c = client();
    const r = await run(tex, { redact: TERMS }, { client: c });
    expect(r.exitCode).toBe(0);
    expect(c.calls.length).toBeGreaterThan(0);
    // 行をまたいだ "Hanako\nYamada" も 1 つとして置き換える。
    expect(r.summary.redaction).toEqual({ terms: 2, replaced: 3 });
    expectNoTerm(c, r.summary.outDir, r.summary);
    expect(readFileSync(path.join(r.summary.outDir, ".run", "source", "paper.tex"), "utf8")).toContain("\\author{***}");
    // 利用者の入力のファイルは書き換えない。
    expect(readFileSync(tex, "utf8")).toBe(TEX);
  });

  it("指定が無ければ置き換えない（要約は null）", async () => {
    const dir = tmp();
    const tex = path.join(dir, "paper.tex");
    writeFileSync(tex, TEX);
    const c = client();
    const r = await run(tex, {}, { client: c });
    expect(r.exitCode).toBe(0);
    expect(r.summary.redaction).toBeNull();
    expect(c.calls.some((q) => q.user.includes("Yamada"))).toBe(true);
  });

  it("前の run の取り込みの checkpoint を使わずに、伏せ字で取り込み直す", async () => {
    const dir = tmp();
    const tex = path.join(dir, "paper.tex");
    writeFileSync(tex, TEX);
    const out = path.join(tmp(), "out");
    await run(tex, { outDir: out }, { client: client() });
    const c = client();
    const r = await run(tex, { outDir: out, redact: TERMS }, { client: c });
    expect(r.exitCode).toBe(0);
    for (const req of c.calls) expect(`${req.system}\n${req.user}`).not.toContain("Yamada");
  });

  it("語が LaTeX のコマンド名の中にあれば、LLM を呼ぶ前に exit 2（語は誤りの文に載せない）", async () => {
    const dir = tmp();
    const tex = path.join(dir, "paper.tex");
    writeFileSync(tex, TEX.replace("\\maketitle", "\\newcommand{\\Yamadafoo}{x}\\maketitle"));
    const c = client();
    const r = await run(tex, { redact: TERMS }, { client: c });
    expect(r.exitCode).toBe(2);
    expect(r.error?.message).toContain("コマンド名");
    expect(r.error?.message).not.toContain("Yamada");
    expect(c.calls).toHaveLength(0);
  });
});

describe("伏せ字（契約付録 §8）: PDF 入力", () => {
  const PAGES = [
    `Introduction to alpha methods by ${NAME}. We study alpha estimators in the plain setting`,
    "carefully and report bravo results for charlie problems in this short paper.",
  ];
  const words = (text: string): string =>
    text
      .split(" ")
      .map((w, i) => `<word xMin="${String(72 + i * 40)}" yMin="100" xMax="${String(72 + i * 40 + 35)}" yMax="110">${w}</word>`)
      .join("");
  const masks: { page: number; mask: readonly Box[] | undefined }[] = [];
  const tools: PdfTools = {
    pageCount: () => Promise.resolve(PAGES.length),
    pageText: (_p, page) => Promise.resolve(PAGES[page - 1]!),
    renderPage: (_p, page, prefix, _s, mask) => {
      masks.push({ page, mask });
      writeFileSync(`${prefix}.png`, "png");
      return Promise.resolve(`${prefix}.png`);
    },
    pageLayout: (_p, page) =>
      Promise.resolve(`<doc><page width="504" height="720"><flow><block xMin="72" yMin="100" xMax="431" yMax="110"><line xMin="72" yMin="100" xMax="431" yMax="110">${words(PAGES[page - 1]!)}</line></block></flow></page></doc>`),
    renderRegion: (_p, _page, _box, prefix) => {
      writeFileSync(`${prefix}.png`, "png");
      return Promise.resolve(`${prefix}.png`);
    },
  };

  it("テキスト層を書き換え、ページ画像では語の矩形を白で塗る", async () => {
    masks.length = 0;
    const pdf = path.join(tmp(), "book.pdf");
    writeFileSync(pdf, "%PDF-1.4\n% fake\n");
    const c = client();
    const r = await run(pdf, { redact: TERMS, bilingual: false }, { client: c, pdfTools: tools });
    expect(r.exitCode).toBe(0);
    expect(r.summary.redaction).toEqual({ terms: 2, replaced: 1 });
    expectNoTerm(c, r.summary.outDir, r.summary);
    // "Hanako" は 0 から数えて 5 語目・"Yamada." は 6 語目（語の幅 35pt・間隔 40pt、1pt 広げる）。
    const m = masks.find((x) => x.page === 1)!.mask!;
    expect(m.map((b) => [b.x0, b.x1])).toEqual([
      [72 + 5 * 40 - 1, 72 + 5 * 40 + 36],
      [72 + 6 * 40 - 1, 72 + 6 * 40 + 36],
    ]);
    expect(masks.find((x) => x.page === 2)!.mask).toBeUndefined();
  });
});
