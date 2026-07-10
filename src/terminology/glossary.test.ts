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
});
