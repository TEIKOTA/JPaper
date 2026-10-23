import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assembleWithMap } from "./assemble-latex.js";

// 共通テンプレートの組み立て結果を lualatex で実際に組む。lualatex と luatexja が無い環境では飛ばす。

const hasLuaTex =
  spawnSync("lualatex", ["--version"], { stdio: "ignore" }).status === 0 &&
  spawnSync("kpsewhich", ["luatexja-preset.sty"], { encoding: "utf8" }).stdout.trim() !== "";

// 1912.02400（GECCO '20、acmart の sigconf）の前文と著者欄・謝辞の形。
const ACMART = [
  "\\documentclass[sigconf]{acmart}",
  "\\setcopyright{rightsretained}",
  "\\copyrightyear{2020}",
  "\\acmYear{2020}",
  "\\setcopyright{acmlicensed}\\acmConference[GECCO '20]{Genetic and Evolutionary Computation Conference}{July 8--12, 2020}{Canc\\'un, Mexico}",
  "\\acmBooktitle{Genetic and Evolutionary Computation Conference (GECCO '20)}",
  "\\acmPrice{15.00}",
  "\\acmDOI{10.1145/3377930.3390232}",
  "\\acmISBN{978-1-4503-7128-5/20/07}",
  "\\begin{document}",
  "\\end{document}",
].join("\n");

const BODY = [
  "\\title{T}",
  "\\author{A}",
  "\\affiliation{\\institution{U}\\city{Los Angeles}\\state{CA}}",
  "\\email{a@example.com}",
  "\\renewcommand{\\shortauthors}{A}",
  "\\maketitle",
  "\\section{はじめに}",
  "本文。",
  "\\begin{acks}",
  "謝辞の本文。",
  "\\end{acks}",
].join("\n");

function build(cleanLatex: string, body: string): string[] {
  const dir = mkdtempSync(path.join(tmpdir(), "jpaper-acm-"));
  try {
    const { mainTex } = assembleWithMap({ cleanLatex, segments: [{ id: "seg-0000", tex: body }], mode: "template" });
    writeFileSync(path.join(dir, "main.tex"), mainTex);
    const r = spawnSync("lualatex", ["-interaction=nonstopmode", "-halt-on-error", "main.tex"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 240_000,
    });
    const errors = r.stdout.split("\n").filter((l) => l.startsWith("!"));
    return existsSync(path.join(dir, "main.pdf")) ? errors : [...errors, "main.pdf が無い"];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// acmart 以外の論文が acmart の shim と同じ名前を自分で定義する形（強化学習の \state など）。
const ARTICLE_OWN = [
  "\\documentclass{article}",
  "\\newcommand{\\state}{s}",
  "\\newcommand{\\orcid}[1]{}",
  "\\newenvironment{acks}{\\section*{Acknowledgments}}{}",
  "\\begin{document}",
  "\\end{document}",
].join("\n");

describe.skipIf(!hasLuaTex)("acmart の論文を共通テンプレートで組む（issue #495）", () => {
  it("acmart 以外の論文が同じ名前の命令・環境を定義していても PDF が出る", () => {
    expect(build(ARTICLE_OWN, "$\\state$\n\\begin{acks}x\\end{acks}")).toEqual([]);
  }, 300_000);

  it("前文の書誌メタデータ・\\shortauthors・acks 環境があっても PDF が出る", () => {
    expect(build(ACMART, BODY)).toEqual([]);
  }, 300_000);
});
