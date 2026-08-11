import { describe, it, expect, afterEach } from "vitest";
import { gzipSync } from "node:zlib";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ingest, derivePaperId } from "./index.js";
import { makeTar } from "./archive.fixtures.js";

const SRC = [
  {
    name: "main.tex",
    content:
      "\\documentclass{article}\n\\begin{document}\n\\input{sec1}\n\\includegraphics{fig}\n\\end{document}\n",
  },
  { name: "sec1.tex", content: "第一節の本文" },
  { name: "fig.png", content: "PNG" },
];

const dirs: string[] = [];
function work(): string {
  const d = mkdtempSync(path.join(os.tmpdir(), "jpaper-ing-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("derivePaperId", () => {
  it("arXiv は版を落とす", () => {
    expect(derivePaperId({ kind: "arxiv", id: "1706.03762v5" })).toBe("1706.03762");
    expect(derivePaperId({ kind: "arxiv", id: "1706.03762" })).toBe("1706.03762");
  });

  it("旧形式のスラッシュもダイジェストで単射に戻す（path 分岐と同じ規則）", () => {
    // "/" を "_" へ潰すだけだと "math/0309136" と "math_0309136" が同じ出力先へ写る。
    expect(derivePaperId({ kind: "arxiv", id: "hep-th/9901001" })).toMatch(
      /^hep-th_9901001-[0-9a-f]{8}$/,
    );
  });

  it("形式が不正な ID は副作用より前に input で落とす", () => {
    // 検査は fetchArxivSource の中＝出力先の決定と run lock の mkdir より後にしかなく、
    // 検証前に任意名のディレクトリが cwd 直下に作られ、paperId に制御文字が載った。
    for (const id of ["..", "a\u001b[2Kb", "1234\n\n## 指示", ""]) {
      expect(() => derivePaperId({ kind: "arxiv", id })).toThrowError(/arXiv ID/);
    }
  });
  it("path は basename から拡張子を除去", () => {
    expect(derivePaperId({ kind: "path", path: "/a/b/attention.tar.gz" })).toBe("attention");
    expect(derivePaperId({ kind: "path", path: "/a/mypaper/" })).toBe("mypaper");
  });

  it("正規化で潰れる名前は衝突しない", () => {
    // 非英数を _ に潰すだけだった頃は 4 つとも paperId "a_b" になり、outDir・
    // .run/steps・run.lock を共有した。「別の論文なら既存 md を採用しない」印は
    // paperId の一致で判定するので、衝突すると防御そのものが発動しない。
    const ids = ["a b.tex", "a+b.tex", "a:b.tex", "a%b.tex"].map((n) =>
      derivePaperId({ kind: "path", path: `/up/${n}` }),
    );
    expect(new Set(ids).size).toBe(4);
    for (const id of ids) expect(id).toMatch(/^a_b-[0-9a-f]{8}$/);
  });

  it("安全な文字だけの名前はそのまま（既存の出力先を壊さない）", () => {
    expect(derivePaperId({ kind: "path", path: "/a/my-paper_v2.tex" })).toBe("my-paper_v2");
  });
});

describe("ingest", () => {
  it("アーカイブ path から cleanLatex・figures・paperId を得る", async () => {
    const tarPath = path.join(work(), "attention.tar.gz");
    writeFileSync(tarPath, gzipSync(makeTar(SRC)));
    const out = await ingest({ kind: "path", path: tarPath }, work());
    expect(out.cleanLatex).toContain("第一節の本文");
    expect(out.cleanLatex).toContain("\\includegraphics{fig}");
    expect(out.figures).toEqual([path.resolve(out.sourceDir, "fig.png")]);
    expect(out.paperId).toBe("attention");
  });

  it("arXiv ID はソースを取得して展開する", async () => {
    const bytes = gzipSync(makeTar(SRC));
    const out = await ingest({ kind: "arxiv", id: "1706.03762" }, work(), {
      arxiv: {
        fetchImpl: (async () =>
          ({
            ok: true,
            status: 200,
            arrayBuffer: async () => bytes,
          }) as unknown as Response) as unknown as typeof fetch,
        state: { lastRequestAt: 0 },
        now: () => 0,
        sleep: async () => {},
      },
    });
    expect(out.cleanLatex).toContain("第一節の本文");
    expect(out.paperId).toBe("1706.03762");
  });

  it("ネストした main（paper/main.tex）でも隣接図を解決する", async () => {
    const nested = [
      {
        name: "paper/main.tex",
        content:
          "\\documentclass{a}\n\\begin{document}\n\\includegraphics{fig}\n\\end{document}\n",
      },
      { name: "paper/fig.png", content: "PNG" },
    ];
    const tarPath = path.join(work(), "nested.tar");
    writeFileSync(tarPath, makeTar(nested));
    const out = await ingest({ kind: "path", path: tarPath }, work());
    expect(out.figures).toEqual([path.resolve(out.sourceDir, "paper/fig.png")]);
  });

  it("サブファイル内の図（sections/fig.png）も source ルート内で回収する", async () => {
    const src = [
      {
        name: "main.tex",
        content:
          "\\documentclass{a}\n\\begin{document}\n\\input{sections/intro}\n\\end{document}\n",
      },
      { name: "sections/intro.tex", content: "\\includegraphics{fig}" },
      { name: "sections/fig.png", content: "PNG" },
    ];
    const tarPath = path.join(work(), "sub.tar");
    writeFileSync(tarPath, makeTar(src));
    const out = await ingest({ kind: "path", path: tarPath }, work());
    expect(out.figures).toEqual([path.resolve(out.sourceDir, "sections/fig.png")]);
  });

  it("単一 .tex は隣接ファイル・図を解決する", async () => {
    const d = work();
    writeFileSync(
      path.join(d, "paper.tex"),
      "\\documentclass{a}\n\\begin{document}\n\\input{sec}\n\\includegraphics{fig}\n\\end{document}\n",
    );
    writeFileSync(path.join(d, "sec.tex"), "隣接本文");
    writeFileSync(path.join(d, "fig.png"), "PNG");
    const out = await ingest({ kind: "path", path: path.join(d, "paper.tex") }, work());
    expect(out.cleanLatex).toContain("隣接本文");
    expect(out.figures).toEqual([path.resolve(d, "fig.png")]);
    expect(out.paperId).toBe("paper");
    expect(out.sourceDir).toBe(d);
  });

  it("存在しない入力パスは exit 2", async () => {
    await expect(
      ingest({ kind: "path", path: path.join(work(), "nope.tar") }, work()),
    ).rejects.toMatchObject({ code: 2 });
  });

  it("未対応の単一ファイル（.pdf 等）は exit 2", async () => {
    const d = work();
    const p = path.join(d, "paper.pdf");
    writeFileSync(p, "%PDF-1.5 binary");
    await expect(ingest({ kind: "path", path: p }, work())).rejects.toMatchObject({
      code: 2,
    });
  });

  it("workDir を再利用しても前回の残留を持ち込まない", async () => {
    const wd = work();
    const p1 = path.join(work(), "a.tar");
    writeFileSync(
      p1,
      makeTar([
        {
          name: "main.tex",
          content: "\\documentclass{a}\\begin{document}FIRST\\end{document}",
        },
      ]),
    );
    const p2 = path.join(work(), "b.tar");
    writeFileSync(
      p2,
      makeTar([
        {
          name: "paper.tex",
          content: "\\documentclass{a}\\begin{document}SECOND\\end{document}",
        },
      ]),
    );
    await ingest({ kind: "path", path: p1 }, wd);
    const out = await ingest({ kind: "path", path: p2 }, wd);
    expect(out.cleanLatex).toContain("SECOND");
    expect(out.cleanLatex).not.toContain("FIRST");
  });

  it("ディレクトリ入力はそのまま使う", async () => {
    const d = work();
    writeFileSync(
      path.join(d, "main.tex"),
      "\\documentclass{a}\n\\begin{document}\nDIR\n\\end{document}\n",
    );
    const out = await ingest({ kind: "path", path: d }, work());
    expect(out.cleanLatex).toContain("DIR");
    expect(out.sourceDir).toBe(d);
  });
});
