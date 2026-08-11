import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(path.join(os.tmpdir(), "jpaper-promote-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function fixture(name: string, thesis: string, body = "Alpha beta gamma delta.") {
  const { makeTar } = await import("../ingest/archive.fixtures.js");
  const work = tmp();
  const tar = path.join(work, `${name}.tar`);
  writeFileSync(
    tar,
    makeTar([
      {
        name: "main.tex",
        content: `\\documentclass{a}\\begin{document}\\section{Intro}${body}\\end{document}`,
      },
    ]),
  );
  return { tar, thesis };
}

async function client(thesis: string, onTranslate?: (user: string) => void) {
  const { FakeLlmClient } = await import("../testing/fake-llm.js");
  return new FakeLlmClient((req) => {
    if (req.system.includes("編纂者")) {
      return JSON.stringify({
        resolved: [],
        brief: { thesis, sectionRoles: [], notationConventions: [] },
        style: { tensePolicy: `時制${thesis}`, headingStyle: "b", numberStyle: "c" },
      });
    }
    if (req.system.includes("審査者")) return '{"verdict":"pass","issues":[]}';
    onTranslate?.(req.user);
    return '{"segmentId":"x","ja":"これは訳文である。"}';
  });
}

const ok = (d: string) => {
  writeFileSync(path.join(d, "main.pdf"), "%PDF");
  return { code: 0, log: "Output written on main.pdf (1 page)." };
};

describe("中断した run の中間物", () => {
  it("brief/style/glossary を outDir に残さない", async () => {
    const { translatePaper } = await import("./translate-paper.js");
    const { GlossaryDb } = await import("../terminology/db.js");
    const { tar } = await fixture("a", "秘密A");
    const outDir = path.join(tmp(), "out");

    const c = new AbortController();
    const r = await translatePaper(
      { kind: "path", path: tar },
      { provider: "ollama", outDir, signal: c.signal, concurrency: 1 },
      {
        client: await client("秘密A", () => c.abort()),
        db: new GlossaryDb(),
        latexRunner: ok,
      },
    );
    expect(r.exitCode).toBe(6);
    for (const f of ["brief.md", "style.md", "glossary.md", ".paper-id"]) {
      expect(existsSync(path.join(outDir, f))).toBe(false);
    }
  });

  it("組版に失敗した run は正本を確定しない", async () => {
    // 正本の確定が組版より前だった頃は、exit 5 でも glossary.md / .paper-id が
    // 書かれ、壊れた出力先が次の run の正本になった（契約付録 §2）。
    const { translatePaper } = await import("./translate-paper.js");
    const { GlossaryDb } = await import("../terminology/db.js");
    const { tar } = await fixture("a", "秘密A");
    const outDir = path.join(tmp(), "out");

    const r = await translatePaper(
      { kind: "path", path: tar },
      { provider: "ollama", outDir, concurrency: 1 },
      {
        client: await client("秘密A"),
        db: new GlossaryDb(),
        latexRunner: () => ({ code: 1, log: "! LaTeX Error." }),
      },
    );
    expect(r.exitCode).toBe(5);
    for (const f of ["brief.md", "style.md", "glossary.md", ".paper-id"]) {
      expect(existsSync(path.join(outDir, f))).toBe(false);
    }
  });

  it("中断後に入力を直して再実行すると、新しい文脈が使われる", async () => {
    const { translatePaper } = await import("./translate-paper.js");
    const { GlossaryDb } = await import("../terminology/db.js");
    const first = await fixture("a", "x");
    const outDir = path.join(tmp(), "out");

    const c = new AbortController();
    await translatePaper(
      { kind: "path", path: first.tar },
      { provider: "ollama", outDir, signal: c.signal, concurrency: 1 },
      {
        client: await client("中断時の主張", () => c.abort()),
        db: new GlossaryDb(),
        latexRunner: ok,
      },
    );

    // 入力を直して再実行する（原文が変われば builder の checkpoint も無効化される）。
    const fixed = await fixture("a", "x", "Theta iota kappa lambda mu.");
    const prompts: string[] = [];
    const r2 = await translatePaper(
      { kind: "path", path: fixed.tar },
      { provider: "ollama", outDir },
      {
        client: await client("やり直しの主張", (u) => prompts.push(u)),
        db: new GlossaryDb(),
        latexRunner: ok,
      },
    );
    expect(r2.status).toBe("ok");
    // 中断 run が残した md が正本になっていたら、直しても古い文脈のままになる。
    expect(prompts.join("\n")).toContain("やり直しの主張");
    expect(prompts.join("\n")).not.toContain("中断時の主張");
  });
});

describe("別論文が同じ outDir を使う場合", () => {
  it("前の論文の brief/style を引き継がない", async () => {
    const { translatePaper } = await import("./translate-paper.js");
    const { GlossaryDb } = await import("../terminology/db.js");
    const outDir = path.join(tmp(), "shared");
    const a = await fixture("paperA", "社外秘の研究テーマ");
    const b = await fixture("paperB", "公開してよい主張", "Delta epsilon zeta eta.");

    const r1 = await translatePaper(
      { kind: "path", path: a.tar },
      { provider: "ollama", outDir },
      { client: await client("社外秘の研究テーマ"), db: new GlossaryDb(), latexRunner: ok },
    );
    expect(r1.status).toBe("ok");
    expect(readFileSync(path.join(outDir, ".paper-id"), "utf8").split("\n")[0]).toBe("paperA");

    const prompts: string[] = [];
    const warns: string[] = [];
    const r2 = await translatePaper(
      { kind: "path", path: b.tar },
      { provider: "ollama", outDir },
      {
        client: await client("公開してよい主張", (u) => prompts.push(u)),
        db: new GlossaryDb(),
        latexRunner: ok,
        onError: (m) => warns.push(m),
      },
    );
    expect(r2.status).toBe("ok");
    const joined = prompts.join("\n");
    expect(joined).toContain("公開してよい主張");
    expect(joined).not.toContain("社外秘の研究テーマ");
    expect(warns.some((w) => w.includes("別の論文"))).toBe(true);
    expect(readFileSync(path.join(outDir, ".paper-id"), "utf8").split("\n")[0]).toBe("paperB");
  });
});

describe("人間の編集は尊重し続ける", () => {
  it("完了した run が書いた glossary.md を編集して再実行すると編集が使われる", async () => {
    const { translatePaper } = await import("./translate-paper.js");
    const { GlossaryDb } = await import("../terminology/db.js");
    const { tar } = await fixture("edited", "テーゼX");
    const outDir = path.join(tmp(), "out");

    await translatePaper(
      { kind: "path", path: tar },
      { provider: "ollama", outDir },
      { client: await client("テーゼX"), db: new GlossaryDb(), latexRunner: ok },
    );
    const briefMd = path.join(outDir, "brief.md");
    writeFileSync(briefMd, readFileSync(briefMd, "utf8").replace("テーゼX", "人が直したテーゼ"));

    const prompts: string[] = [];
    await translatePaper(
      { kind: "path", path: tar },
      { provider: "ollama", outDir },
      {
        client: await client("テーゼX", (u) => prompts.push(u)),
        db: new GlossaryDb(),
        latexRunner: ok,
      },
    );
    expect(prompts.join("\n")).toContain("人が直したテーゼ");
  });
});

describe("出力先は 1 つの論文のものに保つ", () => {
  const fail = () => ({ code: 1, log: "! LaTeX Error: broke." });
  const run = async (name: string, thesis: string, outDir: string, runner: typeof ok) => {
    const { translatePaper } = await import("./translate-paper.js");
    const { GlossaryDb } = await import("../terminology/db.js");
    const { tar } = await fixture(name, thesis);
    return translatePaper(
      { kind: "path", path: tar },
      { provider: "ollama", outDir },
      { client: await client(thesis), db: new GlossaryDb(), latexRunner: runner },
    );
  };

  it("同じ論文の再試行で組版が失敗しても前回の PDF を壊さない", async () => {
    const outDir = path.join(tmp(), "out");
    const pdf = path.join(outDir, "translation", "build", "main.pdf");
    expect((await run("a", "核A", outDir, ok)).status).toBe("ok");
    expect(existsSync(pdf)).toBe(true);
    expect((await run("a", "核A", outDir, fail)).status).toBe("failed");
    expect(existsSync(pdf)).toBe(true);
  });

  it("別の論文が組版で失敗しても、前の論文の正本を名乗ったままにしない", async () => {
    const outDir = path.join(tmp(), "out");
    expect((await run("a", "核A", outDir, ok)).status).toBe("ok");
    expect(readFileSync(path.join(outDir, ".paper-id"), "utf8").split("\n")[0]).toBe("a");

    expect((await run("b", "核B", outDir, fail)).exitCode).toBe(5);
    // .paper-id / md が A のまま残ると、A の md と B の本文が混ざったディレクトリになる。
    for (const f of ["brief.md", "style.md", "glossary.md", ".paper-id"]) {
      expect(existsSync(path.join(outDir, f))).toBe(false);
    }
    expect(existsSync(path.join(outDir, "translation", "chapters", "seg-0000.tex"))).toBe(true);
    expect(existsSync(path.join(outDir, "translation", "build", "main.pdf"))).toBe(false);
  });
});

describe("同じ名前で内容の違う論文", () => {
  it("main.tex 同士でも前の論文の brief がプロンプトに載らない", async () => {
    const { translatePaper } = await import("./translate-paper.js");
    const { GlossaryDb } = await import("../terminology/db.js");
    const outDir = path.join(tmp(), "out");
    const seen: string[] = [];
    const warns: string[] = [];

    const run = async (body: string, thesis: string) => {
      const { tar } = await fixture("main", thesis, body);
      return translatePaper(
        { kind: "path", path: tar },
        { provider: "ollama", outDir },
        {
          client: await client(thesis, (u) => seen.push(u)),
          db: new GlossaryDb(),
          onError: (m) => warns.push(m),
          latexRunner: ok,
        },
      );
    };

    expect((await run("Alpha beta gamma delta.", "秘密A")).status).toBe("ok");
    // どちらも fixture 名 "main" ＝ paperId が一致する（arXiv ソースで最も普通の名前）。
    seen.length = 0;
    expect((await run("Bravo zeta eta theta.", "核B")).status).toBe("ok");
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.filter((u) => u.includes("秘密A"))).toEqual([]);
    expect(warns.some((w) => w.includes("内容の違う論文"))).toBe(true);
  });

  it("同じ論文の再実行では既存 md を採用し続ける", async () => {
    const { translatePaper } = await import("./translate-paper.js");
    const { GlossaryDb } = await import("../terminology/db.js");
    const outDir = path.join(tmp(), "out");
    const run = async (thesis: string) => {
      const { tar } = await fixture("main", thesis, "Alpha beta gamma delta.");
      return translatePaper(
        { kind: "path", path: tar },
        { provider: "ollama", outDir },
        { client: await client(thesis), db: new GlossaryDb(), latexRunner: ok },
      );
    };
    expect((await run("最初の核")).status).toBe("ok");
    expect((await run("あとから来た核")).status).toBe("ok");
    // 2 回目は既存 md を正本として採用する＝作り直して上書きしない。
    expect(readFileSync(path.join(outDir, "brief.md"), "utf8")).toContain("最初の核");
  });
});
