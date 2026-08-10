import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { JpaperInput, Provider } from "../types/contract.js";

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(path.join(os.tmpdir(), "jpaper-entry-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("web ハンドラから見た入口", () => {
  it("壊れた入力は生の例外ではなく input で返る", async () => {
    const { translatePaper } = await import("./translate-paper.js");
    for (const bad of [
      { kind: "path" } as unknown as JpaperInput,
      { kind: "path", path: undefined } as unknown as JpaperInput,
      { kind: "url", url: "http://x" } as unknown as JpaperInput,
      undefined as unknown as JpaperInput,
    ]) {
      const r = await translatePaper(bad, { provider: "ollama", outDir: path.join(tmp(), "o") });
      expect(r.status).toBe("failed");
      expect(r.error?.kind).toBe("input");
      expect(r.exitCode).toBe(2);
    }
  });

  it("未知の provider は黙って claude 扱いにせず input で返る", async () => {
    const { translatePaper } = await import("./translate-paper.js");
    const { makeTar } = await import("../ingest/archive.fixtures.js");
    const work = tmp();
    const tar = path.join(work, "p.tar");
    writeFileSync(
      tar,
      makeTar([
        {
          name: "main.tex",
          content: "\\documentclass{a}\\begin{document}\\section{I}Alpha.\\end{document}",
        },
      ]),
    );
    const r = await translatePaper({ kind: "path", path: tar }, {
      provider: "openai" as unknown as Provider,
      outDir: path.join(work, "out"),
    });
    expect(r.status).toBe("failed");
    expect(r.error?.kind).toBe("input");
    expect(r.error?.message).toContain("provider");
  });
});

describe("注入ゲート", () => {
  it("プロセス上限を置き換えず、内側の第 2 段として重なる", async () => {
    const { makeGate, setLlmGate, llmGate } = await import("../runtime/concurrency.js");
    const { withGate } = await import("../runtime/concurrency.js");
    const process1 = makeGate(1);
    setLlmGate(process1);
    try {
      // 注入ゲートが 64 でも、外側のプロセスゲートが 1 なら同時実行は 1 に留まる。
      const injected = makeGate(64);
      let peak = 0;
      let active = 0;
      const client = withGate(
        withGate(
          {
            complete: async () => {
              active++;
              peak = Math.max(peak, active);
              await new Promise((r) => setTimeout(r, 5));
              active--;
              return "ok";
            },
          },
          injected,
        ),
        llmGate(),
      );
      await Promise.all(
        Array.from({ length: 8 }, () => client.complete({ system: "s", user: "u" })),
      );
      expect(peak).toBe(1);
    } finally {
      setLlmGate(undefined);
    }
  });
});
