import { describe, it, expect } from "vitest";
import { href, parseRoute } from "./router.js";

describe("画面の切り替え（契約付録 §9）", () => {
  it("探す・翻訳・設定のハッシュを読み書きする", () => {
    expect(parseRoute(href.search())).toEqual({ page: "search" });
    expect(parseRoute(href.search("rashomon set"))).toEqual({ page: "search", q: "rashomon set" });
    expect(parseRoute(href.translate())).toEqual({ page: "translate" });
    expect(parseRoute(href.translate("hep-th/9901001", "A & B"))).toEqual({
      page: "translate",
      id: "hep-th/9901001",
      title: "A & B",
    });
    expect(parseRoute(href.settings())).toEqual({ page: "settings" });
    expect(parseRoute(href.papers())).toEqual({ page: "papers" });
  });
});
