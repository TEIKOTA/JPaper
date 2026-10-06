import { describe, it, expect } from "vitest";
import { gzipSync, deflateRawSync } from "node:zlib";
import { extractArchive, parseTar } from "./extract.js";
import { fetchArxivSource } from "./arxiv.js";
import { DEFAULT_LIMITS, type IngestLimits } from "./limits.js";

const SMALL: IngestLimits = {
  maxArchiveBytes: 1024 * 1024,
  maxTotalBytes: 64 * 1024,
  maxEntryBytes: 32 * 1024,
  maxEntries: 4,
  maxLatexBytes: DEFAULT_LIMITS.maxLatexBytes,
  maxFigureRefs: DEFAULT_LIMITS.maxFigureRefs,
};

function tarEntry(name: string, size: number): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, "utf8");
  header.write("0000644\0", 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  header.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
  header.write("00000000000\0", 136);
  header.write("        ", 148);
  header.write("0", 156);
  header.write("ustar\0" + "00", 257);
  let sum = 0;
  for (const b of header) sum += b;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  const body = Buffer.alloc(Math.ceil(size / 512) * 512, 0x41);
  return Buffer.concat([header, body]);
}

function tarOf(entries: { name: string; size: number }[]): Buffer {
  return Buffer.concat([...entries.map((e) => tarEntry(e.name, e.size)), Buffer.alloc(1024)]);
}

function zipOf(name: string, raw: Buffer): Buffer {
  const comp = deflateRawSync(raw);
  const nameBuf = Buffer.from(name, "utf8");
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(comp.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  const lho = 0;
  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(8, 10);
  cd.writeUInt32LE(comp.length, 20);
  cd.writeUInt32LE(raw.length, 24);
  cd.writeUInt16LE(nameBuf.length, 28);
  cd.writeUInt32LE(lho, 42);
  const head = Buffer.concat([local, nameBuf, comp]);
  const central = Buffer.concat([cd, nameBuf]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(head.length, 16);
  return Buffer.concat([head, central, eocd]);
}

describe("展開のリソース上限", () => {
  it("gzip 爆弾は展開後の合計サイズ上限で止まる", () => {
    const bomb = gzipSync(Buffer.alloc(1024 * 1024, 0));
    expect(bomb.length).toBeLessThan(SMALL.maxTotalBytes); // 入力は小さい
    expect(() => extractArchive(bomb, SMALL)).toThrow(/上限/);
  });

  it("zip の単一エントリは展開後サイズ上限で止まる", () => {
    const bomb = zipOf("big.tex", Buffer.alloc(200 * 1024, 0x41));
    expect(() => extractArchive(bomb, SMALL)).toThrow(/上限/);
  });

  it("tar の累積サイズが上限を超えたら止まる", () => {
    const tar = tarOf([
      { name: "a.tex", size: 30 * 1024 },
      { name: "b.tex", size: 30 * 1024 },
      { name: "c.tex", size: 30 * 1024 },
    ]);
    expect(() => parseTar(tar, SMALL)).toThrow(/合計サイズ/);
  });

  it("エントリ数が上限を超えたら止まる", () => {
    const tar = tarOf(
      Array.from({ length: 6 }, (_, i) => ({ name: `f${i}.tex`, size: 16 })),
    );
    expect(() => parseTar(tar, SMALL)).toThrow(/エントリ数/);
  });

  it("上限内のアーカイブは従来どおり展開する", () => {
    const files = parseTar(tarOf([{ name: "main.tex", size: 8 }]), SMALL);
    expect([...files.keys()]).toEqual(["main.tex"]);
  });

  it("生アーカイブのサイズ上限を超えたら展開に入らない", () => {
    expect(() => extractArchive(Buffer.alloc(SMALL.maxArchiveBytes + 1), SMALL)).toThrow(/アーカイブ/);
  });

  it("既定の上限は取得上限より展開上限が大きい（圧縮を許容しつつ増幅を止める）", () => {
    expect(DEFAULT_LIMITS.maxTotalBytes).toBeGreaterThan(DEFAULT_LIMITS.maxArchiveBytes);
  });
});

describe("arXiv 取得のサイズ上限", () => {
  const deps = {
    sleep: async () => {},
    minIntervalMs: 0,
    state: { lastRequestAt: 0 },
    limits: SMALL,
  };

  it("Content-Length が上限を超えるなら読まずに失敗する", async () => {
    const res = {
      ok: true,
      status: 200,
      headers: new Headers({ "content-length": String(SMALL.maxArchiveBytes + 1) }),
      body: null,
    } as unknown as Response;
    await expect(
      fetchArxivSource("2203.06060", { ...deps, fetchImpl: async () => res }),
    ).rejects.toThrow(/上限/);
  });

  it("申告が無くても実読み取りバイト数で打ち切る", async () => {
    const chunk = new Uint8Array(16 * 1024);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk);
      },
    });
    const res = { ok: true, status: 200, headers: new Headers(), body } as unknown as Response;
    await expect(
      fetchArxivSource("2203.06060", { ...deps, fetchImpl: async () => res }),
    ).rejects.toThrow(/上限/);
  });

  it("旧形式 ID はスラッシュを保ったまま endpoint へ渡す", async () => {
    const seen: string[] = [];
    const res = {
      ok: true,
      status: 200,
      headers: new Headers(),
      body: null,
      arrayBuffer: async () => Buffer.alloc(4),
    } as unknown as Response;
    await fetchArxivSource("math.GT/0309136", {
      ...deps,
      fetchImpl: async (url) => {
        seen.push(String(url));
        return res;
      },
    });
    expect(seen[0]).toContain("e-print/math.GT/0309136");
  });

  it("形式外の id は取得前に拒否する（URL の向き先を変えさせない）", async () => {
    let called = false;
    await expect(
      fetchArxivSource("../../evil@example.com/x", {
        ...deps,
        fetchImpl: async () => {
          called = true;
          return {} as Response;
        },
      }),
    ).rejects.toThrow(/形式/);
    expect(called).toBe(false);
  });
});
