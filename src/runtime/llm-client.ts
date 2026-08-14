// 契約付録 §1・§8。LLM 応答（JSON テキスト）の取り出しと zod 検証。
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
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

const VALID_ESCAPES = '"\\/bfnrtu';

// LaTeX を JSON 文字列で運ぶと、モデルは `\\citep` の二重化にしばしば失敗する
// （実測: 同じ応答の中で `\\subsubsection` は二重化され `\citep` だけ 1 本だった）。
// `\c` は不正なエスケープなので JSON.parse が落ちる。**モデルが書こうとした 1 本の
// backslash をそのまま復元する**だけで、中身は推測しない。契約付録 §8
export function repairJsonEscapes(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (!inString) {
      out += ch;
      if (ch === '"') inString = true;
      continue;
    }
    if (ch === '"') {
      out += ch;
      inString = false;
      continue;
    }
    if (ch === "\\") {
      const next = text[i + 1];
      if (next === undefined) {
        out += "\\\\";
        continue;
      }
      const isHex = (c: string | undefined): boolean => c !== undefined && /[0-9a-fA-F]/.test(c);
      const validU =
        next === "u" && [1, 2, 3, 4].every((k) => isHex(text[i + 1 + k]));
      if (VALID_ESCAPES.includes(next) && (next !== "u" || validU)) {
        out += ch + next;
        i++;
        continue;
      }
      // 不正なエスケープ＝literal な backslash。次の文字は消費せず、同じループで
      // もう一度見る（`\` の直後が生の改行なら、その改行も綴りへ直す必要がある）。
      out += "\\\\";
      continue;
    }
    // 文字列中の生の制御文字は JSON では不正。改行・タブは正しい綴りへ直す。
    const code = ch.charCodeAt(0);
    if (code < 0x20) {
      out +=
        ch === "\n" ? "\\n" : ch === "\r" ? "\\r" : ch === "\t" ? "\\t" : `\\u${code.toString(16).padStart(4, "0")}`;
      continue;
    }
    out += ch;
  }
  return out;
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
  // 修復した全体 parse は、断片の走査より**先**に試す。順序を逆にすると、不正な
  // エスケープを含む外側が parse できないまま、backslash を含まない内側の断片
  // （`{"severity":…}` など）が先に見つかって返ってしまう。実測: evaluator の応答が
  // verdict も issues も持たないオブジェクトとして解釈され、zod で落ちて再試行になった。
  const repaired = repairJsonEscapes(body);
  if (repaired !== body) {
    try {
      return JSON.parse(repaired);
    } catch {
      // 修復しても全体が parse できないときだけ走査へ落とす。
    }
  }
  for (const text of repaired === body ? [body] : [body, repaired]) {
    const budget = { steps: MAX_SCAN_STEPS };
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]!;
      if (ch !== "{" && ch !== "[") continue;
      const found = tryBalanced(text, i, budget);
      if (found) return found.value;
      if (budget.steps < 0) break;
    }
  }
  throw new Error("JSON が見つかりません");
}

// 契約に合わなかった生応答を、JPAPER_DUMP_RAW が指すディレクトリへ残す（既定は残さない）。
// 応答は checkpoint にも成果物にも永続しないので、これが無いと parse 失敗の原因が追えない。
// 論文由来の文字列を含むため、既定では書かない。書き込み失敗は握り潰す（run は続ける）。
function dumpRaw(req: LlmRequest, raw: string): void {
  const dir = process.env.JPAPER_DUMP_RAW;
  if (dir === undefined || dir === "") return;
  try {
    mkdirSync(dir, { recursive: true });
    const name = [req.meta?.role ?? "agent", req.meta?.segmentId ?? "-", String(req.meta?.pass ?? 0)]
      .join("-")
      .replace(/[^A-Za-z0-9._-]/g, "_");
    writeFileSync(path.join(dir, `${name}-${String(dumpSeq++)}.txt`), raw);
  } catch {
    // 観測チャネルの故障は run を壊さない。
  }
}
let dumpSeq = 0;

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
        dumpRaw(req, raw);
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
