import { describe, it, expect } from "vitest";
import { runCli, formatProgress } from "./cli.js";
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
    bilingual: { status: "skipped", pairs: 0, fallbackSegments: 0 },
    llmCalls: 0,
    sharedDefaults: [],
    title: null,
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

  it("対訳 PDF があれば標準出力に表示する", async () => {
    let out = "";
    await runCli(["node", "jpaper", "1706.03762", "--provider", "claude"], {
      stdout: (s) => (out += s),
      translate: async () => ({
        ...okResult,
        summary: {
          ...okResult.summary,
          bilingual: {
            status: "ok",
            pdfPath: "/out/translation/bilingual/main.pdf",
            pairs: 3,
            fallbackSegments: 0,
          },
        },
      }),
    });
    expect(out).toContain("対訳 PDF: /out/translation/bilingual/main.pdf");
  });

  it("--no-bilingual は bilingual: false を渡し、無指定なら渡さない", async () => {
    const got: unknown[] = [];
    for (const extra of [["--no-bilingual"], []]) {
      const code = await runCli(["node", "jpaper", "1706.03762", "--provider", "claude", ...extra], {
        stdout: () => {},
        translate: async (_input, opts) => {
          got.push(opts.bilingual);
          return okResult;
        },
      });
      expect(code).toBe(0);
    }
    expect(got).toEqual([false, undefined]);
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

  it("--provider openrouter で --model と --context-window を openrouter 設定として渡す", async () => {
    let got: unknown;
    const code = await runCli(
      [
        "node",
        "jpaper",
        "1706.03762",
        "--provider",
        "openrouter",
        "--model",
        "google/gemma-4-26b-a4b-it:free",
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
      provider: "openrouter",
      openrouter: { model: "google/gemma-4-26b-a4b-it:free", contextWindow: 32768 },
    });
    expect((got as { ollama?: unknown }).ollama).toBeUndefined();
  });

  // --think は ollama だけの口。OpenRouter はモデル側の既定に委ねる。
  it("--provider openrouter に --think を付けると exit 2", async () => {
    let err = "";
    const code = await runCli(
      ["node", "jpaper", "1706.03762", "--provider", "openrouter", "--think"],
      { stderr: (s) => (err += s), translate: async () => okResult },
    );
    expect(code).toBe(2);
    expect(err).toContain("--think");
  });

  it("--provider claude は --model / --effort を claude 設定として渡す", async () => {
    let got: unknown;
    const code = await runCli(
      ["node", "jpaper", "1706.03762", "--provider", "claude", "--model", "sonnet", "--effort", "medium"],
      {
        stdout: () => {},
        translate: async (_input, opts) => {
          got = opts;
          return okResult;
        },
      },
    );
    expect(code).toBe(0);
    expect(got).toMatchObject({ provider: "claude", claude: { model: "sonnet", effort: "medium" } });
  });

  it("--provider claude で片方だけ指定したら、その片方だけを渡す", async () => {
    let got: { claude?: unknown } = {};
    await runCli(["node", "jpaper", "1706.03762", "--provider", "claude", "--effort", "high"], {
      stdout: () => {},
      translate: async (_input, opts) => {
        got = opts;
        return okResult;
      },
    });
    expect(got.claude).toEqual({ effort: "high" });
  });

  it("--provider claude で --model / --effort 未指定なら claude 設定は undefined（ログイン設定の既定）", async () => {
    let got: { claude?: unknown } = { claude: "unset" };
    const code = await runCli(["node", "jpaper", "1706.03762", "--provider", "claude"], {
      stdout: () => {},
      translate: async (_input, opts) => {
        got = opts;
        return okResult;
      },
    });
    expect(code).toBe(0);
    expect(got.claude).toBeUndefined();
  });

  it.each(["ollama", "openrouter"])("--provider %s に --effort を付けると exit 2", async (provider) => {
    let called = false;
    let err = "";
    const code = await runCli(["node", "jpaper", "1706.03762", "--provider", provider, "--effort", "high"], {
      stderr: (s) => (err += s),
      translate: async () => {
        called = true;
        return okResult;
      },
    });
    expect(code).toBe(2);
    expect(called).toBe(false);
    expect(err).toContain("--effort");
  });

  it.each([
    ["大文字", "Medium"],
    ["数字", "high2"],
    ["空白入り", "high -c x"],
    ["空文字", ""],
  ])("--effort が%sなら exit 2", async (_name, raw) => {
    let called = false;
    const code = await runCli(["node", "jpaper", "1706.03762", "--provider", "claude", "--effort", raw], {
      stderr: () => {},
      translate: async () => {
        called = true;
        return okResult;
      },
    });
    expect(code).toBe(2);
    expect(called).toBe(false);
  });

  it.each([
    ["空白のみ", " "],
    ["先頭が -", "-x"],
  ])("--provider claude の --model が%sなら exit 2", async (_name, raw) => {
    let called = false;
    const code = await runCli(["node", "jpaper", "1706.03762", "--provider", "claude", "--model", raw], {
      stderr: () => {},
      translate: async () => {
        called = true;
        return okResult;
      },
    });
    expect(code).toBe(2);
    expect(called).toBe(false);
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

  it("--concurrency を opts へ渡す", async () => {
    let got: { concurrency?: number } | undefined;
    await runCli(["node", "jpaper", "1706.03762", "--provider", "ollama", "--concurrency", "2"], {
      stdout: () => {},
      translate: async (_input, opts) => {
        got = opts;
        return okResult;
      },
    });
    expect(got?.concurrency).toBe(2);
  });

  it("--concurrency 無指定なら opts に載せず provider 別の既定へ委ねる", async () => {
    let got: { concurrency?: number } | undefined;
    await runCli(["node", "jpaper", "1706.03762", "--provider", "ollama"], {
      stdout: () => {},
      translate: async (_input, opts) => {
        got = opts;
        return okResult;
      },
    });
    expect(got?.concurrency).toBeUndefined();
  });

  it.each([
    ["0", "0"],
    ["負数", "-2"],
    ["非整数", "two"],
    ["小数", "1.5"],
    ["上限超過", "65"],
  ])("--concurrency が%sなら exit 2", async (_n, raw) => {
    const code = await runCli(
      ["node", "jpaper", "1706.03762", "--provider", "ollama", "--concurrency", raw],
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

describe("実行中の進捗（#246）", () => {
  // 失敗したセグメントは checkpoint に永続しないので、実行中に出さないと
  // 「どれが落ちたか」は run が終わるまで誰にも分からない。契約付録 §5。
  it("通過した節を件数付きで 1 行に出す", () => {
    expect(
      formatProgress({
        phase: "translate",
        segmentId: "seg-0006",
        done: 7,
        total: 36,
        passed: true,
        failedKinds: [],
        usedRevisions: 1,
        maxRevisions: 3,
      }),
    ).toBe("[翻訳 7/36] seg-0006 ok (改稿 1/3)");
  });

  it("落ちた節は検査の種別を添えて出す", () => {
    expect(
      formatProgress({
        phase: "translate",
        segmentId: "seg-0007",
        done: 8,
        total: 36,
        passed: false,
        failedKinds: ["math", "symbol-command"],
        usedRevisions: 3,
        maxRevisions: 3,
      }),
    ).toBe("[翻訳 8/36] seg-0007 失敗 math, symbol-command (改稿 3/3)");
  });

  it("種別が空の失敗は品質の失敗として出す（形式は通ったが evaluator が落とした）", () => {
    const line = formatProgress({
      phase: "translate",
      segmentId: "seg-0005",
      done: 6,
      total: 36,
      passed: false,
      failedKinds: [],
      usedRevisions: 3,
      maxRevisions: 3,
    });
    expect(line).toContain("失敗 品質");
  });

  it("翻訳以外のフェーズは完了時だけ 1 行出す", () => {
    expect(formatProgress({ phase: "ingest", done: 1, total: 1 })).toBe("[取り込み] 完了");
    expect(formatProgress({ phase: "context", done: 0, total: 1 })).toBeUndefined();
    expect(formatProgress({ phase: "typeset", done: 1, total: 1 })).toBe("[組版] 完了");
  });

  it("進捗を stderr へ流す（stdout の JSON を汚さない）", async () => {
    let out = "";
    let err = "";
    await runCli(["node", "jpaper", "1706.03762", "--provider", "claude"], {
      stdout: (s) => (out += s),
      stderr: (s) => (err += s),
      translate: async (_input, _opts, deps) => {
        deps?.onProgress?.({ phase: "ingest", done: 1, total: 1 });
        deps?.onProgress?.({
          phase: "translate",
          segmentId: "seg-0000",
          done: 1,
          total: 2,
          passed: false,
          failedKinds: ["math"],
          usedRevisions: 3,
          maxRevisions: 3,
        });
        return okResult;
      },
    });
    expect(err).toContain("[取り込み] 完了");
    expect(err).toContain("[翻訳 1/2] seg-0000 失敗 math (改稿 3/3)");
    expect(out).not.toContain("seg-0000");
  });

  it("進捗の宛先が投げても run の終了コードを変えない（副作用チャネル）", async () => {
    const code = await runCli(["node", "jpaper", "1706.03762", "--provider", "claude"], {
      stdout: () => {},
      stderr: () => {
        throw new Error("端末が閉じた");
      },
      translate: async (_input, _opts, deps) => {
        try {
          deps?.onProgress?.({ phase: "ingest", done: 1, total: 1 });
        } catch {
          // 呼び出し側（core）は握り潰す。契約付録 §5。
        }
        return okResult;
      },
    });
    expect(code).toBe(0);
  });
});
