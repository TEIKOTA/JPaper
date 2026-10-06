import { describe, it, expect, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { checkpoint, hashContext, pruneSteps } from "./checkpoint.js";

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

describe("旧世代の掃除", () => {
  it("同じ step の無効化ハッシュ違いは残さない", async () => {
    const dir = tmp();
    const key = Buffer.alloc(32, 7);
    for (const gen of ["a1", "b2", "c3"]) {
      await checkpoint(dir, "ingest", z.object({ v: z.string() }), async () => ({ v: gen }), {
        invalidation: gen,
        key,
      });
    }
    const files = readdirSync(path.join(dir, "steps"));
    expect(files).toEqual(["ingest.c3.json"]);
  });

  it("別の step は消さない・再開はそのまま効く", async () => {
    const dir = tmp();
    const key = Buffer.alloc(32, 7);
    const schema = z.object({ v: z.string() });
    await checkpoint(dir, "glossary", schema, async () => ({ v: "g" }), { invalidation: "h", key });
    await checkpoint(dir, "seg-0000", schema, async () => ({ v: "s" }), { invalidation: "h", key });
    let calls = 0;
    const again = await checkpoint(
      dir,
      "glossary",
      schema,
      async () => {
        calls++;
        return { v: "再計算" };
      },
      { invalidation: "h", key },
    );
    expect(again.v).toBe("g");
    expect(calls).toBe(0);
    expect(readdirSync(path.join(dir, "steps")).sort()).toEqual([
      "glossary.h.json",
      "seg-0000.h.json",
    ]);
  });
});

describe("pruneSteps", () => {
  it("今回使わなかった step の checkpoint を消す", () => {
    // dropOldGenerations は同じ stepId の旧世代しか見ないので、節が減る再実行では
    // 消えた seg-NNNN が残り続けた（実測 8 節→1 節で 4.2MB・7 件が前回の訳文）。
    const dir = mkdtempSync(path.join(os.tmpdir(), "jpaper-prune-"));
    const steps = path.join(dir, "steps");
    mkdirSync(steps, { recursive: true });
    for (const name of [
      "ingest.aa11.json",
      "glossary.json",
      "seg-0000.bb22.json",
      "seg-0001.cc33.json",
      "seg-0002.json",
      "notes.txt",
    ]) {
      writeFileSync(path.join(steps, name), "{}");
    }
    const removed = pruneSteps(dir, new Set(["ingest", "glossary", "seg-0000"]));
    expect(removed).toBe(2);
    expect(readdirSync(steps).sort()).toEqual([
      "glossary.json",
      "ingest.aa11.json",
      "notes.txt",
      "seg-0000.bb22.json",
    ]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("steps が無くても落ちない", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "jpaper-prune-"));
    expect(pruneSteps(dir, new Set(["ingest"]))).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });
});
