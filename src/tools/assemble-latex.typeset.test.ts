import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { classifyLog } from "./build-gate.js";
import { assembleWithMap } from "./assemble-latex.js";
import { sandboxEnv, stageBuild } from "./build-gate.js";

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

function build(cleanLatex: string, body: string, mode: "original" | "template" = "template"): string[] {
  const dir = mkdtempSync(path.join(tmpdir(), "jpaper-acm-"));
  try {
    const { mainTex } = assembleWithMap({ cleanLatex, segments: [{ id: "seg-0000", tex: body }], mode });
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

// 古い acmart で書かれ、所属に \\country が無い論文（1912.02400 の著者欄の形）。
const ACMART_NO_COUNTRY = ["\\documentclass[sigconf]{acmart}", "\\begin{document}", "\\end{document}"].join("\n");
const NO_COUNTRY_BODY = [
  "\\title{T}",
  "\\author{A}",
  "\\affiliation{\\institution{U}\\city{Los Angeles}\\state{CA}}",
  "\\author{B}",
  "\\affiliation{\\institution{V}\\city{New York City}}",
  "\\begin{abstract}要旨。\\end{abstract}",
  "\\maketitle",
  "本文。",
].join("\n");

const hasAcmartCountryCheck =
  hasLuaTex &&
  (() => {
    const cls = spawnSync("kpsewhich", ["acmart.cls"], { encoding: "utf8" }).stdout.trim();
    return cls !== "" && readFileSync(cls, "utf8").includes("No country present");
  })();

describe.skipIf(!hasAcmartCountryCheck)("国名の無い acmart の所属を原文の前文で組む（issue #497）", () => {
  it("\\country の無い所属があっても acmart の検査で止まらず PDF が出る", () => {
    expect(build(ACMART_NO_COUNTRY, NO_COUNTRY_BODY, "original")).toEqual([]);
  }, 300_000);

  it("前文で \\makeatletter を開いたまま本文で @ 入りの命令を使う論文も、原文の前文で組める", () => {
    const own = ["\\documentclass{article}", "\\makeatletter", "\\newcommand{\\foo@bar}{X}", "\\begin{document}", "\\end{document}"].join("\n");
    expect(build(own, "\\foo@bar\n\\makeatother", "original")).toEqual([]);
  }, 300_000);
});

// 2107.03315（ICCV 2021）の形: \author の引数の中に空行がある。
describe.skipIf(!hasLuaTex)("\\author の引数の中の空行（issue #517）", () => {
  const own = ["\\documentclass{article}", "\\title{T}", "\\author{A\\\\", "", "B}", "\\begin{document}", "\\end{document}"].join("\n");
  it.each(["original", "template"] as const)("%s: 空行を詰めて PDF が出る", (mode) => {
    expect(build(own, "\\maketitle\n本文。", mode)).toEqual([]);
  }, 300_000);
});

// 2107.03315（ICCV 2021）の \begin{document} から \maketitle まで。\author の引数（74 行目付近）に空行がある。
const ICCV_FRONT = readFileSync(new URL("./fixtures/iccv-2107.03315-front.tex", import.meta.url), "utf8");
describe.skipIf(!hasLuaTex)("本文にある \\author の引数の空行（issue #517、2107.03315）", () => {
  const clean = `\\documentclass{article}\n\\begin{document}\n${ICCV_FRONT}\n\\end{document}\n`;
  it.each(["original", "template"] as const)("%s: 訳文が空行を写していても PDF が出る", (mode) => {
    expect(build(clean, ICCV_FRONT, mode)).toEqual([]);
  }, 300_000);

  it("空行が残った実ログは構造起因に分類される", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "jpaper-iccv-"));
    try {
      const { mainTex, sourceMap } = assembleWithMap({ cleanLatex: clean, segments: [{ id: "seg-0000", tex: ICCV_FRONT }] });
      // 詰めた後の main.tex に原文の空行を戻して、組版が止まったときのログを作る。
      writeFileSync(path.join(dir, "main.tex"), mainTex.replace("Vaishaal Shankar", "\n\nVaishaal Shankar"));
      const r = spawnSync("lualatex", ["-interaction=nonstopmode", "-file-line-error", "-halt-on-error", "main.tex"], { cwd: dir, encoding: "utf8", timeout: 240_000 });
      const c = classifyLog(r.stdout, sourceMap, clean);
      expect(r.stdout).toContain("Paragraph ended before \\author");
      expect(c.failedSegments).toEqual([]);
      expect(c.structuralErrors.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 300_000);
});

// 同梱 .sty が siunitx を読んだ後に \newcommand{\unit} を定義する形（2201.04234 の lifetime.sty）。
describe.skipIf(!hasLuaTex)("同梱 .sty の \\unit が siunitx v3 と衝突する論文を組む（issue #531）", () => {
  it("siunitx を読む .sty と \\newcommand{\\unit} があっても PDF が出る", () => {
    const src = mkdtempSync(path.join(tmpdir(), "jpaper-unit-src-"));
    const dir = path.join(mkdtempSync(path.join(tmpdir(), "jpaper-unit-")), "b");
    try {
      writeFileSync(path.join(src, "life.sty"), "\\usepackage{siunitx}\n\\newcommand{\\unit}{\\boldsymbol{1}}\n");
      const cleanLatex = [
        "\\documentclass{article}",
        "\\usepackage{amsmath,amssymb,bm}",
        "\\usepackage{life}",
        "\\begin{document}",
        "\\end{document}",
      ].join("\n");
      const { mainTex } = assembleWithMap({ cleanLatex, segments: [{ id: "seg-0000", tex: "$\\unit$ と \\qty{3}{m}" }], mode: "original" });
      stageBuild(dir, mainTex, { sourceDir: src, mainDir: src, figures: [] }, () => new Set<string>());
      const r = spawnSync("lualatex", ["-interaction=nonstopmode", "-halt-on-error", "main.tex"], {
        cwd: dir,
        encoding: "utf8",
        timeout: 240_000,
        env: sandboxEnv(process.env, dir),
      });
      expect(r.stdout.split("\n").filter((l) => l.startsWith("!"))).toEqual([]);
      expect(existsSync(path.join(dir, "main.pdf"))).toBe(true);
    } finally {
      rmSync(src, { recursive: true, force: true });
      rmSync(path.dirname(dir), { recursive: true, force: true });
    }
  }, 300_000);
});

describe.skipIf(!hasLuaTex)("xcolor に color オプションを渡す原文を組む（issue #521）", () => {
  const own = ["\\documentclass{article}", "\\usepackage[svgnames,dvipsnames,color,table]{xcolor}", "\\begin{document}", "\\end{document}"].join("\n");

  it.each(["original", "template"] as const)("%s: color を外して PDF が出る", (mode) => {
    expect(build(own, "\\textcolor{red}{x}", mode)).toEqual([]);
  }, 300_000);
});

// 前文に \newcommand{\x} がある論文（2201.04234 の lifetime.sty の形。issue #518）。
const X_OWN = ["\\documentclass{article}", "\\newcommand{\\x}{x}", "\\begin{document}", "\\end{document}"].join("\n");

describe.skipIf(!hasLuaTex)("luatexja が残す \\x（issue #518）", () => {
  it.each(["original", "template"] as const)("前文の \\newcommand{\\x} が %s で組める", (mode) => {
    expect(build(X_OWN, "$\\x$ 本文。", mode)).toEqual([]);
  }, 300_000);
});
