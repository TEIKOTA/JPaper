import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectMainTex, expandInputs } from "./main-tex.js";

const dirs: string[] = [];
function tmp(files: Record<string, string>): string {
  const d = mkdtempSync(path.join(os.tmpdir(), "jpaper-mt-"));
  dirs.push(d);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(d, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const DOC = "\\documentclass{article}\n\\begin{document}\n本文\n\\end{document}\n";

describe("detectMainTex", () => {
  it("documentclass＋begin{document} を持つファイルを選ぶ", () => {
    const d = tmp({ "main.tex": DOC, "helper.tex": "\\section{x}" });
    expect(detectMainTex(d)).toBe("main.tex");
  });

  it("複数候補は名前（main.tex 等）で解決", () => {
    const d = tmp({ "a.tex": DOC, "main.tex": DOC });
    expect(detectMainTex(d)).toBe("main.tex");
  });

  it("documentclass が無ければ失敗", () => {
    const d = tmp({ "a.tex": "\\section{x}" });
    expect(() => detectMainTex(d)).toThrow(/見つかりません/);
  });

  it("一意に決められない複数フルドキュメントは失敗", () => {
    const d = tmp({ "a.tex": DOC, "b.tex": DOC });
    expect(() => detectMainTex(d)).toThrow(/一意に決定できません/);
  });
});

describe("expandInputs", () => {
  it("\\input/\\include を再帰展開しコメントを除去", () => {
    const d = tmp({
      "main.tex":
        "\\documentclass{a}\n\\begin{document}\n\\input{sec/intro}\n% これはコメント\\input{ignored}\n\\end{document}\n",
      "sec/intro.tex": "序論本文 50\\% 完了\n\\include{sec/body}",
      "sec/body.tex": "本体",
    });
    const out = expandInputs(d, "main.tex");
    expect(out).toContain("序論本文");
    expect(out).toContain("本体");
    expect(out).not.toContain("これはコメント");
    expect(out).toContain("50\\% 完了");
  });

  it("未解決の \\input は除去する", () => {
    const d = tmp({ "main.tex": "A\\input{missing}B" });
    expect(expandInputs(d, "main.tex")).toBe("AB");
  });

  it("同じファイルの複数 \\input を各回展開する", () => {
    const d = tmp({ "main.tex": "\\input{part}-\\input{part}", "part.tex": "P" });
    expect(expandInputs(d, "main.tex")).toBe("P-P");
  });

  it("循環参照でも停止する", () => {
    const d = tmp({ "main.tex": "M\\input{loop}", "loop.tex": "L\\input{main}" });
    expect(expandInputs(d, "main.tex")).toBe("ML");
  });

  it("ソースルート外への \\input は拒否する", () => {
    const container = mkdtempSync(path.join(os.tmpdir(), "jpaper-esc-"));
    dirs.push(container);
    writeFileSync(path.join(container, "secret.tex"), "SECRET");
    const src = path.join(container, "src");
    mkdirSync(src);
    writeFileSync(path.join(src, "main.tex"), "A\\input{../secret}B");
    expect(expandInputs(src, "main.tex")).toBe("AB");
  });
});
