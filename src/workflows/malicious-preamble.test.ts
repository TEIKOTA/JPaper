import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(path.join(os.tmpdir(), "jpaper-preamble-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// プリアンブルは翻訳されず verbatim に持ち越されるので、節ループの品質ゲートでは検査されない。
const EVIL = String.raw`\documentclass{article}
\newread\myin \openin\myin=/etc/passwd \read\myin to\leaked \closein\myin
\begin{document}\section{Intro}Alpha beta gamma delta.\end{document}`;

const CLEAN = String.raw`\documentclass{article}
\begin{document}\section{Intro}Alpha beta gamma delta.\end{document}`;

async function run(content: string) {
  const { translatePaper } = await import("./translate-paper.js");
  const { FakeLlmClient } = await import("../testing/fake-llm.js");
  const { GlossaryDb } = await import("../terminology/db.js");
  const { makeTar } = await import("../ingest/archive.fixtures.js");

  const work = tmp();
  const tar = path.join(work, "p.tar");
  writeFileSync(tar, makeTar([{ name: "main.tex", content }]));
  let calls = 0;
  const result = await translatePaper(
    { kind: "path", path: tar },
    { provider: "ollama", outDir: path.join(work, "out") },
    {
      client: new FakeLlmClient((req) => {
        calls++;
        if (req.system.includes("編纂者")) {
          return JSON.stringify({
            resolved: [],
            brief: { thesis: "核", sectionRoles: [], notationConventions: [] },
            style: { tensePolicy: "a", headingStyle: "b", numberStyle: "c" },
          });
        }
        if (req.system.includes("審査者")) return '{"verdict":"pass","issues":[]}';
        return '{"segmentId":"x","ja":"これは訳文である。"}';
      }),
      db: new GlossaryDb(),
      latexRunner: (d) => {
        writeFileSync(path.join(d, "main.pdf"), "%PDF");
        return { code: 0, log: "Output written on main.pdf (1 page)." };
      },
    },
  );
  return { result, calls: () => calls };
}

describe("プリアンブル経由のファイル読み出し", () => {
  it("読み出しプリミティブを含む論文は LLM を呼ぶ前に拒否する", async () => {
    const { result, calls } = await run(EVIL);
    expect(result.status).toBe("failed");
    expect(result.error?.kind).toBe("input");
    expect(result.error?.message).toContain("openin");
    expect(calls()).toBe(0); // 悪意ある論文に LLM コストを払わない
  });

  it("正規の論文はこれまでどおり通る", async () => {
    const { result, calls } = await run(CLEAN);
    expect(result.status).toBe("ok");
    expect(calls()).toBeGreaterThan(0);
  });
});

describe("組版ゲートの多層防御", () => {
  it("組立後の main.tex に混入していれば latexmk を起動せず失敗させる", async () => {
    const { runBuildGate } = await import("../tools/build-gate.js");
    const dir = tmp();
    let ran = false;
    const r = await runBuildGate(
      {
        buildDir: path.join(dir, "build"),
        mainTex: String.raw`\documentclass{article}\directlua{os.time()}\begin{document}x\end{document}`,
        sourceDir: dir,
        mainDir: dir,
        figures: [],
        sourceMap: [],
      },
      () => {
        ran = true;
        return { code: 0, log: "" };
      },
    );
    expect(r.buildOk).toBe(false);
    expect(ran).toBe(false);
    expect(r.structuralErrors[0]).toContain("directlua");
  });
});

describe("同梱 .sty 経由の読み出し", () => {
  const STY_TEX = "\\documentclass{article}\\usepackage{jphack}" +
    "\\begin{document}\\section{Intro}Alpha beta gamma delta.\\end{document}";

  async function runWithSty(styBody: string, styName = "jphack.sty") {
    const { translatePaper } = await import("./translate-paper.js");
    const { FakeLlmClient } = await import("../testing/fake-llm.js");
    const { GlossaryDb } = await import("../terminology/db.js");
    const { makeTar } = await import("../ingest/archive.fixtures.js");

    const work = tmp();
    const tar = path.join(work, "p.tar");
    writeFileSync(
      tar,
      makeTar([
        { name: "main.tex", content: STY_TEX },
        { name: styName, content: styBody },
      ]),
    );
    let calls = 0;
    const result = await translatePaper(
      { kind: "path", path: tar },
      { provider: "ollama", outDir: path.join(work, "out") },
      {
        client: new FakeLlmClient((req) => {
          calls++;
          if (req.system.includes("編纂者")) {
            return JSON.stringify({
              resolved: [],
              brief: { thesis: "核", sectionRoles: [], notationConventions: [] },
              style: { tensePolicy: "a", headingStyle: "b", numberStyle: "c" },
            });
          }
          if (req.system.includes("審査者")) return '{"verdict":"pass","issues":[]}';
          return '{"segmentId":"x","ja":"これは訳文である。"}';
        }),
        db: new GlossaryDb(),
        latexRunner: (d) => {
          writeFileSync(path.join(d, "main.pdf"), "%PDF");
          return { code: 0, log: "Output written on main.pdf (1 page)." };
        },
      },
    );
    return { result, calls: () => calls };
  }

  it("同梱 .sty の Lua 実行は LLM を呼ぶ前に拒否する（main.tex は無害でも）", async () => {
    const { result, calls } = await runWithSty(
      '\\directlua{local f=io.open("/etc/hosts","r") tex.sprint(f:read("*a"))}',
    );
    expect(result.status).toBe("failed");
    expect(result.error?.kind).toBe("input");
    expect(result.error?.message).toContain("jphack.sty");
    expect(result.error?.message).toContain("directlua");
    expect(calls()).toBe(0);
  });

  it("\\write / \\openout だけの .sty は通す（正規のクラスファイルを落とさない）", async () => {
    const { result } = await runWithSty(
      "\\newwrite\\jp@toc \\immediate\\openout\\jp@toc=\\jobname.jptoc \\immediate\\write\\jp@toc{x}",
    );
    expect(result.status).toBe("ok");
  });
});

describe("\\csname で綴りを組み立てた読み込み", () => {
  // expandInputs の正規表現をすり抜けてプリアンブルに残り、latexmk が実際に読む経路。
  const EXFIL = String.raw`\documentclass{article}
\begin{document}\section{Intro}Exfil: \csname input\endcsname{/etc/passwd} Alpha beta.\end{document}`;

  it("LLM を呼ぶ前に input エラーで落とす", async () => {
    const { result, calls } = await run(EXFIL);
    expect(result.status).toBe("failed");
    expect(result.error?.kind).toBe("input");
    expect(result.error?.message).toContain("input");
    expect(calls()).toBe(0);
  });

  it("expandInputs が畳まない綴り（\\InputIfFileExists）の絶対パスも落とす", async () => {
    // 素の \input{/abs} は expandInputs が除去するため cleanLatex に残らない。
    // 残るのは畳まれない綴りの方で、そこが実際の流出経路。
    const { result } = await run(
      String.raw`\documentclass{article}
\InputIfFileExists{/etc/passwd}{}{}
\begin{document}\section{Intro}Alpha beta.\end{document}`,
    );
    expect(result.status).toBe("failed");
    expect(result.error?.kind).toBe("input");
  });
});
