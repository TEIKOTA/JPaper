import { describe, it, expect } from "vitest";
import { resolveExitCode, isTransient, JpaperError, redactPaths, toRunError } from "./errors.js";

describe("resolveExitCode", () => {
  it("失敗が無ければ 0", () => {
    expect(resolveExitCode([])).toBe(0);
    expect(resolveExitCode([0, 0])).toBe(0);
  });

  it("優先順位 2 > 3 > 4 > 5", () => {
    expect(resolveExitCode([4, 3, 5])).toBe(3);
    expect(resolveExitCode([5, 4])).toBe(4);
    expect(resolveExitCode([2, 3, 4, 5])).toBe(2);
    expect(resolveExitCode([5])).toBe(5);
  });

  it("既知失敗が無く 1 があれば 1", () => {
    expect(resolveExitCode([1])).toBe(1);
    expect(resolveExitCode([1, 0])).toBe(1);
  });

  it("既知失敗は 1 より優先", () => {
    expect(resolveExitCode([1, 3])).toBe(3);
  });
});

describe("isTransient", () => {
  it("一時的なネットワーク/レート/5xx は true", () => {
    expect(isTransient({ code: "ECONNREFUSED" })).toBe(true);
    expect(isTransient({ code: "ETIMEDOUT" })).toBe(true);
    expect(isTransient({ status: 429 })).toBe(true);
    expect(isTransient({ statusCode: 503 })).toBe(true);
    expect(isTransient(new Error("socket hang up"))).toBe(true);
    expect(isTransient(new Error("Request timeout after 30s"))).toBe(true);
    expect(isTransient(new Error("429 Too Many Requests"))).toBe(true);
  });

  it("transient マーカーを尊重する", () => {
    expect(isTransient({ transient: true })).toBe(true);
    expect(isTransient({ transient: false })).toBe(false);
  });

  it("cause に隠れた一時コードも辿る（Node fetch 相当）", () => {
    const e = Object.assign(new TypeError("fetch failed"), {
      cause: { code: "ECONNRESET" },
    });
    expect(isTransient(e)).toBe(true);
  });

  it("cause の循環でも停止する", () => {
    const a: { message: string; cause?: unknown } = { message: "boom" };
    a.cause = a;
    expect(isTransient(a)).toBe(false);
  });

  it("タスク失敗・不明は false", () => {
    expect(isTransient(null)).toBe(false);
    expect(isTransient(new Error("build failed: missing figure"))).toBe(false);
    expect(isTransient({ status: 400 })).toBe(false);
    expect(isTransient(new JpaperError(3, "formal", "MAX_REVISIONS 超過"))).toBe(
      false,
    );
  });
});

describe("JpaperError", () => {
  it("code/kind を保持する", () => {
    const e = new JpaperError(2, "provider", "ollama 未起動");
    expect(e.code).toBe(2);
    expect(e.kind).toBe("provider");
    expect(e).toBeInstanceOf(Error);
  });
});

describe("redactPaths", () => {
  it("ホストの絶対パスを伏せる（Unix / Windows / UNC / ~）", () => {
    expect(redactPaths("open /Users/a/JPaper/secret.tex")).toBe("open <path>");
    expect(redactPaths("C:\\Users\\a\\secret.tex")).toBe("<path>");
    expect(redactPaths("\\\\server\\share\\secret.tex")).toBe("<path>");
    expect(redactPaths("~/.jpaper/db.sqlite が読めません")).toBe("<path> が読めません");
    expect(redactPaths("cannot write /etc")).toBe("cannot write <path>");
  });

  it("URL・相対パス・日付は伏せない（外向きの唯一の診断情報を壊さない）", () => {
    const url = "https://arxiv.org/abs/2401.12345 に到達できません";
    expect(redactPaths(url)).toBe(url);
    expect(redactPaths("出力先 ./out/ja を確認してください")).toBe(
      "出力先 ./out/ja を確認してください",
    );
    expect(redactPaths("期限 2026/08/11 を超過しました")).toBe("期限 2026/08/11 を超過しました");
    expect(redactPaths("図 fig/x.png が見つかりません")).toBe("図 fig/x.png が見つかりません");
  });

  it("区切りとして書いた単独の / を伏せない", () => {
    // 先頭の / の直後にパス構成要素を要求していなかった頃は、区切りの / まで伏せて
    // 外向きメッセージの意味が壊れた（実測: .paper-id 不一致の警告文で発生）。
    expect(redactPaths("既存の glossary.md / brief.md / style.md は使いません")).toBe(
      "既存の glossary.md / brief.md / style.md は使いません",
    );
    expect(redactPaths("入力/出力 の設定")).toBe("入力/出力 の設定");
    expect(redactPaths("進捗 3/5 セグメント")).toBe("進捗 3/5 セグメント");
  });
});

describe("sqlite の競合は internal ではなく busy", () => {
  it("database is locked は kind=busy / exit 2", () => {
    const e = Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR" });
    const r = toRunError(e);
    expect(r.kind).toBe("busy");
    expect(r.code).toBe(2);
    expect(r.message).not.toContain("locked");
  });

  it("sqlite の文法エラーは internal のまま（本当のバグ）", () => {
    const e = Object.assign(new Error('near "SELCT": syntax error'), {
      code: "ERR_SQLITE_ERROR",
    });
    expect(toRunError(e).kind).toBe("internal");
  });
});

describe("redactPaths は非 ASCII の絶対パスも伏せる", () => {
  it("日本語ディレクトリ名で始まるパスを丸ごと伏せる", () => {
    expect(redactPaths("/ユーザ/機密/論文/main.tex")).toBe("<path>");
    expect(redactPaths("~/ドキュメント/paper.tex")).toBe("<path>");
    expect(redactPaths("/@tenant42/secret/paper.tex")).toBe("<path>");
  });

  it("区切りの / ・URL・日付は伏せない", () => {
    expect(redactPaths("glossary.md / brief.md")).toBe("glossary.md / brief.md");
    expect(redactPaths("入力/出力 の設定")).toBe("入力/出力 の設定");
    expect(redactPaths("https://example.com/a/b")).toBe("https://example.com/a/b");
    expect(redactPaths("2026/08/11 の実行")).toBe("2026/08/11 の実行");
    expect(redactPaths("and/or の判断")).toBe("and/or の判断");
  });

  it("文中・括弧内のパスも伏せる", () => {
    expect(redactPaths("見つかりません: /tmp/x/y")).toBe("見つかりません: <path>");
    expect(redactPaths("(/tmp/x) を確認")).toBe("(<path>) を確認");
  });
});
