#!/usr/bin/env tsx
// SKILL.md の frontmatter を Agent Skills 共通契約（name・description）と repo の起動条件規約で検査する（issue #416）。
// 使い方: pnpm exec tsx scripts/check-skill-frontmatter.ts [<skills-dir>]
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isAlias, isCollection, isScalar, parseDocument, visit } from "yaml";

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TRIGGER = /\buse\s+(?:when|before)\b/i;
const MAX_NAME = 64;
const MAX_DESCRIPTION = 1024;

export const USAGE = "Usage: scripts/check-skill-frontmatter.ts [<skills-dir>]\nSKILL.md の frontmatter を検査する。\n";

export function skillFiles(root: string): string[] {
  const single = path.join(root, "SKILL.md");
  if (existsSync(single) && statSync(single).isFile()) return [single];
  if (!existsSync(root) || !statSync(root).isDirectory()) return [];
  return readdirSync(root)
    .filter((d) => !d.startsWith("."))
    .sort()
    .map((d) => path.join(root, d, "SKILL.md"))
    .filter((p) => existsSync(p) && statSync(p).isFile());
}

const chars = (s: string): number => [...s].length;

function safeLoad(text: string): { value: unknown } | { error: string } {
  const doc = parseDocument(text, { schema: "yaml-1.1" });
  if (doc.errors.length > 0) return { error: doc.errors[0]!.message.split("\n")[0]!.trim() };
  let bad: string | undefined;
  visit(doc, (_key, node) => {
    if (isAlias(node)) bad = "alias は使えません";
    else if (isCollection(node) && node.tag !== undefined && !["tag:yaml.org,2002:map", "tag:yaml.org,2002:seq"].includes(node.tag))
      bad = `${node.tag} は使えません`;
    else if (isScalar(node) && (node.value instanceof Date || node.value instanceof Uint8Array)) bad = "日付・バイナリは使えません";
    if (bad !== undefined) return visit.BREAK;
    return undefined;
  });
  if (bad !== undefined) return { error: bad };
  return { value: doc.toJS() };
}

export function splitFrontmatter(text: string): { yaml: string } | { missing: "open" | "close" } {
  const lines = text.split("\n");
  if (lines[0]?.replace(/\r$/, "") !== "---") return { missing: "open" };
  const close = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (close < 0) return { missing: "close" };
  return { yaml: lines.slice(1, close).join("\n") };
}

export function checkSkill(file: string): string[] {
  const split = splitFrontmatter(readFileSync(file, "utf8"));
  if ("missing" in split) {
    return split.missing === "open"
      ? [`${file}: 1 行目に frontmatter 開始 marker (---) がありません`]
      : [`${file}: frontmatter 終了 marker (---) がありません`];
  }

  const loaded = safeLoad(split.yaml);
  if ("error" in loaded) return [`${file}: frontmatter を YAML として読めません (${loaded.error})`];
  const meta = loaded.value;
  if (meta === null || typeof meta !== "object" || Array.isArray(meta)) return [`${file}: frontmatter は YAML map である必要があります`];

  const errors: string[] = [];
  const { name, description } = meta as Record<string, unknown>;
  if (!(typeof name === "string" && NAME.test(name) && chars(name) <= MAX_NAME)) {
    errors.push(`${file}: name は 1〜64 文字の小文字英数字・単一 hyphen 連結で指定してください`);
  }
  const dir = path.basename(path.dirname(file));
  if (typeof name === "string" && name !== dir) {
    errors.push(`${file}: name (${name}) は親 directory 名 (${dir}) と一致させてください`);
  }
  if (!(typeof description === "string" && description !== "")) {
    errors.push(`${file}: 必須の description を空でない文字列として指定してください`);
    return errors;
  }
  if (chars(description) > MAX_DESCRIPTION) {
    errors.push(`${file}: description は 1024 文字以内にしてください (${String(chars(description))} 文字)`);
  }
  if (!TRIGGER.test(description)) {
    errors.push(`${file}: description に起動条件を \`Use when\` または \`Use BEFORE\` で明記してください`);
  }
  return errors;
}

export interface Io {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

export function main(argv: string[], io: Io, defaultRoot: string): number {
  if (argv.length === 1 && (argv[0] === "-h" || argv[0] === "--help")) {
    io.stdout(USAGE);
    return 0;
  }
  const root = argv[0] ?? defaultRoot;
  const files = skillFiles(root);
  if (files.length === 0) {
    io.stderr(`ERROR: SKILL.md が見つかりません: ${root}\n`);
    return 1;
  }
  const errors = files.flatMap(checkSkill);
  if (errors.length > 0) {
    for (const e of errors) io.stderr(`ERROR: ${e}\n`);
    return 1;
  }
  io.stdout(`OK: skill frontmatter ${String(files.length)} 件\n`);
  return 0;
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const defaultRoot = fileURLToPath(new URL("../.claude/skills", import.meta.url));
  process.exitCode = main(process.argv.slice(2), { stdout: (s) => process.stdout.write(s), stderr: (s) => process.stderr.write(s) }, defaultRoot);
}
