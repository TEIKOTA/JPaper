// 契約付録 §2。横断用語 DB（node:sqlite・UNIQUE 無し・dedup はアプリ層 (src,ja,domain)）。
import type { DatabaseSync as DatabaseSyncInstance } from "node:sqlite";

// ⚠ docs/design/landmines.md
const sqlite = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");

const DDL = `
CREATE TABLE IF NOT EXISTS term (
  id          INTEGER PRIMARY KEY,
  src         TEXT NOT NULL,
  ja          TEXT,
  class       TEXT NOT NULL,
  rendering   TEXT NOT NULL,
  domain      TEXT,
  description TEXT,
  aliases     TEXT,
  status      TEXT NOT NULL CHECK(status IN ('confirmed','proposed')),
  source      TEXT
);
CREATE INDEX IF NOT EXISTS idx_term_src ON term(src);
`;

export interface TermEntry {
  src: string;
  ja: string | null;
  class: string;
  rendering: string;
  domain: string | null;
  description: string | null;
  aliases: string[];
  status: "confirmed" | "proposed";
  source: string | null;
}

export interface ProposedInput {
  src: string;
  ja?: string | null;
  class: string;
  rendering: string;
  domain?: string | null;
  description?: string | null;
  aliases?: string[];
  source?: string | null;
}

interface Row {
  src: string;
  ja: string | null;
  class: string;
  rendering: string;
  domain: string | null;
  description: string | null;
  aliases: string | null;
  status: string;
  source: string | null;
}

function toEntry(r: Row): TermEntry {
  return {
    src: r.src,
    ja: r.ja,
    class: r.class,
    rendering: r.rendering,
    domain: r.domain,
    description: r.description,
    aliases: r.aliases ? (JSON.parse(r.aliases) as string[]) : [],
    status: r.status === "confirmed" ? "confirmed" : "proposed",
    source: r.source,
  };
}

export class GlossaryDb {
  private readonly db: DatabaseSyncInstance;

  constructor(location = ":memory:") {
    this.db = new sqlite.DatabaseSync(location);
    this.db.exec(DDL);
  }

  close(): void {
    this.db.close();
  }

  private exists(src: string, ja: string | null, domain: string | null): boolean {
    const row = this.db
      .prepare(
        "SELECT 1 FROM term WHERE src=? AND IFNULL(ja,'')=IFNULL(?,'') AND IFNULL(domain,'')=IFNULL(?,'') LIMIT 1",
      )
      .get(src, ja, domain);
    return row !== undefined;
  }

  writeBackProposed(entries: ProposedInput[]): number {
    const insert = this.db.prepare(
      "INSERT INTO term (src,ja,class,rendering,domain,description,aliases,status,source) VALUES (?,?,?,?,?,?,?,'proposed',?)",
    );
    let added = 0;
    for (const e of entries) {
      const ja = e.ja ?? null;
      const domain = e.domain ?? null;
      if (this.exists(e.src, ja, domain)) continue;
      insert.run(
        e.src,
        ja,
        e.class,
        e.rendering,
        domain,
        e.description ?? null,
        e.aliases ? JSON.stringify(e.aliases) : null,
        e.source ?? null,
      );
      added++;
    }
    return added;
  }

  promote(src: string, ja: string | null, domain: string | null): number {
    const r = this.db
      .prepare(
        "UPDATE term SET status='confirmed' WHERE src=? AND IFNULL(ja,'')=IFNULL(?,'') AND IFNULL(domain,'')=IFNULL(?,'')",
      )
      .run(src, ja, domain);
    return Number(r.changes);
  }

  confirmedFor(src: string): TermEntry[] {
    return (
      this.db
        .prepare("SELECT * FROM term WHERE src=? AND status='confirmed'")
        .all(src) as unknown as Row[]
    ).map(toEntry);
  }

  allFor(src: string): TermEntry[] {
    return (
      this.db.prepare("SELECT * FROM term WHERE src=?").all(src) as unknown as Row[]
    ).map(toEntry);
  }

  allSrcTerms(): string[] {
    return (
      this.db.prepare("SELECT DISTINCT src FROM term").all() as unknown as {
        src: string;
      }[]
    ).map((r) => r.src);
  }

  matchKnownTerms(text: string): string[] {
    return this.allSrcTerms()
      .sort((a, b) => b.length - a.length)
      .filter((t) => text.includes(t));
  }
}
