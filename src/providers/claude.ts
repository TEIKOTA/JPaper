// 契約付録 §5・§8。claude プロバイダ（純変換器化した公式 CLI subprocess）。
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { LlmClient } from "../types/contract.js";
import { JpaperError, isTransient } from "../types/errors.js";

const pExecFile = promisify(execFile);

export interface ClaudeDeps {
  run?: (args: string[]) => Promise<string>;
}

async function defaultRun(args: string[]): Promise<string> {
  const { stdout } = await pExecFile("claude", args, {
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

export function makeClaudeClient(deps: ClaudeDeps = {}): LlmClient {
  const run = deps.run ?? defaultRun;
  return {
    async complete(req) {
      // model は渡さない（CLI ログインセッションのモデルを使う）。
      let stdout: string;
      try {
        stdout = await run([
          "-p",
          req.user,
          "--output-format",
          "json",
          "--append-system-prompt",
          req.system,
          "--max-turns",
          "1",
          "--allowedTools",
          "",
        ]);
      } catch (e) {
        if (isTransient(e)) throw e; // 瞬断等は withRetry へ
        throw new JpaperError(
          2,
          "provider",
          `claude 実行に失敗（未インストール/未ログイン/非ゼロ終了）: ${String((e as Error)?.message ?? e)}`,
        );
      }
      let parsed: { result?: unknown };
      try {
        parsed = JSON.parse(stdout) as { result?: unknown };
      } catch {
        throw new JpaperError(1, "provider", "claude 応答が JSON でない");
      }
      if (typeof parsed.result !== "string") {
        throw new JpaperError(1, "provider", "claude 応答に result 文字列が無い");
      }
      return parsed.result;
    },
  };
}
