// 契約付録 §1・§8。LLM 応答（JSON テキスト）の取り出しと zod 検証。
import type { z } from "zod";
import type { LlmClient, LlmRequest } from "../types/contract.js";

export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = (fenced ? fenced[1]! : text).trim();
  try {
    return JSON.parse(body);
  } catch {
    // フェンス内/前後に散文がある場合は最初の balanced な JSON を走査する。
  }
  const start = body.search(/[{[]/);
  if (start === -1) throw new Error("JSON が見つかりません");
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
      if (depth === 0) return JSON.parse(body.slice(start, i + 1));
    }
  }
  throw new Error("JSON の対応が閉じていません");
}

export async function runAgent<S extends z.ZodTypeAny>(
  client: LlmClient,
  req: LlmRequest,
  schema: S,
): Promise<z.infer<S>> {
  const raw = await client.complete(req);
  return schema.parse(extractJson(raw)) as z.infer<S>;
}
