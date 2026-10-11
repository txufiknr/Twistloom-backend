/**
 * Explore sort/filter SQL contract tests.
 *
 * Pins the invariant that every book sort's membership predicate is folded
 * into the SINGLE combined WHERE clause rather than applied via a chained
 * `.where()` call. Drizzle's `.where()` ASSIGNS `config.where` (last call
 * wins), so a second `.where()` silently discards the base
 * `status='active' + visibility='public'` scope — leaking private/draft books
 * into public explore shelves and inflating pagination totals.
 *
 * This was a live production bug: `originals` generated
 * `WHERE image_id IS NOT NULL` (dropping both `is_original` and the base
 * scope). These tests assert on generated SQL via `.toSQL()` — no database
 * connection is made, so they run in milliseconds and cannot flake.
 */
import { afterAll, describe, expect, it, mock } from "bun:test";
import { and, eq } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { books, users } from "../src/db/schema.js";
import type { BookSortOption } from "../src/types/book.js";

// `buildBookQuery` builds its pagination COUNT via `dbRead.select(...)`, and
// drizzle can render `.toSQL()` with no live connection. Some earlier suite
// files replace `dbRead` with a `.select()` that throws (e.g. to assert a
// credential path never reads a replica), and Bun's `mock.module` is
// process-global — so this file installs a connection-free `dbRead` of its own
// and restores the actual module in `afterAll` (see the mock-restore rule in
// `tests/helpers/store-verification-db.ts`).
const actualDbClient = await import("../src/db/client.js");
mock.module("../src/db/client.js", () => ({
  ...actualDbClient,
  dbRead: { select: (fields?: unknown) => new QueryBuilder().select(fields as never) },
}));

// Imported AFTER the mock so the binding `buildBookQuery` resolves is the
// connection-free stand-in above.
const { buildBookQuery, getEnrichedBookSelect } = await import("../src/services/book-controller.js");

afterAll(() => {
  mock.module("../src/db/client.js", () => actualDbClient);
});

/**
 * Base scope the explore route always applies. Every sort must retain it.
 */
const baseCondition = and(eq(books.status, "active"), eq(books.visibility, "public"))!;

/**
 * Builds a query the same way the explore route does: enriched select joined
 * to `users` for author data, plus the active/public base scope.
 */
function buildExploreQuery(params: {
  bookSortBy?: BookSortOption;
  currentUserId?: string | null;
  personalized?: boolean;
  tags?: string[];
  collection?: string;
}) {
  const baseQuery = getFakeDb()
    .select(getEnrichedBookSelect(null))
    .from(books)
    .leftJoin(users, eq(books.userId, users.userId));

  return buildBookQuery({
    baseQuery,
    baseCondition,
    ...params,
  });
}

/**
 * Minimal drizzle query builder stand-in — enough for `.select().from()`
 * chains and `.toSQL()`, with no connection or pool. Mirrors what
 * `dbRead.select(...)` returns for query-shape purposes.
 */
function getFakeDb() {
  return { select: (fields?: unknown) => new QueryBuilder().select(fields as never) };
}

/**
 * Extracts the OUTER-most WHERE clause from generated SQL.
 *
 * Naive `lastIndexOf(" where ")` matches the innermost subquery's WHERE (e.g.
 * inside an `EXISTS (...)`), so this scans for the first `where` keyword at
 * parenthesis depth 0 — the top-level clause.
 */
function whereClause(sql: string): string {
  const lowered = sql.toLowerCase();
  let depth = 0;
  let i = 0;
  while (i < lowered.length) {
    const ch = lowered[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    else if (depth === 0 && lowered.startsWith(" where ", i)) {
      return sql.slice(i + 7);
    }
    i += 1;
  }
  return "";
}

/**
 * Asserts the combined WHERE retains BOTH the active status and public
 * visibility predicates — the leak this suite exists to prevent.
 */
function expectRetainsBaseScope(where: string, label: string) {
  expect(where, `${label}: WHERE must retain status='active'`).toContain('"books"."status"');
  expect(where, `${label}: WHERE must retain visibility='public'`).toContain('"books"."visibility"');
}

describe("Explore sort membership predicates fold into the combined WHERE", () => {
  it("newest retains the base scope (ordering-only sort)", () => {
    const { query, countQuery } = buildExploreQuery({ bookSortBy: "newest" });
    expectRetainsBaseScope(whereClause(query.toSQL().sql), "newest");
    expectRetainsBaseScope(whereClause(countQuery.toSQL().sql), "newest/count");
  });

  it("for-you retains base scope AND tags filter AND the interest predicate", () => {
    const { query, countQuery } = buildExploreQuery({
      bookSortBy: "for-you",
      currentUserId: "user-123",
      tags: ["mystery"],
    });

    const resultWhere = whereClause(query.toSQL().sql);
    const countWhere = whereClause(countQuery.toSQL().sql);

    expectRetainsBaseScope(resultWhere, "for-you");
    expectRetainsBaseScope(countWhere, "for-you/count");

    // tags= filter must AND with the sort predicate, not be discarded by it.
    expect(resultWhere).toContain('"books"."keywords" &&');
    expect(countWhere).toContain('"books"."keywords" &&');

    // Interest predicate: cold-start cardinality guard + read exclusion.
    expect(resultWhere).toContain("cardinality");
    expect(resultWhere).toContain("NOT EXISTS");
    expect(countWhere).toContain("cardinality");
    expect(countWhere).toContain("NOT EXISTS");
  });

  it("for-you for an anonymous viewer collapses to 1=0 while keeping the base scope", () => {
    const { countQuery } = buildExploreQuery({
      bookSortBy: "for-you",
      currentUserId: null,
    });
    const where = whereClause(countQuery.toSQL().sql);
    expectRetainsBaseScope(where, "for-you/anonymous");
    expect(where).toContain("1=0");
  });

  it("originals retains is_original AND the base scope", () => {
    // The historical leak: chained .where() reduced this to `image_id IS NOT NULL`.
    const { query, countQuery } = buildExploreQuery({ bookSortBy: "originals" });

    const resultWhere = whereClause(query.toSQL().sql);
    const countWhere = whereClause(countQuery.toSQL().sql);

    expectRetainsBaseScope(resultWhere, "originals");
    expectRetainsBaseScope(countWhere, "originals/count");

    expect(resultWhere).toContain('"books"."is_original"');
    expect(resultWhere).toContain('"books"."image_id" IS NOT NULL');
    expect(countWhere).toContain('"books"."is_original"');
    expect(countWhere).toContain('"books"."image_id" IS NOT NULL');
  });

  it("top-picks with personalized=true retains top_pick filter, base scope, and interest predicate", () => {
    const { query, countQuery } = buildExploreQuery({
      bookSortBy: "top-picks",
      personalized: true,
      currentUserId: "user-123",
    });

    const resultWhere = whereClause(query.toSQL().sql);
    const countWhere = whereClause(countQuery.toSQL().sql);

    expectRetainsBaseScope(resultWhere, "top-picks+personalized");
    expectRetainsBaseScope(countWhere, "top-picks+personalized/count");

    expect(resultWhere).toContain('"books"."top_pick" IS NOT NULL');
    expect(resultWhere).toContain("cardinality");
    expect(countWhere).toContain('"books"."top_pick" IS NOT NULL');
    expect(countWhere).toContain("cardinality");
  });

  it("pen retains is_pen_book + authoring_status='complete' AND the base scope", () => {
    const { countQuery } = buildExploreQuery({ bookSortBy: "pen" });
    const where = whereClause(countQuery.toSQL().sql);
    expectRetainsBaseScope(where, "pen");
    expect(where).toContain('"books"."is_pen_book"');
    expect(where).toContain("authoring_status");
  });

  it("reads for an anonymous viewer collapses to 1=0 while keeping the base scope", () => {
    const { countQuery } = buildExploreQuery({ bookSortBy: "reads", currentUserId: null });
    const where = whereClause(countQuery.toSQL().sql);
    expectRetainsBaseScope(where, "reads/anonymous");
    expect(where).toContain("1=0");
  });

  it("favorites scopes the EXISTS predicate to the requested collection", () => {
    const { countQuery } = buildExploreQuery({
      bookSortBy: "favorites",
      currentUserId: "user-123",
      collection: "summer",
    });
    const { sql, params } = countQuery.toSQL();
    const where = whereClause(sql);
    expectRetainsBaseScope(where, "favorites");
    expect(where).toContain("EXISTS");
    // The collection name is a bound parameter ($4), not a literal in the SQL.
    expect(where).toContain("uf.collection =");
    expect(params).toContain("summer");
  });

  it("for-you with personalized=true does not duplicate the interest predicate", () => {
    // buildBookQuery skips personalizedCondition for for-you because the sort
    // already applies the identical predicate. cardinality appears once.
    const { countQuery } = buildExploreQuery({
      bookSortBy: "for-you",
      personalized: true,
      currentUserId: "user-123",
    });
    const where = whereClause(countQuery.toSQL().sql);
    const occurrences = where.split("cardinality").length - 1;
    expect(occurrences).toBe(1);
  });
});
