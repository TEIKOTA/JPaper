// 契約付録 §9（伏せ字の範囲選択）。アップロードした PDF のページの語の矩形と、伏せ字の語の当たり。
// 当て方は CLI と同じ関数（makeRedactor・redactionBoxes）を使い、画面の赤枠が白く塗られる位置と一致するようにする。
import { execFile } from "node:child_process";
import { JpaperError } from "../../../src/types/errors.js";
import { makeRedactor, type Redactor } from "../../../src/ingest/redact.js";
import { pageWords, redactionBoxes } from "../../../src/ingest/pdf/redact-pdf.js";
import type { Box } from "../../../src/ingest/pdf/poppler.js";

export interface PageWords {
  width: number;
  height: number;
  words: (Box & { text: string })[];
}

export interface TermMatch {
  term: string;
  count: number;
  pages: number[];
}

// まとめて読むページ数（pdftotext -bbox-layout の 1 回分）。
const CHUNK = 20;
// 語を覚えておくアップロードの数。
const KEEP = 3;
// 当たりを数えるだけなので、鍵は何でもよい。
const KEY = Buffer.alloc(32);

export type LayoutRange = (pdf: string, first: number, last: number) => Promise<string>;

export const popplerLayoutRange: LayoutRange = (pdf, first, last) =>
  new Promise((resolve, reject) => {
    execFile(
      "pdftotext",
      ["-bbox-layout", "-f", String(first), "-l", String(last), "-enc", "UTF-8", pdf, "-"],
      { timeout: 60_000, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" },
      (err, stdout) => (err === null ? resolve(stdout) : reject(new JpaperError(2, "input", "PDF の語の位置を読めません"))),
    );
  });

const attr = (tag: string, name: string): number => Number(new RegExp(`${name}="([-0-9.]+)"`).exec(tag)?.[1] ?? NaN);

export class UploadWords {
  private readonly cache = new Map<string, Map<number, PageWords>>();

  constructor(private readonly layoutRange: LayoutRange = popplerLayoutRange) {}

  private pagesOf(id: string): Map<number, PageWords> {
    let m = this.cache.get(id);
    if (m === undefined) {
      m = new Map();
      this.cache.set(id, m);
      while (this.cache.size > KEEP) this.cache.delete(this.cache.keys().next().value!);
    } else {
      this.cache.delete(id);
      this.cache.set(id, m);
    }
    return m;
  }

  async page(id: string, file: string, page: number, total: number): Promise<PageWords> {
    if (!Number.isInteger(page) || page < 1 || page > total) throw new JpaperError(2, "input", "ページの番号が不正です");
    const pages = this.pagesOf(id);
    const hit = pages.get(page);
    if (hit !== undefined) return hit;
    const first = Math.floor((page - 1) / CHUNK) * CHUNK + 1;
    const last = Math.min(total, first + CHUNK - 1);
    const xml = await this.layoutRange(file, first, last);
    const blocks = [...xml.matchAll(/<page ([^>]*)>([\s\S]*?)<\/page>/g)];
    for (let i = first; i <= last; i++) {
      const b = blocks[i - first];
      pages.set(
        i,
        b === undefined
          ? { width: 0, height: 0, words: [] }
          : { width: attr(b[1]!, "width"), height: attr(b[1]!, "height"), words: pageWords(b[2]!) },
      );
    }
    return pages.get(page)!;
  }

  // 語ごとの当たりの数と当たったページ（全ページを読む）。
  async matches(id: string, file: string, total: number, terms: readonly string[]): Promise<TermMatch[]> {
    const each = terms.map((t) => ({ term: t, r: makeRedactor([t], KEY)!, count: 0, pages: [] as number[] }));
    for (let p = 1; p <= total; p++) {
      const { words } = await this.page(id, file, p, total);
      for (const e of each) {
        const { hits } = redactionBoxes(words, e.r);
        if (hits > 0) {
          e.count += hits;
          e.pages.push(p);
        }
      }
    }
    return each.map(({ term, count, pages }) => ({ term, count, pages }));
  }

  // そのページで白く塗る矩形（すべての語をまとめて当てる。CLI と同じ）。
  async boxes(id: string, file: string, total: number, page: number, terms: readonly string[]): Promise<Box[]> {
    const r: Redactor | undefined = makeRedactor(terms, KEY);
    if (r === undefined) return [];
    return redactionBoxes((await this.page(id, file, page, total)).words, r).boxes;
  }
}
