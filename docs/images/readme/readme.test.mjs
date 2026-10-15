import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const readme = readFileSync(`${ROOT}README.md`, "utf8");

describe("README（issue #418）", () => {
  it("参照する手元の画像がすべてある", () => {
    const images = [...readme.matchAll(/!\[[^\]]*\]\(([^)\s]+)[^)]*\)|<img[^>]*\ssrc="([^"]+)"/g)]
      .map((m) => (m[1] ?? m[2]).replace(/[#?].*$/, "").replace(/^\.\//, ""))
      .filter((p) => !/^[a-z]+:/i.test(p));
    expect(images.length).toBeGreaterThan(0);
    for (const p of images) expect(existsSync(`${ROOT}${p}`), p).toBe(true);
  });

  it("使い方は Web アプリを CLI より先に、画面のスクリーンショット付きで説明する", () => {
    const usage = readme.slice(readme.indexOf("## 使い方"), readme.indexOf("## コマンド"));
    const web = usage.indexOf("### Web アプリ");
    const cli = usage.indexOf("### CLI");
    expect(web).toBeGreaterThan(0);
    expect(cli).toBeGreaterThan(web);
    for (const shot of ["web-search.png", "web-translate.png", "web-paper.png", "web-term.png"]) {
      expect(usage.slice(web, cli)).toContain(`docs/images/readme/${shot}`);
    }
  });
});
