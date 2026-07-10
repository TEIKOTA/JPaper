// 設計メモ §11。ファイル checkpoint（tmp→rename・idempotent-skip・無効化ハッシュ）。
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { z } from "zod";

export function hashContext(...parts: string[]): string {
  const h = createHash("sha256");
  for (const p of parts) h.update(p).update("\0");
  return h.digest("hex").slice(0, 16);
}

export interface CheckpointOptions<T = unknown> {
  invalidation?: string;
  cacheable?: (result: T) => boolean;
}

export async function checkpoint<S extends z.ZodTypeAny>(
  runDir: string,
  stepId: string,
  schema: S,
  fn: () => Promise<z.infer<S>>,
  opts: CheckpointOptions<z.infer<S>> = {},
): Promise<z.infer<S>> {
  const dir = path.join(runDir, "steps");
  const suffix = opts.invalidation ? `.${opts.invalidation}` : "";
  const file = path.join(dir, `${stepId}${suffix}.json`);

  if (existsSync(file)) {
    try {
      return schema.parse(JSON.parse(readFileSync(file, "utf8")));
    } catch {
      // 破損/スキーマ不整合のキャッシュは無視して再計算する。
    }
  }

  const result = await fn();
  if (opts.cacheable === undefined || opts.cacheable(result)) {
    mkdirSync(dir, { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(result));
    renameSync(tmp, file);
  }
  return result;
}
