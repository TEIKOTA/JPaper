import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectFigures } from "./resolve.js";

const dirs: string[] = [];
function tmp(files: string[]): string {
  const d = mkdtempSync(path.join(os.tmpdir(), "jpaper-fig-"));
  dirs.push(d);
  for (const rel of files) {
    const abs = path.join(d, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, "IMG");
  }
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("collectFigures", () => {
  it("拡張子補完・実在するもののみ・ソートして返す", () => {
    const d = tmp(["fig1.png", "sub/fig2.pdf"]);
    const latex =
      "\\includegraphics{fig1}\n\\includegraphics[width=1cm]{sub/fig2.pdf}\n\\includegraphics{missing}";
    const figs = collectFigures(latex, d);
    expect(figs).toEqual(
      [path.resolve(d, "fig1.png"), path.resolve(d, "sub/fig2.pdf")].sort(),
    );
  });

  it("\\graphicspath を基準に探索する", () => {
    const d = tmp(["images/plot.pdf"]);
    const latex = "\\graphicspath{{images/}}\n\\includegraphics{plot}";
    expect(collectFigures(latex, d)).toEqual([path.resolve(d, "images/plot.pdf")]);
  });

  it("連続する \\graphicspath は直後の参照で最後の宣言が有効", () => {
    const d = tmp(["old/fig.png", "new/fig.png"]);
    const latex =
      "\\graphicspath{{old/}}\\graphicspath{{new/}}\\includegraphics{fig}";
    expect(collectFigures(latex, d)).toEqual([path.resolve(d, "new/fig.png")]);
  });

  it("\\graphicspath を途中で変えると参照ごとに有効パスで解決する", () => {
    const d = tmp(["a/fig.png", "b/fig.png"]);
    const latex =
      "\\graphicspath{{a/}}\\includegraphics{fig}\\graphicspath{{b/}}\\includegraphics{fig}";
    expect(collectFigures(latex, d)).toEqual(
      [path.resolve(d, "a/fig.png"), path.resolve(d, "b/fig.png")].sort(),
    );
  });

  it("同名 basename が複数ある場合は曖昧として取りこぼす", () => {
    const d = tmp(["a/fig.png", "b/fig.png"]);
    expect(collectFigures("\\includegraphics{fig}", d)).toEqual([]);
  });

  it("\\includegraphics と引数の間の空白も解決する", () => {
    const d = tmp(["fig.png"]);
    expect(collectFigures("\\includegraphics [w=1cm] {fig}", d)).toEqual([
      path.resolve(d, "fig.png"),
    ]);
  });

  it("スター付き \\includegraphics* も解決する", () => {
    const d = tmp(["fig.png"]);
    expect(collectFigures("\\includegraphics*{fig}", d)).toEqual([
      path.resolve(d, "fig.png"),
    ]);
  });

  it("\\graphicspath と引数の間の空白も許容する", () => {
    const d = tmp(["images/fig.png", "other/fig.png"]);
    const latex = "\\graphicspath {{images/}}\\includegraphics{fig}";
    expect(collectFigures(latex, d)).toEqual([path.resolve(d, "images/fig.png")]);
  });

  it("複数 \\graphicspath は最後の宣言を採用する", () => {
    const d = tmp(["old/fig.png", "new/fig.png"]);
    const latex = "\\graphicspath{{old/}}\\graphicspath{{new/}}\\includegraphics{fig}";
    expect(collectFigures(latex, d)).toEqual([path.resolve(d, "new/fig.png")]);
  });

  it("図が無ければ空配列", () => {
    const d = tmp([]);
    expect(collectFigures("\\includegraphics{none}", d)).toEqual([]);
  });

  it("ソースルート外の図は拒否する", () => {
    const container = mkdtempSync(path.join(os.tmpdir(), "jpaper-figesc-"));
    dirs.push(container);
    writeFileSync(path.join(container, "outside.png"), "IMG");
    const src = path.join(container, "src");
    mkdirSync(src);
    expect(collectFigures("\\includegraphics{../outside.png}", src)).toEqual([]);
    expect(
      collectFigures("\\graphicspath{{../}}\n\\includegraphics{outside.png}", src),
    ).toEqual([]);
  });
});

describe("図の解決コストの上限", () => {
  it("未解決参照が多くてもツリーを 1 度しか走査しない", () => {
    // 参照ごとに listAllFiles を呼んでいた頃は O(参照数 × ファイル数) で、
    // 2,000 参照 × 500 ファイル（main.tex 49KB）が 770ms 同期でイベントループを止めた。
    const files = Array.from({ length: 500 }, (_, i) => `pad/p${String(i)}.png`);
    const d = tmp(files);
    const latex = Array.from(
      { length: 2000 },
      (_, i) => `\\includegraphics{nope${String(i)}}`,
    ).join("");
    const started = Date.now();
    expect(collectFigures(latex, d)).toEqual([]);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("\\graphicspath のディレクトリ数でコストが膨らまない", () => {
    // maxFigureRefs は参照件数しか縛らない。1 参照あたりのコストが bases に比例するので、
    // 同じ綴りを数千個並べるだけで実測 39KiB の入力が 36,769ms 同期ブロックした。
    const d = tmp(["fig.png"]);
    const gp = `\\graphicspath{${"{nowhere/}".repeat(4000)}}`;
    const body = Array.from({ length: 1000 }, (_, i) => `\\includegraphics{nope${String(i)}}`).join("");
    const started = Date.now();
    expect(collectFigures(gp + body, d)).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("実在するディレクトリが多すぎたら too-large", () => {
    const dirs = Array.from({ length: 70 }, (_, i) => `d${String(i)}/keep.png`);
    const d = tmp(dirs);
    const gp = `\\graphicspath{${dirs.map((_, i) => `{d${String(i)}/}`).join("")}}`;
    expect(() => collectFigures(`${gp}\\includegraphics{keep}`, d)).toThrowError(/上限/);
  });

  it("図の参照が上限を超えたら too-large", () => {
    const d = tmp(["fig.png"]);
    const latex = Array.from(
      { length: 20 },
      (_, i) => `\\includegraphics{nope${String(i)}}`,
    ).join("");
    expect(() => collectFigures(latex, d, d, 10)).toThrowError(/上限/);
    // 同じ参照の繰り返しは 1 件として数える（正規の論文が同じ図を並べても落ちない）。
    const repeated = "\\includegraphics{fig}".repeat(50);
    expect(collectFigures(repeated, d, d, 10)).toEqual([path.resolve(d, "fig.png")]);
  });
});
