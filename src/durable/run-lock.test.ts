import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { acquireRunLock, LOCK_TTL_MS } from "./run-lock.js";
import { JpaperError } from "../types/errors.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "jpaper-lock-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("acquireRunLock", () => {
  it("同一 runDir の二重取得は明示的な失敗になる", () => {
    const first = acquireRunLock(dir);
    let err: unknown;
    try {
      acquireRunLock(dir);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(JpaperError);
    expect((err as JpaperError).code).toBe(2);
    expect((err as Error).message).toContain("別の実行が進行中");
    first.release();
  });

  it("release 後は取り直せる", () => {
    acquireRunLock(dir).release();
    const again = acquireRunLock(dir);
    expect(existsSync(path.join(dir, "run.lock"))).toBe(true);
    again.release();
    expect(existsSync(path.join(dir, "run.lock"))).toBe(false);
  });

  it("TTL 切れのロックは奪う（クラッシュしたランで永久に塞がない）", () => {
    const file = path.join(dir, "run.lock");
    // 生存している pid だが startedAt が古い＝失効。
    writeFileSync(
      file,
      JSON.stringify({ pid: process.pid, startedAt: Date.now() - LOCK_TTL_MS - 1 }),
    );
    const lock = acquireRunLock(dir);
    const info = JSON.parse(readFileSync(file, "utf8")) as { startedAt: number };
    expect(Date.now() - info.startedAt).toBeLessThan(LOCK_TTL_MS);
    lock.release();
  });

  it("死んだ保持者のロックは TTL 内でも奪う", () => {
    let dead = 2 ** 22; // 存在しない pid を探す
    for (; dead > 1; dead--) {
      try {
        process.kill(dead, 0);
      } catch {
        break;
      }
    }
    writeFileSync(
      path.join(dir, "run.lock"),
      JSON.stringify({ pid: dead, startedAt: Date.now() }),
    );
    const lock = acquireRunLock(dir);
    lock.release();
    expect(existsSync(path.join(dir, "run.lock"))).toBe(false);
  });

  it("壊れたロックファイルは奪う", () => {
    writeFileSync(path.join(dir, "run.lock"), "not json");
    const lock = acquireRunLock(dir);
    lock.release();
    expect(existsSync(path.join(dir, "run.lock"))).toBe(false);
  });

  it("奪われた後の release は他人のロックを消さない", () => {
    const file = path.join(dir, "run.lock");
    const stale = acquireRunLock(dir);
    // 別プロセスが奪った状態を作る。
    writeFileSync(file, JSON.stringify({ pid: process.pid + 1, startedAt: Date.now() }));
    stale.release();
    expect(existsSync(file)).toBe(true);
  });
});
