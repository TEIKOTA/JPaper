// 契約付録 §8（伏せ字）。pdftoppm の PPM（P6・8 bit）の矩形を白で塗り、PNG に書く。外部の画像ライブラリは使わない。
import { deflateSync } from "node:zlib";
import { JpaperError } from "../../types/errors.js";

export interface Raster {
  width: number;
  height: number;
  // RGB の 3 バイトずつ、行ごと。
  data: Buffer;
}

export interface PixelBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

// P6 の PPM を読む（コメント行を飛ばす）。
export function parsePpm(buf: Buffer): Raster {
  let pos = 0;
  const token = (): string => {
    for (;;) {
      while (pos < buf.length && /\s/.test(String.fromCharCode(buf[pos]!))) pos++;
      if (buf[pos] === 0x23) {
        while (pos < buf.length && buf[pos] !== 0x0a) pos++;
        continue;
      }
      break;
    }
    const start = pos;
    while (pos < buf.length && !/\s/.test(String.fromCharCode(buf[pos]!))) pos++;
    return buf.toString("latin1", start, pos);
  };
  const magic = token();
  const width = Number(token());
  const height = Number(token());
  const max = Number(token());
  pos++;
  if (magic !== "P6" || !(width > 0) || !(height > 0) || max !== 255 || buf.length - pos < width * height * 3) {
    throw new JpaperError(1, "internal", "pdftoppm の出力（PPM）を読めません");
  }
  return { width, height, data: buf.subarray(pos, pos + width * height * 3) };
}

// 矩形（画素。端を含まない）を白で塗る。画像の外ははみ出さない。
export function paintWhite(r: Raster, boxes: readonly PixelBox[]): void {
  for (const b of boxes) {
    const x0 = Math.max(0, Math.floor(b.x0));
    const y0 = Math.max(0, Math.floor(b.y0));
    const x1 = Math.min(r.width, Math.ceil(b.x1));
    const y1 = Math.min(r.height, Math.ceil(b.y1));
    for (let y = y0; y < y1; y++) r.data.fill(0xff, (y * r.width + x0) * 3, (y * r.width + x1) * 3);
  }
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// RGB 8 bit の PNG（フィルタなし）。
export function encodePng(r: Raster): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(r.width, 0);
  ihdr.writeUInt32BE(r.height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const stride = r.width * 3;
  const raw = Buffer.alloc((stride + 1) * r.height);
  for (let y = 0; y < r.height; y++) r.data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
