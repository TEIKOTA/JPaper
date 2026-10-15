// 契約付録 §8（伏せ字）・伏せ字 ADR(20261015)。指定した文字列を、LLM に渡す前に *** へ置き換える。
import { createHmac } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { JpaperError } from "../types/errors.js";

export const REDACTED = "***";
// 語の最小の長さ（文字数）。
export const MIN_TERM_CHARS = 2;
export const MAX_TERMS = 1000;
const MAX_TERM_CHARS = 200;
// 書き換える取り込みのファイル（テキスト）。
const TEXT_EXT = /\.(?:tex|bib|bbl|sty|cls|bst|cfg|def|clo|txt|ltx|dtx|ins)$/i;

export interface Redactor {
  terms: readonly string[];
  // 語を区別する鍵付きの値（checkpoint の無効化キーに入れる。語そのものは復元できない）。
  fingerprint: string;
  pattern: RegExp;
}

export interface RedactCount {
  terms: number;
  replaced: number;
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// 伏せ字のファイル（1 行 1 語。空行と # で始まる行は読まない）を読む。誤りの文には語を載せない（行番号だけ）。
export function parseRedactTerms(text: string): string[] {
  const terms = new Set<string>();
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const chars = [...line].length;
    if (chars < MIN_TERM_CHARS || chars > MAX_TERM_CHARS || /[\x00-\x1f\x7f]/.test(line)) {
      throw new JpaperError(
        2,
        "input",
        `--redact-file の ${String(i + 1)} 行目の語は ${String(MIN_TERM_CHARS)}〜${String(MAX_TERM_CHARS)} 文字にしてください`,
      );
    }
    terms.add(line);
  }
  if (terms.size > MAX_TERMS) throw new JpaperError(2, "input", `--redact-file の語は ${String(MAX_TERMS)} 個までです`);
  return [...terms];
}

export function makeRedactor(terms: readonly string[], key: Buffer): Redactor | undefined {
  if (terms.length === 0) return undefined;
  // 長い語から当てる（"Taro Yamada" を "Yamada" より先に）。語の中の空白は改行を含む空白の並びに当てる。
  const sorted = [...terms].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
  const pattern = new RegExp(sorted.map((t) => t.split(/\s+/).map(escape).join("\\s+")).join("|"), "g");
  const h = createHmac("sha256", key).update("jpaper-redact\0");
  for (const t of sorted) h.update(t).update("\0");
  return { terms: sorted, fingerprint: h.digest("hex").slice(0, 16), pattern };
}

export function redactText(text: string, r: Redactor): { text: string; replaced: number } {
  let replaced = 0;
  const out = text.replace(r.pattern, () => {
    replaced++;
    return REDACTED;
  });
  return { text: out, replaced };
}

// LaTeX の制御綴り（\Yamada など）の中の一致。置き換えると組版が壊れるので、見つけたら止める。
export function controlWordHits(tex: string, r: Redactor): number {
  let hits = 0;
  for (const m of tex.matchAll(/\\[A-Za-z@]+/g)) {
    r.pattern.lastIndex = 0;
    if (r.pattern.test(m[0].slice(1))) hits++;
  }
  r.pattern.lastIndex = 0;
  return hits;
}

// 取り込んだソースのテキストのファイルをすべて書き換える。制御綴りに当たる語があれば入力エラー。
export function redactTree(dir: string, r: Redactor): number {
  let replaced = 0;
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.isFile() && TEXT_EXT.test(e.name) && statSync(abs).size > 0) {
        const buf = readFileSync(abs);
        // UTF-8 として往復できないファイル（latin1 の .bib など）は 1 バイト 1 文字で扱う。
        const utf8 = buf.toString("utf8");
        const encoding: BufferEncoding = Buffer.from(utf8, "utf8").equals(buf) ? "utf8" : "latin1";
        const text = encoding === "utf8" ? utf8 : buf.toString("latin1");
        if (controlWordHits(text, r) > 0) {
          throw new JpaperError(
            2,
            "input",
            `--redact-file の語が LaTeX のコマンド名の中にあります（${path.relative(dir, abs)}）。置き換えると組版が壊れるため止めました`,
          );
        }
        const out = redactText(text, r);
        if (out.replaced > 0) {
          writeFileSync(abs, out.text, encoding);
          replaced += out.replaced;
        }
      }
    }
  };
  walk(dir);
  return replaced;
}
