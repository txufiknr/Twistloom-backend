/**
 * Bulk-like request parsing contract (POST /api/books/likes/bulk).
 *
 * Covers the 400 boundary of the welcome-wizard batch endpoint
 * (USER_ONBOARDING_WIZARD_ROADMAP, Step 1) as a pure function — the route
 * itself needs a live database, which this suite does not use.
 */

import { describe, expect, it } from "bun:test";
import {
  BULK_LIKE_MAX_IDS,
  BULK_LIKE_MAX_RAW_IDS,
  parseBulkLikeIds,
} from "../src/utils/book-likes.js";

const ids = (count: number) => Array.from({ length: count }, (_, i) => `b${i}`);

describe("parseBulkLikeIds", () => {
  it("accepts a single id", () => {
    expect(parseBulkLikeIds(["b1"])).toEqual({ ok: true, ids: ["b1"] });
  });

  it("accepts the maximum batch size", () => {
    const result = parseBulkLikeIds(ids(BULK_LIKE_MAX_IDS));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.ids).toHaveLength(BULK_LIKE_MAX_IDS);
  });

  it("deduplicates while preserving first-seen order", () => {
    const result = parseBulkLikeIds(["b2", "b1", "b2", "b3", "b1"]);
    expect(result).toEqual({ ok: true, ids: ["b2", "b1", "b3"] });
  });

  it("rejects a missing or non-array value", () => {
    for (const raw of [undefined, null, "b1", 42, { bookIds: ["b1"] }]) {
      const result = parseBulkLikeIds(raw);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("non-empty array");
    }
  });

  it("rejects an empty array", () => {
    const result = parseBulkLikeIds([]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("non-empty array");
  });

  it("rejects non-string or empty entries", () => {
    for (const raw of [["b1", 7], ["b1", ""], ["b1", null], ["b1", ["b2"]]]) {
      const result = parseBulkLikeIds(raw);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("non-empty strings");
    }
  });

  it("rejects more raw entries than the parse ceiling", () => {
    const result = parseBulkLikeIds(ids(BULK_LIKE_MAX_RAW_IDS + 1));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain(String(BULK_LIKE_MAX_RAW_IDS));
    }
  });

  it("rejects more unique ids than the batch limit after dedupe", () => {
    const result = parseBulkLikeIds(ids(BULK_LIKE_MAX_IDS + 1));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain(String(BULK_LIKE_MAX_IDS));
    }
  });

  it("enforces the unique limit, not the raw length, within the parse ceiling", () => {
    // 40 raw entries but only 20 unique — dedupe brings it inside the limit.
    const raw = [...ids(BULK_LIKE_MAX_IDS), ...ids(BULK_LIKE_MAX_IDS)];
    expect(raw).toHaveLength(BULK_LIKE_MAX_IDS * 2);
    const result = parseBulkLikeIds(raw);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.ids).toHaveLength(BULK_LIKE_MAX_IDS);
  });
});
