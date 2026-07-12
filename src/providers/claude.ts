// 契約付録 §5・§8。claude プロバイダ（純変換器化した公式 CLI subprocess）。
import { spawn } from "node:child_process";
import type { LlmClient } from "../types/contract.js";
import { JpaperError } from "../types/errors.js";

export interface ClaudeDeps {
  run?: (args: string[]) => Promise<string>;
}

async function defaultRun(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(out);
      else {
        const detail = (err || out).slice(0, 800);
        reject(Object.assign(new Error(`claude exited ${code}: ${detail}`), { code }));
      }
    });
    child.stdin.end(); // stdin を即 EOF にして -p 位置引数のプロンプトを使わせる（3秒待機回避）。
  });
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
          "--tools",
          "none",
        ]);
      } catch (e) {
        if ((e as { code?: unknown }).code === "ENOENT") {
          throw new JpaperError(2, "provider", "claude が見つかりません（未インストール/PATH 外）");
        }
        // 非ゼロ終了・タイムアウトは API 側の一時障害が多い → transient にして withRetry へ委ねる。
        const err = new JpaperError(
          2,
          "provider",
          `claude 実行に失敗: ${String((e as Error)?.message ?? e)}`,
        );
        Object.assign(err, { transient: true });
        throw err;
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
