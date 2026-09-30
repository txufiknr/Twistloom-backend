/**
 * Custom-action orphan recovery — cron contract (audit R9).
 *
 * A submitted custom action charges credits up front and hands generation to an
 * on-demand GitHub workflow. This endpoint is the only thing that notices when
 * that dispatch dies, so the reader is charged with no page delivered. The tests
 * below pin down the two things an operator depends on:
 *
 * 1. **Control flow** — a genuinely dead claim is released and re-dispatched, a
 *    claim held by a live dispatcher is left alone, and each outcome is counted
 *    honestly (a failure reported as success would silence QStash retries).
 * 2. **Scheduler contract** — `CRON_SECRET` enforcement, and 500-on-failure so
 *    QStash retries instead of dropping the message. `inFlight` deliberately does
 *    not fail the request.
 *
 * No live database and no GitHub: `src/db/client.js` and the two dispatcher
 * helpers are replaced with doubles, exactly as `store-verification.test.ts` does.
 * The sweep service itself runs for real — the point is its behavior, not its SQL.
 */

import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { customActions, pages } from "../src/db/schema.js";
import { CUSTOM_ACTION_GENERATION_STALE_MS } from "../src/services/custom-actions.js";

// ---------------------------------------------------------------------------
// Module doubles (captured before `mock.module`, per the bearer-matrix pattern)
// ---------------------------------------------------------------------------

interface StaleRow {
  id: string;
  userId: string;
  bookId: string;
  pageId: string;
  bookTitle: string;
}

interface SweepState {
  /** Rows the detection query "returns" (projection is already applied). */
  staleRows: StaleRow[];
  /** `pages.is_generating_started_at` for whatever page is being inspected. */
  pageClaim: Date | null;
  dispatchResult: { success: boolean; error?: string; alreadyInProgress?: boolean };
  /** When set, `triggerCandidateGenerationWorkflow` throws instead of returning. */
  dispatchError: string | null;
  claimReleaseResult: boolean;
}

const state: SweepState = {
  staleRows: [],
  pageClaim: null,
  dispatchResult: { success: true, alreadyInProgress: false },
  dispatchError: null,
  claimReleaseResult: true,
};

const releasedClaims: Array<{ pageId: string; expectedClaim: Date | null }> = [];
const dispatchCalls: Array<Record<string, unknown>> = [];

/**
 * Minimal query chain: the detection read returns the seeded stale rows, the
 * claim read returns the seeded claim. Predicates are deliberately not
 * evaluated — that is SQL's job, exercised by the database, whereas these tests
 * assert what the service does *with* the answer.
 */
function selectChain(table: unknown): unknown {
  const chain: any = {
    from: () => chain,
    innerJoin: () => chain,
    leftJoin: () => chain,
    where: () => chain,
    limit: () => chain,
    orderBy: () => chain,
    then(resolve: (value: unknown) => void, reject: (error: unknown) => void) {
      try {
        resolve(table === pages ? [{ claimAt: state.pageClaim }] : state.staleRows);
      } catch (error) {
        reject(error);
      }
      return undefined;
    },
  };
  return chain;
}

const fakeRead = { select: (_projection?: unknown) => selectChain(customActions) };
const fakeWrite = {
  select: (_projection?: unknown) => selectChain(pages),
  update: () => {
    throw new Error("FakeDb: the sweep must not write through dbWrite — claim release goes through releaseGenerationClaim");
  },
};

const actualDb = await import("../src/db/client.js");
mock.module("../src/db/client.js", () => ({
  ...actualDb,
  dbRead: fakeRead,
  dbWrite: fakeWrite,
}));

const actualCandidateGeneration = await import("../src/utils/candidate-generation.js");
mock.module("../src/utils/candidate-generation.js", () => ({
  ...actualCandidateGeneration,
  releaseGenerationClaim: async (pageId: string, expectedClaim: Date | null | undefined) => {
    releasedClaims.push({ pageId, expectedClaim: expectedClaim ?? null });
    return state.claimReleaseResult;
  },
  triggerCandidateGenerationWorkflow: async (params: Record<string, unknown>) => {
    dispatchCalls.push(params);
    if (state.dispatchError) throw new Error(state.dispatchError);
    return state.dispatchResult;
  },
}));

// Imported only after the doubles are in place, so the service binds to them.
const cronRouter = (await import("../src/routes/cron.js")).default;
const { QSTASH_SCHEDULES } = await import("../src/cron/ensure-qstash-schedules.js");

// ---------------------------------------------------------------------------

const CRON_SECRET = "sweep-secret-key";
const ORIGINAL_CRON_SECRET = process.env.CRON_SECRET;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

const STALE_ROW: StaleRow = {
  id: "ca-11111111",
  userId: "user-11111111",
  bookId: "book-11111111",
  pageId: "page-11111111",
  bookTitle: "The Haunting",
};

const AUTH = { authorization: `Bearer ${CRON_SECRET}` };

function resetSweepState(): void {
  state.staleRows = [];
  state.pageClaim = null;
  state.dispatchResult = { success: true, alreadyInProgress: false };
  state.dispatchError = null;
  state.claimReleaseResult = true;
  releasedClaims.length = 0;
  dispatchCalls.length = 0;
}

beforeEach(() => {
  resetSweepState();
  process.env.CRON_SECRET = CRON_SECRET;
  process.env.NODE_ENV = "production";
});

afterAll(() => {
  if (ORIGINAL_CRON_SECRET === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = ORIGINAL_CRON_SECRET;
  if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  mock.module("../src/db/client.js", () => actualDb);
  mock.module("../src/utils/candidate-generation.js", () => actualCandidateGeneration);
});

// ---------------------------------------------------------------------------

describe("POST /api/cron/sweep-custom-actions", () => {
  it("rejects a request without the cron secret", async () => {
    state.staleRows = [STALE_ROW];

    const res = await cronRouter.request("/sweep-custom-actions", { method: "POST" });

    expect(res.status).toBe(401);
    expect(dispatchCalls).toHaveLength(0);
    expect(releasedClaims).toHaveLength(0);
  });

  it("rejects a wrong cron secret even when work is pending", async () => {
    state.staleRows = [STALE_ROW];

    const res = await cronRouter.request("/sweep-custom-actions", {
      method: "POST",
      headers: { authorization: "Bearer not-the-secret" },
    });

    expect(res.status).toBe(401);
    expect(dispatchCalls).toHaveLength(0);
  });

  it("answers 200 with an all-zero payload when nothing is orphaned", async () => {
    const res = await cronRouter.request("/sweep-custom-actions", {
      method: "POST",
      headers: AUTH,
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data).toEqual({ scanned: 0, dispatched: 0, inFlight: 0, failed: 0 });
    expect(dispatchCalls).toHaveLength(0);
    expect(releasedClaims).toHaveLength(0);
  });

  it("releases a claim that outlived the stale window, then re-dispatches", async () => {
    const deadClaim = new Date(Date.now() - (CUSTOM_ACTION_GENERATION_STALE_MS + 60_000));
    state.staleRows = [STALE_ROW];
    state.pageClaim = deadClaim;

    const res = await cronRouter.request("/sweep-custom-actions", {
      method: "POST",
      headers: AUTH,
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toEqual({ scanned: 1, dispatched: 1, inFlight: 0, failed: 0 });

    // Compare-and-clear must be handed the exact claim that was read, or a
    // fresher claim taken meanwhile would be erased.
    expect(releasedClaims).toEqual([{ pageId: STALE_ROW.pageId, expectedClaim: deadClaim }]);

    expect(dispatchCalls).toHaveLength(1);
    expect(dispatchCalls[0]).toEqual({
      bookTitle: STALE_ROW.bookTitle,
      bookId: STALE_ROW.bookId,
      pageId: STALE_ROW.pageId,
      userId: STALE_ROW.userId,
      maxDepth: 1,
      context: "cron/sweep-custom-actions",
    });
  });

  it("re-dispatches immediately when the page has no claim at all", async () => {
    state.staleRows = [STALE_ROW];
    state.pageClaim = null;

    const res = await cronRouter.request("/sweep-custom-actions", {
      method: "POST",
      headers: AUTH,
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toEqual({ scanned: 1, dispatched: 1, inFlight: 0, failed: 0 });
    expect(releasedClaims).toHaveLength(0);
    expect(dispatchCalls).toHaveLength(1);
  });

  it("never reaps a claim a live dispatcher still holds", async () => {
    const liveClaim = new Date(Date.now() - 30_000);
    state.staleRows = [STALE_ROW];
    state.pageClaim = liveClaim;
    // What the real dispatcher answers when the CAS loses to an existing claim.
    state.dispatchResult = { success: true, alreadyInProgress: true };

    const res = await cronRouter.request("/sweep-custom-actions", {
      method: "POST",
      headers: AUTH,
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toEqual({ scanned: 1, dispatched: 0, inFlight: 1, failed: 0 });
    expect(releasedClaims).toHaveLength(0);
    // Still dispatched, because the real function decides on its own whether the
    // claim is taken; counting it here would double-report.
    expect(dispatchCalls).toHaveLength(1);
  });

  it("answers 500 when a dispatch fails so QStash retries the message", async () => {
    state.staleRows = [STALE_ROW];
    state.dispatchResult = { success: false, error: "GitHub API unavailable" };

    const res = await cronRouter.request("/sweep-custom-actions", {
      method: "POST",
      headers: AUTH,
    });

    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error).toContain("re-dispatch 1 custom action(s)");
    expect(json.data).toEqual({ scanned: 1, dispatched: 0, inFlight: 0, failed: 1 });
  });

  it("counts a thrown dispatch as failed rather than crashing the sweep", async () => {
    state.staleRows = [STALE_ROW, { ...STALE_ROW, id: "ca-22222222", pageId: "page-22222222" }];
    state.dispatchError = "socket hang up";

    const res = await cronRouter.request("/sweep-custom-actions", {
      method: "POST",
      headers: AUTH,
    });

    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.data).toEqual({ scanned: 2, dispatched: 0, inFlight: 0, failed: 2 });
    // The sweep keeps going after a row throws — one bad row must not hide the rest.
    expect(dispatchCalls).toHaveLength(2);
  });

  it("keeps inFlight rows off the failure path", async () => {
    state.staleRows = [STALE_ROW];
    state.dispatchResult = { success: true, alreadyInProgress: true };

    const res = await cronRouter.request("/sweep-custom-actions", {
      method: "POST",
      headers: AUTH,
    });

    expect(res.status).toBe(200);
  });
});

describe("GET /api/cron/sweep-custom-actions", () => {
  it("is registered for the Vercel Cron migration path", async () => {
    state.staleRows = [STALE_ROW];
    state.pageClaim = null;

    const res = await cronRouter.request("/sweep-custom-actions", {
      method: "GET",
      headers: AUTH,
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toEqual({ scanned: 1, dispatched: 1, inFlight: 0, failed: 0 });
  });
});

describe("QStash schedule registration", () => {
  it("registers the minutes-scale custom-action sweep", () => {
    const schedule = QSTASH_SCHEDULES.find((entry) => entry.id === "custom-action-sweep");
    expect(schedule?.path).toBe("/api/cron/sweep-custom-actions");
    expect(schedule?.method).toBe("POST");
    expect(schedule?.forwardCronSecret).toBe(true);
    expect((schedule?.retries ?? 0) > 0).toBe(true);
  });

  it("runs at least as often as the 3-minute staleness floor allows", () => {
    const schedule = QSTASH_SCHEDULES.find((entry) => entry.id === "custom-action-sweep");
    expect(schedule?.cron).toBe("*/5 * * * *");
  });

  it("stays within the QStash free-tier schedule limit of 10", () => {
    expect(QSTASH_SCHEDULES.length).toBeLessThanOrEqual(10);
  });

  it("keeps every schedule under its own CRON_SECRET-protected path", () => {
    for (const schedule of QSTASH_SCHEDULES) {
      expect(schedule.path.startsWith("/api/cron/")).toBe(true);
      expect(schedule.forwardCronSecret).toBe(true);
    }
  });
});
