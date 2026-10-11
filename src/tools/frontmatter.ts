// 契約付録 §3・§8。論文の前付け（タイトル・組む位置・原文のまま残す命令）の表と、型の判定。
// 調査表の正本は docs/design/frontmatter-commands.md。
import type { Segment } from "../segment/segmenter.js";
import { commandSpans, envSpans, type Span } from "./tex-spans.js";

export interface FrontMatterProfile {
  id: string;
  // タイトルの本題を持つ命令（[短縮] は読み飛ばす）。走行タイトル（\icmltitlerunning など）は別の綴りなので数えない。
  titleCommands: readonly string[];
  // その場でタイトルを組む命令（組む位置は命令の直後）。
  selfSetting: readonly string[];
  // \maketitle がタイトルを組む位置か（iopart の \maketitle は改ページにすぎない）。
  maketitle: boolean;
  // 複数の \title を後勝ちでなく連結する（elsarticle）。
  accumulates: boolean;
  // 原文のまま残す命令と、その必須引数の数。
  keepCommands: Readonly<Record<string, number>>;
  // 原文のまま残す環境。
  keepEnvs: readonly string[];
}

// 著者・所属・注記。キーワードと PNAS の significance statement は訳すので入れない。契約付録 §3
const KEEP_COMMANDS: Readonly<Record<string, number>> = {
  author: 1,
  thanks: 1,
  affil: 1,
  affiliation: 1,
  affiliations: 1,
  additionalaffiliation: 1,
  altaffiliation: 1,
  address: 1,
  institute: 1,
  email: 1,
  ead: 1,
  homepage: 1,
  orcid: 1,
  orcidID: 1,
  orcidlink: 1,
  corref: 1,
  cortext: 1,
  cormark: 1,
  fnref: 1,
  fntext: 1,
  fnmark: 1,
  tnoteref: 1,
  tnotetext: 1,
  authornote: 1,
  authornotemark: 1,
  equalcontrib: 1,
  equalcont: 1,
  equalauthors: 1,
  correspondingauthor: 1,
  corres: 1,
  Author: 1,
  IEEEauthorblockN: 1,
  IEEEauthorblockA: 1,
  icmlauthor: 2,
  icmlaffiliation: 2,
  icmlcorrespondingauthor: 2,
  icmlsetsymbol: 2,
  aistatsauthor: 1,
  aistatsaddress: 1,
};

const KEEP_ENVS = ["icmlauthorlist", "affiliations"];

export const DEFAULT_PROFILE: FrontMatterProfile = {
  id: "default",
  titleCommands: ["title"],
  selfSetting: [],
  maketitle: true,
  accumulates: false,
  keepCommands: KEEP_COMMANDS,
  keepEnvs: KEEP_ENVS,
};

interface Rule {
  classes?: RegExp;
  packages?: RegExp;
  // 本文・前文に現れれば型を決める命令（改名した派生スタイルでも拾う）。
  commands?: readonly string[];
  profile: Partial<FrontMatterProfile> & { id: string };
}

// 上から順に最初に当たった型を使う。どれにも当たらなければ DEFAULT_PROFILE。
const RULES: readonly Rule[] = [
  {
    packages: /^icml\d{4}$/,
    commands: ["icmltitle"],
    profile: { id: "icml", titleCommands: ["icmltitle", "title"], selfSetting: ["icmltitle"] },
  },
  {
    packages: /^aistats\d{4}$/,
    commands: ["aistatstitle"],
    profile: { id: "aistats", titleCommands: ["aistatstitle", "title"], selfSetting: ["aistatstitle"] },
  },
  { classes: /^elsarticle$/, profile: { id: "elsarticle", accumulates: true } },
  {
    classes: /^iopart$/,
    profile: { id: "iopart", selfSetting: ["title"], maketitle: false },
  },
  {
    classes: /(^|\/)mdpi$/,
    profile: { id: "mdpi", titleCommands: ["Title"] },
  },
];

// 任意引数・名前の長さを区切り、名前の前後の空白は正規表現でなく trim で落とす。⚠ landmines.md
const DOCUMENTCLASS = /\\documentclass\s*(?:\[[^\]]{0,1000}\]\s*)?\{([^}]{0,200})\}/;
const USEPACKAGE = /\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]{0,1000}\]\s*)?\{([^}]{0,1000})\}/g;

// 行コメント（% から行末まで。\% はエスケープ）を落とす。型の判定だけに使う。
function uncommented(tex: string): string {
  let out = "";
  let from = 0;
  for (let i = 0; i < tex.length; i++) {
    const c = tex[i];
    if (c === "\\") i++;
    else if (c === "%") {
      out += tex.slice(from, i);
      const nl = tex.indexOf("\n", i);
      if (nl === -1) return out;
      from = i = nl;
    }
  }
  return out + tex.slice(from);
}

const usesCommand = (tex: string, name: string): boolean => new RegExp(`\\\\${name}(?![A-Za-z@])`).test(tex);

// \documentclass・\usepackage の名前と特徴的な命令から型を選ぶ。契約付録 §8
export function detectProfile(cleanLatex: string): FrontMatterProfile {
  const tex = uncommented(cleanLatex);
  const cls = (DOCUMENTCLASS.exec(tex)?.[1] ?? "").trim();
  const packages = [...tex.matchAll(USEPACKAGE)].flatMap((m) => m[1]!.split(",").map((p) => p.trim()));
  for (const r of RULES) {
    const hit =
      (r.classes !== undefined && r.classes.test(cls)) ||
      (r.packages !== undefined && packages.some((p) => r.packages!.test(p))) ||
      (r.commands !== undefined && r.commands.some((c) => usesCommand(tex, c)));
    if (hit) return { ...DEFAULT_PROFILE, ...r.profile };
  }
  return DEFAULT_PROFILE;
}

// 原文のまま残す区間（命令と引数・環境全体）。重なれば外側だけを、開始位置の順に返す。契約付録 §3
export function keptSpans(tex: string, profile: FrontMatterProfile = DEFAULT_PROFILE): Span[] {
  const all: Span[] = [];
  for (const [name, n] of Object.entries(profile.keepCommands)) {
    if (tex.includes(`\\${name}`)) for (const s of commandSpans(tex, name, n)) all.push(s);
  }
  for (const env of profile.keepEnvs) {
    if (tex.includes(`\\begin{${env}`)) for (const s of envSpans(tex, env)) all.push(s);
  }
  all.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const out: Span[] = [];
  for (const s of all) {
    const last = out[out.length - 1];
    if (last !== undefined && s[0] < last[1]) {
      if (s[1] > last[1]) last[1] = s[1];
      continue;
    }
    out.push([s[0], s[1]]);
  }
  return out;
}

// 節の frozen。分割で決めていない節（テストなどで直接作った節）は既定の型で決める。契約付録 §3
export function frozenSpansOf(seg: Pick<Segment, "latex" | "keep" | "frozen">): Span[] {
  if (seg.frozen !== undefined) return seg.frozen;
  const keep = seg.keep;
  return keptSpans(seg.latex).filter((f) => keep === undefined || f[1] <= keep.start || f[0] >= keep.end);
}
