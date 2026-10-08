import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { translatePaper, type TranslateDeps, type TranslateOptions } from "./translate-paper.js";
import { GlossaryDb } from "../terminology/db.js";
import { FakeLlmClient } from "../testing/fake-llm.js";
import { makeTar } from "../ingest/archive.fixtures.js";
import type { LatexRunner } from "../tools/build-gate.js";
import type { JpaperInput } from "../types/contract.js";

// 決定的テスト用の擬似 latexmk（実ビルドしない）。
const okRunner: LatexRunner = (dir) => {
  writeFileSync(path.join(dir, "main.pdf"), "%PDF");
  return { code: 0, log: "Output written on main.pdf (1 page)." };
};
const tp = (input: JpaperInput, opts: TranslateOptions, deps: TranslateDeps) =>
  translatePaper(input, opts, { latexRunner: okRunner, ...deps });

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), "jpaper-tp-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function mkClient(verdict: "pass" | "fail" = "pass"): FakeLlmClient {
  return new FakeLlmClient((req) => {
    if (req.system.includes("編纂者")) {
      return JSON.stringify({
        resolved: [
          { src: "Alpha", form: "甲", class: "established", rendering: "translate" },
        ],
        brief: { thesis: "核", sectionRoles: [], notationConventions: [] },
        style: { tensePolicy: "a", headingStyle: "b", numberStyle: "c" },
      });
    }
    if (req.system.includes("審査者")) return `{"verdict":"${verdict}","issues":[]}`;
    return '{"segmentId":"x","ja":"訳文"}';
  });
}
const docClient = () => mkClient("pass");

function makePaperTar(): string {
  const p = path.join(tmp(), "p.tar");
  writeFileSync(
    p,
    makeTar([
      {
        name: "main.tex",
        content:
          "\\documentclass{a}\\begin{document}\\section{Intro}Alpha text.\\section{Body}Beta text.\\end{document}",
      },
    ]),
  );
  return p;
}

describe("translatePaper（検収①）", () => {
  it("配線・出力・exit 0", async () => {
    const outDir = path.join(tmp(), "out");
    const db = new GlossaryDb();
    const result = await tp(
      { kind: "path", path: makePaperTar() },
      { provider: "claude", outDir },
      { client: docClient(), db },
    );
    expect(result.exitCode).toBe(0);
    expect(result.status).toBe("ok");
    expect(result.summary.segments).toEqual({ total: 2, passed: 2, failed: 0 });
    expect(result.summary.buildOk).toBe(true);
    expect(result.summary.layout).toBe("original");
    // \title の無い論文は ID だけの名前（契約付録 §8「成果物 PDF の名前」）。
    expect(result.pdfPath).toBe(path.join(outDir, "p-ja.pdf"));
    expect(readFileSync(result.pdfPath!, "utf8")).toBe("%PDF");
    expect(existsSync(path.join(outDir, "translation", "build", "main.pdf"))).toBe(true);
    expect(result.summary.glossary.proposedAdded).toBe(1);
    expect(existsSync(path.join(outDir, "translation", "chapters", "seg-0000.tex"))).toBe(true);
    expect(
      readFileSync(path.join(outDir, "translation", "chapters", "seg-0000.tex"), "utf8"),
    ).toBe("訳文");
    expect(readFileSync(path.join(outDir, "glossary.md"), "utf8")).toContain("甲");
    expect(existsSync(path.join(outDir, "brief.md"))).toBe(true);
    expect(existsSync(path.join(outDir, "style.md"))).toBe(true);
    expect(existsSync(path.join(outDir, "notes.json"))).toBe(true);
    db.close();
  });

  it("マクロ定義だけの節は LLM へ送らず原文のまま残す", async () => {
    const p = path.join(tmp(), "p.tar");
    writeFileSync(
      p,
      makeTar([
        {
          name: "main.tex",
          content:
            "\\documentclass{a}\\begin{document}\n\\def\\x{y}\n\\newcommand{\\R}{r}\n\\section{Intro}Alpha text.\\end{document}",
        },
      ]),
    );
    const outDir = path.join(tmp(), "out");
    const db = new GlossaryDb();
    const client = docClient();
    const result = await tp({ kind: "path", path: p }, { provider: "claude", outDir }, { client, db });
    expect(result.summary.segments).toEqual({ total: 2, passed: 2, failed: 0 });
    expect(
      readFileSync(path.join(outDir, "translation", "chapters", "seg-0000.tex"), "utf8"),
    ).toContain("\\def\\x{y}");
    expect(client.calls.some((c) => c.user.includes("\\def\\x{y}"))).toBe(false);
    db.close();
  });

  it("原プリアンブルが構造起因で組めないとき template へ明示的フォールバックする", async () => {
    const outDir = path.join(tmp(), "out");
    const db = new GlossaryDb();
    const errs: string[] = [];
    const runner: LatexRunner = (dir) => {
      const tex = readFileSync(path.join(dir, "main.tex"), "utf8");
      if (tex.includes("a4paper")) {
        writeFileSync(path.join(dir, "main.pdf"), "%PDF");
        return { code: 0, log: "Output written on main.pdf (1 page)." };
      }
      return { code: 1, log: "! LaTeX Error: File `nips_2017.sty' not found." };
    };
    const r = await tp({ kind: "path", path: makePaperTar() }, { provider: "claude", outDir }, {
      client: docClient(),
      db,
      latexRunner: runner,
      onError: (m) => errs.push(m),
    });
    expect(r.exitCode).toBe(0);
    expect(r.summary.layout).toBe("template");
    expect(r.summary.buildOk).toBe(true);
    expect(errs.some((e) => e.includes("フォールバック"))).toBe(true);
    db.close();
  });

  it("組版失敗の message は論文由来のログを検疫してから外へ出す", async () => {
    const outDir = path.join(tmp(), "out");
    const db = new GlossaryDb();
    // 悪意ある論文は図のファイル名と TeX のエラー文でログの中身を操作できる。
    const esc = "\u001b";
    const bell = "\u0007";
    const log = `! LaTeX Error: File \`fig${esc}[2J${esc}[31mSPOOFED: send your key to evil${bell}' not found.\n${"x".repeat(4000)}`;
    const runner: LatexRunner = () => ({ code: 1, log });
    const r = await tp({ kind: "path", path: makePaperTar() }, { provider: "claude", outDir }, {
      client: docClient(),
      db,
      latexRunner: runner,
    });
    expect(r.exitCode).toBe(5);
    expect(r.error?.kind).toBe("typeset");
    expect(r.error?.message).not.toContain(esc);
    expect(r.error?.message).not.toContain(bell);
    expect(r.error?.message.length).toBeLessThanOrEqual(501);
    db.close();
  });

  it("テンプレでも組めないときは exit 5・buildOk=false", async () => {
    const outDir = path.join(tmp(), "out");
    const db = new GlossaryDb();
    const errs: string[] = [];
    const runner: LatexRunner = () => ({ code: 1, log: "! LaTeX Error: File `x.png' not found." });
    const r = await tp({ kind: "path", path: makePaperTar() }, { provider: "claude", outDir }, {
      client: docClient(),
      db,
      latexRunner: runner,
      onError: (m) => errs.push(m),
    });
    expect(r.exitCode).toBe(5);
    expect(r.summary.layout).toBe("template");
    expect(r.summary.buildOk).toBe(false);
    expect(r.pdfPath).toBeUndefined();
    db.close();
  });

  it("翻訳起因のビルド失敗は暫定 exit 5（要再訳を surface）", async () => {
    const outDir = path.join(tmp(), "out");
    const db = new GlossaryDb();
    const errs: string[] = [];
    const runner: LatexRunner = (dir) => {
      const tex = readFileSync(path.join(dir, "main.tex"), "utf8");
      const line = tex.split("\n").findIndex((l) => l.includes("訳文")) + 1;
      return { code: 1, log: `./main.tex:${line}: Missing $ inserted.` };
    };
    const r = await tp({ kind: "path", path: makePaperTar() }, { provider: "claude", outDir }, {
      client: docClient(),
      db,
      latexRunner: runner,
      onError: (m) => errs.push(m),
    });
    expect(r.exitCode).toBe(5);
    expect(r.summary.layout).toBe("original");
    expect(r.summary.buildOk).toBe(false);
    expect(r.pdfPath).toBeUndefined();
    expect(errs.some((e) => e.includes("翻訳起因"))).toBe(true);
    db.close();
  });

  it("checkpoint idempotent-skip: 2回目は LLM を呼ばない", async () => {
    const outDir = path.join(tmp(), "out");
    const tar = makePaperTar();
    const db = new GlossaryDb();
    await tp({ kind: "path", path: tar }, { provider: "claude", outDir }, {
      client: docClient(),
      db,
    });
    const client2 = docClient();
    await tp({ kind: "path", path: tar }, { provider: "claude", outDir }, {
      client: client2,
      db,
    });
    expect(client2.calls.length).toBe(0);
    db.close();
  });

  it("glossary.md を編集して再実行すると該当セグメントを再訳し md を上書きしない", async () => {
    const outDir = path.join(tmp(), "out");
    const tar = makePaperTar();
    const db = new GlossaryDb();
    await tp({ kind: "path", path: tar }, { provider: "claude", outDir }, {
      client: docClient(),
      db,
    });
    const gPath = path.join(outDir, "glossary.md");
    writeFileSync(gPath, readFileSync(gPath, "utf8").replace("甲", "エー"));
    const client2 = docClient();
    await tp({ kind: "path", path: tar }, { provider: "claude", outDir }, {
      client: client2,
      db,
    });
    expect(client2.calls.length).toBeGreaterThan(0);
    expect(readFileSync(gPath, "utf8")).toContain("エー");
    db.close();
  });

  it("style.md の編集を反映して再訳する", async () => {
    const outDir = path.join(tmp(), "out");
    const tar = makePaperTar();
    const db = new GlossaryDb();
    await tp({ kind: "path", path: tar }, { provider: "claude", outDir }, {
      client: docClient(),
      db,
    });
    const sPath = path.join(outDir, "style.md");
    writeFileSync(sPath, readFileSync(sPath, "utf8").replace("時制: a", "時制: 現在形固定"));
    const client2 = docClient();
    await tp({ kind: "path", path: tar }, { provider: "claude", outDir }, {
      client: client2,
      db,
    });
    expect(client2.calls.length).toBeGreaterThan(0);
    db.close();
  });

  it("同じ outDir で入力（path 内容）が変わると再取り込みして再訳する", async () => {
    const outDir = path.join(tmp(), "out");
    const tar = path.join(tmp(), "p.tar");
    writeFileSync(
      tar,
      makeTar([
        {
          name: "main.tex",
          content: "\\documentclass{a}\\begin{document}\\section{One}Alpha text.\\end{document}",
        },
      ]),
    );
    const db = new GlossaryDb();
    await tp({ kind: "path", path: tar }, { provider: "claude", outDir }, {
      client: docClient(),
      db,
    });
    writeFileSync(
      tar,
      makeTar([
        {
          name: "main.tex",
          content: "\\documentclass{a}\\begin{document}\\section{Two}Gamma text here.\\end{document}",
        },
      ]),
    );
    const client2 = docClient();
    await tp({ kind: "path", path: tar }, { provider: "claude", outDir }, {
      client: client2,
      db,
    });
    expect(client2.calls.length).toBeGreaterThan(0);
    db.close();
  });

  it("失敗セグメントはキャッシュせず再実行で再訳を試みる", async () => {
    const outDir = path.join(tmp(), "out");
    const tar = makePaperTar();
    const db = new GlossaryDb();
    const r1 = await tp({ kind: "path", path: tar }, { provider: "claude", outDir }, {
      client: mkClient("fail"),
      db,
    });
    expect(r1.exitCode).toBe(4);
    const client2 = mkClient("fail");
    await tp({ kind: "path", path: tar }, { provider: "claude", outDir }, {
      client: client2,
      db,
    });
    expect(client2.calls.length).toBeGreaterThan(0);
    db.close();
  });

  it("入力が縮小したら古い chapter を残さない", async () => {
    const outDir = path.join(tmp(), "out");
    const tar = path.join(tmp(), "p.tar");
    const db = new GlossaryDb();
    writeFileSync(
      tar,
      makeTar([
        {
          name: "main.tex",
          content:
            "\\documentclass{a}\\begin{document}\\section{A}Alpha text.\\section{B}Beta text.\\end{document}",
        },
      ]),
    );
    await tp({ kind: "path", path: tar }, { provider: "claude", outDir }, {
      client: docClient(),
      db,
    });
    const seg1 = path.join(outDir, "translation", "chapters", "seg-0001.tex");
    expect(existsSync(seg1)).toBe(true);
    writeFileSync(
      tar,
      makeTar([
        {
          name: "main.tex",
          content: "\\documentclass{a}\\begin{document}\\section{A}Alpha text only.\\end{document}",
        },
      ]),
    );
    await tp({ kind: "path", path: tar }, { provider: "claude", outDir }, {
      client: docClient(),
      db,
    });
    expect(existsSync(path.join(outDir, "translation", "chapters", "seg-0000.tex"))).toBe(true);
    expect(existsSync(seg1)).toBe(false);
    db.close();
  });

  it("翻訳の並列度を concurrency で制限する", async () => {
    const outDir = path.join(tmp(), "out");
    const tar = path.join(tmp(), "p.tar");
    writeFileSync(
      tar,
      makeTar([
        {
          name: "main.tex",
          content:
            "\\documentclass{a}\\begin{document}\\section{A}a text.\\section{B}b text.\\section{C}c text.\\section{D}d text.\\end{document}",
        },
      ]),
    );
    let active = 0;
    let maxActive = 0;
    const client = {
      async complete(req: { system: string }) {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        if (req.system.includes("編纂者")) {
          return JSON.stringify({
            resolved: [],
            brief: { thesis: "t", sectionRoles: [], notationConventions: [] },
            style: { tensePolicy: "a", headingStyle: "b", numberStyle: "c" },
          });
        }
        if (req.system.includes("審査者")) return '{"verdict":"pass","issues":[]}';
        return '{"segmentId":"x","ja":"訳文"}';
      },
    };
    const db = new GlossaryDb();
    const r = await tp(
      { kind: "path", path: tar },
      { provider: "claude", outDir, concurrency: 2 },
      { client, db },
    );
    expect(r.summary.segments.total).toBe(4);
    expect(maxActive).toBeLessThanOrEqual(2);
    db.close();
  });

  it("入力失敗は例外を投げず exit 2・onError に理由を渡す", async () => {
    const errs: string[] = [];
    const db = new GlossaryDb();
    const result = await tp(
      { kind: "path", path: path.join(tmp(), "missing.tar") },
      { provider: "claude", outDir: path.join(tmp(), "out") },
      { client: docClient(), db, onError: (m) => errs.push(m) },
    );
    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(2);
    expect(errs.length).toBeGreaterThan(0);
    db.close();
  });

  it("glossary.md を空にすると空を尊重し再生成しない", async () => {
    const outDir = path.join(tmp(), "out");
    const tar = makePaperTar();
    const db = new GlossaryDb();
    await tp({ kind: "path", path: tar }, { provider: "claude", outDir }, {
      client: docClient(),
      db,
    });
    const gPath = path.join(outDir, "glossary.md");
    writeFileSync(
      gPath,
      "# 用語集\n\n| 原語 | 確定訳/表記 | 分類 | 表記方針 | 訳注 |\n|---|---|---|---|---|\n",
    );
    await tp({ kind: "path", path: tar }, { provider: "claude", outDir }, {
      client: docClient(),
      db,
    });
    expect(readFileSync(gPath, "utf8")).not.toContain("甲");
    db.close();
  });
});

describe("本文が空になる入力", () => {
  it("セグメント 0 件は成功にせず exit 2 で落とす", async () => {
    // failed === 0 は results.length === 0 でも真なので、ここで落とさないと
    // 空の PDF が exit 0 の成功として返り、glossary 1 回ぶんだけ課金される。
    const p = path.join(tmp(), "p.tar");
    writeFileSync(
      p,
      makeTar([
        {
          name: "main.tex",
          content:
            "\\documentclass{a}\\begin{document}\\input{sections/intro}\\include{sections/method}\\end{document}",
        },
      ]),
    );
    const out = tmp();
    const r = await tp(
      { kind: "path", path: p },
      { provider: "ollama", outDir: out },
      { client: docClient(), db: new GlossaryDb(":memory:"), cacheKey: Buffer.alloc(32, 3) },
    );
    expect(r.status).toBe("failed");
    expect(r.exitCode).toBe(2);
    expect(r.error?.kind).toBe("input");
    expect(r.error?.message).toContain("本文が空");
    expect(r.error?.message).toContain("2 件");
    expect(r.summary.buildOk).not.toBe(true);
  });

  it("本文が残っていても未解決の \\input は警告として観測できる", async () => {
    const p = path.join(tmp(), "p.tar");
    writeFileSync(
      p,
      makeTar([
        {
          name: "main.tex",
          content:
            "\\documentclass{a}\\begin{document}\\section{Intro}Alpha text.\\input{sections/missing}\\end{document}",
        },
      ]),
    );
    const warnings: string[] = [];
    const r = await tp(
      { kind: "path", path: p },
      { provider: "ollama", outDir: tmp() },
      {
        client: docClient(),
        db: new GlossaryDb(":memory:"),
        cacheKey: Buffer.alloc(32, 4),
        onError: (m) => warnings.push(m),
      },
    );
    expect(r.status).toBe("ok");
    expect(warnings.some((w) => w.includes("解決できない"))).toBe(true);
  });
});

describe("対訳 PDF", () => {
  // main.tex に paracol があれば対訳の組版とみなす。
  const isBilingual = (dir: string): boolean =>
    readFileSync(path.join(dir, "main.tex"), "utf8").includes("\\begin{paracol}");

  it("既定で和訳 PDF のあとに対訳 PDF を組み、RunSummary に載せる", async () => {
    const outDir = path.join(tmp(), "out");
    const db = new GlossaryDb();
    const built: string[] = [];
    const runner: LatexRunner = (dir) => {
      built.push(isBilingual(dir) ? "bilingual" : "translation");
      return okRunner(dir);
    };
    const r = await tp({ kind: "path", path: makePaperTar() }, { provider: "claude", outDir }, {
      client: docClient(),
      db,
      latexRunner: runner,
    });
    expect(r.exitCode).toBe(0);
    expect(built).toEqual(["translation", "bilingual"]);
    expect(r.pdfPath).toBe(path.join(outDir, "p-ja.pdf"));
    const pdf = path.join(outDir, "p-bilingual.pdf");
    expect(r.summary.bilingual).toEqual({ status: "ok", pdfPath: pdf, pairs: 2, fallbackSegments: 0 });
    expect(existsSync(pdf)).toBe(true);
    expect(existsSync(path.join(outDir, "translation", "bilingual", "main.pdf"))).toBe(true);
    expect(existsSync(path.join(outDir, "translation", "bilingual.next"))).toBe(false);
    const tex = readFileSync(path.join(outDir, "translation", "bilingual", "main.tex"), "utf8");
    expect(tex).toContain("\\section{Intro}Alpha text.\n\\switchcolumn\n訳文\n\\switchcolumn*");
    db.close();
  });

  it("bilingual: false では組まず、RunSummary で disabled と区別できる", async () => {
    const outDir = path.join(tmp(), "out");
    const db = new GlossaryDb();
    const built: string[] = [];
    const runner: LatexRunner = (dir) => {
      built.push(isBilingual(dir) ? "bilingual" : "translation");
      return okRunner(dir);
    };
    const r = await tp(
      { kind: "path", path: makePaperTar() },
      { provider: "claude", outDir, bilingual: false },
      { client: docClient(), db, latexRunner: runner },
    );
    expect(r.exitCode).toBe(0);
    expect(built).toEqual(["translation"]);
    expect(r.summary.bilingual).toEqual({ status: "disabled", pairs: 0, fallbackSegments: 0 });
    expect(existsSync(path.join(outDir, "translation", "bilingual"))).toBe(false);
    db.close();
  });

  it("対訳の組版失敗は警告に留め、run は成功・和訳 PDF は出す", async () => {
    const outDir = path.join(tmp(), "out");
    const db = new GlossaryDb();
    const errs: string[] = [];
    const tar = makePaperTar();
    const first = await tp({ kind: "path", path: tar }, { provider: "claude", outDir }, { client: docClient(), db });
    expect(first.summary.bilingual.status).toBe("ok");
    const runner: LatexRunner = (dir) =>
      isBilingual(dir) ? { code: 1, log: "! LaTeX Error: File `paracol.sty' not found." } : okRunner(dir);
    const r = await tp({ kind: "path", path: tar }, { provider: "claude", outDir }, {
      client: docClient(),
      db,
      latexRunner: runner,
      onError: (m) => errs.push(m),
    });
    expect(r.exitCode).toBe(0);
    expect(r.status).toBe("ok");
    expect(r.error).toBeUndefined();
    expect(r.summary.buildOk).toBe(true);
    expect(existsSync(path.join(outDir, "translation", "build", "main.pdf"))).toBe(true);
    expect(r.summary.bilingual.status).toBe("failed");
    expect(r.summary.bilingual.pdfPath).toBeUndefined();
    expect(r.summary.bilingual.message).toContain("対訳 PDF の組版に失敗しました");
    expect(errs.some((e) => e.includes("対訳 PDF の組版に失敗しました"))).toBe(true);
    expect(existsSync(path.join(outDir, "translation", "bilingual.next"))).toBe(false);
    // 和訳 build は今回の訳に置き換わったので、前回の訳の対訳は残さない。
    expect(existsSync(path.join(outDir, "translation", "bilingual"))).toBe(false);
    expect(existsSync(path.join(outDir, "p-bilingual.pdf"))).toBe(false);
    expect(r.pdfPath).toBe(path.join(outDir, "p-ja.pdf"));
    expect(existsSync(path.join(outDir, "glossary.md"))).toBe(true);
    db.close();
  });

  it("原プリアンブルで対訳が組めなければ共通テンプレで組み直す", async () => {
    const outDir = path.join(tmp(), "out");
    const db = new GlossaryDb();
    const errs: string[] = [];
    const built: string[] = [];
    const runner: LatexRunner = (dir) => {
      const template = readFileSync(path.join(dir, "main.tex"), "utf8").includes("a4paper");
      built.push(`${isBilingual(dir) ? "bilingual" : "translation"}:${template ? "template" : "original"}`);
      if (isBilingual(dir) && !template) {
        return { code: 1, log: "! Package paracol Error: Environment paracol cannot work with ordinary two-column typesetting." };
      }
      return okRunner(dir);
    };
    const r = await tp({ kind: "path", path: makePaperTar() }, { provider: "claude", outDir }, {
      client: docClient(),
      db,
      latexRunner: runner,
      onError: (m) => errs.push(m),
    });
    expect(r.exitCode).toBe(0);
    expect(r.summary.layout).toBe("original");
    expect(built).toEqual(["translation:original", "bilingual:original", "bilingual:template"]);
    expect(r.summary.bilingual.status).toBe("ok");
    expect(errs.some((e) => e.includes("対訳: 原プリアンブルで組めず共通テンプレで組み直します"))).toBe(true);
    const tex = readFileSync(path.join(outDir, "translation", "bilingual", "main.tex"), "utf8");
    expect(tex).toContain("\\documentclass[a4paper]{article}");
    db.close();
  });

  it("対訳の組版中の例外も警告に留める", async () => {
    const outDir = path.join(tmp(), "out");
    const db = new GlossaryDb();
    const errs: string[] = [];
    const runner: LatexRunner = (dir) => {
      if (isBilingual(dir)) throw new Error("latexmk が見つかりません");
      return okRunner(dir);
    };
    const r = await tp({ kind: "path", path: makePaperTar() }, { provider: "claude", outDir }, {
      client: docClient(),
      db,
      latexRunner: runner,
      onError: (m) => errs.push(m),
    });
    expect(r.exitCode).toBe(0);
    expect(r.summary.bilingual.status).toBe("failed");
    expect(errs.some((e) => e.includes("対訳"))).toBe(true);
    db.close();
  });

  it("対訳の組版中の中断は握らず exit 6 で返し、前回の対訳を残さない", async () => {
    const outDir = path.join(tmp(), "out");
    const db = new GlossaryDb();
    const tar = makePaperTar();
    await tp({ kind: "path", path: tar }, { provider: "claude", outDir }, { client: docClient(), db });
    expect(existsSync(path.join(outDir, "translation", "bilingual", "main.pdf"))).toBe(true);
    const c = new AbortController();
    const runner: LatexRunner = (dir) => {
      if (isBilingual(dir)) {
        c.abort();
        return { code: 1, log: "killed" };
      }
      return okRunner(dir);
    };
    const r = await tp({ kind: "path", path: tar }, { provider: "claude", outDir, signal: c.signal }, {
      client: docClient(),
      db,
      latexRunner: runner,
    });
    expect(r.exitCode).toBe(6);
    expect(r.status).toBe("failed");
    expect(r.error?.kind).toBe("canceled");
    expect(existsSync(path.join(outDir, "translation", "bilingual"))).toBe(false);
    expect(existsSync(path.join(outDir, "translation", "bilingual.next"))).toBe(false);
    expect(existsSync(path.join(outDir, "p-bilingual.pdf"))).toBe(false);
    db.close();
  });

  it("和訳 PDF が組めなければ対訳は組まない（skipped）", async () => {
    const outDir = path.join(tmp(), "out");
    const db = new GlossaryDb();
    const built: string[] = [];
    const runner: LatexRunner = (dir) => {
      built.push(isBilingual(dir) ? "bilingual" : "translation");
      return { code: 1, log: "! LaTeX Error: File `x.png' not found." };
    };
    const r = await tp({ kind: "path", path: makePaperTar() }, { provider: "claude", outDir }, {
      client: docClient(),
      db,
      latexRunner: runner,
    });
    expect(r.exitCode).toBe(5);
    expect(built).not.toContain("bilingual");
    expect(r.summary.bilingual.status).toBe("skipped");
    db.close();
  });
});
