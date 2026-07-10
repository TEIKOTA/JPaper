// 契約付録 §5・設計メモ §3。アーカイブ判定＋展開（zlib＋自前 tar/zip・追加依存ゼロ）。
import { gunzipSync, inflateRawSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { JpaperError } from "../types/errors.js";

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
  return b.length >= 262 && b.toString("ascii", 257, 262) === "ustar";
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

export function parseTar(buf: Buffer): FileMap {
  const files: FileMap = new Map();
  let off = 0;
  let override: string | null = null;
  while (off + 512 <= buf.length) {
    const name = readStr(buf, off, 100);
    if (name === "") break;
    const size = parseInt(readStr(buf, off + 124, 12).trim(), 8) || 0;
    const type = buf[off + 156];
    const dataStart = off + 512;
    const data = buf.subarray(dataStart, dataStart + size);
    const advance = dataStart + Math.ceil(size / 512) * 512;
    if (type === 0x4c) {
      override = readZ(data); // GNU long name ('L')
    } else if (type === 0x78) {
      override = paxPath(data) ?? override; // PAX ext header ('x')
    } else if (type === 0x67) {
      // PAX global ('g') は無視
    } else {
      if (type === 0x30 || type === 0) {
        const prefix = readStr(buf, off + 345, 155);
        const ustar = prefix ? `${prefix}/${name}` : name;
        files.set(normalizePath(override ?? ustar), data);
      }
      override = null;
    }
    off = advance;
  }
  return files;
}

function findEOCD(buf: Buffer): number {
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

export function parseZip(buf: Buffer): FileMap {
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
    const comp = buf.subarray(dataStart, dataStart + compSize);
    if (!name.endsWith("/")) {
      let content: Buffer;
      if (method === 0) content = Buffer.from(comp);
      else if (method === 8) content = inflateRawSync(comp);
      else {
        throw new JpaperError(2, "input", `zip: 未対応の圧縮方式 ${method}`);
      }
      files.set(normalizePath(name), content);
    }
    cd += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

export function isArchive(b: Buffer): boolean {
  return isZip(b) || isGzip(b) || isTar(b);
}

export function extractArchive(bytes: Buffer): FileMap {
  try {
    if (isZip(bytes)) return parseZip(bytes);
    if (isGzip(bytes)) {
      const inner = gunzipSync(bytes);
      if (isTar(inner)) return parseTar(inner);
      return new Map([["main.tex", inner]]);
    }
    if (isTar(bytes)) return parseTar(bytes);
    return new Map([["main.tex", bytes]]);
  } catch (e) {
    if (e instanceof JpaperError) throw e;
    throw new JpaperError(
      2,
      "input",
      `アーカイブ展開に失敗: ${String((e as Error)?.message ?? e)}`,
    );
  }
}

export function writeFileMap(files: FileMap, destDir: string): void {
  for (const [rel, content] of files) {
    const abs = path.join(destDir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}
