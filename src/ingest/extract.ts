// 契約付録 §5・設計メモ §3。アーカイブ判定＋展開（zlib＋自前 tar/zip・追加依存ゼロ）。
import { gunzipSync, inflateRawSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { JpaperError } from "../types/errors.js";
import { DEFAULT_LIMITS, type IngestLimits } from "./limits.js";

export type FileMap = Map<string, Buffer>;

function isGzip(b: Buffer): boolean {
  return b.length > 2 && b[0] === 0x1f && b[1] === 0x8b;
}
function isZip(b: Buffer): boolean {
  return (
    b.length > 4 &&
    b[0] === 0x50 &&
    b[1] === 0x4b &&
    b[2] === 0x03 &&
    b[3] === 0x04
  );
}
function isTar(b: Buffer): boolean {
  if (b.length < 512) return false;
  if (b.toString("ascii", 257, 262) === "ustar") return true;
  // V7（ustar マジック無し）はヘッダチェックサムで判定。
  const stored = parseInt(readStr(b, 148, 8).trim(), 8);
  if (!Number.isFinite(stored)) return false;
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : b[i]!;
  return sum === stored;
}

function readStr(b: Buffer, start: number, len: number): string {
  const slice = b.subarray(start, start + len);
  const nul = slice.indexOf(0);
  return slice.toString("utf8", 0, nul === -1 ? len : nul);
}

function normalizePath(p: string): string {
  const norm = p.replace(/\\/g, "/").replace(/^\.\//, "");
  if (norm.split("/").some((seg) => seg === "..")) {
    throw new JpaperError(2, "input", `不正なアーカイブパス: ${p}`);
  }
  return norm;
}

function readZ(b: Buffer): string {
  const nul = b.indexOf(0);
  return b.toString("utf8", 0, nul === -1 ? b.length : nul);
}

function paxPath(data: Buffer): string | null {
  const m = /(?:^|\n)\d+ path=([^\n]*)/.exec(data.toString("utf8"));
  return m ? (m[1] ?? null) : null;
}

function tooLarge(what: string, limit: number): JpaperError {
  return new JpaperError(2, "too-large", `${what}が上限 ${limit} バイトを超えています`);
}

// 展開量の累積を 1 箇所で監視する（tar/zip/gzip のどの経路でも同じ上限を効かせる）。
class Budget {
  private total = 0;
  private entries = 0;
  constructor(private readonly limits: IngestLimits) {}
  admit(size: number): void {
    if (++this.entries > this.limits.maxEntries) {
      throw new JpaperError(2, "too-large", `アーカイブのエントリ数が上限 ${this.limits.maxEntries} を超えています`);
    }
    if (size > this.limits.maxEntryBytes) throw tooLarge("アーカイブ内の単一ファイル", this.limits.maxEntryBytes);
    this.total += size;
    if (this.total > this.limits.maxTotalBytes) throw tooLarge("展開後の合計サイズ", this.limits.maxTotalBytes);
  }
  get remaining(): number {
    return Math.max(0, this.limits.maxTotalBytes - this.total);
  }
}

export function parseTar(buf: Buffer, limits: IngestLimits = DEFAULT_LIMITS): FileMap {
  const budget = new Budget(limits);
  const files: FileMap = new Map();
  let off = 0;
  let override: string | null = null;
  let terminated = false;
  while (off + 512 <= buf.length) {
    const name = readStr(buf, off, 100);
    if (name === "") {
      terminated = true;
      break;
    }
    const size = parseInt(readStr(buf, off + 124, 12).trim(), 8) || 0;
    const type = buf[off + 156];
    const dataStart = off + 512;
    const advance = dataStart + Math.ceil(size / 512) * 512;
    if (dataStart + size > buf.length || advance > buf.length) {
      throw new JpaperError(2, "input", "tar が途中で切れています");
    }
    const data = buf.subarray(dataStart, dataStart + size);
    if (type === 0x4c) {
      override = readZ(data); // GNU long name ('L')
    } else if (type === 0x78) {
      override = paxPath(data) ?? override; // PAX ext header ('x')
    } else if (type === 0x67) {
      // PAX global ('g') は無視
    } else {
      if (type === 0x30 || type === 0) {
        budget.admit(size);
        const prefix = readStr(buf, off + 345, 155);
        const ustar = prefix ? `${prefix}/${name}` : name;
        files.set(normalizePath(override ?? ustar), data);
      }
      override = null;
    }
    off = advance;
  }
  if (!terminated) {
    throw new JpaperError(2, "input", "tar が途中で切れています");
  }
  return files;
}

function findEOCD(buf: Buffer): number {
  const minEnd = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= minEnd; i--) {
    if (
      buf.readUInt32LE(i) === 0x06054b50 &&
      i + 22 + buf.readUInt16LE(i + 20) === buf.length
    ) {
      return i;
    }
  }
  return -1;
}

export function parseZip(buf: Buffer, limits: IngestLimits = DEFAULT_LIMITS): FileMap {
  const budget = new Budget(limits);
  const files: FileMap = new Map();
  const eocd = findEOCD(buf);
  if (eocd < 0) throw new JpaperError(2, "input", "zip: EOCD が見つかりません");
  const count = buf.readUInt16LE(eocd + 10);
  let cd = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(cd) !== 0x02014b50) {
      throw new JpaperError(2, "input", "zip: 中央ディレクトリが壊れています");
    }
    const method = buf.readUInt16LE(cd + 10);
    const compSize = buf.readUInt32LE(cd + 20);
    const nameLen = buf.readUInt16LE(cd + 28);
    const extraLen = buf.readUInt16LE(cd + 30);
    const commentLen = buf.readUInt16LE(cd + 32);
    const lho = buf.readUInt32LE(cd + 42);
    const name = buf.toString("utf8", cd + 46, cd + 46 + nameLen);
    const lNameLen = buf.readUInt16LE(lho + 26);
    const lExtraLen = buf.readUInt16LE(lho + 28);
    const dataStart = lho + 30 + lNameLen + lExtraLen;
    if (dataStart + compSize > buf.length) {
      throw new JpaperError(2, "input", "zip が途中で切れています");
    }
    const comp = buf.subarray(dataStart, dataStart + compSize);
    if (!name.endsWith("/")) {
      let content: Buffer;
      // 展開後サイズは圧縮ヘッダを信用できないため、zlib 側の出力上限で止める。
      const cap = Math.min(limits.maxEntryBytes, budget.remaining) + 1;
      if (method === 0) content = Buffer.from(comp);
      else if (method === 8) content = inflateRawSync(comp, { maxOutputLength: cap });
      else {
        throw new JpaperError(2, "input", `zip: 未対応の圧縮方式 ${method}`);
      }
      budget.admit(content.length);
      files.set(normalizePath(name), content);
    }
    cd += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

export function isArchive(b: Buffer): boolean {
  return isZip(b) || isGzip(b) || isTar(b);
}

export function extractArchive(bytes: Buffer, limits: IngestLimits = DEFAULT_LIMITS): FileMap {
  if (bytes.length > limits.maxArchiveBytes) throw tooLarge("アーカイブ", limits.maxArchiveBytes);
  try {
    if (isZip(bytes)) return parseZip(bytes, limits);
    if (isGzip(bytes)) {
      const inner = gunzipSync(bytes, { maxOutputLength: limits.maxTotalBytes + 1 });
      if (isTar(inner)) return parseTar(inner, limits);
      return new Map([["main.tex", inner]]);
    }
    if (isTar(bytes)) return parseTar(bytes, limits);
    return new Map([["main.tex", bytes]]);
  } catch (e) {
    if (e instanceof JpaperError) throw e;
    // zlib の出力上限超過は Buffer 系エラーで来る。上限違反として扱う。
    if ((e as { code?: string })?.code === "ERR_BUFFER_TOO_LARGE") {
      throw tooLarge("展開後の合計サイズ", limits.maxTotalBytes);
    }
    throw new JpaperError(
      2,
      "input",
      `アーカイブ展開に失敗: ${String((e as Error)?.message ?? e)}`,
    );
  }
}

// エントリ名そのものが不正で書けない場合の syscode。権限・容量（EACCES/ENOSPC 等）とは
// 分けて扱う。"." エントリやファイル a と a/b の衝突は入力起因なのに、素通しすると
// infra（exit 1＝サーバ側の障害）として報告され、誤ったアラートと自動リトライを誘発する。
const ENTRY_NAME_SYSCODES = new Set(["EISDIR", "EEXIST", "ENOTDIR", "ENAMETOOLONG"]);

export function writeFileMap(files: FileMap, destDir: string): void {
  for (const [rel, content] of files) {
    const abs = path.join(destDir, rel);
    try {
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code !== undefined && ENTRY_NAME_SYSCODES.has(code)) {
        throw new JpaperError(2, "input", `アーカイブのエントリ名が不正です: ${rel}`);
      }
      throw e;
    }
  }
}
