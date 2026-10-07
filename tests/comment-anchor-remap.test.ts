/**
 * Integration test for roadmap Step 3 — `remapPageComments` /
 * `buildCommentRemapStatement` (READER_COMMENT_ANCHOR_DURABILITY_ROADMAP.md).
 *
 * SQLite cannot prove PostgreSQL for everything, but it *can* prove the one
 * property this design exists for: SQLite and PostgreSQL both evaluate a
 * single `UPDATE`'s `CASE` and `WHERE` against each row's pre-statement value,
 * while sequential statements see each other's writes. So rendering the real
 * drizzle statement through `PgDialect`, converting `$N` placeholders to
 * positional `?`, and executing it against an in-memory table demonstrates the
 * atomicity the roadmap demands — and the `control` test below shows the
 * forbidden loop form failing the same scenario.
 *
 * Honest limits: no live Postgres here, so column types, `RETURNING` and
 * isolation level are exercised only through SQLite's compatible subset, and
 * no transaction/rollback is simulated (the statement itself is the unit under
 * test; its call site places it inside the prose transaction).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  buildCommentRemapStatement,
  remapPageComments,
  type CommentRemapExecutor,
} from "../src/services/comment_anchor_alignment.js";

const PAGE = "page-1";
const OTHER_PAGE = "page-2";
const dialect = new PgDialect();

let db: Database;
let executedStatements: number;

type AnchorMap = Record<string, number | null>;

/**
 * Runs a rendered statement and returns its `RETURNING paragraph_number` rows.
 * `$N` is mapped back to a positional parameter by number (not by encounter
 * order) so the conversion stays correct even if drizzle ever reorders chunks.
 */
function runReturning(statement: SQL): Array<{ paragraph_number: number | null }> {
  const compiled = dialect.sqlToQuery(statement);
  const order: number[] = [];
  const text = compiled.sql.replace(/\$(\d+)/g, (_match, digits: string) => {
    order.push(Number(digits));
    return "?";
  });
  const params = order.map((index) => compiled.params[index - 1]);
  return db
    .query(text)
    .all<{ paragraph_number: number | null }>(...(params as never[]));
}

const sqliteExecutor: CommentRemapExecutor = {
  execute(statement: SQL) {
    executedStatements++;
    return Promise.resolve({ rows: runReturning(statement) });
  },
};

function seed(rows: ReadonlyArray<readonly [id: string, pageId: string, anchor: number | null]>): void {
  for (const [id, pageId, anchor] of rows) {
    db.run(
      "INSERT INTO user_comments (id, page_id, paragraph_number) VALUES (?, ?, ?)",
      id,
      pageId,
      anchor,
    );
  }
}

function anchors(pageId: string): AnchorMap {
  const rows = db
    .query("SELECT id, paragraph_number FROM user_comments WHERE page_id = ? ORDER BY id")
    .all<{ id: string; paragraph_number: number | null }>(pageId);
  const result: AnchorMap = {};
  for (const row of rows) result[row.id] = row.paragraph_number;
  return result;
}

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(`
    CREATE TABLE user_comments (
      id TEXT PRIMARY KEY,
      page_id TEXT NOT NULL,
      paragraph_number INTEGER
    );
  `);
  executedStatements = 0;
});

afterEach(() => {
  db.close();
});

describe("comment anchor remap", () => {
  it("reorders {1→2, 2→1} and demotes 3 in one statement, leaving other pages and NULL anchors alone", async () => {
    seed([
      ["c1", PAGE, 1],
      ["c2", PAGE, 2],
      ["c3", PAGE, 3],
      ["other", OTHER_PAGE, 1],
      ["page-level", PAGE, null],
    ]);

    const stats = await remapPageComments(
      sqliteExecutor,
      PAGE,
      "Alpha\n\nBeta\n\nGamma",
      "Beta\n\nAlpha",
    );

    // The atomic result: every comment sits on the paragraph it discussed.
    expect(anchors(PAGE)).toEqual({ c1: 2, c2: 1, c3: null, "page-level": null });
    // Scope is page-local and never resurrects a page-level comment.
    expect(anchors(OTHER_PAGE)).toEqual({ other: 1 });
    // One `execute` per remap — a regression to a per-anchor loop would raise this.
    expect(executedStatements).toBe(1);
    expect(stats).toEqual({
      remapped: 2,
      demoted: 1,
      oldParagraphCount: 3,
      newParagraphCount: 2,
    });
  });

  it("emits exactly one UPDATE with one CASE and no statement separator", () => {
    const statement = buildCommentRemapStatement(PAGE, {
      remapped: new Map([
        [1, 2],
        [2, 1],
      ]),
      demoted: [3],
    });
    if (!statement) throw new Error("expected a remap statement for a reorder + demotion");

    const text = dialect.sqlToQuery(statement).sql;
    expect(text.match(/\bUPDATE\b/g)).toHaveLength(1);
    expect(text.match(/\bCASE\b/g)).toHaveLength(1);
    expect(text).not.toContain(";");
  });

  it("control: the forbidden per-anchor loop collapses the same reorder", () => {
    seed([
      ["c1", PAGE, 1],
      ["c2", PAGE, 2],
      ["c3", PAGE, 3],
    ]);

    // The sequential form the roadmap forbids: each statement sees the
    // previous one's writes, so the swap cannot survive.
    db.run(
      "UPDATE user_comments SET paragraph_number = ? WHERE page_id = ? AND paragraph_number = ?",
      2,
      PAGE,
      1,
    );
    db.run(
      "UPDATE user_comments SET paragraph_number = ? WHERE page_id = ? AND paragraph_number = ?",
      1,
      PAGE,
      2,
    );

    // Both comments collapsed onto anchor 1, and anchor 3 was never demoted —
    // exactly the corruption the single-statement form prevents.
    expect(anchors(PAGE)).toEqual({ c1: 1, c2: 1, c3: 3 });
  });

  it("demotes only the anchors whose paragraph disappeared", async () => {
    seed([
      ["c1", PAGE, 1],
      ["c2", PAGE, 2],
      ["c3", PAGE, 3],
    ]);

    const stats = await remapPageComments(
      sqliteExecutor,
      PAGE,
      "Alpha\n\nBeta\n\nGamma",
      "Alpha",
    );

    // Anchor 1 is untouched (identity mappings are not rewritten), so it is
    // absent from RETURNING and counts as neither remapped nor demoted.
    expect(anchors(PAGE)).toEqual({ c1: 1, c2: null, c3: null });
    expect(stats).toEqual({
      remapped: 0,
      demoted: 2,
      oldParagraphCount: 3,
      newParagraphCount: 1,
    });
    expect(executedStatements).toBe(1);
  });

  it("issues no statement for a pure identity alignment", async () => {
    const statement = buildCommentRemapStatement(PAGE, {
      remapped: new Map([
        [1, 1],
        [2, 2],
      ]),
      demoted: [],
    });
    expect(statement).toBeNull();

    // Texts differ only by a trailing separator — same canonical paragraphs.
    const stats = await remapPageComments(
      sqliteExecutor,
      PAGE,
      "Alpha\n\nBeta",
      "Alpha\n\nBeta\n\n",
    );

    expect(stats).toEqual({
      remapped: 0,
      demoted: 0,
      oldParagraphCount: 2,
      newParagraphCount: 2,
    });
    expect(executedStatements).toBe(0);
  });

  it("issues no statement when the prose is unchanged", async () => {
    const stats = await remapPageComments(sqliteExecutor, PAGE, "Alpha", "Alpha");

    expect(stats).toEqual({
      remapped: 0,
      demoted: 0,
      oldParagraphCount: 1,
      newParagraphCount: 1,
    });
    expect(executedStatements).toBe(0);
  });

  it("throws on an unexpected RETURNING row instead of silently miscounting", async () => {
    const broken: CommentRemapExecutor = {
      execute: () => Promise.resolve({ rows: [{ unexpected: 1 }] }),
    };

    let error: unknown;
    try {
      await remapPageComments(broken, PAGE, "Alpha", "Beta");
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("RETURNING row shape");
  });
});
