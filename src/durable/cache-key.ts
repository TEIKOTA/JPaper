// 契約付録 §2。checkpoint 署名鍵（JPAPER_HOME 配下・所有者のみ読める）。
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveJpaperHome } from "../config.js";

const KEY_FILE = "cache.key";
const KEY_BYTES = 32;

// 鍵は .run/ ではなく JPAPER_HOME に置く。.run/ に書ける主体が署名を作れてはならない。
// 鍵の無い home で複数のプロセスが同時に作っても、link で 1 つだけが置き、全員がその鍵を返す（issue #395）。
// 短すぎる鍵（壊れたファイル）の置き換えと、link を作れないファイルシステムでは rename で置くので、
// 同時に作ったプロセスの鍵が割れることがある（署名が合わない checkpoint は作り直しになる）。
export function loadCacheKey(home: string = resolveJpaperHome()): Buffer {
  const file = path.join(home, KEY_FILE);
  const existing = readKey(file);
  if (existing !== undefined) return existing;
  mkdirSync(home, { recursive: true });
  const tmp = `${file}.${String(process.pid)}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, randomBytes(KEY_BYTES), { mode: 0o600, flag: "wx" });
    chmodSync(tmp, 0o600);
    try {
      linkSync(tmp, file);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "ENOTSUP" || code === "ENOSYS" || code === "EXDEV") {
        renameSync(tmp, file);
        return readKey(file) ?? readFileSync(file);
      }
      // 先に置いたプロセスの鍵を使う。短すぎる鍵（壊れたファイル）だけは置き換える。
      if (code !== "EEXIST") throw e;
      const theirs = readKey(file);
      if (theirs !== undefined) return theirs;
      renameSync(tmp, file);
    }
  } finally {
    rmSync(tmp, { force: true });
  }
  return readKey(file) ?? readFileSync(file);
}

function readKey(file: string): Buffer | undefined {
  if (!existsSync(file)) return undefined;
  const key = readFileSync(file);
  return key.length >= KEY_BYTES ? key : undefined;
}
