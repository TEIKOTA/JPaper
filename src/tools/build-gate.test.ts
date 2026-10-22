import { describe, it, expect, afterEach } from "vitest";
import { budgetMs, fastestMs } from "../testing/timing.js";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  classifyLog,
  stageBuild,
  runBuildGate,
  checkFigures,
  sandboxEnv,
  SRC_PKG_DIR,
  parseResolved,
  unsafeSupportFiles,
  defaultRunner,
  probeLatexmk,
  describeLaunchError,
  LATEXMK_MISSING,
} from "./build-gate.js";
import type { SourceSpan } from "./assemble-latex.js";
import type { LatexRunner } from "./build-gate.js";

const MAP: SourceSpan[] = [
  { id: "seg-0000", startLine: 10, endLine: 20 },
  { id: "seg-0001", startLine: 21, endLine: 40 },
];

const temps: string[] = [];
function mkTemp(): string {
  const d = mkdtempSync(path.join(tmpdir(), "jpaper-build-"));
  temps.push(d);
  return d;
}
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("classifyLog", () => {
  it("本文行のエラーはセグメントへ逆引きする（翻訳起因）", () => {
    const log = "./main.tex:25: Paragraph ended before \\align* was complete.";
    const c = classifyLog(log, MAP);
    expect(c.failedSegments).toEqual([
      { id: "seg-0001", line: 25, message: "Paragraph ended before \\align* was complete." },
    ]);
    expect(c.structuralErrors).toEqual([]);
  });
  it("マップ外（前文など）のエラーは構造起因にする", () => {
    const log = "main.tex:3: Undefined control sequence.";
    const c = classifyLog(log, MAP);
    expect(c.failedSegments).toEqual([]);
    expect(c.structuralErrors).toEqual(["main.tex:3: Undefined control sequence."]);
  });
  it("main.tex 以外（.cls/.sty）の file:line エラーも構造起因に残す", () => {
    const log = "./nips_2017.sty:42: Undefined control sequence.";
    const c = classifyLog(log, MAP);
    expect(c.failedSegments).toEqual([]);
    expect(c.structuralErrors).toEqual(["nips_2017.sty:42: Undefined control sequence."]);
  });
  it("原文にも存在する未定義環境は構造起因にする（本文行でも再訳に回さない）", () => {
    const log = "./main.tex:12: LaTeX Error: Environment frontmatter undefined.";
    const original = "\\documentclass{elsarticle}\n\\begin{document}\n\\begin{frontmatter}\\end{frontmatter}";
    const c = classifyLog(log, MAP, original);
    expect(c.failedSegments).toEqual([]);
    expect(c.structuralErrors).toEqual([
      "main.tex:12: LaTeX Error: Environment frontmatter undefined.",
    ]);
  });
  it("原文にも存在する未定義制御綴りは文脈行から名前を取り構造起因にする", () => {
    const log = ["./main.tex:15: Undefined control sequence.", "l.15 keyword \\sep", "more"].join("\n");
    const c = classifyLog(log, MAP, "\\begin{keyword}a \\sep b\\end{keyword}");
    expect(c.failedSegments).toEqual([]);
    expect(c.structuralErrors).toHaveLength(1);
  });
  it("訳文だけに現れるマクロ由来の未定義は翻訳起因に残す", () => {
    const log = ["./main.tex:15: Undefined control sequence.", "l.15 X \\hallucinated", ""].join("\n");
    const c = classifyLog(log, MAP, "\\begin{document}X\\end{document}");
    expect(c.failedSegments).toEqual([
      { id: "seg-0000", line: 15, message: "Undefined control sequence." },
    ]);
    expect(c.structuralErrors).toEqual([]);
  });
  it("原文の前方一致する別マクロを同名扱いしない", () => {
    const log = ["./main.tex:15: Undefined control sequence.", "l.15 X \\sep", ""].join("\n");
    const c = classifyLog(log, MAP, "\\separate{x}");
    expect(c.failedSegments).toHaveLength(1);
  });
  it("Fatal error の追随行は直前の診断の分類を引き継ぐ", () => {
    const log = [
      "./main.tex:12: LaTeX Error: Environment frontmatter undefined.",
      "./main.tex:12: ==> Fatal error occurred, no output PDF file produced!",
    ].join("\n");
    const c = classifyLog(log, MAP, "\\begin{frontmatter}\\end{frontmatter}");
    expect(c.failedSegments).toEqual([]);
    expect(c.structuralErrors).toHaveLength(2);
  });
  it("欠図と未解決参照/引用を抽出する", () => {
    const log = [
      "LaTeX Warning: File `Figures/x.png' not found.",
      "! Unable to load picture or PDF file `vis/y.pdf'.",
      "LaTeX Warning: Reference `fig:foo' on page 4 undefined on input line 216.",
      "LaTeX Warning: Citation `bar2017' undefined on input line 30.",
    ].join("\n");
    const c = classifyLog(log, MAP);
    expect(c.missingFigures.sort()).toEqual(["Figures/x.png", "vis/y.pdf"]);
    expect(c.unresolvedRefs.sort()).toEqual(["bar2017", "fig:foo"]);
  });
});

describe("checkFigures", () => {
  const mainDir = "/src";
  it("本文に残る図は落とさず、消えた図を dropped に挙げる", () => {
    const mainTex = "見よ \\includegraphics{Figures/a} を参照";
    const dropped = checkFigures(mainTex, mainDir, ["/src/Figures/a.png", "/src/Figures/gone.pdf"]);
    expect(dropped).toEqual(["Figures/gone.pdf"]);
  });

  it("図数 × 本文長に比例しない", () => {
    // 図ごとに本文全体を走査していた頃は 5,000 図 × 8MB 本文で 1,472ms 同期ブロックした。
    const mainTex = "x".repeat(8 * 1024 * 1024);
    const figures = Array.from({ length: 5000 }, (_, i) => `/src/f${String(i)}.pdf`);
    expect(
      fastestMs(3, () => expect(checkFigures(mainTex, mainDir, figures)).toHaveLength(5000)),
    ).toBeLessThan(budgetMs(300));
  });

  it("\\includegraphics の引数以外に同じ綴りがあっても残存とは見なさない", () => {
    const mainTex = "本文で Figures/a という語に触れるだけ";
    expect(checkFigures(mainTex, mainDir, ["/src/Figures/a.png"])).toEqual(["Figures/a.png"]);
  });

  it("消えた図は OS の区切りに依らず / 区切りで返す", () => {
    const dir = path.resolve("/src");
    expect(checkFigures("", dir, [path.join(dir, "Figures", "sub", "gone.pdf")])).toEqual(["Figures/sub/gone.pdf"]);
  });
});

describe("stageBuild", () => {
  it("main.tex・支援ファイル(.sty/.bib は srcpkg/ へ再帰収集)・図(main 相対)を複製する", () => {
    const src = mkTemp();
    writeFileSync(path.join(src, "nips.sty"), "% sty");
    writeFileSync(path.join(src, "refs.bib"), "@x{}");
    writeFileSync(path.join(src, "notes.txt"), "ignore");
    mkdirSync(path.join(src, "sub"));
    writeFileSync(path.join(src, "sub", "extra.cls"), "% cls");
    mkdirSync(path.join(src, "Figures"));
    writeFileSync(path.join(src, "Figures", "a.png"), "PNG");
    const build = path.join(mkTemp(), "b");
    stageBuild(
      build,
      "MAIN",
      { sourceDir: src, mainDir: src, figures: [path.join(src, "Figures", "a.png")] },
      () => new Set<string>(),
    );
    const pkg = path.join(build, SRC_PKG_DIR);
    expect(existsSync(path.join(build, "main.tex"))).toBe(true);
    expect(existsSync(path.join(pkg, "nips.sty"))).toBe(true);
    expect(existsSync(path.join(pkg, "refs.bib"))).toBe(true);
    expect(existsSync(path.join(pkg, "extra.cls"))).toBe(true); // 再帰
    expect(existsSync(path.join(build, "sub", "extra.cls"))).toBe(true); // \documentclass{sub/extra} 用
    expect(existsSync(path.join(build, "nips.sty"))).toBe(false); // main 直下のものは cwd に置かない
    expect(existsSync(path.join(build, "Figures", "a.png"))).toBe(true);
    expect(readdirSync(pkg)).not.toContain("notes.txt");
  });
  it("同梱パッケージは build 直下に置かない（cwd 優先で配布版を上書きさせない）", () => {
    const src = mkTemp();
    writeFileSync(path.join(src, "graphicx.sty"), "% EVIL");
    const build = path.join(mkTemp(), "b");
    stageBuild(build, "MAIN", { sourceDir: src, mainDir: src, figures: [] }, () => new Set<string>());
    expect(existsSync(path.join(build, "graphicx.sty"))).toBe(false);
    expect(existsSync(path.join(build, SRC_PKG_DIR, "graphicx.sty"))).toBe(true);
  });
  it("配布パッケージと同名の同梱ファイルを shadowed として返す", () => {
    const src = mkTemp();
    writeFileSync(path.join(src, "graphicx.sty"), "% EVIL");
    writeFileSync(path.join(src, "mypaper.sty"), "% own");
    const build = path.join(mkTemp(), "b");
    const shadowed = stageBuild(
      build,
      "MAIN",
      { sourceDir: src, mainDir: src, figures: [] },
      (names) => new Set(names.filter((n) => n === "graphicx.sty")),
    );
    expect(shadowed).toEqual(["graphicx.sty"]);
  });
  it("main と同じ階層の .bbl がちょうど 1 つなら build 直下の main.bbl として置く", () => {
    const src = mkTemp();
    writeFileSync(path.join(src, "arxiv.bbl"), "\\begin{thebibliography}{1}\\end{thebibliography}");
    const build = path.join(mkTemp(), "b");
    stageBuild(build, "MAIN", { sourceDir: src, mainDir: src, figures: [] }, () => new Set<string>());
    expect(readFileSync(path.join(build, "main.bbl"), "utf8")).toBe(
      "\\begin{thebibliography}{1}\\end{thebibliography}",
    );
    expect(existsSync(path.join(build, SRC_PKG_DIR, "arxiv.bbl"))).toBe(true);
  });
  it(".bbl が無ければ main.bbl を置かない", () => {
    const src = mkTemp();
    writeFileSync(path.join(src, "refs.bib"), "@x{}");
    mkdirSync(path.join(src, "dir.bbl"));
    const build = path.join(mkTemp(), "b");
    stageBuild(build, "MAIN", { sourceDir: src, mainDir: src, figures: [] }, () => new Set<string>());
    expect(existsSync(path.join(build, "main.bbl"))).toBe(false);
  });
  it(".bbl が 2 つ以上なら main.bbl を置かない", () => {
    const src = mkTemp();
    writeFileSync(path.join(src, "a.bbl"), "A");
    writeFileSync(path.join(src, "b.bbl"), "B");
    const build = path.join(mkTemp(), "b");
    stageBuild(build, "MAIN", { sourceDir: src, mainDir: src, figures: [] }, () => new Set<string>());
    expect(existsSync(path.join(build, "main.bbl"))).toBe(false);
  });
  it("入れ子 main では main と同じ階層の .bbl だけを見る", () => {
    const src = mkTemp();
    const mainDir = path.join(src, "paper");
    mkdirSync(mainDir);
    writeFileSync(path.join(src, "root.bbl"), "ROOT");
    writeFileSync(path.join(mainDir, "paper.bbl"), "PAPER");
    const build = path.join(mkTemp(), "b");
    stageBuild(build, "MAIN", { sourceDir: src, mainDir, figures: [] }, () => new Set<string>());
    expect(readFileSync(path.join(build, "main.bbl"), "utf8")).toBe("PAPER");
  });
  it("入れ子 main の階層に .bbl が無ければ、上の階層の .bbl は main.bbl にしない", () => {
    const src = mkTemp();
    const mainDir = path.join(src, "paper");
    mkdirSync(mainDir);
    writeFileSync(path.join(src, "root.bbl"), "ROOT");
    const build = path.join(mkTemp(), "b");
    stageBuild(build, "MAIN", { sourceDir: src, mainDir, figures: [] }, () => new Set<string>());
    expect(existsSync(path.join(build, "main.bbl"))).toBe(false);
  });
  it("配布版と同名の .bbl は main.bbl にしない（安全検査の対象外のため）", () => {
    const src = mkTemp();
    writeFileSync(path.join(src, "dist.bbl"), "X");
    const build = path.join(mkTemp(), "b");
    stageBuild(
      build,
      "MAIN",
      { sourceDir: src, mainDir: src, figures: [] },
      (names) => new Set(names.filter((n) => n === "dist.bbl")),
    );
    expect(existsSync(path.join(build, "main.bbl"))).toBe(false);
  });
});

describe("sandboxEnv", () => {
  it("探索パスは既定を先頭に置き、同梱 srcpkg を後ろへ回す", () => {
    const env = sandboxEnv({}, "/b");
    for (const key of ["TEXINPUTS", "BIBINPUTS", "BSTINPUTS"] as const) {
      expect(env[key]).toBe(`${path.delimiter}${path.join("/b", SRC_PKG_DIR)}//`);
      expect(env[key]!.startsWith(path.delimiter)).toBe(true); // 先頭の空要素＝既定パス
    }
  });
  it("shell escape と build ツリー外への書き出しを禁止する", () => {
    const env = sandboxEnv({}, "/b");
    expect(env.shell_escape).toBe("f");
    expect(env.openout_any).toBe("p");
  });
  it("既存の環境変数は保つ", () => {
    expect(sandboxEnv({ PATH: "/usr/bin" }, "/b").PATH).toBe("/usr/bin");
  });
  it("入れ子 main の図は main 相対で配置する（sourceDir 相対にしない）", () => {
    const src = mkTemp();
    const mainDir = path.join(src, "paper");
    mkdirSync(path.join(mainDir, "Figures"), { recursive: true });
    writeFileSync(path.join(mainDir, "Figures", "a.png"), "PNG");
    const build = path.join(mkTemp(), "b");
    stageBuild(build, "MAIN", { sourceDir: src, mainDir, figures: [path.join(mainDir, "Figures", "a.png")] });
    expect(existsSync(path.join(build, "Figures", "a.png"))).toBe(true);
    expect(existsSync(path.join(build, "paper", "Figures", "a.png"))).toBe(false);
  });
});

describe("runBuildGate", () => {
  const src = () => {
    const s = mkTemp();
    writeFileSync(path.join(s, "s.sty"), "% x");
    return s;
  };
  it("ビルド成功＋警告なしは buildOk かつ pdfPath", async () => {
    const s = src();
    const build = path.join(mkTemp(), "b");
    const runner = (dir: string) => {
      writeFileSync(path.join(dir, "main.pdf"), "%PDF");
      return { code: 0, log: "Output written on main.pdf (15 pages)." };
    };
    const r = await runBuildGate({ buildDir: build, mainTex: "M", sourceDir: s, mainDir: s, figures: [], sourceMap: MAP }, runner);
    expect(r.buildOk).toBe(true);
    expect(r.pdfPath).toBe(path.join(build, "main.pdf"));
  });
  it("翻訳起因の fatal は buildOk=false かつ failedSegments に載る", async () => {
    const s = src();
    const build = path.join(mkTemp(), "b");
    const runner = () => ({ code: 1, log: "./main.tex:25: Missing $ inserted." });
    const r = await runBuildGate({ buildDir: build, mainTex: "M", sourceDir: s, mainDir: s, figures: [], sourceMap: MAP }, runner);
    expect(r.buildOk).toBe(false);
    expect(r.failedSegments[0]!.id).toBe("seg-0001");
  });
  it("欠図（構造起因）は成功終了でも buildOk=false", async () => {
    const s = src();
    const build = path.join(mkTemp(), "b");
    const runner = (dir: string) => {
      writeFileSync(path.join(dir, "main.pdf"), "%PDF");
      return { code: 0, log: "LaTeX Warning: File `Figures/x.png' not found." };
    };
    const r = await runBuildGate({ buildDir: build, mainTex: "M", sourceDir: s, mainDir: s, figures: [], sourceMap: MAP }, runner);
    expect(r.buildOk).toBe(false);
    expect(r.missingFigures).toEqual(["Figures/x.png"]);
  });
});

describe("組版はイベントループを止めない", () => {
  it("runner の待ち時間中もタイマーが進む", async () => {
    const s = mkTemp();
    const build = path.join(mkTemp(), "b");
    let ticks = 0;
    const timer = setInterval(() => {
      ticks++;
    }, 10);
    const slowRunner: LatexRunner = async (dir) => {
      await new Promise((r) => setTimeout(r, 300));
      writeFileSync(path.join(dir, "main.pdf"), "%PDF");
      return { code: 0, log: "" };
    };
    await runBuildGate(
      { buildDir: build, mainTex: "M", sourceDir: s, mainDir: s, figures: [], sourceMap: MAP },
      slowRunner,
    );
    clearInterval(timer);
    expect(ticks).toBeGreaterThan(5); // 同期実行なら 0 になる
  });

  it("同期 runner も従来どおり受け付ける", async () => {
    const s = mkTemp();
    const build = path.join(mkTemp(), "b");
    const r = await runBuildGate(
      { buildDir: build, mainTex: "M", sourceDir: s, mainDir: s, figures: [], sourceMap: MAP },
      (dir) => {
        writeFileSync(path.join(dir, "main.pdf"), "%PDF");
        return { code: 0, log: "" };
      },
    );
    expect(r.buildOk).toBe(true);
  });
});

describe("kpsewhich はまとめて 1 回だけ問う", () => {
  it("支援ファイルが何個でも resolver 呼び出しは 1 回", () => {
    const src = mkTemp();
    for (const n of ["a.sty", "b.sty", "c.cls", "d.bib"]) {
      writeFileSync(path.join(src, n), "%");
    }
    const build = path.join(mkTemp(), "b");
    let calls = 0;
    stageBuild(build, "MAIN", { sourceDir: src, mainDir: src, figures: [] }, (names) => {
      calls++;
      expect(names).toHaveLength(4);
      return new Set<string>();
    });
    expect(calls).toBe(1);
  });
});

describe("組版の中断", () => {
  it("abort 済みならステージングも走らせずに中断で抜ける", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "jpaper-gate-abort-"));
    const src = path.join(dir, "src");
    mkdirSync(src, { recursive: true });
    const c = new AbortController();
    c.abort();
    let ran = false;
    await expect(
      runBuildGate(
        {
          buildDir: path.join(dir, "build"),
          mainTex: "\\documentclass{article}\\begin{document}x\\end{document}",
          sourceDir: src,
          mainDir: src,
          figures: [],
          sourceMap: [],
          signal: c.signal,
        },
        () => {
          ran = true;
          return { code: 0, log: "" };
        },
      ),
    ).rejects.toMatchObject({ code: 6, kind: "canceled" });
    expect(ran).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("runner に signal を渡す（実行中の中断を子プロセスへ届ける）", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "jpaper-gate-sig-"));
    const src = path.join(dir, "src");
    mkdirSync(src, { recursive: true });
    const c = new AbortController();
    let seen: AbortSignal | undefined;
    await runBuildGate(
      {
        buildDir: path.join(dir, "build"),
        mainTex: "\\documentclass{article}\\begin{document}x\\end{document}",
        sourceDir: src,
        mainDir: src,
        figures: [],
        sourceMap: [],
        signal: c.signal,
      },
      (_d, signal) => {
        seen = signal;
        return { code: 1, log: "" };
      },
    );
    expect(seen).toBe(c.signal);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("配布パッケージの解決", () => {
  it("一部だけ解決できた出力からも集合を作れる", () => {
    // kpsewhich は 1 つでも未解決だと exit != 0 を返すが、解決分は stdout に出ている。
    // throw を「全滅」として扱うと、read プリミティブを含む配布パッケージ（TeX Live の
    // tex/latex 6,000 件のうち実測 4.4%）を同梱しただけの正規論文が組版前に落ちる。
    // arXiv 提出物は .bbl を同梱するのが常道なので、未解決が混ざるのはむしろ普通。
    const out = "/usr/share/texmf/tex/latex/cleveref/cleveref.sty\n\n";
    expect([...parseResolved(out)]).toEqual(["cleveref.sty"]);
    expect(parseResolved("").size).toBe(0);
  });

  it("解決できた配布パッケージは危険判定から除外される", () => {
    const dir = mkTemp();
    writeFileSync(path.join(dir, "vendor.sty"), "\\openin1=x \\read1 to \\y");
    writeFileSync(path.join(dir, "mine.sty"), "\\directlua{print(1)}");
    const bad = unsafeSupportFiles(dir, (names) =>
      names.includes("vendor.sty") ? new Set(["vendor.sty"]) : new Set(),
    );
    expect(bad.map((b) => b.file)).toEqual(["mine.sty"]);
  });
});

describe("組版の道具を起動できない環境の障害（契約付録 §6）", () => {
  const withEmptyPath = async <T>(f: (dir: string) => Promise<T> | T): Promise<T> => {
    const saved = process.env.PATH;
    const empty = mkTemp();
    process.env.PATH = empty;
    try {
      return await f(empty);
    } finally {
      process.env.PATH = saved;
    }
  };

  it("PATH に latexmk が無いと defaultRunner は原因を名指しした envError を返す（ログは空）", async () => {
    const r = await withEmptyPath((d) => defaultRunner(d));
    expect(r.envError).toBe(LATEXMK_MISSING);
    expect(r.log).toBe("");
    expect(r.code).toBe(1);
  });

  it("probeLatexmk も同じ説明を返す", async () => {
    expect(await withEmptyPath(() => probeLatexmk())).toBe(LATEXMK_MISSING);
  });

  it("ENOENT 以外の起動失敗はコードと理由を出す", () => {
    const m = describeLaunchError(Object.assign(new Error("spawn latexmk EACCES"), { code: "EACCES" }));
    expect(m).toContain("EACCES");
    expect(m).not.toBe(LATEXMK_MISSING);
  });

  it("runner の envError は runBuildGate の結果へ伝わり、ログの分類は空のまま buildOk=false になる", async () => {
    const dir = mkTemp();
    const src = mkTemp();
    const g = await runBuildGate(
      { buildDir: path.join(dir, "b"), mainTex: "\\documentclass{article}", sourceDir: src, mainDir: src, figures: [], sourceMap: MAP },
      () => ({ code: 1, log: "", envError: LATEXMK_MISSING }),
    );
    expect(g.buildOk).toBe(false);
    expect(g.envError).toBe(LATEXMK_MISSING);
    expect(g.failedSegments).toEqual([]);
    expect(g.structuralErrors).toEqual([]);
  });
});
