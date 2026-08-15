import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadDotEnv } from "./env-file.js";
import { JpaperError } from "../types/errors.js";

const KEYS = ["JPAPER_TEST_A", "JPAPER_TEST_B"] as const;

describe("loadDotEnv", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "jpaper-env-"));
    for (const k of KEYS) delete process.env[k];
  });

  afterEach(() => {
    for (const k of KEYS) delete process.env[k];
    rmSync(dir, { recursive: true, force: true });
  });

  it(".env の値をプロセスに載せる", () => {
    writeFileSync(path.join(dir, ".env"), "JPAPER_TEST_A=fromfile\n");
    expect(loadDotEnv(dir)).toBe(true);
    expect(process.env.JPAPER_TEST_A).toBe("fromfile");
  });

  // シェル・CI の明示指定が .env に負けると、切り分けのつもりで渡した値が黙って
  // 無視される。.env は「何も指定しなかったときの既定」に留める。
  it("既存の環境変数は .env より優先される", () => {
    process.env.JPAPER_TEST_A = "fromenv";
    writeFileSync(path.join(dir, ".env"), "JPAPER_TEST_A=fromfile\nJPAPER_TEST_B=fromfile\n");
    loadDotEnv(dir);
    expect(process.env.JPAPER_TEST_A).toBe("fromenv");
    expect(process.env.JPAPER_TEST_B).toBe("fromfile");
  });

  it(".env が無くても落ちない（無いのが普通の状態）", () => {
    expect(loadDotEnv(dir)).toBe(false);
  });

  // 握るのは「無い」だけ。読めない .env を黙って無視すると、鍵が載らない理由が
  // 「認証エラー」として遠くで出る。（中身の壊れは Node の parser が素通しするので
  // ここでは検出できない。捕まえられるのは I/O 側の失敗だけ。）
  it("無い以外の理由で読めない .env は終了コード 2 の明示的失敗にする", () => {
    mkdirSync(path.join(dir, ".env")); // ディレクトリを置いてしまった、という取り違え
    let err: unknown;
    try {
      loadDotEnv(dir);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(JpaperError);
    expect((err as JpaperError).code).toBe(2);
    expect((err as JpaperError).message).toContain(".env");
  });
});
