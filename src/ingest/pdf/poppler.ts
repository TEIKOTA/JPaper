// 契約付録 §8（PDF 入力）。poppler の CLI（pdfinfo・pdftotext・pdftocairo）の呼び出し。
import { execFile } from "node:child_process";
import { closeSync, openSync, readSync } from "node:fs";
import { JpaperError } from "../../types/errors.js";

export const RENDER_DPI = 150;
const TIMEOUT_MS = 60_000;
const MAX_BUFFER = 64 * 1024 * 1024;

export interface PdfTools {
  pageCount(pdf: string, signal?: AbortSignal): Promise<number>;
  pageText(pdf: string, page: number, signal?: AbortSignal): Promise<string>;
  // outPrefix に .png を付けたファイルへ書く。
  renderPage(pdf: string, page: number, outPrefix: string, signal?: AbortSignal): Promise<string>;
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
            new JpaperError(2, "input", `PDF の読み取りに poppler の ${cmd} が必要です（brew install poppler）`),
          );
        }
        if (signal?.aborted === true) return reject(err);
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
  async renderPage(pdf, page, outPrefix, signal) {
    await run(
      "pdftocairo",
      ["-png", "-singlefile", "-r", String(RENDER_DPI), "-f", String(page), "-l", String(page), pdf, outPrefix],
      signal,
    );
    return `${outPrefix}.png`;
  },
};
