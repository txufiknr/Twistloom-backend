/**
 * AI generation outcome notification contract (F-8).
 *
 * Covers the two pure pieces of `ai-generation-notification.ts`:
 *  - `resolveGenerationOutcome` — the exactly-once gate that combines the
 *    pre-update status read with the guarded UPDATE's RETURNING result;
 *  - `buildGenerationOutcomeRow` — the inbox row's type strings, copy, and
 *    the `data.bookSlug` deep-link payload web's UtilityFab consumes.
 * The DB insert itself needs a live database and is not exercised here.
 */

import { describe, expect, it } from "bun:test";
import {
  buildGenerationOutcomeRow,
  resolveGenerationOutcome,
} from "../src/services/ai-generation-notification.js";

describe("resolveGenerationOutcome", () => {
  it("notifies on a real in_progress → completed transition", () => {
    expect(
      resolveGenerationOutcome({ finalStatus: "completed", priorStatus: "in_progress", updateApplied: true }),
    ).toBe("completed");
  });

  it("notifies on a real in_progress → failed transition", () => {
    expect(
      resolveGenerationOutcome({ finalStatus: "failed", priorStatus: "in_progress", updateApplied: true }),
    ).toBe("failed");
  });

  it("notifies when a failed generation is retried and completes (failed → completed)", () => {
    expect(
      resolveGenerationOutcome({ finalStatus: "completed", priorStatus: "failed", updateApplied: true }),
    ).toBe("completed");
  });

  it("suppresses a duplicate failed callback (failed → failed restamps the row)", () => {
    expect(
      resolveGenerationOutcome({ finalStatus: "failed", priorStatus: "failed", updateApplied: true }),
    ).toBeNull();
  });

  it("suppresses when the WHERE guard refused the write (row already completed)", () => {
    expect(
      resolveGenerationOutcome({ finalStatus: "completed", priorStatus: "completed", updateApplied: false }),
    ).toBeNull();
  });

  it("suppresses when the row is cancelled even though statuses differ", () => {
    // WHERE excludes cancelled rows, so updateApplied is false; the differing
    // statuses alone must never trigger a notification.
    expect(
      resolveGenerationOutcome({ finalStatus: "completed", priorStatus: "cancelled", updateApplied: false }),
    ).toBeNull();
  });

  it("never notifies for non-terminal statuses", () => {
    for (const finalStatus of ["pending", "in_progress", "cancelled"] as const) {
      expect(
        resolveGenerationOutcome({ finalStatus, priorStatus: "in_progress", updateApplied: true }),
      ).toBeNull();
    }
  });

  it("never notifies when no prior row existed", () => {
    expect(
      resolveGenerationOutcome({ finalStatus: "completed", priorStatus: undefined, updateApplied: true }),
    ).toBeNull();
  });

  it("never notifies for an undefined final status", () => {
    expect(
      resolveGenerationOutcome({ finalStatus: undefined, priorStatus: "in_progress", updateApplied: true }),
    ).toBeNull();
  });
});

describe("buildGenerationOutcomeRow", () => {
  const ctx = {
    userId: "u1",
    bookId: "b1",
    bookSlug: "the-haunted-loom",
    bookTitle: "The Haunted Loom",
    outcome: "completed" as const,
  };

  it("builds the completed row with the ai_completed type and book identity", () => {
    const row = buildGenerationOutcomeRow(ctx);
    expect(row.type).toBe("ai_completed");
    expect(row.title).toContain("The Haunted Loom");
    expect(row.read).toBe(false);
    expect(row.userId).toBe("u1");
  });

  it("builds the failed row with the ai_failed type", () => {
    const row = buildGenerationOutcomeRow({ ...ctx, outcome: "failed" });
    expect(row.type).toBe("ai_failed");
    expect(row.title).toContain("The Haunted Loom");
    expect(row.message.length).toBeGreaterThan(0);
    expect(row.read).toBe(false);
  });

  it("carries the data.bookSlug deep-link payload web's notification feed opens", () => {
    for (const outcome of ["completed", "failed"] as const) {
      const row = buildGenerationOutcomeRow({ ...ctx, outcome });
      expect(row.data).toEqual({
        bookId: "b1",
        bookSlug: "the-haunted-loom",
        bookTitle: "The Haunted Loom",
        status: outcome,
      });
    }
  });

  it("keeps a null slug in the payload instead of dropping the key", () => {
    const row = buildGenerationOutcomeRow({ ...ctx, bookSlug: null });
    expect(row.data.bookSlug).toBeNull();
  });
});
