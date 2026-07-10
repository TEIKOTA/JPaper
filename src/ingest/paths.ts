// ソースルート封じ込め（untrusted なソースが dir 外を参照するのを防ぐ）。
import path from "node:path";

export function isInsideDir(dir: string, target: string): boolean {
  const rel = path.relative(path.resolve(dir), path.resolve(target));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
