// 契約付録 §8（論文タイトルの翻訳）。前文の \title の主引数を取り出し・差し替える。
import type { Segment } from "../segment/segmenter.js";
import { estimateTokens } from "../segment/token-estimator.js";

// 主引数の中身（外側の波括弧を含まない）の範囲。
export interface TitleArg {
  start: number;
  end: number;
}

export interface PaperTitle {
  // 翻訳へ渡す本文（コメント・\thanks・\footnote を除き、空白を 1 つに畳んだもの）。
  text: string;
  // 本文から外した \thanks{…} / \footnote{…}（原文の綴りのまま・出現順）。
  notes: string[];
}

export const TITLE_SEGMENT_ID = "title";

const NOTE_COMMANDS = new Set(["thanks", "footnote"]);
// 短縮タイトル [..] を読む長さの上限。契約付録 §8（本文全体を走る同期パスは走査量を有界にする）
const MAX_OPTIONAL_ARG = 1000;

const isLetter = (c: string | undefined): boolean => c !== undefined && /[a-zA-Z]/.test(c);

// tex[i] === "%" のとき、行末の改行と次行の行頭空白まで飛ばした位置を返す。
function skipComment(tex: string, i: number): number {
  const nl = tex.indexOf("\n", i);
  if (nl === -1) return tex.length;
  let j = nl + 1;
  while (j < tex.length && (tex[j] === " " || tex[j] === "\t")) j++;
  return j;
}

function skipSpaceAndComments(tex: string, i: number): number {
  let j = i;
  for (;;) {
    while (j < tex.length && /\s/.test(tex[j]!)) j++;
    if (tex[j] !== "%") return j;
    j = skipComment(tex, j);
  }
}

// tex[i] === "{" から対応する "}" の直後の位置。閉じなければ undefined。
function readBraced(tex: string, i: number): number | undefined {
  let depth = 0;
  for (let j = i; j < tex.length; j++) {
    const c = tex[j];
    if (c === "\\") j++;
    else if (c === "%") j = skipComment(tex, j) - 1;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return j + 1;
  }
  return undefined;
}

// tex[i] === "[" から、波括弧の外にある最初の "]" の直後の位置。上限内で閉じなければ undefined。
function readOptional(tex: string, i: number): number | undefined {
  let depth = 0;
  const stop = Math.min(tex.length, i + 1 + MAX_OPTIONAL_ARG);
  for (let j = i + 1; j < stop; j++) {
    const c = tex[j];
    if (c === "\\") j++;
    else if (c === "%") j = skipComment(tex, j) - 1;
    else if (c === "{") depth++;
    else if (c === "}") depth = Math.max(0, depth - 1);
    else if (c === "]" && depth === 0) return j + 1;
  }
  return undefined;
}

// \name[opt]{arg} の引数部（name の直後から）を読む。主引数の中身の範囲と、読み終えた位置を返す。
function readArgs(
  tex: string,
  from: number,
  optional: boolean,
): { arg: TitleArg; end: number } | "unclosed" | undefined {
  let j = skipSpaceAndComments(tex, from);
  if (optional && tex[j] === "[") {
    const after = readOptional(tex, j);
    if (after === undefined) return undefined;
    j = skipSpaceAndComments(tex, after);
  }
  if (tex[j] !== "{") return undefined;
  const end = readBraced(tex, j);
  if (end === undefined) return "unclosed";
  return { arg: { start: j + 1, end: end - 1 }, end };
}

// \iffalse の読み飛ばしで入れ子として数える条件分岐の綴り（TeX の基本命令。\newif で作った綴りは別途数える）。
const PRIMITIVE_IFS = new Set([
  "if",
  "ifcat",
  "ifnum",
  "ifdim",
  "ifodd",
  "ifvmode",
  "ifhmode",
  "ifmmode",
  "ifinner",
  "ifvoid",
  "ifhbox",
  "ifvbox",
  "ifx",
  "ifeof",
  "iftrue",
  "iffalse",
  "ifcase",
  "ifdefined",
  "ifcsname",
  "iffontchar",
  "ifincsname",
]);
const COMMENT_ENV_BEGIN = /\s*\{comment\}/y;
const COMMENT_ENV_END = "\\end{comment}";

const newifNames = (tex: string): Set<string> =>
  new Set([...tex.matchAll(/\\newif\s*\\(if[a-zA-Z]+)/g)].map((m) => m[1]!));

// \iffalse の名前の直後 from から、対応する \else または \fi の直後の位置（閉じなければ末尾）。契約付録 §8
function skipIffalse(tex: string, from: number, ifs: ReadonlySet<string>): number {
  let depth = 0;
  for (let i = from; i < tex.length; i++) {
    const c = tex[i];
    if (c === "%") {
      i = skipComment(tex, i) - 1;
      continue;
    }
    if (c !== "\\") continue;
    let j = i + 1;
    while (isLetter(tex[j])) j++;
    if (j === i + 1) {
      i++;
      continue;
    }
    const name = tex.slice(i + 1, j);
    if (PRIMITIVE_IFS.has(name) || ifs.has(name)) depth++;
    else if (depth === 0 && (name === "fi" || name === "else")) return j;
    else if (name === "fi") depth--;
    i = j - 1;
  }
  return tex.length;
}

// \begin の名前の直後 from が {comment} なら、\end{comment} の直後の位置（閉じなければ末尾）。契約付録 §8
function skipCommentEnv(tex: string, from: number): number | undefined {
  COMMENT_ENV_BEGIN.lastIndex = from;
  if (!COMMENT_ENV_BEGIN.test(tex)) return undefined;
  const end = tex.indexOf(COMMENT_ENV_END, COMMENT_ENV_BEGIN.lastIndex);
  return end === -1 ? tex.length : end + COMMENT_ENV_END.length;
}

// 制御綴り name の出現（コメント・エスケープ・\iffalse の偽の枝・comment 環境の外）ごとに visit を呼ぶ。
// visit が返した位置から走査を続ける。
function scanCommands(
  tex: string,
  names: ReadonlySet<string>,
  visit: (name: string, start: number, afterName: number) => number | "stop",
): void {
  let ifs: Set<string> | undefined;
  for (let i = 0; i < tex.length; i++) {
    const c = tex[i];
    if (c === "%") {
      i = skipComment(tex, i) - 1;
      continue;
    }
    if (c !== "\\") continue;
    let j = i + 1;
    while (isLetter(tex[j])) j++;
    if (j === i + 1) {
      i++; // 記号 1 文字の綴り（\\ \% \{ など）
      continue;
    }
    const name = tex.slice(i + 1, j);
    if (name === "iffalse") {
      ifs ??= newifNames(tex);
      i = skipIffalse(tex, j, ifs) - 1;
      continue;
    }
    const dead = name === "begin" ? skipCommentEnv(tex, j) : undefined;
    if (dead !== undefined) {
      i = dead - 1;
      continue;
    }
    if (!names.has(name)) {
      i = j - 1;
      continue;
    }
    const next = visit(name, i, j);
    if (next === "stop") return;
    i = next - 1;
  }
}

const DEFINERS = [
  "newcommand",
  "renewcommand",
  "providecommand",
  "DeclareRobustCommand",
  "let",
  "def",
  "gdef",
  "edef",
  "xdef",
];
const TITLE_SCAN = new Set(["title", ...DEFINERS]);

// 最後の \title[短縮]{本題} の本題の中身の範囲（LaTeX は後の定義が勝つ）。
export function findTitleArg(tex: string): TitleArg | undefined {
  let found: TitleArg | undefined;
  // 定義命令（* と空白・コメントを挟んでよい）の直後の \title は拾わない。契約付録 §8
  let definedAt = -1;
  scanCommands(tex, TITLE_SCAN, (name, start, afterName) => {
    if (name !== "title") {
      definedAt = skipSpaceAndComments(tex, afterName);
      if (tex[definedAt] === "*") definedAt = skipSpaceAndComments(tex, definedAt + 1);
      return afterName;
    }
    if (start === definedAt) return afterName;
    const r = readArgs(tex, afterName, true);
    if (r === "unclosed") return "stop";
    if (r === undefined) return afterName;
    found = r.arg;
    return r.end;
  });
  return found;
}

// 行コメントを TeX と同じく「% から次行の行頭空白まで」落とす。
export function stripTexComments(tex: string): string {
  let out = "";
  for (let i = 0; i < tex.length; i++) {
    const c = tex[i]!;
    if (c === "\\") {
      out += tex.slice(i, i + 2);
      i++;
    } else if (c === "%") {
      i = skipComment(tex, i) - 1;
    } else {
      out += c;
    }
  }
  return out;
}

function splitNotes(body: string): PaperTitle {
  const notes: string[] = [];
  let text = "";
  let pos = 0;
  scanCommands(body, NOTE_COMMANDS, (name, start, afterName) => {
    const r = readArgs(body, afterName, name === "footnote");
    if (r === "unclosed") return "stop";
    if (r === undefined) return afterName;
    text += body.slice(pos, start);
    notes.push(body.slice(start, r.end));
    pos = r.end;
    return r.end;
  });
  text += body.slice(pos);
  return { text, notes };
}

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

// 前文から翻訳対象のタイトルを取り出す。\title が無い・中身が空なら undefined。
export function extractTitle(preamble: string): PaperTitle | undefined {
  const arg = findTitleArg(preamble);
  if (arg === undefined) return undefined;
  const { text, notes } = splitNotes(stripTexComments(preamble.slice(arg.start, arg.end)));
  const body = oneLine(text);
  return body === "" ? undefined : { text: body, notes };
}

// 制御綴りを除いて文字・数字が残るか（\title{\papertitle} のようなマクロ参照だけの本題は false）。契約付録 §8
export function hasProse(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text.replace(/\\(?:[a-zA-Z]+|.)/gs, ""));
}

// 節ループへ通す 1 節。契約付録 §8
export function titleSegment(title: PaperTitle): Segment {
  const latex = `\\title{${title.text}}`;
  return { id: TITLE_SEGMENT_ID, latex, tokens: estimateTokens(latex) };
}

// 節ループの訳文から \title の中身を取り出す。無い・空なら undefined。
export function translatedTitle(ja: string): string | undefined {
  const arg = findTitleArg(ja);
  if (arg === undefined) return undefined;
  const body = oneLine(stripTexComments(ja.slice(arg.start, arg.end)));
  return body === "" ? undefined : body;
}

// 訳したタイトルの末尾へ、外しておいた \thanks / \footnote を原文のまま戻す。
export function composeTitle(ja: string, title: PaperTitle): string {
  return `${ja}${title.notes.join("")}`;
}

// 前文の最後の \title の主引数だけを body に差し替える。\title が無ければそのまま返す。
export function replaceTitle(preamble: string, body: string): string {
  const arg = findTitleArg(preamble);
  if (arg === undefined) return preamble;
  return `${preamble.slice(0, arg.start)}${body}${preamble.slice(arg.end)}`;
}
