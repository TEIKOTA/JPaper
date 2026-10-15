// 利用者向けの skill（/jpaper・$jpaper）を確かめる（issue #424）。
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { BOOL_FLAGS, VALUE_FLAGS } from "../src/cli.js";
import { ErrorKind, RunSummary } from "../src/types/contract.js";
import { checkSkill, splitFrontmatter } from "./check-skill-frontmatter.js";

const ROOT = path.join(import.meta.dirname, "..");
const SKILL = path.join(ROOT, ".claude", "skills", "jpaper", "SKILL.md");
const text = readFileSync(SKILL, "utf8");
const split = splitFrontmatter(text);
const frontmatter = parse("yaml" in split ? split.yaml : "") as Record<string, unknown>;

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
    const known = new Set([...VALUE_FLAGS, ...BOOL_FLAGS, "--help"]);
    const translate = text.slice(text.indexOf("## 3. 和訳する"));
    expect(translate).not.toBe(text);
    const options = new Set([...translate.matchAll(/`(--[a-z][a-z-]*)/g)].map((m) => m[1]!));
    expect(options.size).toBeGreaterThan(0);
    for (const o of options) expect(known.has(o), o).toBe(true);
  });

  it("失敗したら原因を調べ、JPaper の不具合だけを、利用者の了承を得てから起票する", () => {
    const failure = text.slice(text.indexOf("## 4. 失敗したとき"));
    expect(failure).not.toBe(text);
    expect(failure).toContain("推測で起票しない");
    expect(failure).toContain("了承を得たときだけ、`gh issue create --repo TEIKOTA/JPaper");
    expect(failure).toContain("gh issue list --repo TEIKOTA/JPaper --state all");
    expect(failure).toContain("gh pr list --repo TEIKOTA/JPaper --state all");
    expect(failure).toContain("失敗したときに消える");
    const keys = /RunSummary`）の ((?:`[A-Za-z]+`・?)+)/.exec(failure)?.[1];
    expect(keys).toBeDefined();
    for (const k of [...keys!.matchAll(/`([A-Za-z]+)`/g)].map((m) => m[1]!)) expect(Object.keys(RunSummary.shape), k).toContain(k);
    expect(existsSync(path.join(ROOT, ".github", "ISSUE_TEMPLATE", "bug-report.md"))).toBe(true);
  });

  it("失敗の手がかりとして挙げる標準エラーの文言と置き場が、CLI のソースにある", () => {
    const src = ["src/cli.ts", "src/workflows/translate-paper.ts"].map((f) => readFileSync(path.join(ROOT, f), "utf8")).join("\n");
    for (const s of [
      "失敗[",
      "想定外エラー: ",
      "原プリアンブルで組めず共通テンプレへフォールバック: ",
      "対訳 PDF の組版に失敗しました",
      "翻訳起因: ",
      '"translation", "chapters"',
      '"failed-segments.json"',
    ]) {
      expect(src, s).toContain(s);
      expect(text, s).toContain(s.replace(/"/g, "").replace(", ", "/").replace(/: $/, ""));
    }
  });

  it("失敗の分け方の表が、すべての kind を扱う", () => {
    const table = text.slice(text.indexOf("### 原因で分ける"), text.indexOf("### issue に起票する"));
    const listed = [...table.matchAll(/^\| ((?:`[a-z-]+`・?)+)/gm)].flatMap((m) => [...m[1]!.matchAll(/`([a-z-]+)`/g)].map((k) => k[1]!));
    expect([...listed].sort()).toEqual([...ErrorKind.options].sort());
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
