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
    expect(readFileSync(path.join(outDir, ".paper-id"), "utf8")).toBe("paperA");

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
    expect(readFileSync(path.join(outDir, ".paper-id"), "utf8")).toBe("paperB");
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
