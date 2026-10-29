import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runBuildGate } from "./build-gate.js";
import { summarizeGateFailure } from "../workflows/translate-paper.js";
import { outwardMessage } from "../types/errors.js";

// 実際の latexmk（lualatex）で組み、TeX Live のファイルのエラーの理由が読めることを確かめる（issue #515）。
const hasLatexmk =
  spawnSync("latexmk", ["-v"], { stdio: "ignore" }).status === 0 &&
  spawnSync("lualatex", ["--version"], { stdio: "ignore" }).status === 0;

// 2107.04649 の前文。xcolor が `color` を未知のオプションとして拒む。
const MAIN = [
  "\\documentclass{article}",
  "\\usepackage[svgnames,dvipsnames,color,table]{xcolor}",
  "\\begin{document}",
  "x",
  "\\end{document}",
  "",
].join("\n");

describe.skipIf(!hasLatexmk)("組版の失敗の理由（issue #515）", () => {
  it("TeX Live の長いパスのエラーが 1 行で読め、ホストの絶対パスは出ない", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "jpaper-gate-"));
    try {
      const src = path.join(root, "src");
      mkdirSync(src);
      const r = await runBuildGate({
        buildDir: path.join(root, "build"),
        mainTex: MAIN,
        sourceDir: src,
        mainDir: src,
        figures: [],
        sourceMap: [],
        originalTex: MAIN,
      });
      expect(r.buildOk).toBe(false);
      expect(r.structuralErrors[0]).toBe("xcolor.sty:265: LaTeX Error: Unknown option 'color' for package xcolor.");
      const msg = outwardMessage(summarizeGateFailure(r));
      expect(msg).toContain("xcolor.sty:265: LaTeX Error: Unknown option 'color' for package xcolor.");
      expect(msg).not.toContain("<path>");
      expect(msg).not.toContain("/usr/");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 300_000);
});
