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
