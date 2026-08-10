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

const DENY = new Set<string>(READ_EXEC_COMMANDS);
const SUPPORT_DENY = new Set<string>(SUPPORT_READ_EXEC_COMMANDS);

// \csname openin\endcsname のように綴りを組み立てる回避も拾う。
// TeX の \lowercase は文字トークンだけを畳むので、\lowercase{\csname OPENIN\endcsname} は
// 実行時に \openin になる。本文は大小文字を畳んで照合する（実証済みの回避経路）。
function csnameNames(tex: string): string[] {
  const names: string[] = [];
  for (const m of tex.matchAll(/\\csname([^\\]*?)\\endcsname/g)) {
    const body = m[1]!.toLowerCase();
    names.push(body.replace(/\s+/g, ""));
    for (const token of body.split(/[^a-z@]+/)) if (token !== "") names.push(token);
  }
  return names;
}

function scan(tex: string, deny: ReadonlySet<string>): string[] {
  const src = stripTexComments(decodeCarets(tex));
  const hits: string[] = [];
  const add = (name: string): void => {
    if (deny.has(name) && !hits.includes(name)) hits.push(name);
  };
  // 制御綴りは大小文字を区別する（\OPENIN は \openin ではない）ので、そのまま照合する。
  for (const m of src.matchAll(/\\([a-zA-Z]+)/g)) add(m[1]!);
  for (const name of csnameNames(src)) add(name);
  return hits;
}

// 検出したコマンド名（重複なし・入力順）。空配列なら検査通過。
export function findUnsafeTexCommands(tex: string): string[] {
  return scan(tex, DENY);
}

// 同梱支援ファイル用。誤検知で正規の論文を落とさないよう対象を絞る。
export function findUnsafeSupportCommands(tex: string): string[] {
  return scan(tex, SUPPORT_DENY);
}
