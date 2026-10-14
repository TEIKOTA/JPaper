import { describe, it, expect } from "vitest";
import { buildPaperGlossary, writeBackResolved } from "./glossary.js";
import { GlossaryDb } from "./db.js";
import { FakeLlmClient } from "../testing/fake-llm.js";

const resp = JSON.stringify({
  resolved: [
    { src: "attention", form: "アテンション", class: "established", rendering: "translate" },
  ],
  brief: { thesis: "t", sectionRoles: [], notationConventions: [] },
  style: { tensePolicy: "a", headingStyle: "b", numberStyle: "c" },
});

describe("buildPaperGlossary / writeBackResolved", () => {
  it("本文の抜粋（abstract・見出し・冒頭）を glossary-builder に渡す（issue #258）", async () => {
    const c = new FakeLlmClient(resp);
    const db = new GlossaryDb();
    await buildPaperGlossary(
      c,
      db,
      "p",
      "\\begin{document}\\begin{abstract}We study attention.\\end{abstract}\\section{Method}We use attention. Done.\\end{document}",
    );
    expect(c.calls[0]!.user).toContain("> [abstract] We study attention.\n> § Method: We use attention. Done.");
    db.close();
  });

  it("収集→build し、候補を prompt に載せる", async () => {
    const db = new GlossaryDb();
    const client = new FakeLlmClient(resp);
    const out = await buildPaperGlossary(client, db, "p", "We use \\emph{attention} here.");
    expect(out.resolved[0]!.form).toBe("アテンション");
    expect(client.calls[0]!.user).toContain("attention");
    db.close();
  });

  it("writeBackResolved は初回のみ追加（dedup で再実行は 0）", async () => {
    const db = new GlossaryDb();
    const client = new FakeLlmClient(resp);
    const out = await buildPaperGlossary(client, db, "p", "\\emph{attention}");
    expect(writeBackResolved(db, out, "p")).toBe(1);
    expect(writeBackResolved(db, out, "p")).toBe(0);
    expect(db.allFor("attention")[0]!.ja).toBe("アテンション");
    db.close();
  });

  it("glossary-builder が句読点付きの src を返しても、確定語と書き戻しは句読点を落とす（issue #376）", async () => {
    const dirty = JSON.stringify({
      resolved: [
        { src: "Rashomon Ratio.", form: "ラショモン比。", class: "established", rendering: "translate" },
        {
          src: "Training with Data Subsets.",
          form: "データ部分集合による学習(Training with Data Subsets.)",
          class: "paper-defined",
          rendering: "bilingual",
        },
        { src: "et al.", form: "et al.", class: "do-not-translate", rendering: "keep-original" },
      ],
      brief: { thesis: "t", sectionRoles: [], notationConventions: [] },
      style: { tensePolicy: "a", headingStyle: "b", numberStyle: "c" },
    });
    const db = new GlossaryDb();
    const out = await buildPaperGlossary(new FakeLlmClient(dirty), db, "p", "\\textbf{Rashomon Ratio.} x");
    expect(out.resolved.map((r) => [r.src, r.form])).toEqual([
      ["Rashomon Ratio", "ラショモン比"],
      ["Training with Data Subsets", "データ部分集合による学習(Training with Data Subsets)"],
      ["et al.", "et al."],
    ]);
    const raw = JSON.parse(dirty) as typeof out;
    expect(writeBackResolved(db, raw, "p")).toBe(3);
    expect(db.allFor("Rashomon Ratio")[0]!.ja).toBe("ラショモン比");
    expect(db.allFor("Rashomon Ratio.")).toEqual([]);
    expect(db.allFor("Training with Data Subsets")[0]!.ja).toBe(
      "データ部分集合による学習(Training with Data Subsets)",
    );
    expect(db.allFor("et al.")[0]!.ja).toBe("et al.");
    db.close();
  });
});
