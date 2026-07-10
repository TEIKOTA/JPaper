import { describe, it, expect } from "vitest";
import { detectInput } from "./detect-input.js";

const noExist = () => false;

describe("detectInput", () => {
  it("新形式 arXiv ID（版付き含む）", () => {
    expect(detectInput("1706.03762", noExist)).toEqual({
      kind: "arxiv",
      id: "1706.03762",
    });
    expect(detectInput("arXiv:1706.03762v5", noExist)).toEqual({
      kind: "arxiv",
      id: "1706.03762v5",
    });
    expect(detectInput("2310.12345", noExist)).toEqual({
      kind: "arxiv",
      id: "2310.12345",
    });
  });

  it("旧形式 arXiv ID", () => {
    expect(detectInput("hep-th/9901001", noExist)).toEqual({
      kind: "arxiv",
      id: "hep-th/9901001",
    });
    expect(detectInput("math.AG/0601001v2", noExist)).toEqual({
      kind: "arxiv",
      id: "math.AG/0601001v2",
    });
    expect(detectInput("cond-mat.stat-mech/0101001", noExist)).toEqual({
      kind: "arxiv",
      id: "cond-mat.stat-mech/0101001",
    });
    expect(detectInput("physics.gen-ph/0101001", noExist)).toEqual({
      kind: "arxiv",
      id: "physics.gen-ph/0101001",
    });
  });

  it("実在パスは path として優先", () => {
    expect(detectInput("paper.tar.gz", () => true)).toEqual({
      kind: "path",
      path: "paper.tar.gz",
    });
    expect(detectInput("1706.03762", () => true)).toEqual({
      kind: "path",
      path: "1706.03762",
    });
  });

  it("判定不能・空は exit 2", () => {
    expect(() => detectInput("???not-an-id", noExist)).toThrow(/判定できません/);
    expect(() => detectInput("   ", noExist)).toThrow();
    try {
      detectInput("nope", noExist);
    } catch (e) {
      expect((e as { code: number }).code).toBe(2);
    }
  });
});
