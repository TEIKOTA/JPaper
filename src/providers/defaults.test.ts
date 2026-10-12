import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { latestSolModel, readCodexModelCache, withCliDefaults } from "./defaults.js";

const cache = (models: { slug: string; visibility?: string }[]): string =>
  JSON.stringify({ fetched_at: "2026-10-13T00:00:00Z", models: models.map((m) => ({ visibility: "list", ...m })) });

// 2026-10-13 時点の codex のモデル一覧（slug と表示の有無だけ）。
const NOW = cache([
  { slug: "gpt-6.1-sol" },
  { slug: "gpt-6-astra" },
  { slug: "gpt-6-sol" },
  { slug: "gpt-6-luna" },
  { slug: "gpt-reserve", visibility: "hide" },
  { slug: "gpt-5.6-sol" },
  { slug: "gpt-5.6-terra" },
  { slug: "gpt-5.5", visibility: "hide" },
]);

describe("latestSolModel", () => {
  it("Sol 系のうち版が最も新しいものを選ぶ（並び順によらない）", () => {
    expect(latestSolModel(NOW)).toBe("gpt-6.1-sol");
    expect(latestSolModel(cache([{ slug: "gpt-5.6-sol" }, { slug: "gpt-6-sol" }, { slug: "gpt-6.1-sol" }]))).toBe(
      "gpt-6.1-sol",
    );
  });

  it("版は数値で比べる（6.10 は 6.9 より新しい）", () => {
    expect(latestSolModel(cache([{ slug: "gpt-6.9-sol" }, { slug: "gpt-6.10-sol" }]))).toBe("gpt-6.10-sol");
  });

  it("visibility が list でないモデル（hide・未知の値・欠落）は選ばない", () => {
    const raw = JSON.stringify({
      models: [
        { slug: "gpt-9-sol", visibility: "internal" },
        { slug: "gpt-8-sol" },
        { slug: "gpt-7-sol", visibility: "hide" },
        { slug: "gpt-6-sol", visibility: "list" },
      ],
    });
    expect(latestSolModel(raw)).toBe("gpt-6-sol");
  });

  it("隠されたモデル・Sol 以外・形の違う slug は選ばない", () => {
    expect(latestSolModel(cache([{ slug: "gpt-7-sol", visibility: "hide" }, { slug: "gpt-6-sol" }]))).toBe("gpt-6-sol");
    expect(latestSolModel(cache([{ slug: "gpt-6-astra" }, { slug: "gpt-6-solar" }, { slug: "x-gpt-6-sol" }]))).toBeUndefined();
  });

  it("壊れた JSON・models が無い・要素が不正なら undefined", () => {
    expect(latestSolModel("{")).toBeUndefined();
    expect(latestSolModel("{}")).toBeUndefined();
    expect(latestSolModel(JSON.stringify({ models: [null, 1, { slug: 2 }] }))).toBeUndefined();
  });
});

describe("readCodexModelCache", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("CODEX_HOME があればその下、無ければ ~/.codex の models_cache.json を読む。無ければ undefined", () => {
    const codexHome = mkdtempSync(path.join(os.tmpdir(), "jpaper-codex-home-"));
    const home = mkdtempSync(path.join(os.tmpdir(), "jpaper-home-"));
    dirs.push(codexHome, home);
    writeFileSync(path.join(codexHome, "models_cache.json"), NOW);
    expect(readCodexModelCache({ CODEX_HOME: codexHome }, () => home)).toBe(NOW);
    expect(readCodexModelCache({}, () => home)).toBeUndefined();
    mkdirSync(path.join(home, ".codex"));
    writeFileSync(path.join(home, ".codex", "models_cache.json"), "x");
    expect(readCodexModelCache({}, () => home)).toBe("x");
    expect(readCodexModelCache({ CODEX_HOME: "" }, () => home)).toBe("x");
  });

  it("CODEX_HOME が相対パス・普通のファイルでない・8MB を超える・ホームが分からないなら読まない", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "jpaper-home-"));
    dirs.push(home);
    mkdirSync(path.join(home, "rel"));
    writeFileSync(path.join(home, "rel", "models_cache.json"), NOW);
    // 実在する相対パスでも読まない（codex は別の作業ディレクトリで起動するので指す場所がずれる）。
    expect(readCodexModelCache({ CODEX_HOME: path.relative(process.cwd(), path.join(home, "rel")) }, () => home)).toBeUndefined();
    expect(readCodexModelCache({ CODEX_HOME: "  " }, () => home)).toBeUndefined();
    mkdirSync(path.join(home, "dir", "models_cache.json"), { recursive: true });
    expect(readCodexModelCache({ CODEX_HOME: path.join(home, "dir") }, () => home)).toBeUndefined();
    mkdirSync(path.join(home, "big"));
    writeFileSync(path.join(home, "big", "models_cache.json"), Buffer.alloc(8 * 1024 * 1024 + 1, 0x20));
    expect(readCodexModelCache({ CODEX_HOME: path.join(home, "big") }, () => home)).toBeUndefined();
    expect(
      readCodexModelCache({}, () => {
        throw new Error("no home");
      }),
    ).toBeUndefined();
  });
});

describe("withCliDefaults（契約付録 §5）", () => {
  it("claude: 未指定なら別名 sonnet と medium、指定した値はそのまま", () => {
    expect(withCliDefaults("claude", {})).toEqual({ claude: { model: "sonnet", effort: "medium" } });
    expect(withCliDefaults("claude", { claude: { model: "opus" } })).toEqual({ claude: { model: "opus", effort: "medium" } });
    expect(withCliDefaults("claude", { claude: { effort: "high" } })).toEqual({ claude: { model: "sonnet", effort: "high" } });
  });

  it("codex: 未指定ならモデル一覧の最新の Sol と medium、指定した model のときは一覧を読まない", () => {
    expect(withCliDefaults("codex", {}, () => NOW)).toEqual({ codex: { model: "gpt-6.1-sol", effort: "medium" } });
    let read = 0;
    const r = withCliDefaults("codex", { codex: { model: "gpt-6-astra", effort: "low" } }, () => {
      read++;
      return NOW;
    });
    expect(r).toEqual({ codex: { model: "gpt-6-astra", effort: "low" } });
    expect(read).toBe(0);
  });

  it("codex: 一覧が読めない・Sol が無いなら model を渡さず（codex の既定）、effort は medium にして警告する", () => {
    for (const read of [() => undefined, () => cache([{ slug: "gpt-6-astra" }])]) {
      const r = withCliDefaults("codex", {}, read);
      expect(r.codex).toEqual({ effort: "medium" });
      expect(r.warning).toContain("最新の Sol 系を見つけられなかった");
    }
  });

  it("ollama・openrouter には既定を足さない", () => {
    expect(withCliDefaults("ollama", {})).toEqual({});
    expect(withCliDefaults("openrouter", {})).toEqual({});
  });
});
