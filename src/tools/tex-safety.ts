import { JpaperError } from "../types/errors.js";

// 契約付録 §8。論文由来の LaTeX に含まれる読み出し・実行プリミティブの決定的検査。
// プリアンブルは翻訳対象ではなく verbatim に持ち越されるため、節ループの品質ゲート
// （訳文が持ち込んだ危険コマンドの検知）では一切カバーされない。ここで別に検査する。

// TeX の ^^ 記法を実文字へ戻す。^^41→"A"、^^64→"d"、^^M→制御文字（コード XOR 64）。
// これを戻さずに制御綴りを抽出すると \^^64irectlua が \directlua として発火するのに検知できない。
export function decodeCarets(tex: string): string {
  let prev = "";
  let cur = tex;
  // ^^ が入れ子で書かれても収束するまで戻す。長さは単調減少なので停止する。
  while (cur !== prev) {
    prev = cur;
    cur = cur
      .replace(/\^\^([0-9a-f]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/\^\^([@-~])/g, (_, c: string) =>
        String.fromCharCode(c.charCodeAt(0) ^ 64),
      );
  }
  return cur;
}

// コメントは実行されないので検査対象から外す（正規の論文での誤検知を減らす）。
export function stripTexComments(tex: string): string {
  return tex.replace(/(^|[^\\])%.*$/gm, (_m, head: string) => head);
}

// ビルドホストのファイルを読む・Lua を実行する・ファイルを書くプリミティブ。
// 正規の論文プリアンブルがこれらを直接使うことはまず無い（パッケージ内部での使用は
// .sty 側なので検査対象外）。\input / \include / \usepackage は正規の用途があるため含めない。
export const READ_EXEC_COMMANDS = [
  "directlua",
  "latelua",
  "luadirect",
  "luaexec",
  "luaescapestring",
  "openin",
  "read",
  "readline",
  "openout",
  "write",
  "shellescape",
  "ShellEscape",
  "pdfshellescape",
] as const;

// 論文が同梱する .sty/.cls 向けの狭い denylist。任意読み出しと Lua 実行だけを見る。
// \write / \openout は正規のクラスファイル（elsarticle・IEEEtran・llncs 等）が日常的に使い、
// 書き込み先は openout_any=p で build ツリーに閉じ込め済みなので含めない。
export const SUPPORT_READ_EXEC_COMMANDS = [
  "directlua",
  "latelua",
  "luadirect",
  "luaexec",
  "luaescapestring",
  "openin",
  "read",
  "readline",
] as const;

// ファイルを読み込むコマンド。正規の用途があるため名前だけでは落とせない（\input は日常的）。
// 判定は 2 つ: (1) 引数が絶対パスまたは .. を含む、(2) \csname で綴りを組み立てている。
// (2) は expandInputs（main-tex.ts）の正規表現をすり抜けてプリアンブルに残る経路そのもの。
export const READ_PATH_COMMANDS = [
  "input",
  "include",
  "@@input",
  "InputIfFileExists",
  "IfFileExists",
  "import",
  "subimport",
  "includefrom",
  "subincludefrom",
] as const;

const READ_PATH = new Set<string>(READ_PATH_COMMANDS);
const DENY = new Set<string>(READ_EXEC_COMMANDS);
const SUPPORT_DENY = new Set<string>(SUPPORT_READ_EXEC_COMMANDS);

// build ツリーの外を指す引数。~ と Windows のドライブ指定も絶対パス扱いにする。
function escapesBuildTree(arg: string): boolean {
  const a = arg.trim();
  if (a === "") return false;
  if (a.startsWith("/") || a.startsWith("~") || /^[a-zA-Z]:[\\/]/.test(a)) return true;
  return a.split(/[\\/]/).includes("..");
}

// 読み込みコマンドの引数を静的に検査する。\import{dir}{file} のような多引数も、
// 括弧を書かない TeX 形式（\input path）も、マクロ引数（\input\p）も同じ関門を通す。
// \import{dir}{file} は 2 引数、その他は 1 引数。多く読もうとすると、直後に続く別の
// コマンド（\input{a}\include{b}）を引数と誤認して落としてしまう。
const MULTI_ARG_READ = new Set(["import", "subimport", "includefrom", "subincludefrom"]);

interface ReadArgs {
  args: string[];
  // 引数が制御綴りを含む＝実行時に決まるので静的に検証できない。
  dynamic: boolean;
  // 引数が上限内で閉じない＝中身を読めていない。読めていない引数を「無害」と扱うと、
  // 空白で詰めるだけで検査を外せる（実機で \InputIfFileExists{<空白1100>/abs/path} が
  // ファイルを読み、内容が PDF に出た）。静的に検証できない以上、危険側へ倒す。
  unbounded: boolean;
}

// 引数として妥当な長さの上限。TeX のファイル名はこれより遥かに短い。閉じ波括弧を
// 末尾まで探すと、閉じない `\input{` を並べるだけの入力でマッチ数 × 末尾走査 = O(n²)
// になる（実測 4MiB で 20,040ms、6.3KB のアップロードで 40 秒イベントループ停止）。
const MAX_ARG_CHARS = 1_024;

// 走査する読み込みコマンドの候補数の上限。長さを縛っても候補は線形に増えるので、
// 総量（候補数 × 長さ）を抑えるには件数側にも上限が要る。実在の論文は数百件。
const MAX_READ_CANDIDATES = 20_000;

function findCloseAt(src: string, from: number, close: string): number {
  const limit = Math.min(src.length, from + MAX_ARG_CHARS);
  for (let i = from; i < limit; i++) if (src[i] === close) return i;
  return -1;
}

function findCloseBrace(src: string, from: number): number {
  return findCloseAt(src, from, "}");
}

function readArgsAt(src: string, from: number, argCount: number): ReadArgs {
  let i = from;
  const args: string[] = [];
  let dynamic = false;
  let unbounded = false;
  for (let n = 0; n < argCount; n++) {
    // TeX のファイル名スキャナは改行・CR・FF も読み飛ばす。空白とタブだけを飛ばすと、
    // 改行を 1 つ挟むだけで引数が空に見え、パスの検査が一度も走らない。
    while (i < src.length && /\s/.test(src[i]!)) i++;
    if (src[i] === "[") {
      // オプション引数は読み飛ばす（\import には無いが \includefrom 系の派生に備える）。
      const close = findCloseAt(src, i, "]");
      if (close === -1) {
        unbounded = true;
        break;
      }
      i = close + 1;
      n--;
      continue;
    }
    if (src[i] === "{") {
      const close = findCloseBrace(src, i);
      if (close === -1) {
        unbounded = true;
        break;
      }
      const body = src.slice(i + 1, close);
      if (body.includes("\\")) dynamic = true;
      args.push(body);
      i = close + 1;
      continue;
    }
    if (src[i] === "\\") {
      // \input\p のようにマクロを直接引数にした形。展開結果は静的には分からない。
      dynamic = true;
      break;
    }
    if (n === 0) {
      // 括弧なしの TeX 形式（\input path）。空白で終端する。
      const m = /^[^\s{}\\%]+/.exec(src.slice(i));
      if (m === null) break;
      args.push(m[0]);
      i += m[0].length;
    }
    break;
  }
  return { args, dynamic, unbounded };
}

// strict=false（同梱 .sty/.cls 向け）ではマクロ引数を許す。配布クラス由来のファイルは
// \InputIfFileExists{\@filef@und} のような動的引数を日常的に使うため（実測 18 件中 10 件）。
// 著者が書くプリアンブルには動的引数を使う理由が無いので、main.tex 側だけ strict にする。
function readPathHits(src: string, strict: boolean): string[] {
  const hits: string[] = [];
  const add = (name: string): void => {
    if (!hits.includes(name)) hits.push(name);
  };
  let candidates = 0;
  for (const m of src.matchAll(/\\([a-zA-Z@]+)/g)) {
    const name = m[1]!;
    if (!READ_PATH.has(name)) continue;
    if (++candidates > MAX_READ_CANDIDATES) {
      throw new JpaperError(
        2,
        "too-large",
        `読み込みコマンドが上限 ${MAX_READ_CANDIDATES} 件を超えています`,
      );
    }
    const argCount = MULTI_ARG_READ.has(name) ? 2 : 1;
    const { args, dynamic, unbounded } = readArgsAt(src, m.index + m[0].length, argCount);
    // 引数を連結して判定する（\import{./}{../secret} は第 2 引数だけ見ると無害に見える）。
    // unbounded は strict に関わらず落とす。これは正規の書き方ではなく検査の回避手口で、
    // 支援ファイルだけ許す理由が無い。
    if (
      unbounded ||
      (strict && dynamic) ||
      args.some(escapesBuildTree) ||
      escapesBuildTree(args.join(""))
    ) {
      add(name);
    }
  }
  return hits;
}

// \csname の本体は 1 回だけ集める。正規表現で \endcsname を探すと、閉じない \csname を
// 並べた入力でマッチ位置ごとに末尾まで走査して O(n²) になった（実測 1MiB で 144,204ms、
// 上限の 8MiB なら数時間の同期停止）。本体長・件数の両方に上限を掛けて線形に抑える。
const MAX_CSNAME_BODY_CHARS = 1_024;
const MAX_CSNAME_CANDIDATES = 20_000;
const CSNAME = "\\csname";
const ENDCSNAME = "\\endcsname";

interface CsnameBody {
  body: string;
  // 上限内で \endcsname が見つからない＝綴りが 1024 文字を超える。制御綴りを含まなければ
  // 実際に生える綴りも同じだけ長く、denylist のどれとも一致しないので名前照合から外す。
  unbounded: boolean;
}

function csnameBodies(src: string): CsnameBody[] {
  const out: CsnameBody[] = [];
  for (let i = src.indexOf(CSNAME); i !== -1; i = src.indexOf(CSNAME, i + CSNAME.length)) {
    if (out.length >= MAX_CSNAME_CANDIDATES) {
      throw new JpaperError(
        2,
        "too-large",
        `\\csname が上限 ${MAX_CSNAME_CANDIDATES} 件を超えています`,
      );
    }
    // 制御綴り直後の空白は TeX のトークナイザが読み飛ばすので、窓の起点も同じ位置に置く。
    // 生の位置から数えると、空白を 1024 文字詰めるだけで本体を窓の外へ押し出せる。
    let from = i + CSNAME.length;
    while (from < src.length && /\s/.test(src[from]!)) from++;
    const limit = Math.min(src.length, from + MAX_CSNAME_BODY_CHARS) - ENDCSNAME.length;
    let end = -1;
    for (let j = from; j <= limit; j++) {
      if (src.charCodeAt(j) === 0x5c && src.startsWith(ENDCSNAME, j)) {
        end = j;
        break;
      }
    }
    out.push({
      body: src.slice(from, end === -1 ? limit + ENDCSNAME.length : end),
      unbounded: end === -1,
    });
  }
  return out;
}

// 本体に制御綴りを含むものは名前照合の対象外（綴りが静的に決まらない）。
function staticBodies(bodies: readonly CsnameBody[]): string[] {
  return bodies
    .filter((b) => !b.unbounded && !b.body.includes("\\"))
    .map((b) => b.body.toLowerCase());
}

function csnameNames(bodies: readonly CsnameBody[]): string[] {
  const names: string[] = [];
  for (const body of staticBodies(bodies)) {
    names.push(body.replace(/\s+/g, ""));
    for (const token of body.split(/[^a-z@]+/)) if (token !== "") names.push(token);
  }
  return names;
}

// \csname で組み立てた読み込みコマンド。綴りを分解する正規の理由が無いため、
// 引数の形に関わらず落とす（トークン分割ではなく本体全体で照合し、誤検知を避ける）。
function obfuscatedReadHits(bodies: readonly CsnameBody[]): string[] {
  const hits: string[] = [];
  for (const raw of staticBodies(bodies)) {
    const body = raw.replace(/\s+/g, "");
    for (const name of READ_PATH) {
      if (body === name.toLowerCase() && !hits.includes(name)) hits.push(name);
    }
  }
  return hits;
}

// \csname の本体に制御綴りが混ざる形。\def\x{directlua}\csname\x\endcsname のように
// 実行時に綴りが決まるので、静的には何が発火するか分からない（実機で \directlua による
// 任意ファイル読み出しと PDF への流出を確認した）。著者のプリアンブルで綴りを
// マクロ越しに組み立てる正規の理由は無いので、main.tex では一律拒否する。
// 上限内で閉じない本体も、制御綴りを含むなら「実行時に決まる」側として扱う。展開結果が
// 短い綴りになる余地があり、静的には何が発火するか分からない点は閉じている場合と同じ。
function hasDynamicCsname(bodies: readonly CsnameBody[]): boolean {
  return bodies.some((b) => /\\[a-zA-Z@]/.test(b.body));
}

function scan(tex: string, deny: ReadonlySet<string>, strictReadArgs: boolean): string[] {
  const src = stripTexComments(decodeCarets(tex));
  const hits: string[] = [];
  const add = (name: string): void => {
    if (deny.has(name) && !hits.includes(name)) hits.push(name);
  };
  // 制御綴りは大小文字を区別する（\OPENIN は \openin ではない）ので、そのまま照合する。
  for (const m of src.matchAll(/\\([a-zA-Z]+)/g)) add(m[1]!);
  const bodies = csnameBodies(src);
  for (const name of csnameNames(bodies)) add(name);
  // 綴りが実行時に決まる \csname は、何が発火するか静的に分からない＝安全と示せない。
  if (strictReadArgs && hasDynamicCsname(bodies)) hits.push("csname");
  // 読み込みコマンドは名前では落とせないので、引数の形と難読化で判定する。
  for (const name of [...readPathHits(src, strictReadArgs), ...obfuscatedReadHits(bodies)]) {
    if (!hits.includes(name)) hits.push(name);
  }
  return hits;
}

// 検出したコマンド名（重複なし・入力順）。空配列なら検査通過。
export function findUnsafeTexCommands(tex: string): string[] {
  return scan(tex, DENY, true);
}

// 同梱支援ファイル用。誤検知で正規の論文を落とさないよう対象を絞る。
export function findUnsafeSupportCommands(tex: string): string[] {
  return scan(tex, SUPPORT_DENY, false);
}
