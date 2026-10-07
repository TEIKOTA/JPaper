// 契約付録 §1（翻訳対象の地の文が無い節）。

const DEFINITION = /^\\(?:def|gdef|edef|xdef|let|newcommand\*?|renewcommand\*?|providecommand\*?|DeclareMathOperator\*?|DeclareRobustCommand\*?|newcolumntype)(?![A-Za-z@])/;

function stripComment(line: string): string {
  return line.replace(/((?:^|[^\\])(?:\\\\)*)%.*$/, "$1");
}

// 節がマクロ定義だけでできている（波括弧の外の行がすべて定義命令で始まる）。⚠ landmines.md
export function isMacroDefinitionsOnly(latex: string): boolean {
  let depth = 0;
  let sawDefinition = false;
  for (const raw of latex.split("\n")) {
    const line = stripComment(raw);
    const trimmed = line.trim();
    if (depth === 0 && trimmed !== "") {
      if (!DEFINITION.test(trimmed)) return false;
      sawDefinition = true;
    }
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === "{") depth++;
      else if (c === "}") depth = Math.max(0, depth - 1);
    }
  }
  return sawDefinition && depth === 0;
}
