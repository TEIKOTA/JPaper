import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
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

describe("形式と品質の取り違え", () => {
  // 形式で落ちる節（数式を落とす）と、品質で落ちる節（evaluator が fail）を 1 本の run に混ぜる。
  function mixedClient(): FakeLlmClient {
    return new FakeLlmClient((req) => {
      if (req.system.includes("編纂者")) {
        return JSON.stringify({
          resolved: [],
          brief: { thesis: "核", sectionRoles: [], notationConventions: [] },
          style: { tensePolicy: "a", headingStyle: "b", numberStyle: "c" },
        });
      }
      const aboutBeta = req.user.includes("Beta");
      if (req.system.includes("審査者")) {
        // Beta の節だけ品質で落とす（形式検査は通る）。
        return aboutBeta
          ? '{"verdict":"fail","issues":[{"severity":"error","message":"品質不足"}]}'
          : '{"verdict":"pass","issues":[]}';
      }
      // Alpha の節は数式を落として形式検査に落とす。
      return aboutBeta
        ? '{"segmentId":"x","ja":"ベータの訳文である。"}'
        : '{"segmentId":"x","ja":"アルファの訳文である。"}';
    });
  }

  function mixedPaper(): string {
    const p = path.join(tmp(), "p.tar");
    writeFileSync(
      p,
      makeTar([
        {
          name: "main.tex",
          content:
            "\\documentclass{a}\\begin{document}" +
            "\\section{A}Alpha text with $x = 1$ inside." +
            "\\section{B}Beta text without math." +
            "\\end{document}",
        },
      ]),
    );
    return p;
  }

  it("品質で落ちた節を形式検査の一覧に混ぜず、両方を報告する", async () => {
    const r = await translatePaper(
      { kind: "path", path: mixedPaper() },
      { provider: "ollama", outDir: path.join(tmp(), "out") },
      { client: mixedClient(), db: new GlossaryDb(), latexRunner: okRunner },
    );
    expect(r.exitCode).toBe(3); // 形式が優先される
    const m = r.error?.message ?? "";
    // 形式の一覧には seg-0000 だけが入る（seg-0001 は品質の失敗）。
    expect(m).toMatch(/形式検査を通過しないセグメントがあります: seg-0000\(/);
    expect(m).not.toMatch(/形式検査を通過しないセグメントがあります: [^。]*seg-0001/);
    // 品質の失敗も報告から消さない。
    expect(m).toContain("品質基準に達しないセグメント: seg-0001");
  });

  it("落ちた節ごとに最後の稿の指摘を .run/failed-segments.json に残し、全節通れば消す", async () => {
    const outDir = path.join(tmp(), "out");
    const r = await translatePaper(
      { kind: "path", path: mixedPaper() },
      { provider: "ollama", outDir },
      { client: mixedClient(), db: new GlossaryDb(), latexRunner: okRunner },
    );
    expect(r.error?.message).toContain("最後の指摘は .run/failed-segments.json");
    const file = path.join(outDir, ".run", "failed-segments.json");
    const saved = JSON.parse(readFileSync(file, "utf8")) as {
      runId: string;
      createdAt: string;
      segments: { segmentId: string; failCode: number; lastIssues: unknown }[];
    };
    expect(saved.runId).toMatch(/^p-\d+$/);
    expect(Number.isNaN(Date.parse(saved.createdAt))).toBe(false);
    expect(saved.segments.map((x) => [x.segmentId, x.failCode])).toEqual([
      ["seg-0000", 3],
      ["seg-0001", 4],
    ]);
    expect(saved.segments[0]!.lastIssues).toMatchObject({ by: "formal", issues: [{ kind: "math" }] });
    expect(saved.segments[1]!.lastIssues).toEqual({
      by: "evaluator",
      verdict: "fail",
      issues: [{ severity: "error", message: "品質不足" }],
    });

    const passing = new FakeLlmClient((req) => {
      if (req.system.includes("編纂者")) {
        return JSON.stringify({
          resolved: [],
          brief: { thesis: "核", sectionRoles: [], notationConventions: [] },
          style: { tensePolicy: "a", headingStyle: "b", numberStyle: "c" },
        });
      }
      if (req.system.includes("審査者")) return '{"verdict":"pass","issues":[]}';
      return req.user.includes("Beta")
        ? '{"segmentId":"x","ja":"\\section{B}ベータの訳文である。"}'
        : '{"segmentId":"x","ja":"\\section{A}アルファの訳文 〔1〕 である。"}';
    });
    const again = await translatePaper(
      { kind: "path", path: mixedPaper() },
      { provider: "ollama", outDir },
      { client: passing, db: new GlossaryDb(), latexRunner: okRunner },
    );
    expect(again.exitCode).toBe(0);
    expect(existsSync(file)).toBe(false);
  });

  it("例外で終わった run は前の run の記録を消さず、書き換えもしない", async () => {
    const outDir = path.join(tmp(), "out");
    await translatePaper(
      { kind: "path", path: mixedPaper() },
      { provider: "ollama", outDir },
      { client: mixedClient(), db: new GlossaryDb(), latexRunner: okRunner },
    );
    const file = path.join(outDir, ".run", "failed-segments.json");
    const before = readFileSync(file, "utf8");
    const down = new FakeLlmClient((req) => {
      if (req.system.includes("編纂者")) {
        return JSON.stringify({
          resolved: [],
          brief: { thesis: "核", sectionRoles: [], notationConventions: [] },
          style: { tensePolicy: "a", headingStyle: "b", numberStyle: "c" },
        });
      }
      throw new Error("provider down");
    });
    const r = await translatePaper(
      { kind: "path", path: mixedPaper() },
      { provider: "ollama", outDir },
      { client: down, db: new GlossaryDb(), latexRunner: okRunner },
    );
    expect(r.exitCode).not.toBe(0);
    expect(readFileSync(file, "utf8")).toBe(before);
  });
});
