// 設計メモ §11。ファイル checkpoint（tmp→rename・idempotent-skip・無効化ハッシュ）。
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
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
    writeStep(runDir, stepId, result, { invalidation: opts.invalidation, key });
  }
  return result;
}

export interface StoredStep {
  file: string;
  // ファイル名の無効化キー（無効化なしの step は ""）。
  invalidation: string;
  value: unknown;
}

// 契約付録 §9。stepId の checkpoint のうち、ファイル名の無効化キーで署名が合うものを返す。
// 複数あれば更新の新しいもの。無ければ undefined。
export function readStep(runDir: string, stepId: string, key?: Buffer): StoredStep | undefined {
  const dir = path.join(runDir, "steps");
  const k = key ?? loadCacheKey();
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return undefined;
  }
  let found: (StoredStep & { mtime: number }) | undefined;
  for (const name of names) {
    const invalidation = stepInvalidationOf(name, stepId);
    if (invalidation === undefined) continue;
    const file = path.join(dir, name);
    try {
      const env = JSON.parse(readFileSync(file, "utf8")) as Envelope;
      if (!signatureMatches(sign(k, stepId, invalidation, env?.value), env?.sig)) continue;
      const mtime = statSync(file).mtimeMs;
      if (found === undefined || mtime > found.mtime) found = { file, invalidation, value: env.value, mtime };
    } catch {
      // 破損した checkpoint は無いものとして扱う。
    }
  }
  if (found === undefined) return undefined;
  return { file: found.file, invalidation: found.invalidation, value: found.value };
}

// 契約付録 §9。value を invalidation で署名して書き、同じ step の旧世代を消す。書いたパスを返す。
export function writeStep(
  runDir: string,
  stepId: string,
  value: unknown,
  opts: { invalidation?: string; key?: Buffer } = {},
): string {
  const dir = path.join(runDir, "steps");
  const suffix = opts.invalidation ? `.${opts.invalidation}` : "";
  const file = path.join(dir, `${stepId}${suffix}.json`);
  const key = opts.key ?? loadCacheKey();
  mkdirSync(dir, { recursive: true });
  const env: Envelope = { v: 1, sig: sign(key, stepId, opts.invalidation ?? "", value), value };
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(env));
  renameSync(tmp, file);
  dropOldGenerations(dir, stepId, path.basename(file));
  return file;
}

// "<stepId>.<hash>.json" なら hash、"<stepId>.json" なら ""、それ以外は undefined。
function stepInvalidationOf(name: string, stepId: string): string | undefined {
  if (name === `${stepId}.json`) return "";
  if (!name.startsWith(`${stepId}.`) || !name.endsWith(".json")) return undefined;
  const middle = name.slice(stepId.length + 1, -".json".length);
  return /^[0-9a-f]+$/.test(middle) ? middle : undefined;
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

// run が正常に完了した時点で、今回使わなかった step の checkpoint を消す。
// dropOldGenerations は同じ stepId の旧世代しか見ないので、節が減る再実行では
// 消えた seg-NNNN が残り続ける（実測 8 節→1 節で 4.2MB・7 件が前回の訳文のまま）。
// paperId が衝突すると、これがそのまま別論文の内容の残留経路になる。
export function pruneSteps(runDir: string, keep: ReadonlySet<string>): number {
  const dir = path.join(runDir, "steps");
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    try {
      if (!name.endsWith(".json")) continue;
      const stem = name.slice(0, -".json".length);
      // "<stepId>.<hash>" と無効化なしの "<stepId>"。
      const dot = stem.lastIndexOf(".");
      const stepId =
        dot > 0 && /^[0-9a-f]+$/.test(stem.slice(dot + 1)) ? stem.slice(0, dot) : stem;
      if (keep.has(stepId)) continue;
      rmSync(path.join(dir, name), { force: true });
      removed++;
    } catch {
      // GC は最善努力。1 エントリの失敗で残りを諦めない。
    }
  }
  return removed;
}
