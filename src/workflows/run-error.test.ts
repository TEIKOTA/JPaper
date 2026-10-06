import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { toRunError, JpaperError } from "../types/errors.js";
import { Result } from "../types/contract.js";

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(path.join(os.tmpdir(), "jpaper-runerr-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("toRunError", () => {
  it("JpaperError は kind と code をそのまま保つ", () => {
    expect(toRunError(new JpaperError(2, "too-large", "でかすぎ"))).toEqual({
      kind: "too-large",
      code: 2,
      message: "でかすぎ",
    });
  });

  it("想定外の例外は internal に落とし、原因を detail に残す", () => {
    const e = toRunError(new TypeError("x is not a function"));
    expect(e.kind).toBe("internal");
    expect(e.code).toBe(1);
    expect(e.detail).toContain("TypeError");
  });

  it("Error でない throw も潰さずに扱う", () => {
    const e = toRunError("ただの文字列");
    expect(e.kind).toBe("internal");
    expect(e.message).toBe("ただの文字列");
  });
});

async function harness() {
  const { translatePaper } = await import("./translate-paper.js");
  const { FakeLlmClient } = await import("../testing/fake-llm.js");
  const { GlossaryDb } = await import("../terminology/db.js");
  const { makeTar } = await import("../ingest/archive.fixtures.js");

  const work = tmp();
  const tar = path.join(work, "p.tar");
  writeFileSync(
    tar,
    makeTar([
      {
        name: "main.tex",
        content:
          "\\documentclass{a}\\begin{document}\\section{Intro}Alpha text.\\end{document}",
      },
    ]),
  );
  const client = (ja: string, verdict = "pass") =>
    new FakeLlmClient((req) => {
      if (req.system.includes("編纂者")) {
        return JSON.stringify({
          resolved: [],
          brief: { thesis: "核", sectionRoles: [], notationConventions: [] },
          style: { tensePolicy: "a", headingStyle: "b", numberStyle: "c" },
        });
      }
      if (req.system.includes("審査者"))
        return JSON.stringify({
          verdict,
          issues: verdict === "pass" ? [] : [{ severity: "error", message: "だめ" }],
        });
      return JSON.stringify({ segmentId: "x", ja });
    });
  return { tar, client, GlossaryDb, translatePaper };
}

describe("Result.error（失敗の理由を戻り値から判別できる）", () => {
  it("入力エラーは kind=input で返り、例外は外へ出ない", async () => {
    const { translatePaper, client, GlossaryDb } = await harness();
    const r = await translatePaper(
      { kind: "path", path: path.join(tmp(), "missing.tar") },
      { provider: "ollama", outDir: path.join(tmp(), "out") },
      { client: client("x"), db: new GlossaryDb() },
    );
    expect(r.status).toBe("failed");
    expect(r.error?.kind).toBe("input");
    expect(r.error?.code).toBe(2);
    expect(r.error?.message).not.toBe("");
  });

  it("出力先の競合は kind=conflict（入力不正と区別できる）", async () => {
    const { translatePaper, tar, client, GlossaryDb } = await harness();
    const outDir = path.join(tmp(), "out");
    // 1 本目が同期的にロックを取るので、2 本目は必ず弾かれる。
    const running = translatePaper(
      { kind: "path", path: tar },
      { provider: "ollama", outDir },
      { client: client("これは訳文である。"), db: new GlossaryDb(),
        latexRunner: (d) => {
          writeFileSync(path.join(d, "main.pdf"), "%PDF");
          return { code: 0, log: "Output written on main.pdf (1 page)." };
        } },
    );
    const blocked = await translatePaper(
      { kind: "path", path: tar },
      { provider: "ollama", outDir },
      { client: client("これは訳文である。"), db: new GlossaryDb() },
    );
    await running;
    expect(blocked.error?.kind).toBe("conflict");
    expect(blocked.error?.code).toBe(2);
  });

  it("品質未達は kind=quality で、どのセグメントかが message に出る", async () => {
    const { translatePaper, tar, client, GlossaryDb } = await harness();
    const r = await translatePaper(
      { kind: "path", path: tar },
      { provider: "ollama", outDir: path.join(tmp(), "out") },
      { client: client("これは訳文である。", "fail"), db: new GlossaryDb() },
    );
    expect(r.exitCode).toBe(4);
    expect(r.error?.kind).toBe("quality");
    expect(r.error?.message).toContain("s");
  });

  it("組版失敗は kind=typeset で、ゲートの要約を持つ", async () => {
    const { translatePaper, tar, client, GlossaryDb } = await harness();
    const r = await translatePaper(
      { kind: "path", path: tar },
      { provider: "ollama", outDir: path.join(tmp(), "out") },
      {
        client: client("これは訳文である。"),
        db: new GlossaryDb(),
        latexRunner: () => ({ code: 1, log: "! LaTeX Error: something broke." }),
      },
    );
    expect(r.exitCode).toBe(5);
    expect(r.error?.kind).toBe("typeset");
    expect(r.error?.message).toContain("組版失敗");
  });

  it("成功時は error を持たない（zod 契約にも適合する）", async () => {
    const { translatePaper, tar, client, GlossaryDb } = await harness();
    const r = await translatePaper(
      { kind: "path", path: tar },
      { provider: "ollama", outDir: path.join(tmp(), "out") },
      {
        client: client("これは訳文である。"),
        db: new GlossaryDb(),
        latexRunner: (d) => {
          writeFileSync(path.join(d, "main.pdf"), "%PDF");
          return { code: 0, log: "Output written on main.pdf (1 page)." };
        },
      },
    );
    expect(r.status).toBe("ok");
    expect(r.error).toBeUndefined();
    expect(() => Result.parse(r)).not.toThrow();
  });
});
