import { describe, it, expect } from "vitest";
import { renderGlossaryMd, parseGlossaryMd } from "./glossary-io.js";

describe("glossary.md round-trip", () => {
  it("描画→読み戻しで一致（note 含む）", () => {
    const rows = [
      { src: "attention", form: "アテンション", class: "established", rendering: "translate" },
      {
        src: "value",
        form: "値(Value)",
        class: "paper-defined",
        rendering: "bilingual",
        note: "論文定義",
      },
    ];
    expect(parseGlossaryMd(renderGlossaryMd(rows))).toEqual(rows);
  });

  it("ヘッダ・区切り行は無視する", () => {
    expect(parseGlossaryMd(renderGlossaryMd([]))).toEqual([]);
  });

  it("セル内の | は無害化する", () => {
    const parsed = parseGlossaryMd(
      renderGlossaryMd([{ src: "a|b", form: "x|y", class: "established", rendering: "translate" }]),
    );
    expect(parsed[0]!.src).toBe("a b");
  });
});
