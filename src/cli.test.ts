import { describe, it, expect } from "vitest";
import { runCli } from "./cli.js";
import type { Result } from "./types/contract.js";

const okResult: Result = {
  status: "ok",
  exitCode: 0,
  summary: {
    paperId: "p",
    outDir: "/out",
    segments: { total: 1, passed: 1, failed: 0 },
    revisions: { max: 3, used: 0 },
    glossary: { proposedAdded: 0 },
    notes: { total: 0, byTrigger: {} },
    layout: null,
    buildOk: null,
    exitCode: 0,
  },
};

describe("runCli", () => {
  it("--provider 未指定は exit 2", async () => {
    const code = await runCli(["node", "jpaper", "1706.03762"], {
      stderr: () => {},
      translate: async () => okResult,
    });
    expect(code).toBe(2);
  });

  it("不正 provider は exit 2", async () => {
    const code = await runCli(["node", "jpaper", "1706.03762", "--provider", "openai"], {
      stderr: () => {},
      translate: async () => okResult,
    });
    expect(code).toBe(2);
  });

  it("--out に値が無いと exit 2", async () => {
    const code = await runCli(["node", "jpaper", "1706.03762", "--provider", "claude", "--out"], {
      stderr: () => {},
      translate: async () => okResult,
    });
    expect(code).toBe(2);
  });

  it("<input> 欠如は exit 2", async () => {
    const code = await runCli(["node", "jpaper", "--provider", "claude"], {
      stderr: () => {},
      translate: async () => okResult,
    });
    expect(code).toBe(2);
  });

  it("pdfPath があれば標準出力に表示する", async () => {
    let out = "";
    await runCli(["node", "jpaper", "1706.03762", "--provider", "claude"], {
      stdout: (s) => (out += s),
      translate: async () => ({ ...okResult, pdfPath: "/out/translation/build/main.pdf" }),
    });
    expect(out).toContain("PDF: /out/translation/build/main.pdf");
  });

  it("--model と --context-window を ollama 設定として渡す", async () => {
    let got: unknown;
    const code = await runCli(
      [
        "node",
        "jpaper",
        "1706.03762",
        "--provider",
        "ollama",
        "--model",
        "gemma4:12b-it-qat",
        "--context-window",
        "32768",
      ],
      {
        stdout: () => {},
        translate: async (_input, opts) => {
          got = opts;
          return okResult;
        },
      },
    );
    expect(code).toBe(0);
    expect(got).toMatchObject({
      provider: "ollama",
      ollama: { model: "gemma4:12b-it-qat", contextWindow: 32768, port: 11434 },
    });
  });

  it("--model だけなら contextWindow は既定のまま", async () => {
    let got: { ollama?: { model: string; contextWindow: number } } | undefined;
    await runCli(["node", "jpaper", "1706.03762", "--provider", "ollama", "--model", "qwen3.5:9b"], {
      stdout: () => {},
      translate: async (_input, opts) => {
        got = opts;
        return okResult;
      },
    });
    expect(got?.ollama?.model).toBe("qwen3.5:9b");
    expect(got?.ollama?.contextWindow).toBe(8192);
  });

  it("モデル指定が無ければ ollama を渡さない（既定に委ねる）", async () => {
    let got: { ollama?: unknown } | undefined;
    await runCli(["node", "jpaper", "1706.03762", "--provider", "ollama"], {
      stdout: () => {},
      translate: async (_input, opts) => {
        got = opts;
        return okResult;
      },
    });
    expect(got?.ollama).toBeUndefined();
  });

  it("--provider claude に --model を付けると exit 2（黙って捨てない）", async () => {
    let called = false;
    let err = "";
    const code = await runCli(
      ["node", "jpaper", "1706.03762", "--provider", "claude", "--model", "qwen3.5:9b"],
      {
        stderr: (s) => (err += s),
        translate: async () => {
          called = true;
          return okResult;
        },
      },
    );
    expect(code).toBe(2);
    expect(called).toBe(false);
    expect(err).toContain("--model");
  });

  it("--provider claude に --context-window を付けても exit 2", async () => {
    const code = await runCli(
      ["node", "jpaper", "1706.03762", "--provider", "claude", "--context-window", "32768"],
      { stderr: () => {}, translate: async () => okResult },
    );
    expect(code).toBe(2);
  });

  it.each([
    ["非整数", "32k"],
    ["負数", "-1"],
    ["小数", "1024.5"],
    ["下限未満", "1023"],
    ["上限超過", "1000001"],
    ["安全整数超過", "99999999999999999999"],
  ])("--context-window が%sなら exit 2", async (_name, raw) => {
    let called = false;
    const code = await runCli(
      ["node", "jpaper", "1706.03762", "--provider", "ollama", "--context-window", raw],
      {
        stderr: () => {},
        translate: async () => {
          called = true;
          return okResult;
        },
      },
    );
    expect(code).toBe(2);
    expect(called).toBe(false);
  });

  it("--model が空白だけなら exit 2", async () => {
    const code = await runCli(
      ["node", "jpaper", "1706.03762", "--provider", "ollama", "--model", "   "],
      { stderr: () => {}, translate: async () => okResult },
    );
    expect(code).toBe(2);
  });

  it("--think / --no-think が ollama 設定の think になる", async () => {
    for (const [flag, want] of [
      ["--think", true],
      ["--no-think", false],
    ] as const) {
      let got: { ollama?: { think?: boolean } } | undefined;
      await runCli(["node", "jpaper", "1706.03762", "--provider", "ollama", flag], {
        stdout: () => {},
        translate: async (_input, opts) => {
          got = opts;
          return okResult;
        },
      });
      expect(got?.ollama?.think).toBe(want);
    }
  });

  it("--think と --no-think の同時指定は exit 2", async () => {
    const code = await runCli(
      ["node", "jpaper", "1706.03762", "--provider", "ollama", "--think", "--no-think"],
      { stderr: () => {}, translate: async () => okResult },
    );
    expect(code).toBe(2);
  });

  it("--provider claude に --think を付けると exit 2", async () => {
    const code = await runCli(["node", "jpaper", "1706.03762", "--provider", "claude", "--think"], {
      stderr: () => {},
      translate: async () => okResult,
    });
    expect(code).toBe(2);
  });

  it("綴り違いのオプションは <input> に落とさず exit 2", async () => {
    let err = "";
    const code = await runCli(
      ["node", "jpaper", "1706.03762", "--provider", "ollama", "--modell", "qwen3.5:9b"],
      { stderr: (s) => (err += s), translate: async () => okResult },
    );
    expect(code).toBe(2);
    expect(err).toContain("不明なオプション");
  });

  it("正常系は input/opts を渡し translate の exitCode を返す", async () => {
    let got: { input: unknown; opts: unknown } | undefined;
    const code = await runCli(
      ["node", "jpaper", "1706.03762", "--provider", "claude", "--out", "dir"],
      {
        stdout: () => {},
        translate: async (input, opts) => {
          got = { input, opts };
          return okResult;
        },
      },
    );
    expect(code).toBe(0);
    expect(got?.input).toEqual({ kind: "arxiv", id: "1706.03762" });
    expect(got?.opts).toMatchObject({ provider: "claude", outDir: "dir" });
  });
});
