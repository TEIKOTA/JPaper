// 契約付録 §9（Web アプリ・PDF のアップロード）。受け取った PDF を内容のハッシュの名前で作業フォルダに置く。
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_LIMITS } from "../../../src/ingest/limits.js";
import { JpaperError } from "../../../src/types/errors.js";

export const MAX_UPLOAD_BYTES = DEFAULT_LIMITS.maxArchiveBytes;
// アップロードの ID（内容の sha256 の先頭）の長さ。
const ID_HEX = 16;
const ID = new RegExp(`^[0-9a-f]{${String(ID_HEX)}}$`);
const NAME_MAX = 200;

const tooLarge = (max: number): JpaperError =>
  new JpaperError(2, "input", `PDF が上限 ${String(Math.floor(max / 1024 / 1024))}MiB を超えています`);

// 要求の本文を上限まで読む。上限を超えたら読むのをやめて入力エラー。
export async function readCappedBody(req: Request, max: number): Promise<Buffer> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) throw tooLarge(max);
  if (req.body === null) return Buffer.alloc(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge(max);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

// 表示に使う元のファイル名（URL エンコードされたヘッダの値）。制御文字を除き、200 字で切る。
export function displayName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  let s: string;
  try {
    s = decodeURIComponent(value);
  } catch {
    s = value;
  }
  const name = s.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, NAME_MAX);
  return name === "" ? undefined : name;
}

// 先頭が %PDF- の内容を <dir>/<ID>.pdf に書く（同じ内容は書き直さない）。ID は内容の sha256 の先頭 16 桁。
export function saveUpload(dir: string, body: Buffer): { id: string; file: string; created: boolean } {
  if (body.subarray(0, 5).toString("latin1") !== "%PDF-") {
    throw new JpaperError(2, "input", "PDF ではありません（先頭が %PDF- ではない）");
  }
  const id = createHash("sha256").update(body).digest("hex").slice(0, ID_HEX);
  const file = path.join(dir, `${id}.pdf`);
  if (existsSync(file)) {
    if (readFileSync(file).equals(body)) return { id, file, created: false };
    throw new JpaperError(2, "conflict", "同じ ID の別の PDF が既にあります");
  }
  mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${String(process.pid)}.tmp`;
  try {
    writeFileSync(tmp, body, { flag: "wx" });
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  return { id, file, created: true };
}

// ID から保存した PDF のパスを引く。形が違う・無ければ入力エラー。
export function uploadFile(dir: string, id: unknown): { id: string; file: string } {
  if (typeof id !== "string" || !ID.test(id)) throw new JpaperError(2, "input", "アップロードの ID が不正です");
  const file = path.join(dir, `${id}.pdf`);
  if (!existsSync(file)) throw new JpaperError(2, "input", "アップロードした PDF が見つかりません。もう一度アップロードしてください");
  return { id, file };
}
