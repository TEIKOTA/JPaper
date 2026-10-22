import { defineConfig } from "vitest/config";

// issue #484。テストの状態の隔離（setup の中身は src/testing/isolate-env.ts）。
export default defineConfig({
  test: {
    globalSetup: ["./src/testing/real-home-guard.ts"],
    setupFiles: ["./src/testing/isolate-env.ts"],
  },
});
