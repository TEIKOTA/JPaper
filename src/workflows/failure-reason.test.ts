import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
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
  const d = mkdtempSync(path.join(os.tmpdir(), "jpaper-reason-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// 数式を落とす訳文を返す（math 検査に落ちる）。
function mathDroppingClient(): FakeLlmClient {
  return new FakeLlmClient((req) => {
    if (req.system.includes("編纂者")) {
      return JSON.stringify({
        resolved: [],
        brief: { thesis: "核", sectionRoles: [], notationConventions: [] },
        style: { tensePolicy: "a", headingStyle: "b", numberStyle: "c" },
      });
    }
    if (req.system.includes("審査者")) return '{"verdict":"pass","issues":[]}';
    return JSON.stringify({ segmentId: "x", ja: "はじめに。これは訳文である。" });
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
          "\\documentclass{a}\\begin{document}\\section{Intro}Alpha text with $x = 1$ inside.\\end{document}",
      },
    ]),
  );
  return p;
}

describe("形式検査の失敗理由", () => {
  it("落ちた検査の種別をセグメント ID に添えて返す", async () => {
    // 失敗した訳文は chapters へ書き出されず、失敗結果は checkpoint にも残らない。
    // ID だけを返していたときは、運用者に手掛かりが 1 つも残らなかった。
    const r = await translatePaper(
      { kind: "path", path: paperTar() },
      { provider: "ollama", outDir: path.join(tmp(), "out") },
      { client: mathDroppingClient(), db: new GlossaryDb(), latexRunner: okRunner },
    );
    expect(r.exitCode).toBe(3);
    expect(r.error?.kind).toBe("formal");
    expect(r.error?.message).toMatch(/seg-0000\([^)]*math[^)]*\)/);
  });
});
