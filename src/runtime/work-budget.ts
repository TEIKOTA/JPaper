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

export function resolveWorkLimits(given?: Partial<WorkLimits>): WorkLimits {
  return { ...DEFAULT_WORK_LIMITS, ...given };
}

// 呼び出し回数を run 単位で数える。ゲート（同時実行）は総量を抑えないため別に要る。
// リトライも 1 回として数える（課金されるのは試行回数であって成功回数ではない）。
export function withCallBudget(client: LlmClient, max: number): LlmClient {
  let used = 0;
  return {
    complete(req) {
      used++;
      if (used > max) {
        return Promise.reject(
          new JpaperError(
            2,
            "too-large",
            `LLM 呼び出し回数が上限 ${max} を超えました（入力を分割してください）`,
          ),
        );
      }
      return client.complete(req);
    },
  };
}
