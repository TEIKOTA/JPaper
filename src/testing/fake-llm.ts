// 決定的テスト用の FakeLlmClient（本番 providers/* の代わりに DI する）。
// npm test を LLM 非含有に保つための縫い目。実 LLM は *.live.test.ts で別途。
import type { LlmClient, LlmRequest } from "../types/contract.js";

export type FakeResponder =
  | string // 常に同じ応答
  | string[] // キュー（呼ばれるたび先頭を返す・尽きたら例外）
  | ((req: LlmRequest) => string); // req から計算

export class FakeLlmClient implements LlmClient {
  // 呼び出し履歴（アサーション用）。
  readonly calls: LlmRequest[] = [];
  private readonly queue: string[] | null;
  private readonly fn: ((req: LlmRequest) => string) | null;
  private readonly fixed: string | null;

  constructor(responder: FakeResponder) {
    if (typeof responder === "function") {
      this.fn = responder;
      this.queue = null;
      this.fixed = null;
    } else if (Array.isArray(responder)) {
      this.queue = [...responder];
      this.fn = null;
      this.fixed = null;
    } else {
      this.fixed = responder;
      this.fn = null;
      this.queue = null;
    }
  }

  async complete(req: LlmRequest): Promise<string> {
    this.calls.push(req);
    if (this.fn) return this.fn(req);
    if (this.queue) {
      const next = this.queue.shift();
      if (next === undefined) {
        throw new Error("FakeLlmClient: response queue exhausted");
      }
      return next;
    }
    return this.fixed as string;
  }
}
