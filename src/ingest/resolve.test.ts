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

  it("図が無ければ空配列", () => {
    const d = tmp([]);
    expect(collectFigures("\\includegraphics{none}", d)).toEqual([]);
  });
});
