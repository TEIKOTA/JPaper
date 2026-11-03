import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { segment } from "./segmenter.js";

// 分割した節を空行でつないだ本文が lualatex で組める。lualatex が無い環境では飛ばす。

const hasLua = spawnSync("lualatex", ["--version"], { stdio: "ignore" }).status === 0;

// 2201.04234 の sections/appendix.tex 592 行目の形（\update は \textcolor で包む）。issue #542
const SOURCE = [
  "\\documentclass{article}",
  "\\usepackage{xcolor}",
  "\\newcommand{\\update}[1]{\\textcolor{black}{#1}}",
  "\\begin{document}",
  "\\section{A}",
  "前の節の本文。",
  "",
  "\\update{\\subsection{Details on setup}} \\label{app:fig1_details}",
  "",
  "後ろの本文。",
  "\\section{B}",
  "最後。",
  "\\end{document}",
].join("\n");

function typeset(joined: string): string[] {
  const dir = mkdtempSync(path.join(tmpdir(), "jpaper-seg-"));
  try {
    const head = SOURCE.slice(0, SOURCE.indexOf("\\begin{document}") + "\\begin{document}".length);
    writeFileSync(path.join(dir, "main.tex"), `${head}\n${joined}\n\\end{document}\n`);
    const r = spawnSync("lualatex", ["-interaction=nonstopmode", "-halt-on-error", "main.tex"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 120_000,
    });
    const errors = r.stdout.split("\n").filter((l) => l.startsWith("!"));
    return existsSync(path.join(dir, "main.pdf")) ? errors : [...errors, "main.pdf が無い"];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(!hasLua)("見出しを波括弧で包む原文の分割を組む（issue #542）", () => {
  it("分割した節を空行でつないでも PDF が出る", () => {
    const segs = segment(SOURCE, 100000);
    expect(typeset(segs.map((s) => s.latex).join("\n\n"))).toEqual([]);
  }, 180_000);
});
