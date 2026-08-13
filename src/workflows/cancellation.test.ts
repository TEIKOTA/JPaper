import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  withSignal,
  withCallTimeout,
  throwIfAborted,
  canceledError,
} from "../runtime/cancellation.js";
import { JpaperError, isTransient } from "../types/errors.js";
import type { LlmClient } from "../types/contract.js";

const defer = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(path.join(os.tmpdir(), "jpaper-cancel-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("中断の分類", () => {
  it("中断は終了コード 6・kind=canceled で、retry の対象にしない", () => {
    const e = canceledError("どこか");
    expect(e).toBeInstanceOf(JpaperError);
    expect(e.code).toBe(6);
    expect(e.kind).toBe("canceled");
    expect(isTransient(e)).toBe(false);
  });

  it("throwIfAborted は abort 済みのときだけ投げる", () => {
    const c = new AbortController();
    expect(() => throwIfAborted(c.signal, "x")).not.toThrow();
    c.abort();
    expect(() => throwIfAborted(c.signal, "x")).toThrow(JpaperError);
    expect(() => throwIfAborted(undefined, "x")).not.toThrow();
  });
});

describe("withCallTimeout", () => {
  const never: LlmClient = { complete: () => new Promise<string>(() => undefined) };

  it("期限内に返る呼び出しはそのまま通す", async () => {
    const c = withCallTimeout({ complete: async () => "応答" }, 1000);
    expect(await c.complete({ system: "s", user: "u" })).toBe("応答");
  });

  it("返らない呼び出しは transient な provider エラーになる（retry に載る）", async () => {
    const c = withCallTimeout(never, 20);
    const e = await c.complete({ system: "s", user: "u" }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(JpaperError);
    expect((e as JpaperError).kind).toBe("provider");
    // 沈黙 1 回で run を落とさない。
    expect(isTransient(e)).toBe(true);
  });

  it("親の中断は中断のまま返す（期限超過に化けさせない）", async () => {
    const ctl = new AbortController();
    const c = withCallTimeout(never, 10_000);
    const p = c.complete({ system: "s", user: "u", signal: ctl.signal }).catch((x: unknown) => x);
    ctl.abort();
    const e = await p;
    expect((e as JpaperError).kind).toBe("canceled");
    expect(isTransient(e)).toBe(false);
  });

  it("期限は呼び出しごとに測る（1 本目の経過が 2 本目を切らない）", async () => {
    let n = 0;
    const slow: LlmClient = {
      complete: async () => {
        n++;
        await new Promise((r) => setTimeout(r, 30));
        return `応答${String(n)}`;
      },
    };
    const c = withCallTimeout(slow, 200);
    expect(await c.complete({ system: "s", user: "u" })).toBe("応答1");
    expect(await c.complete({ system: "s", user: "u" })).toBe("応答2");
  });

  it("期限なしはラップしない", () => {
    const base: LlmClient = { complete: async () => "x" };
    expect(withCallTimeout(base, undefined)).toBe(base);
  });

  it("不正な期限は input エラー（黙って無期限にしない）", () => {
    for (const bad of [0, -1, Number("x"), Infinity]) {
      expect(() => withCallTimeout({ complete: async () => "x" }, bad)).toThrow(JpaperError);
    }
  });
});

describe("withSignal", () => {
  it("全ての呼び出しに signal を載せ、abort 後は呼び出さない", async () => {
    const seen: (AbortSignal | undefined)[] = [];
    const base: LlmClient = {
      complete: async (req) => {
        seen.push(req.signal);
        return "{}";
      },
    };
    const c = new AbortController();
    const wrapped = withSignal(base, c.signal);
    await wrapped.complete({ system: "s", user: "u" });
    expect(seen[0]).toBe(c.signal);

    c.abort();
    await expect(wrapped.complete({ system: "s", user: "u" })).rejects.toThrow(JpaperError);
    expect(seen).toHaveLength(1); // 2 本目は境界で止まり provider まで届かない
  });

  it("signal 無しなら client をそのまま返す（余計なラップをしない）", () => {
    const base: LlmClient = { complete: async () => "{}" };
    expect(withSignal(base, undefined)).toBe(base);
  });
});

describe("translatePaper の中断", () => {
  it("翻訳中に abort すると exitCode 6・kind=canceled で返り、以降の LLM を呼ばない", async () => {
    const { translatePaper } = await import("./translate-paper.js");
    const { FakeLlmClient } = await import("../testing/fake-llm.js");
    const { GlossaryDb } = await import("../terminology/db.js");
    const { makeTar } = await import("../ingest/archive.fixtures.js");

    const work = tmp();
    const tar = path.join(work, "p.tar");
    const body = Array.from({ length: 6 }, (_, i) => `\\section{S${i}}Alpha beta gamma.`).join(
      "\n\n",
    );
    writeFileSync(
      tar,
      makeTar([
        { name: "main.tex", content: `\\documentclass{a}\\begin{document}${body}\\end{document}` },
      ]),
    );

    const c = new AbortController();
    let translateCalls = 0;
    const client = new FakeLlmClient(async (req) => {
      if (req.system.includes("編纂者")) {
        return JSON.stringify({
          resolved: [],
          brief: { thesis: "核", sectionRoles: [], notationConventions: [] },
          style: { tensePolicy: "a", headingStyle: "b", numberStyle: "c" },
        });
      }
      if (req.system.includes("審査者")) return '{"verdict":"pass","issues":[]}';
      translateCalls++;
      if (translateCalls === 1) c.abort(); // 1 本目の翻訳中にクライアントが切断した想定
      return JSON.stringify({ segmentId: "x", ja: "これは訳文である。" });
    });

    const r = await translatePaper(
      { kind: "path", path: tar },
      { provider: "ollama", outDir: path.join(work, "out"), concurrency: 1, signal: c.signal },
      { client, db: new GlossaryDb() },
    );
    expect(r.status).toBe("failed");
    expect(r.exitCode).toBe(6);
    expect(r.error?.kind).toBe("canceled");
    expect(translateCalls).toBeLessThan(6); // 全セグメントは処理されていない
  });

  it("最初から abort 済みなら 1 度も LLM を呼ばない", async () => {
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
          content: "\\documentclass{a}\\begin{document}\\section{I}Alpha.\\end{document}",
        },
      ]),
    );
    let calls = 0;
    const c = new AbortController();
    c.abort();
    const r = await translatePaper(
      { kind: "path", path: tar },
      { provider: "ollama", outDir: path.join(work, "out"), signal: c.signal },
      {
        client: new FakeLlmClient(() => {
          calls++;
          return "{}";
        }),
        db: new GlossaryDb(),
      },
    );
    expect(r.exitCode).toBe(6);
    expect(calls).toBe(0);
  });
});

describe("ゲートと中断の相互作用", () => {
  it("枠を取ってから中断を見る（待ち行列に中断済みが居座らない）", async () => {
    const { makeGate, withGate } = await import("../runtime/concurrency.js");
    const gate = makeGate(1);
    const c = new AbortController();
    let calls = 0;
    const base: LlmClient = {
      complete: async () => {
        calls++;
        return "{}";
      },
    };
    const client = withGate(withSignal(base, c.signal), gate);

    const hold = defer();
    void gate.run(() => hold.promise); // 枠を占有する
    const queued = client.complete({ system: "s", user: "u" });
    c.abort();
    hold.resolve();

    await expect(queued).rejects.toThrow(JpaperError);
    expect(calls).toBe(0); // 中断済みは provider へ届かない
    expect(gate.active()).toBe(0); // 枠を掴んだままにしない
  });
});
