import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { acquireRunLock, LOCK_STALE_MS, pidAlive } from "./run-lock.js";
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

  it("heartbeat が途切れたロックは奪う（クラッシュしたランで永久に塞がない）", () => {
    const file = path.join(dir, "run.lock");
    // 生存している pid だが beatAt が古い＝保持者が更新を止めている＝失効。
    const old = Date.now() - LOCK_STALE_MS - 1;
    writeFileSync(
      file,
      JSON.stringify({ pid: process.pid, startedAt: old, beatAt: old }),
    );
    const lock = acquireRunLock(dir);
    const info = JSON.parse(readFileSync(file, "utf8")) as { beatAt: number };
    expect(Date.now() - info.beatAt).toBeLessThan(LOCK_STALE_MS);
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
      JSON.stringify({ pid: dead, startedAt: Date.now(), beatAt: Date.now() }),
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
    writeFileSync(
      file,
      JSON.stringify({ pid: process.pid + 1, startedAt: Date.now(), beatAt: Date.now() }),
    );
    stale.release();
    expect(existsSync(file)).toBe(true);
  });
});

describe("保持者の生存判定", () => {
  it("EPERM（他ユーザ所有の生存プロセス）は生存として扱う", () => {
    // pid 1 は必ず存在し、非 root からは kill(1,0) が EPERM になる。
    // catch 一括で false にすると、コンテナで pid 1 がアプリ本体のとき生きたロックを奪う。
    // Windows に pid 1 は無く、pid 4（System）が必ず存在し、kill(4,0) が EPERM になる。
    expect(pidAlive(process.platform === "win32" ? 4 : 1)).toBe(true);
  });

  it("存在しない pid だけを死亡と判定する", () => {
    let dead = 2 ** 22;
    for (; dead > 1; dead--) {
      try {
        process.kill(dead, 0);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ESRCH") break;
      }
    }
    expect(pidAlive(dead)).toBe(false);
  });
});

describe("失効ロックの奪取", () => {
  it("奪った後は保持者が 1 つに定まる（二重取得できない）", () => {
    const file = path.join(dir, "run.lock");
    const old = Date.now() - LOCK_STALE_MS - 1;
    writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt: old, beatAt: old }));
    const winner = acquireRunLock(dir);
    // 失効ロックを奪った直後に別の取得が来ても、通してはならない。
    expect(() => acquireRunLock(dir)).toThrow(JpaperError);
    winner.release();
  });

  it("中身が空のロック（作成途中の torn read）は失効として扱う", () => {
    writeFileSync(path.join(dir, "run.lock"), "");
    const lock = acquireRunLock(dir);
    lock.release();
    expect(existsSync(path.join(dir, "run.lock"))).toBe(false);
  });

  it("奪取用の補助ロックが残っていても最終的に取得できる", () => {
    const old = Date.now() - LOCK_STALE_MS - 1;
    writeFileSync(
      path.join(dir, "run.lock"),
      JSON.stringify({ pid: process.pid, startedAt: old, beatAt: old }),
    );
    // 落ちたプロセスが残した補助ロック。
    writeFileSync(
      path.join(dir, "run.lock.steal"),
      JSON.stringify({ pid: 999999, startedAt: old, beatAt: old }),
    );
    const lock = acquireRunLock(dir);
    expect(existsSync(path.join(dir, "run.lock.steal"))).toBe(false);
    lock.release();
  });
});

describe("細工されたロックで恒久ブロックできない", () => {
  const write = (beatAt: unknown, startedAt: number): void => {
    writeFileSync(path.join(dir, "run.lock"), JSON.stringify({ pid: 1, startedAt, beatAt }));
  };

  it("beatAt が数値でなければ startedAt にフォールバックし、古ければ失効する", () => {
    const old = Date.now() - 10 * LOCK_STALE_MS;
    for (const bad of [{}, "zzz", null, Number.NaN]) {
      write(bad, old);
      expect(() => acquireRunLock(dir).release()).not.toThrow();
    }
  });

  it("beatAt が未来でも失効扱いにする（クロックずれ・細工）", () => {
    write(Date.now() + 100 * LOCK_STALE_MS, Date.now() - 10 * LOCK_STALE_MS);
    expect(() => acquireRunLock(dir).release()).not.toThrow();
  });

  it("run.lock がディレクトリなら infra（exit 1）で、生の errno を外へ出さない", async () => {
    const { mkdirSync } = await import("node:fs");
    const { toRunError } = await import("../types/errors.js");
    mkdirSync(path.join(dir, "run.lock"), { recursive: true });
    try {
      acquireRunLock(dir).release();
      expect.unreachable("取得できてはいけない");
    } catch (e) {
      const r = toRunError(e);
      expect(r.kind).toBe("infra");
      expect(r.message).not.toContain("rm returned"); // 生のメッセージを素通しにしない
    }
  });
});
