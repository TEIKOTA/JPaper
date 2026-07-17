// 契約付録 §1・§8。LLM 応答（JSON テキスト）の取り出しと zod 検証。
import type { z } from "zod";
import type { LlmClient, LlmRequest } from "../types/contract.js";
import { withRetry, type RetryOptions } from "./session.js";

function tryBalanced(body: string, start: number): { value: unknown } | undefined {
  const open = body[start]!;
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') {
      inStr = true;
    } else if (ch === open) {
      depth++;
    } else if (ch === close) {
      depth--;
      if (depth === 0) {
        try {
          return { value: JSON.parse(body.slice(start, i + 1)) };
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = (fenced ? fenced[1]! : text).trim();
  try {
    return JSON.parse(body);
  } catch {
    // フェンス内/前後に散文がある場合は最初に parse できる balanced 候補を走査する。
  }
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch !== "{" && ch !== "[") continue;
    const found = tryBalanced(body, i);
    if (found) return found.value;
  }
  throw new Error("JSON が見つかりません");
}

export async function runAgent<S extends z.ZodTypeAny>(
  client: LlmClient,
  req: LlmRequest,
  schema: S,
  retry: RetryOptions = {},
): Promise<z.infer<S>> {
  // complete と応答の parse/zod 検証を一体で retry する。
  // モデルが 1 回でも非 JSON/欠けたスキーマを返しても run 全体を落とさない（parse/検証失敗も transient 扱い）。
  // client.complete 自体のエラー分類（provider の transient 判定）は従来どおり保つ（try の外）。
  return withRetry(async () => {
    const raw = await client.complete(req);
    try {
      return schema.parse(extractJson(raw)) as z.infer<S>;
    } catch (e) {
      throw Object.assign(e instanceof Error ? e : new Error(String(e)), { transient: true });
    }
  }, retry);
}
