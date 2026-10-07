import { describe, expect, it } from "vitest";
import { isMacroDefinitionsOnly } from "./macro-only.js";

describe("isMacroDefinitionsOnly", () => {
  it("\\def と \\newcommand だけの節は真", () => {
    expect(isMacroDefinitionsOnly("% macros\n\\def\\x{\\mathbf{x}}\n\\newcommand{\\R}{\n  \\mathbb{R}}\n")).toBe(true);
  });
  it("地の文を含めば偽", () => {
    expect(isMacroDefinitionsOnly("\\def\\x{x}\nWe define x.")).toBe(false);
  });
  it("空や定義なしは偽", () => {
    expect(isMacroDefinitionsOnly("% only comment\n")).toBe(false);
  });
  it("\\definecolor のような別命令は定義扱いしない", () => {
    expect(isMacroDefinitionsOnly("\\definecolor{a}{rgb}{0,0,0}")).toBe(false);
  });
});
