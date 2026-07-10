import { describe, it, expect } from "vitest";
import { gzipSync } from "node:zlib";
import { extractArchive, parseTar } from "./extract.js";
import { makeTar, makeZip } from "./archive.fixtures.js";

const entries = [
  { name: "main.tex", content: "\\documentclass{article}\\begin{document}x\\end{document}" },
  { name: "sec/intro.tex", content: "序論" },
];

describe("extractArchive", () => {
  it("tar を展開する", () => {
    const files = extractArchive(makeTar(entries));
    expect(files.get("main.tex")?.toString("utf8")).toContain("documentclass");
    expect(files.get("sec/intro.tex")?.toString("utf8")).toBe("序論");
  });

  it("gzip-tar（arXiv 拡張子なし）を展開する", () => {
    const files = extractArchive(gzipSync(makeTar(entries)));
    expect(files.get("sec/intro.tex")?.toString("utf8")).toBe("序論");
  });

  it("zip を展開する", () => {
    const files = extractArchive(makeZip(entries));
    expect(files.get("main.tex")?.toString("utf8")).toContain("documentclass");
    expect(files.get("sec/intro.tex")?.toString("utf8")).toBe("序論");
  });

  it("単体 .tex.gz は main.tex 1件になる", () => {
    const files = extractArchive(gzipSync(Buffer.from("\\documentclass{a}", "utf8")));
    expect([...files.keys()]).toEqual(["main.tex"]);
    expect(files.get("main.tex")?.toString("utf8")).toBe("\\documentclass{a}");
  });

  it("生 .tex バイトは main.tex になる", () => {
    const files = extractArchive(Buffer.from("plain tex", "utf8"));
    expect(files.get("main.tex")?.toString("utf8")).toBe("plain tex");
  });

  it("パストラバーサル（..）を拒否する", () => {
    expect(() => parseTar(makeTar([{ name: "../evil.tex", content: "x" }]))).toThrow(
      /不正なアーカイブパス/,
    );
  });
});
