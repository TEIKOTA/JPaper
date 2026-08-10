// 契約付録 §8。1 run が費やせる仕事量の上限（バイト数上限とは別軸）。
// IngestLimits はサイズしか見ないため、「小さいが呼び出し回数が爆発する入力」を止められない。
import type { LlmClient } from "../types/contract.js";
import { JpaperError } from "../types/errors.js";

export interface WorkLimits {
  // 翻訳対象セグメント数。LLM を 1 回も呼ぶ前に判定する。
  maxSegments: number;
  // 1 run の総 LLM 呼び出し回数（リトライ・再訳・評価を含む実課金回数）。
  maxLlmCalls: number;
}

// 実論文（arXiv 2203.06060、本文 109KiB）で 35 セグメント / 96 呼び出し。
// 通常の論文が通り、回数が桁で外れた入力だけが落ちる位置に置く。
export const DEFAULT_WORK_LIMITS: WorkLimits = {
  maxSegments: 150,
  maxLlmCalls: 600,
};

// 上限の上限。プラン設定のミスで事実上の無制限にさせない（concurrency.ts と同じ思想）。
export const WORK_LIMIT_CAPS: WorkLimits = { maxSegments: 2_000, maxLlmCalls: 20_000 };

// 不正値は黙って緩めない。spread でマージすると、明示的な undefined が既定値を消して
// 上限が丸ごと無効化される（web が plan.maxSegments を素通しする普通の書き方で起きる）。
function positiveInt(v: unknown, fallback: number, cap: number): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 1) return fallback;
  return Math.min(cap, Math.floor(v));
}

export function resolveWorkLimits(given?: Partial<WorkLimits>): WorkLimits {
  return {
    maxSegments: positiveInt(
      given?.maxSegments,
      DEFAULT_WORK_LIMITS.maxSegments,
      WORK_LIMIT_CAPS.maxSegments,
    ),
    maxLlmCalls: positiveInt(
      given?.maxLlmCalls,
      DEFAULT_WORK_LIMITS.maxLlmCalls,
      WORK_LIMIT_CAPS.maxLlmCalls,
    ),
  };
}

// 呼び出し回数を run 単位で数える。ゲート（同時実行）は総量を抑えないため別に要る。
// リトライも 1 回として数える（課金されるのは試行回数であって成功回数ではない）。
export function withCallBudget(client: LlmClient, max: number): LlmClient {
  // 呼び出し側が壊れた値を渡しても数え続ける（NaN との比較は常に false で無制限になる）。
  const limit = positiveInt(max, DEFAULT_WORK_LIMITS.maxLlmCalls, WORK_LIMIT_CAPS.maxLlmCalls);
  let used = 0;
  return {
    complete(req) {
      used++;
      if (used > limit) {
        return Promise.reject(
          new JpaperError(
            2,
            "too-large",
            `LLM 呼び出し回数が上限 ${limit} を超えました（入力を分割してください）`,
          ),
        );
      }
      return client.complete(req);
    },
  };
}
