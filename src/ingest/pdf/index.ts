// 契約付録 §8（PDF 入力）・PDF 入力 ADR(20261015)。PDF からクリーンな main.tex を作る段。
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { LlmClient } from "../../types/contract.js";
import { JpaperError } from "../../types/errors.js";
import { checkpoint, hashContext } from "../../durable/checkpoint.js";
import type { LatexRunner } from "../../tools/build-gate.js";
import { popplerTools, type Box, type PdfTools } from "./poppler.js";
import { redactText, type Redactor } from "../redact.js";
import { pageWords, redactionBoxes, sameMatches, unmatchedVariants } from "./redact-pdf.js";
import { hasTextLayer, normalizePageText, parsePageRange, stripRepeatedLines } from "./text-layer.js";
import { readPage } from "./page-reader.js";
import { assembleMainTex, placeFigures, type AssembledPage } from "./assemble.js";
import { documentTextBox, figureKey, figureRegions, parseBboxLayout, type PageLayout } from "./figures.js";

// これを超えるページ数を読むときは利用者の同意（--yes）が要る。
export const LARGE_PDF_PAGES = 100;
// 読み取りの目安（claude-sonnet・effort medium の 1 ページあたり。契約付録 §8 PDF 入力）。
export const ESTIMATED_USD_PER_PAGE = 0.035;
export const ESTIMATED_SECONDS_PER_PAGE = 8;
// プロンプト・ページの検査を変えたら上げる（ページの checkpoint を無効にする）。
export const PDF_READER_VERSION = "2";
export const PDF_STEP_PREFIX = "pdf-p";
// テキスト層の語をこれ以上「省いた」としたページは警告する。
export const OMITTED_NOTICE_WORDS = 10;

export const PdfPageCache = z.object({
  status: z.enum(["ok", "fallback"]),
  tex: z.string(),
  continues: z.boolean(),
  calls: z.number().int().nonnegative(),
  reason: z.string().optional(),
  extraWords: z.number().int().nonnegative(),
  omittedWords: z.number().int().nonnegative().default(0),
});
export type PdfPageCache = z.infer<typeof PdfPageCache>;

export interface PdfReadOptions {
  // "1-72" など。PDF の何枚目か（1 始まり）。
  pages?: string;
  // LARGE_PDF_PAGES を超えても読む。
  allowLarge?: boolean;
}

export interface PdfExtractDeps {
  client: LlmClient;
  runner: LatexRunner;
  runDir: string;
  // main.tex とページ画像を書くディレクトリ（作り直す）。
  outDir: string;
  // 入力の内容の署名（ページの checkpoint の無効化キーに含める）。
  signature: string;
  concurrency: number;
  tools?: PdfTools;
  cacheKey?: Buffer;
  signal?: AbortSignal;
  notify?: (message: string) => void;
  onPage?: (page: number, status: PdfPageCache["status"], done: number, total: number) => void;
  // 伏せ字。テキスト層を書き換え、ページ画像のその位置を白で塗る。契約付録 §8（伏せ字）
  redact?: Redactor;
}

export interface PdfExtracted {
  dir: string;
  pages: number[];
  fallbackPages: number[];
  // 切り出して貼った図の数。
  figures: number;
  // テキスト層で *** に置き換えた数（伏せ字）。
  redacted: number;
  stepIds: string[];
}

export function pdfStepId(page: number): string {
  return `${PDF_STEP_PREFIX}${String(page).padStart(4, "0")}`;
}

export function estimatePdfRead(pages: number, concurrency: number): { usd: number; minutes: number } {
  return {
    usd: Math.round(pages * ESTIMATED_USD_PER_PAGE * 10) / 10,
    minutes: Math.max(1, Math.ceil((pages * ESTIMATED_SECONDS_PER_PAGE) / Math.max(1, concurrency) / 60)),
  };
}

// 読むページ（--pages を当てた後）。LLM を呼ばないので、確認の前に使える。
export async function pdfPagesToRead(
  pdf: string,
  spec: string | undefined,
  tools: PdfTools = popplerTools,
  signal?: AbortSignal,
): Promise<{ total: number; pages: number[] }> {
  const total = await tools.pageCount(pdf, signal);
  if (total < 1) throw new JpaperError(2, "input", "PDF にページがありません");
  const pages = spec === undefined ? Array.from({ length: total }, (_, i) => i + 1) : parsePageRange(spec, total);
  return { total, pages };
}

// 全 worker の決着を待ってから最初の失敗を投げる。⚠ landmines.md
async function runLimited<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failure: { err: unknown } | undefined;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < items.length; i = next++) {
      if (failure !== undefined) return;
      try {
        await fn(items[i]!);
      } catch (err) {
        failure ??= { err };
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  if (failure !== undefined) throw failure.err;
}

export async function extractPdf(pdf: string, opts: PdfReadOptions, deps: PdfExtractDeps): Promise<PdfExtracted> {
  const tools = deps.tools ?? popplerTools;
  const { pages } = await pdfPagesToRead(pdf, opts.pages, tools, deps.signal);
  if (pages.length > LARGE_PDF_PAGES && opts.allowLarge !== true) {
    throw new JpaperError(
      2,
      "input",
      `PDF の読むページが ${String(pages.length)} ページで ${String(LARGE_PDF_PAGES)} ページを超えます。--yes か --pages を指定してください`,
    );
  }
  const raw: string[] = [];
  let redacted = 0;
  // 伏せ字: テキスト層の語を *** に置き換え、ページ画像で白く塗る位置（pt）を語の矩形から求める。契約付録 §8（伏せ字）
  const masks = new Map<number, Box[]>();
  // 空白の入り方だけ違って伏せ字に当たらなかった所のページと数（警告には語を載せない）。
  const unmatched: number[] = [];
  let unmatchedCount = 0;
  for (const p of pages) {
    let text = normalizePageText(await tools.pageText(pdf, p, deps.signal));
    if (deps.redact !== undefined) {
      const original = text;
      const r = redactText(text, deps.redact);
      text = r.text;
      redacted += r.replaced;
      const { boxes, hits, joined } = redactionBoxes(pageWords(await tools.pageLayout(pdf, p, deps.signal)), deps.redact);
      // テキスト層と画像で当たりが食い違えば（当たった文字列が違う・空白などの入り方だけ違う語が当たらずに残る）、どちらかに語が残るので止める。
      if (!sameMatches(original, joined, deps.redact)) {
        throw new JpaperError(
          2,
          "input",
          `PDF の ${String(p)} ページ目で、伏せ字の語の当たりがテキスト層（${String(r.replaced)} か所）とページ上の位置（${String(hits)} か所）で食い違うため止めました（空白・改行の入り方だけが違う同じ語が、どちらかで当たっていない、または当たった文字列が違います。語の書き方をページの文字どおりにするか、空白を入れた形・入れない形の両方を語に足してください）`,
        );
      }
      if (boxes.length > 0) masks.set(p, boxes);
      const variants = unmatchedVariants(original, deps.redact).length;
      if (variants > 0) {
        unmatched.push(p);
        unmatchedCount += variants;
      }
    }
    raw.push(text);
  }
  if (unmatched.length > 0) {
    deps.notify?.(
      `伏せ字の語と空白・改行の入り方だけが違う所が ${String(unmatchedCount)} か所あり、伏せ字にしていません（${unmatched.slice(0, 10).map((p) => `p.${String(p)}`).join(", ")}${unmatched.length > 10 ? " ほか" : ""}）。伏せるなら、その書き方も語に足してください`,
    );
  }
  // 繰り返す行を落として本文が残らないページは、落とす前のテキスト層を使う。
  // 行を落としてつながった語も置き換える（伏せ字）。
  const texts = stripRepeatedLines(raw)
    .map((t, i) => (hasTextLayer(t) ? t : raw[i]!))
    .map((t) => (deps.redact === undefined ? t : redactText(t, deps.redact).text));
  const noText = pages.filter((_, i) => !hasTextLayer(raw[i]!));
  if (noText.length * 2 >= pages.length) {
    throw new JpaperError(
      2,
      "input",
      `テキスト層の無いページが ${String(noText.length)}/${String(pages.length)} ページあります（スキャンした PDF は対象外です）`,
    );
  }

  const workDir = path.join(deps.runDir, "pdf-work");
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });
  const results = new Map<number, PdfPageCache>();
  let done = 0;
  await runLimited(pages, deps.concurrency, async (page) => {
    const i = pages.indexOf(page);
    const text = texts[i]!;
    let r: PdfPageCache;
    if (!hasTextLayer(raw[i]!)) {
      r = { status: "fallback", tex: "", continues: false, calls: 0, reason: "テキスト層が無い", extraWords: 0, omittedWords: 0 };
    } else {
      r = await checkpoint(
        deps.runDir,
        pdfStepId(page),
        PdfPageCache,
        async () => {
          const png = await tools.renderPage(pdf, page, path.join(workDir, `read-${String(page)}`), deps.signal, masks.get(page));
          return readPage(page, readFileSync(png), text, {
            client: deps.client,
            runner: deps.runner,
            buildDir: path.join(workDir, `build-${String(page)}`),
            signal: deps.signal,
          });
        },
        {
          invalidation:
            deps.redact === undefined
              ? hashContext(PDF_READER_VERSION, deps.signature, String(page), text)
              : hashContext(PDF_READER_VERSION, deps.signature, String(page), text, "redact", deps.redact.fingerprint),
          cacheable: (x) => x.status === "ok",
          key: deps.cacheKey,
        },
      );
    }
    results.set(page, r);
    if (r.status === "ok" && r.omittedWords >= OMITTED_NOTICE_WORDS) {
      deps.notify?.(`PDF の ${String(page)} ページ目は、テキスト層の ${String(r.omittedWords)} 語を「省いた」として訳していません（柱・図の中の文字でなければ取りこぼし）`);
    }
    if (r.status === "fallback") {
      deps.notify?.(`PDF の ${String(page)} ページ目を読み取れず、原本の画像を貼ります（${r.reason ?? "検査に通らない"}）`);
    }
    deps.onPage?.(page, r.status, ++done, pages.length);
  });

  const fallbackPages = pages.filter((p) => results.get(p)?.status === "fallback");
  if (fallbackPages.length * 2 > pages.length) {
    throw new JpaperError(
      3,
      "formal",
      `PDF の ${String(fallbackPages.length)}/${String(pages.length)} ページを読み取れませんでした（半数を超えたため翻訳しません）`,
    );
  }

  rmSync(deps.outDir, { recursive: true, force: true });
  mkdirSync(path.join(deps.outDir, "pages"), { recursive: true });
  mkdirSync(path.join(deps.outDir, "figures"), { recursive: true });
  // 図: 読めたページのキャプションの上の空白を切り出し、番号の合う目印を置き換える。契約付録 §8（PDF 入力・図）
  const layouts = new Map<number, PageLayout>();
  const figureTex = new Map<number, string>();
  let figureCount = 0;
  const okPages = pages.filter((page) => results.get(page)!.status === "ok");
  const failed = new Set<number>();
  for (const page of okPages) {
    try {
      const layout = parseBboxLayout(await tools.pageLayout(pdf, page, deps.signal));
      if (layout !== undefined) layouts.set(page, layout);
    } catch (e) {
      if (deps.signal?.aborted === true) throw e;
      failed.add(page);
    }
  }
  const docBox = documentTextBox([...layouts.values()]);
  for (const page of okPages) {
    const tex = results.get(page)!.tex;
    const figures: { key: string; file: string }[] = [];
    const layout = layouts.get(page);
    try {
      for (const [k, region] of (layout === undefined ? [] : figureRegions(layout, docBox)).entries()) {
        const key = figureKey(region.label);
        if (key === undefined) continue;
        const rel = `figures/p-${String(page).padStart(4, "0")}-${String(k + 1)}`;
        await tools.renderRegion(pdf, page, region, path.join(deps.outDir, rel), deps.signal, masks.get(page));
        figures.push({ key, file: `${rel}.png` });
      }
    } catch (e) {
      if (deps.signal?.aborted === true) throw e;
      failed.add(page);
      figures.length = 0;
    }
    const r = placeFigures(tex, figures);
    figureTex.set(page, r.tex);
    figureCount += r.placed;
    if (r.placed < r.marks) {
      deps.notify?.(
        `PDF の ${String(page)} ページ目は、図の目印 ${String(r.marks)} 個のうち ${String(r.marks - r.placed)} 個に図を貼れず、目印のままにします（${failed.has(page) ? "ページの座標・図を描けない" : `キャプションから切り出した図 ${String(figures.length)} 個と番号が合わない`}）`,
      );
    }
  }
  const assembled: AssembledPage[] = [];
  for (const [i, page] of pages.entries()) {
    const r = results.get(page)!;
    let image: string | undefined;
    if (r.status === "fallback") {
      const rel = `pages/p-${String(page).padStart(4, "0")}`;
      await tools.renderPage(pdf, page, path.join(deps.outDir, rel), deps.signal, masks.get(page));
      image = `${rel}.png`;
    }
    assembled.push({
      page,
      text: texts[i]!,
      status: r.status,
      tex: figureTex.get(page) ?? r.tex,
      continues: r.continues,
      image,
    });
  }
  writeFileSync(path.join(deps.outDir, "main.tex"), assembleMainTex(assembled));
  rmSync(workDir, { recursive: true, force: true });
  return { dir: deps.outDir, pages, fallbackPages, figures: figureCount, redacted, stepIds: pages.map(pdfStepId) };
}
