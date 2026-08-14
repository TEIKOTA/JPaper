// テスト用 LlmClient（実 LLM は *.live.test.ts）。
import type { LlmClient, LlmRequest } from "../types/contract.js";

// 応答関数は Promise を返してよい（遅延・中断のテストが必要とする）。complete が async
// なので実行時は元から動いていたが、型が同期関数だけを認めていた。
export type FakeResponder =
  | string
  | string[]
  | ((req: LlmRequest) => string | Promise<string>);

export class FakeLlmClient implements LlmClient {
  readonly calls: LlmRequest[] = [];
  private readonly queue: string[] | null;
  private readonly fn: ((req: LlmRequest) => string | Promise<string>) | null;
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
