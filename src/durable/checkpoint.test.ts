import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { checkpoint, hashContext } from "./checkpoint.js";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), "jpaper-ckpt-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const S = z.object({ v: z.number() });
const KEY = Buffer.alloc(32, 7); // 署名鍵は注入する（テストが JPAPER_HOME を汚さない）

describe("checkpoint", () => {
  it("idempotent-skip: 2回目は fn を呼ばない", async () => {
    const dir = tmp();
    let calls = 0;
    const fn = async () => ({ v: ++calls });
    expect(await checkpoint(dir, "step", S, fn, { key: KEY })).toEqual({ v: 1 });
    expect(await checkpoint(dir, "step", S, fn, { key: KEY })).toEqual({ v: 1 });
    expect(calls).toBe(1);
  });

  it("invalidation 変更で再計算する", async () => {
    const dir = tmp();
    let calls = 0;
    const fn = async () => ({ v: ++calls });
    await checkpoint(dir, "step", S, fn, { key: KEY, invalidation: "h1" });
    await checkpoint(dir, "step", S, fn, { key: KEY, invalidation: "h1" });
    await checkpoint(dir, "step", S, fn, { key: KEY, invalidation: "h2" });
    expect(calls).toBe(2);
  });

  it("破損キャッシュは無視して再計算", async () => {
    const dir = tmp();
    mkdirSync(path.join(dir, "steps"), { recursive: true });
    writeFileSync(path.join(dir, "steps", "step.json"), "not json");
    let calls = 0;
    expect(
      await checkpoint(dir, "step", S, async () => ({ v: ++calls }), { key: KEY }),
    ).toEqual({ v: 1 });
  });

  it("cacheable=false は永続せず毎回再計算", async () => {
    const dir = tmp();
    let calls = 0;
    const fn = async () => ({ v: ++calls });
    await checkpoint(dir, "s", S, fn, { key: KEY, cacheable: () => false });
    await checkpoint(dir, "s", S, fn, { key: KEY, cacheable: () => false });
    expect(calls).toBe(2);
  });

  it("hashContext は決定的で入力差を反映", () => {
    expect(hashContext("a", "b")).toBe(hashContext("a", "b"));
    expect(hashContext("a")).not.toBe(hashContext("b"));
  });
});

describe("checkpoint の完全性", () => {
  const write = (dir: string, file: string, body: unknown): void => {
    mkdirSync(path.join(dir, "steps"), { recursive: true });
    writeFileSync(path.join(dir, "steps", file), JSON.stringify(body));
  };

  it("署名の無い（旧形式の）キャッシュは採用せず再計算する", async () => {
    const dir = tmp();
    write(dir, "step.json", { v: 99 });
    let called = false;
    const r = await checkpoint(dir, "step", S, async () => {
      called = true;
      return { v: 1 };
    }, { key: KEY });
    expect(called).toBe(true);
    expect(r).toEqual({ v: 1 });
  });

  it("値を改竄したキャッシュは採用せず再計算する", async () => {
    const dir = tmp();
    await checkpoint(dir, "step", S, async () => ({ v: 1 }), { key: KEY });
    const file = path.join(dir, "steps", "step.json");
    const env = JSON.parse(readFileSync(file, "utf8")) as { sig: string; value: unknown };
    writeFileSync(file, JSON.stringify({ v: 1, sig: env.sig, value: { v: 666 } }));
    let called = false;
    const r = await checkpoint(dir, "step", S, async () => {
      called = true;
      return { v: 2 };
    }, { key: KEY });
    expect(called).toBe(true);
    expect(r).toEqual({ v: 2 });
  });

  it("別の鍵で署名されたキャッシュは採用しない", async () => {
    const dir = tmp();
    await checkpoint(dir, "step", S, async () => ({ v: 1 }), { key: Buffer.alloc(32, 9) });
    let called = false;
    await checkpoint(dir, "step", S, async () => {
      called = true;
      return { v: 2 };
    }, { key: KEY });
    expect(called).toBe(true);
  });

  it("stepId をすり替えたキャッシュは採用しない（署名が step に束縛される）", async () => {
    const dir = tmp();
    await checkpoint(dir, "a", S, async () => ({ v: 1 }), { key: KEY });
    const env = readFileSync(path.join(dir, "steps", "a.json"), "utf8");
    writeFileSync(path.join(dir, "steps", "b.json"), env);
    let called = false;
    await checkpoint(dir, "b", S, async () => {
      called = true;
      return { v: 2 };
    }, { key: KEY });
    expect(called).toBe(true);
  });

  it("正当なキャッシュは従来どおりヒットする", async () => {
    const dir = tmp();
    await checkpoint(dir, "step", S, async () => ({ v: 1 }), { key: KEY });
    let called = false;
    const r = await checkpoint(dir, "step", S, async () => {
      called = true;
      return { v: 2 };
    }, { key: KEY });
    expect(called).toBe(false);
    expect(r).toEqual({ v: 1 });
  });
});
