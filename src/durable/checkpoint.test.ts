import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
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

describe("checkpoint", () => {
  it("idempotent-skip: 2回目は fn を呼ばない", async () => {
    const dir = tmp();
    let calls = 0;
    const fn = async () => ({ v: ++calls });
    expect(await checkpoint(dir, "step", S, fn)).toEqual({ v: 1 });
    expect(await checkpoint(dir, "step", S, fn)).toEqual({ v: 1 });
    expect(calls).toBe(1);
  });

  it("invalidation 変更で再計算する", async () => {
    const dir = tmp();
    let calls = 0;
    const fn = async () => ({ v: ++calls });
    await checkpoint(dir, "step", S, fn, { invalidation: "h1" });
    await checkpoint(dir, "step", S, fn, { invalidation: "h1" });
    await checkpoint(dir, "step", S, fn, { invalidation: "h2" });
    expect(calls).toBe(2);
  });

  it("破損キャッシュは無視して再計算", async () => {
    const dir = tmp();
    mkdirSync(path.join(dir, "steps"), { recursive: true });
    writeFileSync(path.join(dir, "steps", "step.json"), "not json");
    let calls = 0;
    expect(await checkpoint(dir, "step", S, async () => ({ v: ++calls }))).toEqual({ v: 1 });
  });

  it("cacheable=false は永続せず毎回再計算", async () => {
    const dir = tmp();
    let calls = 0;
    const fn = async () => ({ v: ++calls });
    await checkpoint(dir, "s", S, fn, { cacheable: () => false });
    await checkpoint(dir, "s", S, fn, { cacheable: () => false });
    expect(calls).toBe(2);
  });

  it("hashContext は決定的で入力差を反映", () => {
    expect(hashContext("a", "b")).toBe(hashContext("a", "b"));
    expect(hashContext("a")).not.toBe(hashContext("b"));
  });
});
