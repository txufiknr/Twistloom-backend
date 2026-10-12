/**
 * `evaluateStoryReset` eligibility & cost tests.
 *
 * Pins the single-definition contract: the SAME rule decides eligibility and
 * cost whether it runs as the route's cheap replica pre-flight or as the
 * authoritative in-transaction re-check. Extracting it into
 * `src/services/story-reset.ts` is what lets the route evaluate it twice
 * without the two passes drifting.
 *
 * What is asserted here (against two independent in-memory stores, so
 * "replica lag" is observable):
 * 1. Eligibility: progress OR frontier > 1; page-1 with no progress is
 *    ineligible ("nothing to reset").
 * 2. Free replay: a completed book or a `past` session costs 0 and is
 *    server-derived (the client cannot claim it).
 * 3. Cost routing: `novel` uses the flat STORY_RESET key;
 *    `interactive`/`multiverse` use the distance formula from the frontier.
 * 4. Replica-lag: a stale replica pre-flight that says "eligible" does NOT
 *    make the authoritative (primary) pass say eligible — the primary's answer
 *    governs the charge.
 *
 * Honest limitation: the fake DB has no real locking/isolation, so these
 * tests verify the DECISION LOGIC and the two-store divergence, not true
 * two-in-flight concurrency (which needs real Postgres).
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { createFakeDb } from "./helpers/store-verification-db.js";

// Two independent stores so replica lag is observable, mirroring the pattern
// in `book-access-gate.test.ts`: dbRead (replica) can hold a stale snapshot
// while dbWrite (primary) already reflects the committed reset.
const primaryDb = createFakeDb();
const replicaDb = createFakeDb();

const { evaluateStoryReset, StoryResetAlreadyAppliedError } = await import(
  "../src/services/story-reset.js"
);
const { calculateBranchSwitchCost, getCreditCostForUser } = await import(
  "../src/config/credits.js"
);

const USER = "user-reset-1";
const BOOK = "book-reset-1";

// The fake DB's row stores persist across tests within this file, so clear
// them before every case — otherwise a later test inherits earlier seeds.
beforeEach(() => {
  primaryDb.reset();
  replicaDb.reset();
});

/** Seeds the reader's session + optional progress/completion into a store. */
function seed(
  store: typeof primaryDb,
  opts: {
    frontier?: number;
    status?: string;
    withProgress?: boolean;
    completed?: boolean;
  } = {},
) {
  const { frontier = 1, status = "active", withProgress = false, completed = false } = opts;
  store.rows.userSessions.push({
    userId: USER,
    bookId: BOOK,
    status,
    frontierPageNumber: frontier,
  });
  if (withProgress) {
    store.rows.userPageProgress.push({ userId: USER, bookId: BOOK, id: `prog-${store.rows.userPageProgress.length}` });
  }
  if (completed) {
    store.rows.userCompletedBooks.push({ userId: USER, bookId: BOOK, id: `done-${store.rows.userCompletedBooks.length}` });
  }
}

describe("evaluateStoryReset — eligibility", () => {
  it("is eligible when the reader has action-selection progress", async () => {
    seed(primaryDb, { withProgress: true });
    const evaluation = await evaluateStoryReset(primaryDb.dbWrite, USER, BOOK, "novel");
    expect(evaluation.eligible).toBe(true);
  });

  it("is eligible when the frontier advanced past page 1", async () => {
    seed(primaryDb, { frontier: 4 });
    const evaluation = await evaluateStoryReset(primaryDb.dbWrite, USER, BOOK, "novel");
    expect(evaluation.eligible).toBe(true);
    expect(evaluation.frontier).toBe(4);
  });

  it("is NOT eligible on page 1 with no progress (nothing to reset)", async () => {
    seed(primaryDb, { frontier: 1, withProgress: false });
    const evaluation = await evaluateStoryReset(primaryDb.dbWrite, USER, BOOK, "novel");
    expect(evaluation.eligible).toBe(false);
  });

  it("is NOT eligible when no session or progress rows exist at all", async () => {
    const evaluation = await evaluateStoryReset(primaryDb.dbWrite, USER, BOOK, "novel");
    expect(evaluation.eligible).toBe(false);
    expect(evaluation.session).toBeNull();
  });
});

describe("evaluateStoryReset — free replay is server-derived", () => {
  it("costs 0 and flags free replay when the session status is 'past'", async () => {
    seed(primaryDb, { frontier: 6, status: "past" });
    const evaluation = await evaluateStoryReset(primaryDb.dbWrite, USER, BOOK, "interactive");
    expect(evaluation.isFreeReplay).toBe(true);
    expect(evaluation.cost).toBe(0);
  });

  it("costs 0 and flags free replay when a completion row exists", async () => {
    seed(primaryDb, { frontier: 6, completed: true });
    const evaluation = await evaluateStoryReset(primaryDb.dbWrite, USER, BOOK, "interactive");
    expect(evaluation.isFreeReplay).toBe(true);
    expect(evaluation.cost).toBe(0);
  });
});

describe("evaluateStoryReset — cost routing by book mode", () => {
  it("novel mode uses the flat STORY_RESET key", async () => {
    seed(primaryDb, { frontier: 5 });
    const evaluation = await evaluateStoryReset(primaryDb.dbWrite, USER, BOOK, "novel");
    // Relative assertion: matches whatever getCreditCostForUser resolves for
    // this user (0 under free-demo pricing, the flat key value otherwise).
    expect(evaluation.cost).toBe(getCreditCostForUser(USER, "STORY_RESET"));
  });

  it("interactive mode uses the frontier→1 distance formula", async () => {
    seed(primaryDb, { frontier: 5 });
    const evaluation = await evaluateStoryReset(primaryDb.dbWrite, USER, BOOK, "interactive");
    expect(evaluation.cost).toBe(calculateBranchSwitchCost(5, 1, USER));
  });

  it("multiverse mode uses the frontier→1 distance formula", async () => {
    seed(primaryDb, { frontier: 3 });
    const evaluation = await evaluateStoryReset(primaryDb.dbWrite, USER, BOOK, "multiverse");
    expect(evaluation.cost).toBe(calculateBranchSwitchCost(3, 1, USER));
  });

  it("a deeper frontier never costs less than a shallower one (monotonic)", async () => {
    // Two different readers/books to avoid row collisions in the fake store.
    primaryDb.rows.userSessions.push({ userId: "u-a", bookId: "b-a", status: "active", frontierPageNumber: 2 });
    primaryDb.rows.userSessions.push({ userId: "u-b", bookId: "b-b", status: "active", frontierPageNumber: 9 });
    const shallow = await evaluateStoryReset(primaryDb.dbWrite, "u-a", "b-a", "interactive");
    const deep = await evaluateStoryReset(primaryDb.dbWrite, "u-b", "b-b", "interactive");
    expect(deep.cost).toBeGreaterThanOrEqual(shallow.cost);
  });
});

describe("evaluateStoryReset — replica lag cannot under-price or over-authorize", () => {
  it("stale replica says eligible, authoritative primary says already-reset → not eligible", async () => {
    // Replica (dbRead) still holds the pre-reset snapshot: progress present,
    // frontier advanced. Primary (dbWrite) already reflects the committed
    // reset: progress deleted, frontier back at page 1.
    seed(replicaDb, { frontier: 5, withProgress: true });
    seed(primaryDb, { frontier: 1, withProgress: false });

    // The route's cheap pre-flight (on the replica) would say "eligible".
    const preflight = await evaluateStoryReset(replicaDb.dbRead, USER, BOOK, "interactive");
    expect(preflight.eligible).toBe(true);

    // The authoritative in-transaction pass (on the primary) says otherwise —
    // this is the answer that governs the charge, and the route maps its
    // `eligible === false` to a 409 (already applied), never a second charge.
    const authoritative = await evaluateStoryReset(primaryDb.dbWrite, USER, BOOK, "interactive");
    expect(authoritative.eligible).toBe(false);
  });

  it("cost drift: replica frontier and primary frontier disagree → primary's cost wins", async () => {
    // Replica is stale at frontier 2 (cheap); primary already advanced to 8.
    // Compare FRONTIERS (always observable) rather than absolute cost, because
    // free-demo pricing can zero every cost and make a cost-only diff vacuous.
    seed(replicaDb, { frontier: 2 });
    seed(primaryDb, { frontier: 8 });

    const replicaEval = await evaluateStoryReset(replicaDb.dbRead, USER, BOOK, "interactive");
    const primaryEval = await evaluateStoryReset(primaryDb.dbWrite, USER, BOOK, "interactive");

    expect(replicaEval.frontier).toBe(2);
    expect(primaryEval.frontier).toBe(8);
    // The authoritative cost is derived from the PRIMARY's frontier.
    expect(primaryEval.cost).toBe(calculateBranchSwitchCost(8, 1, USER));
    expect(replicaEval.cost).toBe(calculateBranchSwitchCost(2, 1, USER));
  });
});

describe("StoryResetAlreadyAppliedError", () => {
  it("is an Error with a stable name so routes can map it to 409", () => {
    const error = new StoryResetAlreadyAppliedError();
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("StoryResetAlreadyAppliedError");
  });
});
