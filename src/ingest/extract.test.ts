import { describe, it, expect } from "vitest";
import { gzipSync } from "node:zlib";
import { extractArchive, parseTar, writeFileMap } from "./extract.js";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  makeTar,
  makeZip,
  makeTarGnuLong,
  makeTarPax,
  makeTarV7,
} from "./archive.fixtures.js";

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

  it("GNU long-name / PAX の長いパスを復元する", () => {
    const longName = `deep/${"x".repeat(120)}/main.tex`;
    expect(extractArchive(makeTarGnuLong(longName, "L")).get(longName)?.toString()).toBe(
      "L",
    );
    expect(extractArchive(makeTarPax(longName, "P")).get(longName)?.toString()).toBe("P");
  });

  it("V7 tar（ustar マジック無し）もチェックサムで展開する", () => {
    const files = extractArchive(makeTarV7([{ name: "main.tex", content: "V7" }]));
    expect(files.get("main.tex")?.toString("utf8")).toBe("V7");
  });

  it("途中で切れた tar は exit 2", () => {
    const full = makeTar([{ name: "main.tex", content: "x".repeat(600) }]);
    const truncated = full.subarray(0, 512 + 200);
    try {
      extractArchive(truncated);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as { code: number }).code).toBe(2);
    }
  });

  it("終端ゼロブロックの無い（切れた）tar は exit 2", () => {
    const full = makeTar([{ name: "main.tex", content: "abc" }]);
    const noTrailer = full.subarray(0, 1024);
    try {
      extractArchive(noTrailer);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as { code: number }).code).toBe(2);
    }
  });

  it("壊れた gzip は exit 2 に変換する", () => {
    const corrupt = Buffer.concat([Buffer.from([0x1f, 0x8b]), Buffer.from("garbage")]);
    expect(() => extractArchive(corrupt)).toThrow(/アーカイブ展開に失敗/);
    try {
      extractArchive(corrupt);
    } catch (e) {
      expect((e as { code: number }).code).toBe(2);
    }
  });

  it("アーカイブコメント内の偽 EOCD 署名を無視する", () => {
    const comment = Buffer.alloc(40);
    comment.writeUInt32LE(0x06054b50, 0);
    comment.writeUInt16LE(0xffff, 20);
    const files = extractArchive(makeZip(entries, comment));
    expect(files.get("main.tex")?.toString("utf8")).toContain("documentclass");
  });

  it("圧縮サイズがバッファ長を超える zip は exit 2", () => {
    const zip = Buffer.from(makeZip([{ name: "main.tex", content: "\\documentclass{a}" }]));
    const eocd = zip.length - 22; // makeZip はコメント無し
    const cd = zip.readUInt32LE(eocd + 16);
    zip.writeUInt32LE(0xffffff, cd + 20); // compSize を誇張
    try {
      extractArchive(zip);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as { code: number }).code).toBe(2);
    }
  });

  it("パストラバーサル（..）を拒否する", () => {
    expect(() => parseTar(makeTar([{ name: "../evil.tex", content: "x" }]))).toThrow(
      /不正なアーカイブパス/,
    );
  });
});

describe("エントリ名が不正で書けない場合の分類", () => {
  it('"." エントリは input で落ちる（infra ではない）', () => {
    // INFRA_SYSCODES に素通しすると exit 1（サーバ側の障害）として報告され、
    // 入力起因なのに誤ったアラートと自動リトライを誘発する。
    const d = mkdtempSync(path.join(os.tmpdir(), "jpaper-wfm-"));
    try {
      const files = new Map([[".", Buffer.from("x")]]);
      expect(() => writeFileMap(files, d)).toThrowError(/エントリ名が不正/);
      try {
        writeFileMap(files, d);
      } catch (e) {
        expect((e as { kind?: string }).kind).toBe("input");
      }
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("ファイル a とファイル a/b の衝突も input", () => {
    const d = mkdtempSync(path.join(os.tmpdir(), "jpaper-wfm-"));
    try {
      const files = new Map([
        ["a", Buffer.from("x")],
        ["a/b", Buffer.from("y")],
      ]);
      expect(() => writeFileMap(files, d)).toThrowError(/エントリ名が不正/);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
