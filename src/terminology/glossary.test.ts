import { describe, it, expect } from "vitest";
import { buildPaperGlossary } from "./glossary.js";
import { GlossaryDb } from "./db.js";
import { FakeLlmClient } from "../testing/fake-llm.js";

const resp = JSON.stringify({
  resolved: [
    { src: "attention", form: "アテンション", class: "established", rendering: "translate" },
  ],
  brief: { thesis: "t", sectionRoles: [], notationConventions: [] },
  style: { tensePolicy: "a", headingStyle: "b", numberStyle: "c" },
});

describe("buildPaperGlossary", () => {
  it("収集→build→proposed 書き戻し", async () => {
    const db = new GlossaryDb();
    const client = new FakeLlmClient(resp);
    const { out, proposedAdded } = await buildPaperGlossary(
      client,
      db,
      "p",
      "We use \\emph{attention} here.",
    );
    expect(out.resolved[0]!.form).toBe("アテンション");
    expect(proposedAdded).toBe(1);
    expect(db.allFor("attention")[0]!.ja).toBe("アテンション");
    expect(client.calls[0]!.user).toContain("attention");
    db.close();
  });

  it("同じ論文を2回流しても dedup（proposedAdded=0）", async () => {
    const db = new GlossaryDb();
    const client = new FakeLlmClient([resp, resp]);
    await buildPaperGlossary(client, db, "p", "\\emph{attention}");
    const second = await buildPaperGlossary(client, db, "p", "\\emph{attention}");
    expect(second.proposedAdded).toBe(0);
    db.close();
  });
});
