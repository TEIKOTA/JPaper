import { describe, it, expect, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import {
  resolveJpaperHome,
  dbPath,
  paperOutDir,
  ARTICLE_DIR,
  contextWindowFor,
  DEFAULT_CLAUDE_CW,
  DEFAULT_OLLAMA,
} from "./config.js";

const savedHome = process.env.JPAPER_HOME;
afterEach(() => {
  if (savedHome === undefined) delete process.env.JPAPER_HOME;
  else process.env.JPAPER_HOME = savedHome;
});

describe("resolveJpaperHome / dbPath", () => {
  it("既定は ~/.jpaper", () => {
    delete process.env.JPAPER_HOME;
    expect(resolveJpaperHome()).toBe(path.join(os.homedir(), ".jpaper"));
    expect(dbPath()).toBe(path.join(os.homedir(), ".jpaper", "glossary.db"));
  });

  it("JPAPER_HOME で上書きできる", () => {
    process.env.JPAPER_HOME = "/tmp/jp-home";
    expect(resolveJpaperHome()).toBe("/tmp/jp-home");
    expect(dbPath()).toBe(path.join("/tmp/jp-home", "glossary.db"));
  });

  it("空文字の JPAPER_HOME は無視して既定に倒す", () => {
    process.env.JPAPER_HOME = "   ";
    expect(resolveJpaperHome()).toBe(path.join(os.homedir(), ".jpaper"));
  });
});

describe("paperOutDir", () => {
  it("既定は ./article/<paperId>-ja（絶対パス化）", () => {
    expect(paperOutDir("unet")).toBe(path.resolve("article", "unet-ja"));
    expect(ARTICLE_DIR).toBe("article");
  });
  it("--out で上書きできる", () => {
    expect(paperOutDir("unet", "/somewhere/out")).toBe(
      path.resolve("/somewhere/out"),
    );
  });
});

describe("contextWindowFor", () => {
  it("claude は既定 200_000", () => {
    expect(contextWindowFor("claude")).toBe(DEFAULT_CLAUDE_CW);
    expect(DEFAULT_CLAUDE_CW).toBe(200_000);
  });
  it("ollama は設定の contextWindow", () => {
    expect(contextWindowFor("ollama")).toBe(DEFAULT_OLLAMA.contextWindow);
    expect(contextWindowFor("ollama", { ...DEFAULT_OLLAMA, contextWindow: 32768 })).toBe(
      32768,
    );
  });
});
