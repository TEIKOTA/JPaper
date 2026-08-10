// 契約付録 §8。出力先ごとの排他ロック（同一 outDir の同時実行を明示的失敗にする）。
import {
  mkdirSync,
  openSync,
  closeSync,
  writeSync,
  readFileSync,
  rmSync,
  renameSync,
  linkSync,
} from "node:fs";
import path from "node:path";
import { JpaperError, isInfraError } from "../types/errors.js";

function infraError(e: unknown, runDir: string): JpaperError {
  const code = (e as NodeJS.ErrnoException).code ?? "";
  return new JpaperError(
    1,
    "infra",
    `出力先を用意できません（${code}）。権限と空き容量を確認してください: ${runDir}`,
  );
}

// 保持者は生きている限り beatAt を更新する。更新が途切れたロックだけを失効とみなす。
// pid の生存確認だけに頼ると pid 再利用で誤って「進行中」になるため、鮮度で上限を掛ける。
export const HEARTBEAT_MS = 30_000;
export const LOCK_STALE_MS = 120_000;
// 奪取の相互排他に使う補助ロック。奪取自体は一瞬なので短い。
const STEAL_STALE_MS = 30_000;
const MAX_ATTEMPTS = 5;

export interface LockInfo {
  pid: number;
  startedAt: number;
  beatAt: number;
}

export interface RunLock {
  release: () => void;
}

function readLock(file: string): LockInfo | null {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<LockInfo>;
    if (typeof raw.pid !== "number" || typeof raw.startedAt !== "number") return null;
    return { pid: raw.pid, startedAt: raw.startedAt, beatAt: raw.beatAt ?? raw.startedAt };
  } catch {
    return null;
  }
}

// EPERM は「存在するが権限が無い」＝生存の証拠。死亡と断定してよいのは ESRCH のときだけ。
export function pidAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function holderAlive(info: LockInfo, now: number, staleMs: number): boolean {
  if (now - info.beatAt > staleMs) return false;
  return pidAlive(info.pid);
}

function isEexist(e: unknown): boolean {
  return (e as NodeJS.ErrnoException).code === "EEXIST";
}

// 中身を書き終えた一時ファイルを link で公開する。link は原子的かつ既存があれば EEXIST なので、
// 「排他」と「常に完全な内容が読める」を同時に満たす。open("wx") だと作成と書き込みの間に
// 空ファイルを読まれ、失効と誤判定されて奪われうる（実測で torn read を観測）。
function createExclusive(file: string, now: () => number): boolean {
  const t = now();
  const tmp = `${file}.${process.pid}.${t}.tmp`;
  writeAll(tmp, JSON.stringify({ pid: process.pid, startedAt: t, beatAt: t }));
  try {
    linkSync(tmp, file);
    return true;
  } catch (e) {
    if (isEexist(e)) return false;
    throw e;
  } finally {
    rmSync(tmp, { force: true });
  }
}

function conflict(runDir: string, info: LockInfo | null): JpaperError {
  const who = info === null ? "不明" : String(info.pid);
  return new JpaperError(
    2,
    "conflict",
    `同じ出力先で別の実行が進行中です（pid ${who}）。出力先を分けてください: ${runDir}`,
  );
}

// 失効ロックの削除を補助ロックで直列化する。直列化しないと、複数プロセスが同時に「失効」と
// 判定して互いの新しいロックを消し合い、全員が保持者を自認する（実証済み）。
// ここでは消すだけで、作成は呼び出し側の O_EXCL に任せる（勝者は原子的に 1 つへ定まる）。
function dropStaleUnderMutex(file: string, stealFile: string, now: () => number): void {
  if (!createExclusive(stealFile, now)) {
    const other = readLock(stealFile);
    // 奪取中に落ちたプロセスの補助ロックは短い鮮度で失効させる。
    if (other === null || !holderAlive(other, now(), STEAL_STALE_MS)) {
      rmSync(stealFile, { force: true });
    }
    return; // 次の試行でやり直す
  }
  try {
    // 補助ロックを取れた＝いま実ロックを消せるのは自分だけ。消してよいか読み直して確認する。
    const current = readLock(file);
    if (current !== null && holderAlive(current, now(), LOCK_STALE_MS)) return;
    rmSync(file, { force: true });
  } finally {
    rmSync(stealFile, { force: true });
  }
}

// 保持している間だけ beatAt を更新する。奪われていたら止める（他人のロックを書き換えない）。
function startHeartbeat(file: string, now: () => number): () => void {
  const timer = setInterval(() => {
    const info = readLock(file);
    if (info === null || info.pid !== process.pid) {
      clearInterval(timer);
      return;
    }
    const tmp = `${file}.${process.pid}.beat`;
    try {
      // 部分書き込みを読ませないため tmp→rename で差し替える。
      writeAll(tmp, JSON.stringify({ ...info, beatAt: now() }));
      renameSync(tmp, file);
    } catch {
      rmSync(tmp, { force: true });
    }
  }, HEARTBEAT_MS);
  timer.unref?.(); // ロックが run の寿命を延ばさない
  return () => clearInterval(timer);
}

function writeAll(file: string, body: string): void {
  const fd = openSync(file, "w");
  try {
    writeSync(fd, body);
  } finally {
    closeSync(fd);
  }
}

export function acquireRunLock(runDir: string, now: () => number = Date.now): RunLock {
  // 生の fs エラーを外へ出さない（契約付録 §8）。権限・容量・パス衝突は infra として分類する。
  try {
    mkdirSync(runDir, { recursive: true });
  } catch (e) {
    if (isInfraError(e)) throw infraError(e, runDir);
    throw e;
  }
  const file = path.join(runDir, "run.lock");
  const stealFile = `${file}.steal`;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (createExclusive(file, now)) {
      // 取得は原子的だが、念のため自分の pid が入っていることを確認してから保持者を名乗る。
      const mine = readLock(file);
      if (mine?.pid !== process.pid) continue;
      const stop = startHeartbeat(file, now);
      return {
        release: () => {
          stop();
          // 奪われた後の release で他人のロックを消さない。
          const info = readLock(file);
          if (info === null || info.pid === process.pid) rmSync(file, { force: true });
        },
      };
    }
    const info = readLock(file);
    // 壊れて読めないロックは失効扱い（奪取側で直列化されるので競合しない）。
    if (info !== null && holderAlive(info, now(), LOCK_STALE_MS)) throw conflict(runDir, info);
    dropStaleUnderMutex(file, stealFile, now);
  }
  throw conflict(runDir, readLock(file));
}
