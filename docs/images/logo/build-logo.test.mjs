import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { svg, SVG_PATH } from "./build-logo.mjs";

describe("ロゴ（issue #414）", () => {
  it("commit した logo.svg は生成スクリプトの出力と一致する", () => {
    expect(readFileSync(SVG_PATH, "utf8")).toBe(svg);
  });

  it("README の冒頭でロゴを表示する", () => {
    const readme = readFileSync(new URL("../../../README.md", import.meta.url), "utf8");
    expect(readme.split("\n").slice(0, 5).join("\n")).toContain('src="docs/images/logo/logo.svg"');
  });
});
