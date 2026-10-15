import { describe, expect, it } from "vitest";
import { inflateSync } from "node:zlib";
import { encodePng, paintWhite, parsePpm } from "./raster.js";

const ppm = (w: number, h: number, fill: number): Buffer =>
  Buffer.concat([Buffer.from(`P6\n# c\n${String(w)} ${String(h)}\n255\n`, "latin1"), Buffer.alloc(w * h * 3, fill)]);

describe("白塗りと PNG", () => {
  it("PPM を読み、矩形を白で塗って（画像の外ははみ出さない）PNG に書く", () => {
    const r = parsePpm(ppm(4, 3, 0));
    paintWhite(r, [{ x0: 1, y0: 1, x1: 9, y1: 2 }]);
    const png = encodePng(r);
    expect(png.subarray(1, 4).toString("latin1")).toBe("PNG");
    // IDAT を戻して、行ごとのフィルタ 0 と画素を確かめる。
    const idat = png.indexOf("IDAT");
    const len = png.readUInt32BE(idat - 4);
    const raw = inflateSync(png.subarray(idat + 4, idat + 4 + len));
    const px = (x: number, y: number): number => raw[y * (4 * 3 + 1) + 1 + x * 3]!;
    expect([px(0, 1), px(1, 1), px(3, 1), px(1, 0), px(1, 2)]).toEqual([0, 255, 255, 0, 0]);
  });

  it("P6 でない入力は読めない", () => {
    expect(() => parsePpm(Buffer.from("P3\n1 1\n255\n0 0 0"))).toThrow();
  });
});
