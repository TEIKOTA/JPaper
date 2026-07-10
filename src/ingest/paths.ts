// ソースルート封じ込め（untrusted なソースが dir 外を参照するのを防ぐ）。
import path from "node:path";
import { realpathSync } from "node:fs";

export function isInsideDir(dir: string, target: string): boolean {
  const rel = path.relative(path.resolve(dir), path.resolve(target));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// symlink 脱出も塞ぐため realpath 解決して判定（不能時は字句判定へフォールバック）。
export function isInsideDirReal(dir: string, target: string): boolean {
  try {
    return isInsideDir(realpathSync(dir), realpathSync(target));
  } catch {
    return isInsideDir(dir, target);
  }
}
