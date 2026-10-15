import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { controlWordHits, makeRedactor, parseRedactTerms, redactText, redactTree } from "./redact.js";
import { ingest } from "./index.js";
import { JpaperError } from "../types/errors.js";

const KEY = Buffer.alloc(32, 7);
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("伏せ字の語の読み取り", () => {
  it("1 行 1 語。空行と # の行は読まず、前後の空白を落として重複を除く", () => {
    expect(parseRedactTerms("# names\n Taro Yamada \n\nYamada\nYamada\r\n")).toEqual(["Taro Yamada", "Yamada"]);
  });

  it("短すぎる語は入力エラーで、誤りの文には行番号だけを載せる", () => {
    const err = (() => {
      try {
        parseRedactTerms("Yamada\nX\n");
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(err).toBeInstanceOf(JpaperError);
    expect((err as JpaperError).message).toContain("2 行目");
    expect((err as JpaperError).message).not.toContain("Yamada");
  });
});

describe("置き換え", () => {
  const r = makeRedactor(["Yamada", "Taro Yamada", "山田太郎"], KEY)!;

  it("長い語から当て、語の中の空白は改行を含む空白の並びに当てる", () => {
    expect(redactText("by Taro\n  Yamada and Yamada's 山田太郎です", r)).toEqual({ text: "by *** and ***'s ***です", replaced: 3 });
  });

  it("大文字と小文字は区別し、語の中の一致も置き換える", () => {
    expect(redactText("YAMADA yamada Yamadas", r).text).toBe("YAMADA yamada ***s");
  });

  it("語の一覧の鍵付きの値は、順序によらず同じで、鍵が違えば変わる", () => {
    expect(makeRedactor(["Taro Yamada", "山田太郎", "Yamada"], KEY)!.fingerprint).toBe(r.fingerprint);
    expect(makeRedactor(["Yamada", "Taro Yamada", "山田太郎"], Buffer.alloc(32, 8))!.fingerprint).not.toBe(r.fingerprint);
    expect(makeRedactor([], KEY)).toBeUndefined();
    // 当て方の版も入る（版を上げると古い checkpoint を使わない）。
    expect(r.fingerprint).not.toBe(createHmac("sha256", KEY).update("jpaper-redact\0").update("Taro Yamada\0Yamada\0山田太郎\0").digest("hex").slice(0, 16));
  });

  it("LaTeX のコマンド名の中の一致を数える（\\\\ の改行の後の語は数えない）", () => {
    expect(controlWordHits("\\Yamada{x} \\textbf{Yamada} a\\\\Yamada", r)).toBe(1);
  });

  it("語の中の - は無くても当てる（行末の分綴で落ちた形）。語の端の - は落とさない", () => {
    const h = makeRedactor(["Jean-Pierre", "-ab-"], KEY)!;
    expect(redactText("Jean-Pierre JeanPierre Jean Pierre", h)).toEqual({ text: "*** *** Jean Pierre", replaced: 2 });
    expect(redactText("-ab- ab -ab", h).text).toBe("*** ab -ab");
  });

  it("LaTeX の空白（~・\\ ・\\,）とコメントでの継ぎにも当てる", () => {
    expect(redactText("Taro~Yamada, Taro\\ Yamada, Taro\\,Yamada, Taro%c\nYamada", r).text).toBe("***, ***, ***, ***");
  });

  it("ファイル名に語があれば入力エラーで、誤りの文に語を載せない", () => {
    const d = mkdtempSync(path.join(os.tmpdir(), "jpaper-redact-name-"));
    dirs.push(d);
    writeFileSync(path.join(d, "Yamada.bib"), "x");
    expect(() => redactTree(d, r)).toThrow(/名前を変えて/);
  });
});

describe("取り込んだソースの書き換え", () => {
  it("拡張子によらずテキストのファイルを書き換え、NUL を含むファイルは触らず、latin1 のファイルはバイトを壊さない", () => {
    const d = mkdtempSync(path.join(os.tmpdir(), "jpaper-redact-tree-"));
    dirs.push(d);
    mkdirSync(path.join(d, "sec"));
    writeFileSync(path.join(d, "main.tex"), "Yamada wrote this.");
    writeFileSync(path.join(d, "sec", "refs.bib"), Buffer.from("@misc{a, author={M\xfcller and Yamada}}", "latin1"));
    writeFileSync(path.join(d, "fig.png"), Buffer.from("\x89PNG\x00Yamada", "latin1"));
    writeFileSync(path.join(d, "plot.tikz"), "node {Yamada};");
    const r = makeRedactor(["Yamada"], KEY)!;
    expect(redactTree(d, r)).toBe(3);
    expect(readFileSync(path.join(d, "plot.tikz"), "utf8")).toBe("node {***};");
    expect(readFileSync(path.join(d, "main.tex"), "utf8")).toBe("*** wrote this.");
    expect(readFileSync(path.join(d, "sec", "refs.bib")).equals(Buffer.from("@misc{a, author={M\xfcller and ***}}", "latin1"))).toBe(true);
    expect(readFileSync(path.join(d, "fig.png")).toString("latin1")).toBe("\x89PNG\x00Yamada");
  });
});

describe("取り込みの最後の置き換え", () => {
  it("\\iffalse のブロックを落としてつながった語も、本文から消す", async () => {
    const d = mkdtempSync(path.join(os.tmpdir(), "jpaper-redact-ingest-"));
    dirs.push(d);
    const src = path.join(d, "src");
    mkdirSync(src);
    writeFileSync(
      path.join(src, "paper.tex"),
      "\\documentclass{article}\\begin{document}\nby Hanako\n\\iffalse\ndraft\n\\fi\nYamada.\n\\end{document}\n",
    );
    const r = makeRedactor(["Hanako Yamada"], KEY)!;
    const out = await ingest({ kind: "path", path: path.join(src, "paper.tex") }, path.join(d, "run", "source"), { redact: r });
    expect(out.cleanLatex).not.toContain("Yamada");
    expect(out.redacted).toBe(1);
  });
});

describe("伏せ字のための複写", () => {
  it("自分を指すシンボリックリンクがあっても止まらずに複写し、. で始まる名前は複写しない", async () => {
    const d = mkdtempSync(path.join(os.tmpdir(), "jpaper-redact-copy-"));
    dirs.push(d);
    const src = path.join(d, "src");
    mkdirSync(src);
    writeFileSync(path.join(src, "paper.tex"), "\\documentclass{article}\\begin{document}\nby Hanako Yamada.\n\\end{document}\n");
    writeFileSync(path.join(src, ".env"), "SECRET=1");
    symlinkSync(".", path.join(src, "self"));
    const work = path.join(d, "run", "source");
    const out = await ingest({ kind: "path", path: path.join(src, "paper.tex") }, work, { redact: makeRedactor(["Hanako Yamada"], KEY)! });
    expect(out.cleanLatex).not.toContain("Yamada");
    expect(() => readFileSync(path.join(work, ".env"))).toThrow();
  });
});
