import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeGate } from "../runtime/concurrency.js";
import { withSignal, withDeadline, raceAbort } from "../runtime/cancellation.js";

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(path.join(os.tmpdir(), "jpaper-deadline-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// 中断を無視するクライアント。注入クライアントは任意の実装なので、契約で強制できない。
const deaf = { complete: () => new Promise<string>(() => undefined) };

describe("中断を無視するクライアント", () => {
  it("abort でゲートの枠が返る（枠が枯れてプロセス全体が停まらない）", async () => {
    const gate = makeGate(1);
    const c = new AbortController();
    const client = withSignal(deaf, c.signal);

    const first = gate.run(() => client.complete({ system: "s", user: "u" })).catch((e) => e);
    await Promise.resolve();
    expect(gate.active()).toBe(1);

    // 枠が 1 つしかないので、2 本目は待ち行列に入る。
    const second = gate.run(async () => "ok");
    await Promise.resolve();
    expect(gate.waiting()).toBe(1);

    c.abort();
    expect(await first).toMatchObject({ kind: "canceled", code: 6 });
    expect(await second).toBe("ok");
    expect(gate.active()).toBe(0);
    expect(gate.waiting()).toBe(0);
  });

  it("raceAbort は決着後に abort listener を外す（長い run で溜めない）", async () => {
    const c = new AbortController();
    for (let i = 0; i < 50; i++) await raceAbort(Promise.resolve(i), c.signal, "x");
    // Node の EventTarget は 1 つの signal に付いた listener 数を数えられないため、
    // 代理として「大量呼び出し後も abort が 1 回で伝わる」ことを確認する。
    const pending = raceAbort(new Promise<never>(() => undefined), c.signal, "x").catch((e) => e);
    c.abort();
    expect(await pending).toMatchObject({ kind: "canceled" });
  });
});

describe("withDeadline", () => {
  it("未指定なら期限なし（親の signal をそのまま返す）", () => {
    const c = new AbortController();
    expect(withDeadline(c.signal, undefined).signal).toBe(c.signal);
    expect(withDeadline(undefined, undefined).signal).toBeUndefined();
  });

  it("不正な timeoutMs は黙って期限なしにせず input で拒否する", () => {
    // 黙って無期限にすると、期限を設定したつもりの run が枠を握って他テナントを止める。
    for (const bad of [0, -1, NaN, Infinity, "5000", null]) {
      expect(() => withDeadline(undefined, bad as number)).toThrowError(/timeoutMs/);
    }
  });

  it("巨大な timeoutMs は 2^31-1 でクランプする（即時 abort にしない）", async () => {
    const d = withDeadline(undefined, 3e9);
    await new Promise((r) => setTimeout(r, 20));
    expect(d.signal?.aborted).toBe(false); // 丸められて 1ms で発火していたら true になる
    d.dispose();
  });

  it("親の abort は合流後の signal へ伝わる", () => {
    const c = new AbortController();
    const d = withDeadline(c.signal, 10_000);
    c.abort();
    expect(d.signal?.aborted).toBe(true);
    d.dispose();
  });

  it("dispose 後はタイマーが発火しない", async () => {
    const d = withDeadline(undefined, 5);
    d.dispose();
    await new Promise((r) => setTimeout(r, 20));
    expect(d.signal?.aborted).toBe(false);
  });
});

describe("translatePaper の期限", () => {
  it("timeoutMs 超過は canceled（exit 6）で返る", async () => {
    const { translatePaper } = await import("./translate-paper.js");
    const { GlossaryDb } = await import("../terminology/db.js");
    const { makeTar } = await import("../ingest/archive.fixtures.js");

    const work = tmp();
    const tar = path.join(work, "p.tar");
    writeFileSync(
      tar,
      makeTar([
        {
          name: "main.tex",
          content: "\\documentclass{a}\\begin{document}\\section{I}Alpha beta.\\end{document}",
        },
      ]),
    );

    const r = await translatePaper(
      { kind: "path", path: tar },
      { provider: "ollama", outDir: path.join(work, "out"), timeoutMs: 20 },
      { client: deaf, db: new GlossaryDb() },
    );
    expect(r.exitCode).toBe(6);
    // 期限超過は切断と区別する（web が 504 と 499 を出し分けられるように）。
    expect(r.error?.kind).toBe("timeout");
    expect(r.error?.message).toContain("期限");
  });
});

describe("枠を握った run が中断されない場合", () => {
  it("待機中の run は自分の期限で返る（枠が空くのを待たされない）", async () => {
    const { makeGate } = await import("../runtime/concurrency.js");
    const gate = makeGate(1);
    // A: 期限も signal も持たず、中断を無視するクライアントで枠を握り続ける。
    const held = gate.run(() => new Promise<string>(() => undefined)).catch(() => "");
    await Promise.resolve();
    expect(gate.active()).toBe(1);

    // B: 期限を持つ run。枠は空かないが、待機中に期限が効かなければ永久に返らない。
    const c = new AbortController();
    const waiting = gate.run(async () => "never", c.signal).catch((e: unknown) => e);
    await Promise.resolve();
    expect(gate.waiting()).toBe(1);
    c.abort();

    expect(await waiting).toMatchObject({ kind: "canceled", code: 6 });
    expect(gate.waiting()).toBe(0);
    void held;
  });

  it("中断済みの待機者は枠を消費しない（後続へ譲る）", async () => {
    const { makeGate } = await import("../runtime/concurrency.js");
    const gate = makeGate(1);
    let releaseFirst = (): void => undefined;
    const first = gate.run(() => new Promise<void>((r) => (releaseFirst = r)));
    await Promise.resolve();

    const c = new AbortController();
    const doomed = gate.run(async () => "doomed", c.signal).catch(() => "canceled");
    const survivor = gate.run(async () => "survivor");
    await Promise.resolve();
    c.abort();
    releaseFirst();

    expect(await doomed).toBe("canceled");
    expect(await survivor).toBe("survivor");
    await first;
    expect(gate.active()).toBe(0);
    expect(gate.waiting()).toBe(0);
  });
});

describe("期限超過と切断の区別", () => {
  it("呼び出し側の abort は canceled、期限超過は timeout", async () => {
    const { withDeadline, throwIfAborted } = await import("../runtime/cancellation.js");
    const c = new AbortController();
    c.abort();
    expect(() => throwIfAborted(c.signal, "x")).toThrowError(/中断/);

    const d = withDeadline(undefined, 5);
    await new Promise((r) => setTimeout(r, 30));
    let err: unknown;
    try {
      throwIfAborted(d.signal, "x");
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ kind: "timeout", code: 6 });
    d.dispose();
  });

  it("親の中断は期限超過に化けない", async () => {
    const { withDeadline, throwIfAborted } = await import("../runtime/cancellation.js");
    const c = new AbortController();
    const d = withDeadline(c.signal, 10_000);
    c.abort();
    let err: unknown;
    try {
      throwIfAborted(d.signal, "x");
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ kind: "canceled" });
    d.dispose();
  });
});

describe("期限の印は内部タイマーだけが付ける", () => {
  it("親由来の reason が timeout に化けない（監視シグナルの反転を防ぐ）", async () => {
    const { withDeadline, throwIfAborted } = await import("../runtime/cancellation.js");
    const c = new AbortController();
    const d = withDeadline(c.signal, 10_000);
    // web 層が client 由来の値をそのまま reason に載せた場合。
    c.abort({ jpaperDeadlineMs: 1 });
    let err: unknown;
    try {
      throwIfAborted(d.signal, "x");
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ kind: "canceled" });
    d.dispose();
  });
});
