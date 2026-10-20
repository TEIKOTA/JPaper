// 契約付録 §8（PDF 入力）。poppler の CLI（pdfinfo・pdftotext・pdftocairo）の呼び出し。
import { execFile } from "node:child_process";
import { closeSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from "node:fs";
import { encodePng, paintWhite, parsePpm } from "./raster.js";
import { JpaperError } from "../../types/errors.js";
import { canceledError } from "../../runtime/cancellation.js";

export const RENDER_DPI = 150;
// 図を切り出す解像度。
export const FIGURE_DPI = 200;
const TIMEOUT_MS = 60_000;
const MAX_BUFFER = 64 * 1024 * 1024;

export interface PdfTools {
  pageCount(pdf: string, signal?: AbortSignal): Promise<number>;
  pageText(pdf: string, page: number, signal?: AbortSignal): Promise<string>;
  // outPrefix に .png を付けたファイルへ書く。mask（pt）は白で塗る（伏せ字）。
  renderPage(pdf: string, page: number, outPrefix: string, signal?: AbortSignal, mask?: readonly Box[]): Promise<string>;
  // pdftotext -bbox-layout の出力（1 ページ分）。
  pageLayout(pdf: string, page: number, signal?: AbortSignal): Promise<string>;
  // ページの一部（pt 単位）を FIGURE_DPI で描く。outPrefix に .png を付けたファイルへ書く。
  renderRegion(
    pdf: string,
    page: number,
    box: Box,
    outPrefix: string,
    signal?: AbortSignal,
    mask?: readonly Box[],
  ): Promise<string>;
}

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

// pdftoppm で PPM に描き、mask（ページの pt。crop は描く範囲の pt）を白で塗って PNG に書く。契約付録 §8（伏せ字）
async function renderMasked(
  pdf: string,
  page: number,
  dpi: number,
  outPrefix: string,
  mask: readonly Box[],
  crop: Box | undefined,
  signal?: AbortSignal,
): Promise<string> {
  const s = dpi / 72;
  const px = (v: number): number => Math.max(0, Math.round(v * s));
  await run(
    "pdftoppm",
    [
      "-r",
      String(dpi),
      "-f",
      String(page),
      "-l",
      String(page),
      "-singlefile",
      ...(crop === undefined
        ? []
        : ["-x", String(px(crop.x0)), "-y", String(px(crop.y0)), "-W", String(px(crop.x1 - crop.x0)), "-H", String(px(crop.y1 - crop.y0))]),
      pdf,
      outPrefix,
    ],
    signal,
  );
  const ppm = `${outPrefix}.ppm`;
  try {
    const raster = parsePpm(readFileSync(ppm));
    const ox = crop === undefined ? 0 : px(crop.x0);
    const oy = crop === undefined ? 0 : px(crop.y0);
    paintWhite(
      raster,
      mask.map((b) => ({ x0: b.x0 * s - ox, y0: b.y0 * s - oy, x1: b.x1 * s - ox, y1: b.y1 * s - oy })),
    );
    writeFileSync(`${outPrefix}.png`, encodePng(raster));
  } finally {
    rmSync(ppm, { force: true });
  }
  return `${outPrefix}.png`;
}

// 先頭 5 バイトが %PDF- か。
export function isPdfFile(file: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const buf = Buffer.alloc(5);
    return readSync(fd, buf, 0, 5, 0) === 5 && buf.toString("latin1") === "%PDF-";
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function run(cmd: string, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER, encoding: "utf8", signal },
      (err, stdout, stderr) => {
        if (err === null) return resolve(stdout);
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          return reject(
            new JpaperError(2, "input", `PDF の読み取りに poppler の ${cmd} が必要です（macOS は brew install poppler、Debian / Ubuntu は sudo apt install poppler-utils）`),
          );
        }
        if (signal?.aborted === true) return reject(canceledError(`${cmd} 実行中`, signal));
        reject(new JpaperError(2, "input", `${cmd} が PDF を読めません: ${String(stderr).slice(0, 300)}`));
      },
    );
  });
}

export const popplerTools: PdfTools = {
  async pageCount(pdf, signal) {
    const out = await run("pdfinfo", [pdf], signal);
    const m = /^Pages:\s+(\d+)\s*$/m.exec(out);
    if (m === null) throw new JpaperError(2, "input", "PDF のページ数を読めません");
    return Number(m[1]);
  },
  pageText(pdf, page, signal) {
    return run("pdftotext", ["-f", String(page), "-l", String(page), "-enc", "UTF-8", pdf, "-"], signal);
  },
  async renderPage(pdf, page, outPrefix, signal, mask) {
    if (mask !== undefined && mask.length > 0) return renderMasked(pdf, page, RENDER_DPI, outPrefix, mask, undefined, signal);
    await run(
      "pdftocairo",
      ["-png", "-singlefile", "-r", String(RENDER_DPI), "-f", String(page), "-l", String(page), pdf, outPrefix],
      signal,
    );
    return `${outPrefix}.png`;
  },
  pageLayout(pdf, page, signal) {
    return run("pdftotext", ["-bbox-layout", "-f", String(page), "-l", String(page), "-enc", "UTF-8", pdf, "-"], signal);
  },
  async renderRegion(pdf, page, box, outPrefix, signal, mask) {
    if (mask !== undefined && mask.length > 0) return renderMasked(pdf, page, FIGURE_DPI, outPrefix, mask, box, signal);
    const s = FIGURE_DPI / 72;
    const px = (v: number): string => String(Math.max(0, Math.round(v * s)));
    await run(
      "pdftocairo",
      [
        "-png",
        "-singlefile",
        "-r",
        String(FIGURE_DPI),
        "-f",
        String(page),
        "-l",
        String(page),
        "-x",
        px(box.x0),
        "-y",
        px(box.y0),
        "-W",
        px(box.x1 - box.x0),
        "-H",
        px(box.y1 - box.y0),
        pdf,
        outPrefix,
      ],
      signal,
    );
    return `${outPrefix}.png`;
  },
};
