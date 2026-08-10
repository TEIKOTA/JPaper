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

const DENY = new Set<string>(READ_EXEC_COMMANDS);

// \csname openin\endcsname のように綴りを組み立てる回避も拾う。
function csnameBodies(tex: string): string[] {
  return [...tex.matchAll(/\\csname([^\\]*?)\\endcsname/g)].map((m) => m[1]!.trim());
}

// 検出したコマンド名（重複なし・入力順）。空配列なら検査通過。
export function findUnsafeTexCommands(tex: string): string[] {
  const src = stripTexComments(decodeCarets(tex));
  const hits: string[] = [];
  const add = (name: string): void => {
    if (DENY.has(name) && !hits.includes(name)) hits.push(name);
  };
  for (const m of src.matchAll(/\\([a-zA-Z]+)/g)) add(m[1]!);
  for (const body of csnameBodies(src)) add(body);
  return hits;
}
