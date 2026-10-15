// 利用者向けの skill（/jpaper・$jpaper）を確かめる（issue #424）。
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { checkSkill } from "./check-skill-frontmatter.js";

const ROOT = path.join(import.meta.dirname, "..");
const SKILL = path.join(ROOT, ".claude", "skills", "jpaper", "SKILL.md");
const text = readFileSync(SKILL, "utf8");
const frontmatter = parse(text.split("---\n")[1]!) as Record<string, unknown>;

describe("/jpaper skill（issue #424）", () => {
  it("frontmatter の検査を通る", () => {
    expect(checkSkill(SKILL)).toEqual([]);
  });

  it("Claude Code では /jpaper と打ったときだけ動く", () => {
    expect(frontmatter["disable-model-invocation"]).toBe(true);
  });

  it("Codex では $jpaper と打ったときだけ動き、.agents から同じ skill を読む", () => {
    const policy = parse(readFileSync(path.join(path.dirname(SKILL), "agents", "openai.yaml"), "utf8")) as {
      policy?: { allow_implicit_invocation?: unknown };
    };
    expect(policy.policy?.allow_implicit_invocation).toBe(false);
    expect(realpathSync(path.join(ROOT, ".agents", "skills", "jpaper", "SKILL.md"))).toBe(realpathSync(SKILL));
  });

  it("実行するファイルと、使うオプションが CLI にある", () => {
    expect(text).toContain("node bin/jpaper.mjs <入力> --provider <provider>");
    expect(existsSync(path.join(ROOT, "bin", "jpaper.mjs"))).toBe(true);
    const cli = readFileSync(path.join(ROOT, "src", "cli.ts"), "utf8");
    const options = new Set([...text.matchAll(/`(--[a-z-]+)/g)].map((m) => m[1]!));
    expect(options.size).toBeGreaterThan(0);
    for (const o of options) expect(cli, o).toContain(o);
  });

  it("README の「Coding AI から使う」が両方の呼び方と skill を示す", () => {
    const readme = readFileSync(path.join(ROOT, "README.md"), "utf8");
    const start = readme.indexOf("### Coding AI から使う");
    expect(start).toBeGreaterThan(0);
    const section = readme.slice(start, readme.indexOf("\n### ", start + 1));
    expect(section).toContain("`/jpaper セットアップして`");
    expect(section).toContain("`$jpaper セットアップして`");
    expect(section).toContain("./.claude/skills/jpaper/SKILL.md");
    expect(readme).toContain("(#coding-ai-から使う)");
  });
});
