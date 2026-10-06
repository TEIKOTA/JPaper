import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
const tmp = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), "jpaper-drift-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function clientWith(resolved: unknown[]): FakeLlmClient {
  return new FakeLlmClient((req) => {
    if (req.system.includes("編纂者")) {
      return JSON.stringify({
        resolved,
        brief: { thesis: "核", sectionRoles: [], notationConventions: [] },
        style: { tensePolicy: "a", headingStyle: "b", numberStyle: "c" },
      });
    }
    if (req.system.includes("審査者")) return '{"verdict":"pass","issues":[]}';
    return '{"segmentId":"x","ja":"これは訳文である。"}';
  });
}

function paperTar(): string {
  const p = path.join(tmp(), "p.tar");
  writeFileSync(
    p,
    makeTar([
      {
        name: "main.tex",
        content: "\\documentclass{a}\\begin{document}\\section{I}Alpha.\\end{document}",
      },
    ]),
  );
  return p;
}

describe("用語集の表記揺れの通知", () => {
  it("同居する 1 文字違いの音訳を警告として上げる（落としはしない）", async () => {
    const warnings: string[] = [];
    const r = await translatePaper(
      { kind: "path", path: paperTar() },
      { provider: "ollama", outDir: path.join(tmp(), "out") },
      {
        client: clientWith([
          {
            src: "Hausdorff distance",
            form: "ハウスドルフ距離(Hausdorff distance)",
            class: "paper-defined",
            rendering: "bilingual",
          },
          {
            src: "modified Hausdorff distance",
            form: "修正（95パーセンタイル）ハウスドッフ距離(modified Hausdorff distance)",
            class: "paper-defined",
            rendering: "bilingual",
          },
        ]),
        db: new GlossaryDb(),
        latexRunner: okRunner,
        onError: (m) => warnings.push(m),
      },
    );
    // 警告であって失敗ではない。
    expect(r.exitCode).toBe(0);
    const drift = warnings.filter((w) => w.includes("表記揺れ"));
    expect(drift).toHaveLength(1);
    expect(drift[0]).toContain("ハウスドルフ");
    expect(drift[0]).toContain("ハウスドッフ");
  });

  it("揺れが無ければ警告を出さない", async () => {
    const warnings: string[] = [];
    await translatePaper(
      { kind: "path", path: paperTar() },
      { provider: "ollama", outDir: path.join(tmp(), "out") },
      {
        client: clientWith([
          {
            src: "segmentation",
            form: "セグメンテーション(segmentation)",
            class: "established",
            rendering: "bilingual",
          },
        ]),
        db: new GlossaryDb(),
        latexRunner: okRunner,
        onError: (m) => warnings.push(m),
      },
    );
    expect(warnings.filter((w) => w.includes("表記揺れ"))).toEqual([]);
  });
});
