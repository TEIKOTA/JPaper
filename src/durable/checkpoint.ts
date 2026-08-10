// 設計メモ §11。ファイル checkpoint（tmp→rename・idempotent-skip・無効化ハッシュ）。
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { z } from "zod";
import { loadCacheKey } from "./cache-key.js";

export function hashContext(...parts: string[]): string {
  const h = createHash("sha256");
  for (const p of parts) h.update(p).update("\0");
  return h.digest("hex").slice(0, 16);
}

export interface CheckpointOptions<T = unknown> {
  invalidation?: string;
  cacheable?: (result: T) => boolean;
  // 署名鍵（テスト用に注入可能）。既定は JPAPER_HOME 配下の鍵。
  key?: Buffer;
}

// 保存形式。value だけでなく step/invalidation も署名対象にして差し替えを防ぐ。
interface Envelope {
  v: 1;
  sig: string;
  value: unknown;
}

function sign(key: Buffer, stepId: string, invalidation: string, value: unknown): string {
  return createHmac("sha256", key)
    .update(stepId)
    .update("\0")
    .update(invalidation)
    .update("\0")
    .update(JSON.stringify(value) ?? "")
    .digest("hex");
}

function signatureMatches(expected: string, actual: unknown): boolean {
  if (typeof actual !== "string" || actual.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
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

  const key = opts.key ?? loadCacheKey();
  const invalidation = opts.invalidation ?? "";

  if (existsSync(file)) {
    try {
      const env = JSON.parse(readFileSync(file, "utf8")) as Envelope;
      // 署名が合わないキャッシュ（改竄・旧形式・別鍵）は採用しない。
      if (signatureMatches(sign(key, stepId, invalidation, env?.value), env?.sig)) {
        return schema.parse(env.value);
      }
    } catch {
      // 破損/スキーマ不整合のキャッシュは無視して再計算する。
    }
  }

  const result = await fn();
  if (opts.cacheable === undefined || opts.cacheable(result)) {
    mkdirSync(dir, { recursive: true });
    const env: Envelope = { v: 1, sig: sign(key, stepId, invalidation, result), value: result };
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(env));
    renameSync(tmp, file);
    dropOldGenerations(dir, stepId, path.basename(file));
  }
  return result;
}

// 同じ step の旧世代（無効化ハッシュ違い）を消す。残すと、論文を直して再投入するたびに
// 原文全文・訳文が世代ぶん積み上がり、ディスクが線形に増え続ける（実測 8 世代で 5 倍）。
function dropOldGenerations(dir: string, stepId: string, keep: string): void {
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    try {
      if (name === keep) continue;
      // "<stepId>.<hash>.json" と、無効化なしの "<stepId>.json" だけを対象にする。
      if (!name.startsWith(`${stepId}.`) || !name.endsWith(".json")) continue;
      const middle = name.slice(stepId.length + 1, -".json".length);
      if (middle !== "" && !/^[0-9a-f]+$/.test(middle)) continue;
      rmSync(path.join(dir, name), { force: true });
    } catch {
      // GC は最善努力。1 エントリの失敗で残りを諦めない（諦めると線形増加が復活する）。
    }
  }
}
