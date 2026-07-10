// テスト用の tar/zip バイト列生成（本番非依存・ビルド対象外）。
export function makeTar(entries: { name: string; content: string }[]): Buffer {
  const blocks: Buffer[] = [];
  for (const e of entries) {
    const data = Buffer.from(e.content, "utf8");
    const header = Buffer.alloc(512);
    header.write(e.name, 0);
    header.write("0000644 ", 100);
    header.write("0000000 ", 108);
    header.write("0000000 ", 116);
    header.write(`${data.length.toString(8).padStart(11, "0")} `, 124);
    header.write("00000000000 ", 136);
    header.write("        ", 148);
    header.write("0", 156);
    header.write("ustar\0", 257);
    header.write("00", 263);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += header[i]!;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512);
    data.copy(padded);
    blocks.push(header, padded);
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

function tarHeader(name: string, size: number, type: string): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0);
  h.write("0000644 ", 100);
  h.write("0000000 ", 108);
  h.write("0000000 ", 116);
  h.write(`${size.toString(8).padStart(11, "0")} `, 124);
  h.write("00000000000 ", 136);
  h.write("        ", 148);
  h.write(type, 156);
  h.write("ustar\0", 257);
  h.write("00", 263);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += h[i]!;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return h;
}

function pad512(data: Buffer): Buffer {
  const p = Buffer.alloc(Math.ceil(data.length / 512) * 512);
  data.copy(p);
  return p;
}

export function makeTarGnuLong(longName: string, content: string): Buffer {
  const nameBuf = Buffer.from(`${longName}\0`, "utf8");
  const data = Buffer.from(content, "utf8");
  return Buffer.concat([
    tarHeader("././@LongLink", nameBuf.length, "L"),
    pad512(nameBuf),
    tarHeader(longName.slice(0, 100), data.length, "0"),
    pad512(data),
    Buffer.alloc(1024),
  ]);
}

export function makeTarV7(entries: { name: string; content: string }[]): Buffer {
  const blocks: Buffer[] = [];
  for (const e of entries) {
    const data = Buffer.from(e.content, "utf8");
    const h = Buffer.alloc(512);
    h.write(e.name, 0);
    h.write("0000644 ", 100);
    h.write("0000000 ", 108);
    h.write("0000000 ", 116);
    h.write(`${data.length.toString(8).padStart(11, "0")} `, 124);
    h.write("00000000000 ", 136);
    h.write("        ", 148);
    h.write("0", 156);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += h[i]!;
    h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(h, pad512(data));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

export function makeTarPax(longName: string, content: string): Buffer {
  const record = Buffer.from(`100 path=${longName}\n`, "utf8");
  const data = Buffer.from(content, "utf8");
  return Buffer.concat([
    tarHeader("PaxHeader", record.length, "x"),
    pad512(record),
    tarHeader(longName.slice(0, 100), data.length, "0"),
    pad512(data),
    Buffer.alloc(1024),
  ]);
}

export function makeZip(
  entries: { name: string; content: string }[],
  comment: Buffer = Buffer.alloc(0),
): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const data = Buffer.from(e.content, "utf8");
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 8);
    lh.writeUInt32LE(0, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    local.push(lh, name, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt32LE(0, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += lh.length + name.length + data.length;
  }
  const cdStart = offset;
  const cdSize = central.reduce((n, b) => n + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(comment.length, 20);
  return Buffer.concat([...local, ...central, eocd, comment]);
}
