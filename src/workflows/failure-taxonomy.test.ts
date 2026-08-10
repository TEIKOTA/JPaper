import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { toRunError, safeMessage, isInfraError, JpaperError } from "../types/errors.js";

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(path.join(os.tmpdir(), "jpaper-taxonomy-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      chmodSync(d, 0o755);
    } catch {
      // 既に消えている
    }
    rmSync(d, { recursive: true, force: true });
  }
});

describe("実行環境の障害の分類", () => {
  it("fs の errno は infra として分類し、生の errno とパスを message に出さない", () => {
    const e = Object.assign(new Error("EACCES: permission denied, mkdir '/srv/acme/out'"), {
      code: "EACCES",
    });
    const r = toRunError(e);
    expect(r.kind).toBe("infra");
    expect(r.message).not.toContain("/srv/acme/out");
    expect(r.message).toContain("EACCES"); // 種別だけは残す（運用の切り分け用）
    expect(r.detail).toContain("/srv/acme/out"); // 詳細はサーバ側ログへ
  });

  it("コードのバグ（infra でない例外）は internal のまま", () => {
    expect(toRunError(new TypeError("x is not a function")).kind).toBe("internal");
    expect(isInfraError(new TypeError("boom"))).toBe(false);
  });
});

describe("safeMessage", () => {
  it("制御文字を落とす（端末・応答の偽装を防ぐ）", () => {
    const esc = "\u001b";
    expect(safeMessage(`a${esc}[2Jb\nc`)).toBe("a [2Jb c");
  });

  it("長すぎるメッセージを切る", () => {
    expect(safeMessage("あ".repeat(600)).length).toBeLessThanOrEqual(501);
  });

  it("JpaperError の message にも適用される", () => {
    const bell = "\u0007";
    const r = toRunError(new JpaperError(2, "input", `壊れた${bell}入力`));
    expect(r.message).toBe("壊れた 入力");
  });
});

describe("出力先を用意できないとき", () => {
  it("run lock は生の fs エラーを外へ出さず infra で返す", async () => {
    const { acquireRunLock } = await import("../durable/run-lock.js");
    const base = tmp();
    // 親をファイルにする＝mkdir が ENOTDIR で失敗する。
    const file = path.join(base, "occupied");
    writeFileSync(file, "x");
    let err: unknown;
    try {
      acquireRunLock(path.join(file, ".run"));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(JpaperError);
    expect((err as JpaperError).kind).toBe("infra");
  });

  it("translatePaper からも infra として返る（internal に落ちない）", async () => {
    const { translatePaper } = await import("./translate-paper.js");
    const { FakeLlmClient } = await import("../testing/fake-llm.js");
    const { GlossaryDb } = await import("../terminology/db.js");
    const base = tmp();
    const file = path.join(base, "occupied");
    writeFileSync(file, "x");

    const r = await translatePaper(
      { kind: "path", path: path.join(base, "any.tar") },
      { provider: "ollama", outDir: path.join(file, "out") },
      { client: new FakeLlmClient(() => "{}"), db: new GlossaryDb() },
    );
    expect(r.status).toBe("failed");
    expect(r.error?.kind).toBe("infra");
  });
});

describe("注入クライアントの例外", () => {
  it("素の例外は provider として返る（テナントの 401 が 500 にならない）", async () => {
    const { translatePaper } = await import("./translate-paper.js");
    const { GlossaryDb } = await import("../terminology/db.js");
    const { makeTar } = await import("../ingest/archive.fixtures.js");

    const work = tmp();
    const tar = path.join(work, "p.tar");
    writeFileSync(
      tar,
      makeTar([
        {
          name: "main.tex",
          content: "\\documentclass{a}\\begin{document}\\section{I}Alpha.\\end{document}",
        },
      ]),
    );
    const r = await translatePaper(
      { kind: "path", path: tar },
      { provider: "ollama", outDir: path.join(work, "out") },
      {
        client: {
          complete: () => Promise.reject(new Error("tenant credentials expired (401)")),
        },
        db: new GlossaryDb(),
      },
    );
    expect(r.status).toBe("failed");
    expect(r.error?.kind).toBe("provider");
    expect(r.error?.message).toContain("401");
  });
});

describe("外向きメッセージの検疫", () => {
  it("絶対パスは message から伏せ、detail に残す", async () => {
    const { JpaperError: E } = await import("../types/errors.js");
    const r = toRunError(new E(2, "conflict", "別の実行が進行中です: /srv/acme/out/.run"));
    expect(r.message).not.toContain("/srv/acme");
    expect(r.message).toContain("<path>");
    expect(r.detail).toContain("/srv/acme/out/.run");
  });

  it("internal の生メッセージからも絶対パスを伏せる", () => {
    const r = toRunError(new TypeError("cannot read x of /Users/secret/tenants/a/db.sqlite"));
    expect(r.kind).toBe("internal");
    expect(r.message).not.toContain("/Users/secret");
  });

  it("双方向制御文字・ゼロ幅・行区切りを落とす", () => {
    const rlo = "\u202e";
    const zwsp = "\u200b";
    const ls = "\u2028";
    const out = safeMessage(`OK${rlo}gnitset${zwsp}X${ls}Y`);
    expect(out).not.toContain(rlo);
    expect(out).not.toContain(zwsp);
    expect(out).not.toContain(ls);
  });

  it("環境由来の errno を infra、ネットワーク errno を upstream に分類する", () => {
    for (const code of ["ENOENT", "EEXIST", "EBUSY", "EACCES"]) {
      expect(toRunError(Object.assign(new Error("x"), { code })).kind).toBe("infra");
    }
    const net = toRunError(Object.assign(new Error("connect"), { code: "ECONNREFUSED" }));
    expect(net.kind).toBe("upstream");
    expect(net.code).toBe(2);
  });

  it("cause に包まれた fs エラーも取りこぼさない", () => {
    const wrapped = new Error("db を開けません", {
      cause: Object.assign(new Error("EACCES"), { code: "EACCES" }),
    });
    expect(isInfraError(wrapped)).toBe(true);
    expect(toRunError(wrapped).kind).toBe("infra");
  });
});
