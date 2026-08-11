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

// 他プロセスの書き込みを待つ上限。run 全体の期限（timeoutMs）より十分短く取る。
const BUSY_TIMEOUT_MS = 5_000;

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

  // 契約付録 §2。busy timeout を置かないと、他プロセスが書いている間は DDL の
  // 書き込みトランザクションが即 SQLITE_BUSY になる。既定の dbPath は単一ユーザ共有
  // なので、web を複数 worker で動かした瞬間に全 run が落ちる。⚠ landmines.md
  constructor(location = ":memory:") {
    this.db = new sqlite.DatabaseSync(location, { timeout: BUSY_TIMEOUT_MS });
    // WAL は読み手と書き手を並行させる（既定の rollback journal では読みも排他される）。
    // journal_mode の変更は排他ロックを要求し、busy handler を経由せず即 SQLITE_BUSY を
    // 返しうる。WAL は DB ファイルに永続するので、他プロセスが先に設定していれば
    // それを引き継ぐだけでよい。ここで落ちる理由が無い。
    if (location !== ":memory:") {
      try {
        this.db.exec("PRAGMA journal_mode=WAL");
      } catch {
        /* 他プロセスが設定中。既存の journal_mode のまま続ける。 */
      }
    }
    this.db.exec(`PRAGMA busy_timeout=${String(BUSY_TIMEOUT_MS)}`);
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
    // UNIQUE 制約が無いので dedup（exists→insert）はアプリ層。プロセスを跨いで
    // 直列化しないと同じ (src,ja,domain) が二重に入る。BEGIN IMMEDIATE で書き込み
    // ロックを先に取る（busy timeout の範囲で待つ）。
    this.db.exec("BEGIN IMMEDIATE");
    try {
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
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
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

  // 承認済みの語だけ。proposed は他論文の処理に影響してはならない（用語汚染 ADR 20260811）。
  confirmedSrcTerms(): string[] {
    return (
      this.db
        .prepare("SELECT DISTINCT src FROM term WHERE status='confirmed'")
        .all() as unknown as { src: string }[]
    ).map((r) => r.src);
  }

  matchKnownTerms(text: string): string[] {
    return this.confirmedSrcTerms()
      .sort((a, b) => b.length - a.length)
      .filter((t) => text.includes(t));
  }
}
