/**
 * FakeDb SQL evaluator — the predicate branches every FakeDb-backed test runs on.
 *
 * Pins the `not in` branch: the `in` pattern (`/\bin\b/`) matches inside
 * `"not in"` as well, so a not-in check ordered after the in check would
 * evaluate every `notInArray` predicate as its inverse. Latent today
 * (`notInArray` appears only in `src/scripts/realign-achievements.ts`, which
 * no FakeDb test executes) — but the helper is shared and the branch is
 * cheap to keep honest.
 */
import { describe, expect, it } from "bun:test";
import { eq, inArray, notInArray } from "drizzle-orm";
import { books } from "../src/db/schema.js";
import { evalSql } from "./helpers/store-verification-db.js";

describe("evalSql in / not in branches", () => {
  it("evaluates inArray as membership", () => {
    const expr = inArray(books.id, ["a", "b"]);
    expect(evalSql(expr, { id: "a" })).toBe(true);
    expect(evalSql(expr, { id: "c" })).toBe(false);
  });

  it("evaluates notInArray as negated membership", () => {
    const expr = notInArray(books.id, ["a", "b"]);
    expect(evalSql(expr, { id: "a" })).toBe(false);
    expect(evalSql(expr, { id: "c" })).toBe(true);
  });

  it("still evaluates eq", () => {
    expect(evalSql(eq(books.visibility, "public"), { visibility: "public" })).toBe(true);
    expect(evalSql(eq(books.visibility, "private"), { visibility: "public" })).toBe(false);
  });
});
