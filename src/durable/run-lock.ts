// 契約付録 §8。出力先ごとの排他ロック（同一 outDir の同時実行を明示的失敗にする）。
import { mkdirSync, openSync, closeSync, writeSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { JpaperError } from "../types/errors.js";

// クラッシュしたランのロックで永久に塞がないための有効期限。
export const LOCK_TTL_MS = 30 * 60 * 1000;

export interface LockInfo {
  pid: number;
  startedAt: number;
}

export interface RunLock {
  release: () => void;
}

function readLock(file: string): LockInfo | null {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<LockInfo>;
    if (typeof raw.pid !== "number" || typeof raw.startedAt !== "number") return null;
    return { pid: raw.pid, startedAt: raw.startedAt };
  } catch {
    return null;
  }
}

// 同一プロセスの生存確認。別ホスト・別コンテナの pid は判定できないので TTL に委ねる。
function holderAlive(info: LockInfo, now: number): boolean {
  if (now - info.startedAt > LOCK_TTL_MS) return false;
  if (info.pid === process.pid) return true;
  try {
    process.kill(info.pid, 0); // シグナル 0＝存在確認のみ
    return true;
  } catch {
    return false;
  }
}

// O_EXCL で作れたら取得。既存ロックが生きていれば失敗、死んでいれば奪う。
export function acquireRunLock(
  runDir: string,
  now: () => number = Date.now,
): RunLock {
  mkdirSync(runDir, { recursive: true });
  const file = path.join(runDir, "run.lock");
  const write = (): void => {
    const fd = openSync(file, "wx");
    try {
      writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: now() }));
    } finally {
      closeSync(fd);
    }
  };
  try {
    write();
  } catch {
    const info = readLock(file);
    if (info !== null && holderAlive(info, now())) {
      throw new JpaperError(
        2,
        "input",
        `同じ出力先で別の実行が進行中です（pid ${info.pid}）。出力先を分けてください: ${runDir}`,
      );
    }
    // 失効ロックは奪う。壊れて読めないロックも同じ扱い。
    rmSync(file, { force: true });
    write();
  }
  return {
    release: () => {
      // 奪われた後に自分の release で他人のロックを消さない。
      const info = readLock(file);
      if (info === null || info.pid === process.pid) rmSync(file, { force: true });
    },
  };
}
