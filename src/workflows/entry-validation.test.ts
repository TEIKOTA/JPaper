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

describe("concurrency の検証", () => {
  it("不正な concurrency は internal ではなく input で返る", async () => {
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
    // web の Number(req.query.concurrency) で普通に起きる値。
    for (const bad of [Number("abc"), 0, -3, Infinity]) {
      const r = await translatePaper({ kind: "path", path: tar }, {
        provider: "ollama",
        outDir: path.join(work, `out-${String(bad)}`),
        concurrency: bad,
      });
      expect(r.error?.kind).toBe("input");
      expect(r.error?.message).toContain("concurrency");
    }
  });
});

describe("bilingual の検証", () => {
  it("真偽値でない bilingual は input で返り、RunSummary では組んでいない", async () => {
    const { translatePaper } = await import("./translate-paper.js");
    for (const bad of ["false", 0, null]) {
      const r = await translatePaper({ kind: "path", path: "/tmp/x.tar" }, {
        provider: "ollama",
        outDir: path.join(tmp(), "o"),
        bilingual: bad as unknown as boolean,
      });
      expect(r.error?.kind).toBe("input");
      expect(r.error?.message).toContain("bilingual");
      expect(r.summary.bilingual.status).toBe("skipped");
    }
  });
});

describe("ollama 設定の検証", () => {
  it("空のモデル ID は input で返る（provider に届く前に落とす）", async () => {
    const { translatePaper } = await import("./translate-paper.js");
    const { DEFAULT_OLLAMA } = await import("../config.js");
    for (const bad of ["", "   ", null, 42]) {
      const r = await translatePaper({ kind: "path", path: "/tmp/x.tar" }, {
        provider: "ollama",
        ollama: { ...DEFAULT_OLLAMA, model: bad as unknown as string },
      });
      expect(r.error?.kind).toBe("input");
      expect(r.error?.message).toContain("ollama.model");
    }
  });

  it("範囲外の contextWindow は input で返る", async () => {
    const { translatePaper } = await import("./translate-paper.js");
    const { DEFAULT_OLLAMA } = await import("../config.js");
    // 0 は segmentBudgetFor が 0 を返し「本文が空」に化けるため、ここで落とす必要がある。
    for (const bad of [0, -1, 1023, 1_000_001, 1024.5, Number("x"), Infinity]) {
      const r = await translatePaper({ kind: "path", path: "/tmp/x.tar" }, {
        provider: "ollama",
        ollama: { ...DEFAULT_OLLAMA, contextWindow: bad },
      });
      expect(r.error?.kind).toBe("input");
      expect(r.error?.message).toContain("ollama.contextWindow");
    }
  });
});

describe("outDir の検証", () => {
  it("null / 空文字 / 数値は input で返る（JSON body の null が 500 にならない）", async () => {
    const { translatePaper } = await import("./translate-paper.js");
    for (const bad of [null, "", "   ", 42]) {
      const r = await translatePaper({ kind: "path", path: "/tmp/x.tar" }, {
        provider: "ollama",
        outDir: bad as unknown as string,
      });
      expect(r.error?.kind).toBe("input");
      expect(r.error?.message).toContain("outDir");
    }
  });
});
