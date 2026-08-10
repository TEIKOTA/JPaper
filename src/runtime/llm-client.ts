// 契約付録 §1・§8。LLM 応答（JSON テキスト）の取り出しと zod 検証。
import type { z } from "zod";
import type { LlmClient, LlmRequest } from "../types/contract.js";
import { withRetry, type RetryOptions } from "./session.js";
import { JpaperError } from "../types/errors.js";

// 応答の最大文字数。プロバイダ側でも同じ上限で受信を打ち切る。正規の応答は
// 最大でもセグメント予算（既定 60,000 token ≒ 24 万文字）程度。
export const MAX_RESPONSE_CHARS = 1_000_000;

// 候補走査の仕事量の上限。閉じない `{` が並ぶ応答は候補ごとに末尾まで再走査するので、
// 文字数の上限だけでは二次が消えない（実測 50 万文字で 25,629ms、リトライで 4 倍）。
const MAX_SCAN_STEPS = 20_000_000;

function tryBalanced(body: string, start: number, budget: { steps: number }): { value: unknown } | undefined {
  const open = body[start]!;
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < body.length; i++) {
    if (--budget.steps < 0) return undefined;
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
  if (text.length > MAX_RESPONSE_CHARS) {
    throw new Error(`LLM 応答が上限 ${MAX_RESPONSE_CHARS} 文字を超えています`);
  }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = (fenced ? fenced[1]! : text).trim();
  try {
    return JSON.parse(body);
  } catch {
    // フェンス内/前後に散文がある場合は最初に parse できる balanced 候補を走査する。
  }
  const budget = { steps: MAX_SCAN_STEPS };
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch !== "{" && ch !== "[") continue;
    const found = tryBalanced(body, i, budget);
    if (found) return found.value;
    if (budget.steps < 0) break;
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
  // runAgent は必ず JSON を parse するので JSON 出力を要求する（能力を持つプロバイダのみ強制に使う）。
  const jsonReq = { ...req, jsonMode: true };
  try {
    return await withRetry(async () => {
      const raw = await client.complete(jsonReq);
      try {
        return schema.parse(extractJson(raw)) as z.infer<S>;
      } catch (e) {
        throw Object.assign(e instanceof Error ? e : new Error(String(e)), {
          transient: true,
          schemaFailure: true,
        });
      }
    }, retry);
  } catch (e) {
    // リトライしても応答が契約に合わないのはプロバイダ起因の失敗。internal（＝想定外）へ
    // 落とすと web で 500 相当になり、生の zod エラーがそのまま外へ出る。
    if ((e as { schemaFailure?: boolean }).schemaFailure === true) {
      const detail = String((e as Error).message ?? e).slice(0, 200);
      throw new JpaperError(2, "provider", `LLM 応答が契約に合いません: ${detail}`);
    }
    throw e;
  }
}
