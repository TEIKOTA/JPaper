// 契約付録 §8（伏せ字）・伏せ字 ADR(20261015)。指定した文字列を、LLM に渡す前に *** へ置き換える。
import { createHmac } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { JpaperError } from "../types/errors.js";

export const REDACTED = "***";
// 語の最小の長さ（文字数）。
export const MIN_TERM_CHARS = 2;
export const MAX_TERMS = 1000;
// 当て方を変えたら上げる（checkpoint の無効化キーに入り、古い当て方で作った取り込み・読み取りを使い回さない）。
export const REDACT_RULES_VERSION = "2";
// 書き換えないファイルの先頭の印（PDF・PNG・JPEG・GIF。バイト数が変わると壊れる）。
const BINARY_MAGIC = [Buffer.from("%PDF-"), Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from([0xff, 0xd8, 0xff]), Buffer.from("GIF8")];
const MAX_TERM_CHARS = 200;
// 語の中の空白に当てる並び: 空白・改行、LaTeX の空白（~・\ ・\,・\;・\:・\!）、行末のコメントでの継ぎ。
const GAP = String.raw`(?:\s|~|\\[ ,;:!]|%[^\n]*\n)+`;

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

// - と空白を除いた文字数（語の中の - は無くても当てるので、これも MIN_TERM_CHARS 以上を求める）。
const coreChars = (s: string): number => [...s.replace(/[-\s]/g, "")].length;

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// 伏せ字のファイル（1 行 1 語。空行と # で始まる行は読まない）を読む。誤りの文には語を載せない（行番号だけ）。
// API から渡された語の配列を、1 語ずつ検査する（捨てずに誤りにする）。誤りの文には何語目かだけを載せる。
export function checkRedactTerms(terms: readonly unknown[]): string[] {
  if (terms.length === 0) throw new JpaperError(2, "input", "redact に語がありません");
  if (terms.length > MAX_TERMS) throw new JpaperError(2, "input", `redact の語は ${String(MAX_TERMS)} 個までです`);
  const checked = terms.map((t, i) => {
    const s = typeof t === "string" ? t.trim() : "";
    const chars = [...s].length;
    if (chars < MIN_TERM_CHARS || chars > MAX_TERM_CHARS || coreChars(s) < MIN_TERM_CHARS || /[\x00-\x1f\x7f]/.test(s) || s.startsWith("#")) {
      throw new JpaperError(2, "input", `redact の ${String(i + 1)} 語目は ${String(MIN_TERM_CHARS)}〜${String(MAX_TERM_CHARS)} 文字（- を除いて ${String(MIN_TERM_CHARS)} 文字以上）の、改行を含まず # で始まらない文字列にしてください`);
    }
    return s;
  });
  return [...new Set(checked)];
}

export function parseRedactTerms(text: string): string[] {
  const terms = new Set<string>();
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const chars = [...line].length;
    if (chars < MIN_TERM_CHARS || chars > MAX_TERM_CHARS || coreChars(line) < MIN_TERM_CHARS || /[\x00-\x1f\x7f]/.test(line)) {
      throw new JpaperError(
        2,
        "input",
        `--redact-file の ${String(i + 1)} 行目の語は ${String(MIN_TERM_CHARS)}〜${String(MAX_TERM_CHARS)} 文字（- を除いて ${String(MIN_TERM_CHARS)} 文字以上）にしてください`,
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
  // 語の中の - は無くても当てる（行末で分綴すると PDF のテキスト層では - が落ちる）。契約付録 §8（伏せ字）
  // 長さは語の中の - を除いて数える（- を省いて当たる長さ）。
  const len = (t: string): number => t.replace(/(?<=.)-(?=.)/g, "").length;
  const sorted = [...terms].sort((a, b) => len(b) - len(a) || b.length - a.length || (a < b ? -1 : 1));
  const word = (w: string): string => w.split(/(?<=.)-(?=.)/).map(escape).join("-?");
  const pattern = new RegExp(sorted.map((t) => t.split(/\s+/).map(word).join(GAP)).join("|"), "g");
  const h = createHmac("sha256", key).update("jpaper-redact\0").update(REDACT_RULES_VERSION).update("\0");
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
// 直前の \ が偶数個（\\ の改行の後に語）なら制御綴りではない。
export function controlWordHits(tex: string, r: Redactor): number {
  let hits = 0;
  for (const m of tex.matchAll(/(\\+)([A-Za-z@]+)/g)) {
    if (m[1]!.length % 2 === 0) continue;
    r.pattern.lastIndex = 0;
    if (r.pattern.test(m[2]!)) hits++;
  }
  r.pattern.lastIndex = 0;
  return hits;
}

export function matches(text: string, r: Redactor): boolean {
  r.pattern.lastIndex = 0;
  const hit = r.pattern.test(text);
  r.pattern.lastIndex = 0;
  return hit;
}

// 取り込んだソースのテキストのファイル（NUL を含まないもの。拡張子によらない）をすべて書き換える。
// 制御綴り・ファイル名に当たる語があれば入力エラー（置き換えると参照や組版が壊れる）。誤りの文に語は載せない。
export function redactTree(dir: string, r: Redactor): number {
  let replaced = 0;
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      if (matches(e.name, r)) {
        throw new JpaperError(2, "input", "--redact-file の語を名前に含むファイル・ディレクトリがあります。名前を変えてから訳してください");
      }
      if (e.isDirectory()) walk(abs);
      else if (e.isFile() && statSync(abs).size > 0) {
        const buf = readFileSync(abs);
        if (buf.includes(0) || BINARY_MAGIC.some((m) => buf.subarray(0, m.length).equals(m))) continue;
        // UTF-8 として往復できないファイル（latin1 の .bib など）は 1 バイト 1 文字で扱う。
        const utf8 = buf.toString("utf8");
        const encoding: BufferEncoding = Buffer.from(utf8, "utf8").equals(buf) ? "utf8" : "latin1";
        const text = encoding === "utf8" ? utf8 : buf.toString("latin1");
        if (controlWordHits(text, r) > 0) {
          throw new JpaperError(
            2,
            "input",
            `--redact-file の語が LaTeX のコマンド名の中にあります（${redactText(path.relative(dir, abs), r).text}）。置き換えると組版が壊れるため止めました`,
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
