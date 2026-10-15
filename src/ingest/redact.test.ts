import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { controlWordHits, makeRedactor, parseRedactTerms, redactText, redactTree } from "./redact.js";
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
  });

  it("LaTeX のコマンド名の中の一致を数える", () => {
    expect(controlWordHits("\\Yamada{x} \\textbf{Yamada}", r)).toBe(1);
  });
});

describe("取り込んだソースの書き換え", () => {
  it("テキストのファイルだけを書き換え、latin1 のファイルはバイトを壊さない", () => {
    const d = mkdtempSync(path.join(os.tmpdir(), "jpaper-redact-tree-"));
    dirs.push(d);
    mkdirSync(path.join(d, "sec"));
    writeFileSync(path.join(d, "main.tex"), "Yamada wrote this.");
    writeFileSync(path.join(d, "sec", "refs.bib"), Buffer.from("@misc{a, author={M\xfcller and Yamada}}", "latin1"));
    writeFileSync(path.join(d, "fig.png"), "Yamada");
    const r = makeRedactor(["Yamada"], KEY)!;
    expect(redactTree(d, r)).toBe(2);
    expect(readFileSync(path.join(d, "main.tex"), "utf8")).toBe("*** wrote this.");
    expect(readFileSync(path.join(d, "sec", "refs.bib")).equals(Buffer.from("@misc{a, author={M\xfcller and ***}}", "latin1"))).toBe(true);
    expect(readFileSync(path.join(d, "fig.png"), "utf8")).toBe("Yamada");
  });
});
