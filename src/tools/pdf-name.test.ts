import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MAX_SLUG_CHARS,
  deliverableName,
  dropDeliverables,
  normalizeSlug,
  publishDeliverable,
  safeFileId,
  takePdfNameLine,
} from "./pdf-name.js";

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(path.join(os.tmpdir(), "jpaper-pdfname-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("normalizeSlug", () => {
  it("英小文字・数字・ハイフンだけに整える", () => {
    expect(normalizeSlug("PathoROB")).toBe("pathorob");
    expect(normalizeSlug("CellViT")).toBe("cellvit");
    expect(normalizeSlug("  Vision Transformer!! ")).toBe("vision-transformer");
    expect(normalizeSlug("vision_transformer--v2")).toBe("vision-transformer-v2");
    expect(normalizeSlug("`fast-rcnn`")).toBe("fast-rcnn");
    expect(normalizeSlug("Señor Ünïcode")).toBe("senor-unicode");
    expect(normalizeSlug("ＧＰＴ４")).toBe("gpt4");
  });

  it("英数字が残らなければ undefined", () => {
    expect(normalizeSlug("")).toBeUndefined();
    expect(normalizeSlug("   ")).toBeUndefined();
    expect(normalizeSlug("甲の研究")).toBeUndefined();
    expect(normalizeSlug("---")).toBeUndefined();
    expect(normalizeSlug("../")).toBeUndefined();
  });

  it(`長さは ${String(MAX_SLUG_CHARS)} 文字まで（語の境目で切る。1 語で超えるならその語を切る）`, () => {
    const long = normalizeSlug("alpha beta gamma delta epsilon zeta eta theta iota kappa")!;
    expect(long.length).toBeLessThanOrEqual(MAX_SLUG_CHARS);
    expect(long).toBe("alpha-beta-gamma-delta-epsilon-zeta-eta");
    expect(normalizeSlug("a".repeat(100))).toBe("a".repeat(MAX_SLUG_CHARS));
  });
});

describe("takePdfNameLine", () => {
  it("名前の行を取り外し、値を返す", () => {
    expect(takePdfNameLine("\\title{甲の研究}\n% pdf-name: pathorob")).toEqual({
      text: "\\title{甲の研究}",
      name: "pathorob",
    });
    expect(takePdfNameLine("\\title{甲}\n  %pdf-name :  Cell ViT  \n")).toEqual({
      text: "\\title{甲}",
      name: "Cell ViT",
    });
    expect(takePdfNameLine("% PDF-NAME: x\n\\title{甲}")).toEqual({ text: "\\title{甲}", name: "x" });
  });

  it("複数あれば全部取り外し、最後の値を使う", () => {
    expect(takePdfNameLine("% pdf-name: a\n\\title{甲}\n% pdf-name: b")).toEqual({
      text: "\\title{甲}",
      name: "b",
    });
  });

  it("名前の行が無ければ本文をそのまま返す", () => {
    expect(takePdfNameLine("\\title{甲}\n% comment")).toEqual({ text: "\\title{甲}\n% comment" });
    expect(takePdfNameLine("\\title{甲}\n")).toEqual({ text: "\\title{甲}\n" });
  });
});

describe("safeFileId / deliverableName", () => {
  it("ファイル名に使えない文字を _ にし、先頭の . を潰す", () => {
    expect(safeFileId("2507.17845")).toBe("2507.17845");
    expect(safeFileId("a b/c")).toBe("a_b_c");
    expect(safeFileId("..")).toBe("__");
    expect(safeFileId(".hidden")).toBe("_hidden");
    expect(safeFileId("")).toBe("paper");
    expect(safeFileId("x".repeat(300))).toHaveLength(100);
  });

  it("<ID>_<slug>-<kind>.pdf。slug が無い・不正なら ID だけ", () => {
    expect(deliverableName("2507.17845", "pathorob", "ja")).toBe("2507.17845_pathorob-ja.pdf");
    expect(deliverableName("2507.17845", "pathorob", "bilingual")).toBe("2507.17845_pathorob-bilingual.pdf");
    expect(deliverableName("2306.15350", "CellViT", "ja")).toBe("2306.15350_cellvit-ja.pdf");
    expect(deliverableName("2507.17845", undefined, "ja")).toBe("2507.17845-ja.pdf");
    expect(deliverableName("2507.17845", "甲", "bilingual")).toBe("2507.17845-bilingual.pdf");
    expect(deliverableName("a/b", "../x", "ja")).toBe("a_b_x-ja.pdf");
  });
});

describe("publishDeliverable / dropDeliverables", () => {
  const touch = (dir: string, name: string): void => writeFileSync(path.join(dir, name), name);

  it("PDF を名前を付けて置き、同じ種類の古い名前の成果物だけを消す", () => {
    const out = tmp();
    const build = path.join(out, "translation", "build");
    mkdirSync(build, { recursive: true });
    writeFileSync(path.join(build, "main.pdf"), "%PDF-new");
    touch(out, "p_old-ja.pdf");
    touch(out, "p-ja.pdf");
    touch(out, "p_old-bilingual.pdf");
    touch(out, "notes.json");
    const dest = publishDeliverable(out, path.join(build, "main.pdf"), "p_new-ja.pdf", "ja");
    expect(dest).toBe(path.join(out, "p_new-ja.pdf"));
    expect(readFileSync(dest, "utf8")).toBe("%PDF-new");
    // 組版の build の main.pdf は残す。
    expect(readFileSync(path.join(build, "main.pdf"), "utf8")).toBe("%PDF-new");
    expect(readdirSync(out).sort()).toEqual(["notes.json", "p_new-ja.pdf", "p_old-bilingual.pdf", "translation"]);
  });

  it("dropDeliverables は種類を省くと両方消し、成果物以外とディレクトリには触れない", () => {
    const out = tmp();
    touch(out, "p-ja.pdf");
    touch(out, "p_x-bilingual.pdf");
    touch(out, "glossary.md");
    touch(out, "paper.pdf");
    mkdirSync(path.join(out, "keep-ja.pdf"));
    dropDeliverables(out, "bilingual");
    expect(readdirSync(out).sort()).toEqual(["glossary.md", "keep-ja.pdf", "p-ja.pdf", "paper.pdf"]);
    dropDeliverables(out);
    expect(readdirSync(out).sort()).toEqual(["glossary.md", "keep-ja.pdf", "paper.pdf"]);
  });

  it("出力先が無くても投げない", () => {
    expect(() => dropDeliverables(path.join(tmp(), "missing"))).not.toThrow();
  });
});
