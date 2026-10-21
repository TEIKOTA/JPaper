import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { translatePaper } from "./translate-paper.js";
import { GlossaryDb } from "../terminology/db.js";
import { makeTar } from "../ingest/archive.fixtures.js";
import { writeFakeCli } from "../testing/fake-cli.js";

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

  // PATH に偽の CLI を置き、渡された引数を 1 行 1 引数でファイルへ書かせる。応答は失敗にし、run は期限（timeoutMs）で早く終わらせる。
  function fakeCli(d: string, name: "claude" | "codex"): string {
    const bin = path.join(d, "bin");
    const log = path.join(d, `${name}-args.txt`);
    const reply = name === "claude" ? `process.stdout.write('{"foo":1}');` : `fs.writeFileSync(argAfter("-o"), "not json");`;
    writeFakeCli(
      bin,
      name,
      `await readStdin();\nfs.writeFileSync(${JSON.stringify(log)}, args.map((a) => a + "\\n").join(""));\n${reply}`,
    );
    process.env.PATH = `${bin}${path.delimiter}${saved.PATH ?? ""}`;
    return log;
  }

  function paper(d: string): string {
    const tar = path.join(d, "p.tar");
    writeFileSync(
      tar,
      makeTar([{ name: "main.tex", content: "\\documentclass{a}\\begin{document}\\section{A}Alpha text.\\end{document}" }]),
    );
    return tar;
  }

  const argAfter = (args: string[], flag: string): string | undefined => args[args.indexOf(flag) + 1];

  it("claude: 未指定なら --model sonnet --effort medium、明示した値はそのまま claude CLI に渡る", async () => {
    for (const [given, model, effort] of [
      [{}, "sonnet", "medium"],
      [{ model: "opus", effort: "high" }, "opus", "high"],
    ] as const) {
      const d = mkdtempSync(path.join(os.tmpdir(), "jpaper-cli-defaults-"));
      dirs.push(d);
      const log = fakeCli(d, "claude");
      const db = new GlossaryDb();
      await translatePaper({ kind: "path", path: paper(d) }, { provider: "claude", outDir: path.join(d, "out"), claude: given }, { db });
      db.close();
      const args = readFileSync(log, "utf8").split("\n");
      expect(argAfter(args, "--model")).toBe(model);
      expect(argAfter(args, "--effort")).toBe(effort);
    }
  });

  it("codex: 未指定ならモデル一覧の最新の Sol と medium が codex CLI に渡る", async () => {
    const d = mkdtempSync(path.join(os.tmpdir(), "jpaper-cli-defaults-"));
    dirs.push(d);
    const codexHome = path.join(d, "codex-home");
    mkdirSync(codexHome);
    writeFileSync(
      path.join(codexHome, "models_cache.json"),
      JSON.stringify({ models: [{ slug: "gpt-6-sol", visibility: "list" }, { slug: "gpt-6.1-sol", visibility: "list" }] }),
    );
    process.env.CODEX_HOME = codexHome;
    const log = fakeCli(d, "codex");
    const errs: string[] = [];
    const db = new GlossaryDb();
    await translatePaper({ kind: "path", path: paper(d) }, { provider: "codex", outDir: path.join(d, "out"), timeoutMs: 1500 }, { db, onError: (m) => errs.push(m) });
    db.close();
    const args = readFileSync(log, "utf8").split("\n");
    expect(argAfter(args, "--model")).toBe("gpt-6.1-sol");
    expect(args).toContain('model_reasoning_effort="medium"');
    expect(errs.some((m) => m.includes("Sol 系を見つけられなかった"))).toBe(false);
  });

  it("注入クライアントのときは既定を足さず、モデル一覧も読まない（警告しない）", async () => {
    const d = mkdtempSync(path.join(os.tmpdir(), "jpaper-cli-defaults-"));
    dirs.push(d);
    process.env.CODEX_HOME = path.join(d, "no-codex-home");
    const errs: string[] = [];
    const db = new GlossaryDb();
    await translatePaper(
      { kind: "path", path: paper(d) },
      { provider: "codex", outDir: path.join(d, "out"), timeoutMs: 1500 },
      { db, client: { complete: async () => "not json" }, onError: (m) => errs.push(m) },
    );
    db.close();
    expect(errs.some((m) => m.includes("Sol 系を見つけられなかった"))).toBe(false);
  });
});
