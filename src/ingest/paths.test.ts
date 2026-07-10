import { describe, it, expect } from "vitest";
import path from "node:path";
import { isInsideDir } from "./paths.js";

describe("isInsideDir", () => {
  const root = "/tmp/src";
  it("内側・同一は true", () => {
    expect(isInsideDir(root, "/tmp/src/a/b.tex")).toBe(true);
    expect(isInsideDir(root, "/tmp/src")).toBe(true);
    expect(isInsideDir(root, path.join(root, "x/../y.tex"))).toBe(true);
  });
  it("外側・絶対脱出は false", () => {
    expect(isInsideDir(root, "/tmp/secret.tex")).toBe(false);
    expect(isInsideDir(root, "/tmp/src/../secret.tex")).toBe(false);
    expect(isInsideDir(root, "/etc/passwd")).toBe(false);
  });
});
