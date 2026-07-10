// テスト用の LlmClient 実装。npm test を LLM 非含有に保つ DI 縫い目（実 LLM は *.live.test.ts）。
import type { LlmClient, LlmRequest } from "../types/contract.js";

export type FakeResponder =
  | string
  | string[]
  | ((req: LlmRequest) => string);

export class FakeLlmClient implements LlmClient {
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
