// 契約付録 §2。checkpoint 署名鍵（JPAPER_HOME 配下・所有者のみ読める）。
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveJpaperHome } from "../config.js";

const KEY_FILE = "cache.key";
const KEY_BYTES = 32;

// 鍵は .run/ ではなく JPAPER_HOME に置く。.run/ に書ける主体が署名を作れてはならない。
export function loadCacheKey(home: string = resolveJpaperHome()): Buffer {
  const file = path.join(home, KEY_FILE);
  if (existsSync(file)) {
    const key = readFileSync(file);
    if (key.length >= KEY_BYTES) return key;
  }
  mkdirSync(home, { recursive: true });
  const key = randomBytes(KEY_BYTES);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, key, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
  return key;
}
