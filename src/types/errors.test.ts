import { describe, it, expect } from "vitest";
import { resolveExitCode, isTransient, JpaperError } from "./errors.js";

describe("resolveExitCode", () => {
  it("失敗が無ければ 0", () => {
    expect(resolveExitCode([])).toBe(0);
    expect(resolveExitCode([0, 0])).toBe(0);
  });

  it("優先順位 2 > 3 > 4 > 5", () => {
    expect(resolveExitCode([4, 3, 5])).toBe(3);
    expect(resolveExitCode([5, 4])).toBe(4);
    expect(resolveExitCode([2, 3, 4, 5])).toBe(2);
    expect(resolveExitCode([5])).toBe(5);
  });

  it("既知失敗が無く 1 があれば 1", () => {
    expect(resolveExitCode([1])).toBe(1);
    expect(resolveExitCode([1, 0])).toBe(1);
  });

  it("既知失敗は 1 より優先", () => {
    expect(resolveExitCode([1, 3])).toBe(3);
  });
});

describe("isTransient", () => {
  it("一時的なネットワーク/レート/5xx は true", () => {
    expect(isTransient({ code: "ECONNREFUSED" })).toBe(true);
    expect(isTransient({ code: "ETIMEDOUT" })).toBe(true);
    expect(isTransient({ status: 429 })).toBe(true);
    expect(isTransient({ statusCode: 503 })).toBe(true);
    expect(isTransient(new Error("socket hang up"))).toBe(true);
    expect(isTransient(new Error("Request timeout after 30s"))).toBe(true);
    expect(isTransient(new Error("429 Too Many Requests"))).toBe(true);
  });

  it("transient マーカーを尊重する", () => {
    expect(isTransient({ transient: true })).toBe(true);
    expect(isTransient({ transient: false })).toBe(false);
  });

  it("cause に隠れた一時コードも辿る（Node fetch 相当）", () => {
    const e = Object.assign(new TypeError("fetch failed"), {
      cause: { code: "ECONNRESET" },
    });
    expect(isTransient(e)).toBe(true);
  });

  it("cause の循環でも停止する", () => {
    const a: { message: string; cause?: unknown } = { message: "boom" };
    a.cause = a;
    expect(isTransient(a)).toBe(false);
  });

  it("タスク失敗・不明は false", () => {
    expect(isTransient(null)).toBe(false);
    expect(isTransient(new Error("build failed: missing figure"))).toBe(false);
    expect(isTransient({ status: 400 })).toBe(false);
    expect(isTransient(new JpaperError(3, "formal", "MAX_REVISIONS 超過"))).toBe(
      false,
    );
  });
});

describe("JpaperError", () => {
  it("code/kind を保持する", () => {
    const e = new JpaperError(2, "provider", "ollama 未起動");
    expect(e.code).toBe(2);
    expect(e.kind).toBe("provider");
    expect(e).toBeInstanceOf(Error);
  });
});
