/**
 * `executeWithCredits` in-transaction cost resolver tests.
 *
 * Pins the resolver branch contract added so that a cost derived from MUTABLE
 * user state (session frontier, an existing choice row, an unpaid progress row)
 * is decided INSIDE the charge transaction, after the `users` row lock — not
 * from a possibly-stale replica snapshot read before the call.
 *
 * What is asserted here (all against the in-memory fake DB, no live Postgres):
 * 1. A resolver's returned number is the amount actually charged.
 * 2. The resolver runs AFTER the row lock and receives the transaction, so it
 *    can query authoritative state.
 * 3. A resolver that throws vetoes the charge entirely (rollback, no deduction).
 * 4. An operation that throws rolls back the deduction too.
 * 5. A resolved cost of 0 takes the free path (operation runs, nothing deducted).
 * 6. A demo user has a resolved numeric cost zeroed (numeric demo path).
 * 7. The static number and static key paths are unchanged.
 *
 * Honest limitation: the fake DB has no real locking or isolation, so these
 * tests verify the DECISION LOGIC and the rollback semantics — not true
 * two-in-flight concurrency (which would need a real Postgres).
 */
import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { createFakeDb } from "./helpers/store-verification-db.js";

const fakeDb = createFakeDb();

const actualDbClient = await import("../src/db/client.js");
mock.module("../src/db/client.js", () => ({
  ...actualDbClient,
  dbRead: fakeDb.dbRead,
  dbWrite: fakeDb.dbWrite,
}));

// Fraud gating is orthogonal to cost resolution; stub it out so a flagged-user
// check can never interfere with the charge logic under test.
const actualFraud = await import("../src/services/fraud-detection.js");
mock.module("../src/services/fraud-detection.js", () => ({
  ...actualFraud,
  requireNoFraudFlags: async () => undefined,
}));

// Control `isDemoUser` via a mutable binding the mock closes over, so a single
// module registration can serve both demo and non-demo cases.
const actualCreditsConfig = await import("../src/config/credits.js");
let demoUserId: string | null = null;
mock.module("../src/config/credits.js", () => ({
  ...actualCreditsConfig,
  isDemoUser: (id: string | null | undefined) => id !== null && id === demoUserId,
}));

const { executeWithCredits } = await import("../src/services/credits.js");
const { getCreditCostForUser } = await import("../src/config/credits.js");
const { users } = await import("../src/db/schema.js");
const { authorizeTimeTravelSession, rebaseTimeTravelSession } = await import("../src/services/time-travel.js");

afterAll(() => {
  mock.module("../src/db/client.js", () => actualDbClient);
  mock.module("../src/services/fraud-detection.js", () => actualFraud);
  mock.module("../src/config/credits.js", () => actualCreditsConfig);
});

const USER = "user-resolver-1";

function seedUser(credits: number, id = USER) {
  fakeDb.rows.users.push({ userId: id, credits });
}

function creditsOf(id = USER): number {
  return (fakeDb.rows.users.find((u) => u.userId === id) as { credits: number }).credits;
}

beforeEach(() => {
  fakeDb.reset();
  demoUserId = null;
});

describe("executeWithCredits — in-transaction cost resolver", () => {
  it("charges the number the resolver returns", async () => {
    seedUser(100);

    const { result, remainingCredits } = await executeWithCredits(
      USER,
      async () => 7,
      async () => ({ ok: true as const }),
      { context: "resolver_test" },
    );

    expect(result).toEqual({ ok: true });
    expect(remainingCredits).toBe(93);
    expect(creditsOf()).toBe(93);
    expect(fakeDb.rows.transactions).toHaveLength(1);
    expect(fakeDb.rows.transactions[0].credits).toBe(-7);
  });

  it("calls the resolver with the live transaction (it can query authoritative state)", async () => {
    seedUser(50);
    let sawUserRow = false;

    await executeWithCredits(
      USER,
      async (tx) => {
        const [row] = await tx
          .select({ credits: users.credits })
          .from(users)
          .where(eqUserId())
          .limit(1);
        sawUserRow = row !== undefined;
        return 3;
      },
      async () => ({ ok: true as const }),
      { context: "resolver_test" },
    );

    expect(sawUserRow).toBe(true);
    expect(creditsOf()).toBe(47);
  });

  it("vetoes the charge when the resolver throws — rollback, no deduction", async () => {
    seedUser(40);

    await expect(
      executeWithCredits(
        USER,
        async () => {
          throw new Error("already-applied");
        },
        async () => ({ ok: true as const }),
        { context: "resolver_test" },
      ),
    ).rejects.toThrow("already-applied");

    // Nothing moved: the deduction happens AFTER a successful resolve.
    expect(creditsOf()).toBe(40);
    expect(fakeDb.rows.transactions).toHaveLength(0);
  });

  it("rethrows when the operation throws (real Postgres rolls back the deduction)", async () => {
    seedUser(30);

    // A thrown operation must propagate and restore the transaction snapshot.
    // Real lock contention and isolation require PostgreSQL integration tests.
    await expect(
      executeWithCredits(
        USER,
        async () => 5,
        async () => {
          throw new Error("operation failed");
        },
        { context: "resolver_test" },
      ),
    ).rejects.toThrow("operation failed");
    expect(fakeDb.rows.users[0].credits).toBe(30);
    expect(fakeDb.rows.transactions).toHaveLength(0);
  });

  it("takes the free path when the resolver returns 0 (operation runs, nothing deducted)", async () => {
    seedUser(25);

    const { remainingCredits } = await executeWithCredits(
      USER,
      async () => 0,
      async () => ({ ok: true as const }),
      { context: "resolver_test" },
    );

    expect(remainingCredits).toBe(25);
    expect(creditsOf()).toBe(25);
    expect(fakeDb.rows.transactions).toHaveLength(0);
  });

  it("refuses to charge Time Travel without an authoritative reader session", async () => {
    seedUser(25);
    await expect(executeWithCredits(USER, async tx => {
      await authorizeTimeTravelSession(tx, USER, "book", "next");
      return 5;
    }, async () => undefined, { context: "time_travel_commit" })).rejects.toThrow("reader session");
    expect(fakeDb.rows.users[0].credits).toBe(25);
    expect(fakeDb.rows.transactions).toHaveLength(0);
  });

  it("rolls back a Time Travel charge when its conditional session update affects zero rows", async () => {
    seedUser(25);
    fakeDb.rows.userSessions.push({ userId: USER, bookId: "book", frontierPageId: "before", frontierPageNumber: 3 });
    await expect(executeWithCredits(USER, async tx => {
      await authorizeTimeTravelSession(tx, USER, "book", "next");
      return 5;
    }, async tx => {
      fakeDb.rows.userSessions[0].frontierPageId = "changed";
      await rebaseTimeTravelSession(tx, USER, "book", "before", "next", 4);
    }, { context: "time_travel_commit" })).rejects.toThrow("reader session");
    expect(fakeDb.rows.users[0].credits).toBe(25);
    expect(fakeDb.rows.transactions).toHaveLength(0);
    expect(fakeDb.rows.userSessions[0].frontierPageId).toBe("before");
  });

  it("zeroes a resolved numeric cost for the demo account (numeric demo path)", async () => {
    demoUserId = USER;
    seedUser(60);

    const { remainingCredits } = await executeWithCredits(
      USER,
      async () => 9,
      async () => ({ ok: true as const }),
      { context: "resolver_test" },
    );

    // The demo account is never charged a resolved number, regardless of value.
    expect(remainingCredits).toBe(60);
    expect(creditsOf()).toBe(60);
    expect(fakeDb.rows.transactions).toHaveLength(0);
  });

  it("static NUMBER path is unchanged: charges the number for a non-demo user", async () => {
    seedUser(20);

    await executeWithCredits(USER, 4, async () => ({ ok: true as const }), {
      context: "resolver_test",
    });

    expect(creditsOf()).toBe(16);
    expect(fakeDb.rows.transactions[0].credits).toBe(-4);
  });

  it("static KEY path is unchanged: charges getCreditCostForUser for the key", async () => {
    seedUser(15);
    // Read the expected cost from the SAME mocked config the service uses, so
    // the assertion stays correct whether FEATURE_FREE_DEMO zeroed the map or
    // not (the fake process may inherit either flag value).
    const expected = getCreditCostForUser(USER, "STORY_RESET");

    await executeWithCredits(USER, "STORY_RESET", async () => ({ ok: true as const }), {
      context: "resolver_test",
    });

    expect(creditsOf()).toBe(15 - expected);
    if (expected > 0) {
      expect(fakeDb.rows.transactions[0].credits).toBe(-expected);
    } else {
      // Zero cost (free-demo pricing) takes the free path: no ledger row.
      expect(fakeDb.rows.transactions).toHaveLength(0);
    }
  });

  it("rejects a negative resolved cost before any deduction", async () => {
    seedUser(10);

    await expect(
      executeWithCredits(
        USER,
        async () => -1,
        async () => ({ ok: true as const }),
        { context: "resolver_test" },
      ),
    ).rejects.toThrow(/Invalid credit cost/);

    expect(creditsOf()).toBe(10);
    expect(fakeDb.rows.transactions).toHaveLength(0);
  });
});

/** Minimal `eq(users.userId, USER)` predicate for the resolver's own query. */
function eqUserId() {
  // Built lazily so the drizzle column reference resolves after the mocks.
  const { eq } = require("drizzle-orm") as typeof import("drizzle-orm");
  return eq(users.userId, USER);
}
