import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
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

  it("外部への symlink な main.tex は候補から除外する", () => {
    const container = mkdtempSync(path.join(os.tmpdir(), "jpaper-symmain-"));
    dirs.push(container);
    writeFileSync(path.join(container, "outside.tex"), DOC);
    const src = path.join(container, "src");
    mkdirSync(src);
    symlinkSync(path.join(container, "outside.tex"), path.join(src, "main.tex"));
    expect(() => detectMainTex(src)).toThrow(/見つかりません/);
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

  it("\\@@input も畳む（scanner だけに頼らない多層防御）", () => {
    const d = tmp({
      "main.tex":
        "\\documentclass{a}\\begin{document}\\makeatletter\\@@input\n/etc/hostname\n\\end{document}",
    });
    // build ツリー外は解決できないので削除される（残ると latexmk が実際に読む）。
    expect(expandInputs(d, "main.tex")).not.toContain("@@input");
  });

  it("\\input はルート優先で解決する（TeX 準拠）", () => {
    const d = tmp({
      "main.tex": "\\documentclass{a}\\begin{document}\\input{sub/chapter}\\end{document}",
      "foo.tex": "ROOT",
      "sub/chapter.tex": "\\input{foo}",
      "sub/foo.tex": "SUBFOO",
    });
    const out = expandInputs(d, "main.tex");
    expect(out).toContain("ROOT");
    expect(out).not.toContain("SUBFOO");
  });

  it("\\input と { の間の空白も展開する", () => {
    const d = tmp({ "main.tex": "A\\input {sec}B", "sec.tex": "節" });
    expect(expandInputs(d, "main.tex")).toBe("A節B");
  });

  it("波括弧なしの \\input filename も展開する（TeX プリミティブ）", () => {
    const d = tmp({ "main.tex": "A\\input sec\nB", "sec.tex": "節" });
    expect(expandInputs(d, "main.tex")).toBe("A節\nB");
  });

  it("\\inputencoding など input で始まる別コマンドは展開しない", () => {
    const d = tmp({ "main.tex": "\\inputencoding{utf8}X" });
    expect(expandInputs(d, "main.tex")).toBe("\\inputencoding{utf8}X");
  });

  it("\\\\%（偶数バックスラッシュ）はコメント開始として扱う", () => {
    const d = tmp({ "main.tex": "X\\\\% \\input{draft}\nY", "draft.tex": "DRAFT" });
    const out = expandInputs(d, "main.tex");
    expect(out).not.toContain("DRAFT");
    expect(out).toContain("X\\\\");
  });

  it("波括弧なしの \\input filename も展開する", () => {
    const d = tmp({ "main.tex": "A\\input sec\nB", "sec.tex": "節本文" });
    expect(expandInputs(d, "main.tex")).toBe("A節本文\nB");
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

  it("symlink でルート外へ逃げる \\input を拒否する", () => {
    const container = mkdtempSync(path.join(os.tmpdir(), "jpaper-sym-"));
    dirs.push(container);
    writeFileSync(path.join(container, "secret.tex"), "SECRET");
    const src = path.join(container, "src");
    mkdirSync(src);
    writeFileSync(path.join(src, "main.tex"), "A\\input{linked}B");
    symlinkSync(path.join(container, "secret.tex"), path.join(src, "linked.tex"));
    expect(expandInputs(src, "main.tex")).toBe("AB");
  });
});

describe("main.tex 検出の上限", () => {
  it("参照されない巨大な .tex を全部メモリへ載せない", () => {
    const huge = `% ${"x".repeat(2 * 1024 * 1024)}`; // 前文に \\documentclass を含まない
    const d = tmp({
      "main.tex": "\\documentclass{a}\\begin{document}本文\\end{document}",
      "appendix-huge.tex": huge,
    });
    // 読むのは先頭 256KB までなので、巨大ファイルがあっても検出は成立する。
    expect(detectMainTex(d)).toBe("main.tex");
  });

  it("常駐量が .tex の件数に比例しない", () => {
    // 前文を全件分ため込んでいた頃は 1,200 件で heapUsed 307MB（上限件数なら約 2.5GB）に達し、
    // --max-old-space-size=256 で OOM 死した。翻訳を始める前にワーカーごと落ちる。
    const files: Record<string, string> = {
      "main.tex": "\\documentclass{a}\\begin{document}x\\end{document}",
    };
    const pad = `% ${"x".repeat(256 * 1024)}`;
    for (let i = 0; i < 200; i++) files[`pad${String(i)}.tex`] = pad;
    const d = tmp(files);
    global.gc?.();
    const before = process.memoryUsage().heapUsed;
    expect(detectMainTex(d)).toBe("main.tex");
    // 保持していれば 200 × 256KB ≒ 50MB 増える。1 件分しか持たなければ増えない。
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(16 * 1024 * 1024);
  });

  it(".tex の数が上限を超えたら too-large", () => {
    const files: Record<string, string> = {
      "main.tex": "\\documentclass{a}\\begin{document}x\\end{document}",
    };
    for (let i = 0; i < 5; i++) files[`extra${String(i)}.tex`] = "% pad";
    const d = tmp(files);
    expect(() => detectMainTex(d, 3)).toThrowError(/上限/);
  });
});

describe("展開の予算", () => {
  it("指数展開の入力を即座に too-large で落とす", () => {
    // 各ファイルが次を 2 回読むダイヤモンド型。stack.includes は循環しか止めないので
    // 予算が無いと指数的に膨らみ、実測で 508 バイトの入力がループを 205 秒占有した。
    const files: Record<string, string> = {
      "main.tex": "\\documentclass{a}\\begin{document}\\input{l0}\\end{document}",
    };
    for (let i = 0; i < 26; i++) {
      files[`l${String(i)}.tex`] =
        i === 25 ? "終端" : `\\input{l${String(i + 1)}}\\input{l${String(i + 1)}}`;
    }
    const d = tmp(files);
    const started = Date.now();
    expect(() => expandInputs(d, "main.tex", { maxBytes: 8 * 1024 * 1024 })).toThrowError(/上限/);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("解決だけで終わる \\input の羅列も上限で止まる", () => {
    // 不在先への \input は展開もバイトも増やさないのに existsSync と realpathSync を叩く。
    // 実測 3.8MB（gzip すれば数 KB）の羅列が 1,096ms 同期でイベントループを止め、
    // しかも 47 バイトを返して「成功」していた。
    const body = "\\input{zz}".repeat(400_000);
    const d = tmp({ "main.tex": `\\documentclass{a}\\begin{document}${body}\\end{document}` });
    const started = Date.now();
    expect(() => expandInputs(d, "main.tex", { maxBytes: 8 * 1024 * 1024 })).toThrowError(/上限/);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("入れ子の深さにも上限がある", () => {
    const files: Record<string, string> = {
      "main.tex": "\\documentclass{a}\\begin{document}\\input{l0}\\end{document}",
    };
    for (let i = 0; i < 40; i++) files[`l${String(i)}.tex`] = `\\input{l${String(i + 1)}}`;
    files["l40.tex"] = "終端";
    const d = tmp(files);
    expect(() => expandInputs(d, "main.tex", { maxBytes: 8 * 1024 * 1024 })).toThrowError(/段/);
  });

  it("正規の入れ子は通す", () => {
    const d = tmp({
      "main.tex": "\\documentclass{a}\\begin{document}\\input{sec/intro}\\end{document}",
      "sec/intro.tex": "序論\\input{sec/body}",
      "sec/body.tex": "本体",
    });
    const out = expandInputs(d, "main.tex", { maxBytes: 8 * 1024 * 1024 });
    expect(out).toContain("序論");
    expect(out).toContain("本体");
  });
});
