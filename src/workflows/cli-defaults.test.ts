import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { translatePaper } from "./translate-paper.js";
import { GlossaryDb } from "../terminology/db.js";
import { makeTar } from "../ingest/archive.fixtures.js";

const dirs: string[] = [];
const saved = { PATH: process.env.PATH, CODEX_HOME: process.env.CODEX_HOME };
afterEach(() => {
  process.env.PATH = saved.PATH;
  if (saved.CODEX_HOME === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = saved.CODEX_HOME;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("translatePaper: claude・codex の既定（契約付録 §5）", () => {
  it("codex のモデル一覧が読めなければ、既定のモデルで訳すと警告する", async () => {
    const d = mkdtempSync(path.join(os.tmpdir(), "jpaper-cli-defaults-"));
    dirs.push(d);
    const tar = path.join(d, "p.tar");
    writeFileSync(
      tar,
      makeTar([{ name: "main.tex", content: "\\documentclass{a}\\begin{document}\\section{A}Alpha text.\\end{document}" }]),
    );
    process.env.CODEX_HOME = path.join(d, "no-codex-home");
    process.env.PATH = path.join(d, "no-bin");
    const errs: string[] = [];
    const db = new GlossaryDb();
    const r = await translatePaper(
      { kind: "path", path: tar },
      { provider: "codex", outDir: path.join(d, "out") },
      { db, onError: (m) => errs.push(m) },
    );
    db.close();
    expect(errs.some((m) => m.includes("最新の Sol 系を見つけられなかった"))).toBe(true);
    // codex が無いので run は provider の失敗で終わる（既定の解決は呼び出し前）。
    expect(r.exitCode).not.toBe(0);
  });
});
