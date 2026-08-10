import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { withSignal, throwIfAborted, canceledError } from "../runtime/cancellation.js";
import { JpaperError, isTransient } from "../types/errors.js";
import type { LlmClient } from "../types/contract.js";

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
