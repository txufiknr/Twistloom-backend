# Bounded Batching & Keyset Fan-Out Standardization Roadmap

> **Status:** Completed
> **Date:** 2026-10-26
> **Owner:** Twistloom Core Backend Team

---

## 1. Summary Table

| # | Item | Priority | Status |
|---|------|----------|--------|
| 1 | Standardized Batching Primitives (`src/utils/batch.ts`) | `P0` | ✅ Completed |
| 2 | Defensive Internal Chunking in `createNotificationsBatch` (`src/services/notifications.ts`) | `P0` | ✅ Completed |
| 3 | Bounded Batch Inserts for Voucher Generation (`src/services/voucher.ts`) | `P1` | ✅ Completed |
| 4 | Input Size Boundary Guards on Admin Bulk Endpoints (`src/routes/admin.ts`) | `P1` | ✅ Completed |
| 5 | Anti-Lock Bounded Deletion Loops in Daily Cleanup Cron (`src/cron/cleanup.ts`) | `P0` | ✅ Completed |
| 6 | Replica Client Fix & Bounded Archival in Prompt Cleanup (`src/cron/cleanup-prompts.ts`) | `P1` | ✅ Completed |
| 7 | Keyset Cursor Pagination & Batching for VIP Expiration (`src/cron/vip-expiration.ts`) | `P1` | ✅ Completed |
| 8 | Cursor-Bounded Chunking for Trending Scores Recalculation (`src/cron/update-trending-scores.ts`) | `P2` | ✅ Completed |
| 9 | Reusable Keyset Walker Integration for Orphaned Users (`src/services/user.ts`) | `P2` | ✅ Completed |
| 10 | DRY Refactor of Hand-Rolled Slicers (`psychological-profile.ts`) | `P2` | ✅ Completed |
| 11 | Dedicated Architecture Specification (`docs/architecture/BOUNDED_BATCHING_AND_FANOUT_ARCHITECTURE.md`) | `P0` | ✅ Completed |

---

## 2. Problem Statement

### Current State
Across `src/routes`, `src/services`, and `src/cron`, data fan-out, bulk mutations, and retention sweeps exhibit fragmented and inconsistent batching patterns. While asynchronous outbox fan-out (`src/services/email-campaigns.ts:68-152`), queue-drain batching (`src/services/maturation.ts:22-65`), and synchronous publish notification (`src/services/book-publish-notification.ts:37-80`) properly slice operations, multiple mission-critical services and cron jobs remain unpaginated or unchunked:
- Centralized notification helper `createNotificationsBatch()` (`src/services/notifications.ts:67-90`) executes a monolithic insert with no internal slice bounds.
- Admin bulk mutation endpoints (`src/routes/admin.ts:609-645, 816-850, 972-1000, 1946-1980`) take unvalidated `ids` arrays and pass them directly to `inArray()`.
- Daily cleanup crons (`src/cron/cleanup.ts:81-85` and `src/cron/cleanup-prompts.ts:53-61`) run monolithic unchunked `DELETE ... RETURNING { id }` queries that hold long-lived exclusive table locks and pull millions of deleted IDs into V8 heap memory.
- Multiple modules (`src/services/psychological-profile.ts:581`, `src/services/user.ts:104`, `src/cron/update-trending-scores.ts:124`) hand-roll ad-hoc slice loops with arbitrary chunk sizes (100, 500).

### Pain Points
1. **PostgreSQL Wire-Protocol Parameter Explosions ($65,535$)**: Multi-row batch inserts with 11 columns (such as `user_notifications`) crash with fatal PostgreSQL driver errors when processing $>5,957$ rows.
2. **Serverless Heap Exhaustion (OOM)**: Pulling tens of thousands of rows or thousands of `.returning({ id })` strings into V8 memory triggers stop-the-world garbage collection pauses and container termination (`JavaScript heap out of memory`).
3. **Database Lock Contention & Transaction Starvation**: Monolithic mass deletions on tables like `user_activity_logs` hold exclusive write locks, delay concurrent reads, and bloat the Write-Ahead Log (WAL) burst buffer.
4. **Maintenance Overhead and Logic Drift**: Disparate chunking sizes and ad-hoc slicing code throughout the repository duplicate effort and prevent systematic scaling guarantees.

### Goal
Establish a canonical, DRY, bounded batching framework in `src/utils/batch.ts`, safeguard all centralized insertion helpers and admin endpoints against parameter overflows, convert monolithic cleanup deletions into bounded chunk loops, and author a comprehensive architectural specification.

---

## 3. Intended Design & Rationale

### Design Alternatives

#### Alternative A: Ad-Hoc Inline Chunking in Each Service
Each affected file implements its own `for (let i = 0; i < items.length; i += 100)` slice loop and inline parameterized queries.

- **Pros:** Does not introduce shared utilities.
- **Cons:** High code duplication, inconsistent chunk sizes across services, high risk of regression when new fields are added to schemas, does not dynamically adjust to column counts.

#### Alternative B: Heavy External Queue Dependency (BullMQ / SQS) for All Batch Operations
Move all bulk mutations, deletes, and multi-row inserts into background Redis/SQS queues.

- **Pros:** Decouples execution from web requests.
- **Cons:** Overkill for synchronous database operations (e.g., vouchers, admin bulk updates), introduces external queue latency and Redis dependencies for tasks that Postgres can perform in milliseconds with bounded chunking.

### Recommended: Alternative C (Standardized Lightweight Primitives in `src/utils/batch.ts`)
Implement four reusable, type-safe primitives in `src/utils/batch.ts`:
1. `chunkArray<T>(items, chunkSize)`: Pure in-memory array divider.
2. `batchInsert<TTable>(conn, table, rows, options)`: Dynamic parameter-aware batch inserter that calculates `chunkSize = min(500, floor(60,000 / columnsCount))` to ensure wire-protocol limits are mathematically impossible to exceed.
3. `paginateWithKeysetCursor<TRow, TCursor>(options)`: Generic cursor walker that enforces $O(1)$ B-tree seek pagination instead of $O(N^2)$ `OFFSET` scans.
4. `batchDelete<TTable>(conn, table, idColumn, whereCondition, batchSize)`: Iterative subquery deletion loop that purges records in slices of 2,500 without `.returning()` memory bloat.

### Non-Breaking Guarantees
| Change | What it does NOT change | Why safe |
|---|---|---|
| Adding internal chunking to `createNotificationsBatch()` | Does not change function signature or return type (`Promise<void>`) | Callers pass the same params; rows are simply flushed in safe multi-row slices under the hood. |
| Adding input length caps (`MAX_ADMIN_BULK_IDS = 100`) to admin routes | Does not change valid payload shapes or response formats | Normal admin UI actions process at most 20–50 items per page; only abusive/oversized requests are rejected. |
| Converting cleanup mass deletes to bounded loops | Does not change the deletion criteria (`cutoffDate`) or total deleted rows | Rows are deleted in discrete batches of 2,500 until 0 match, reducing lock time without changing business logic. |

---

## 4. Feasibility Analysis

| Dimension | Assessment |
|---|---|
| **Effort** | Medium (1–2 days for utility creation, service integration, and testing) |
| **Risk** | Low — all changes preserve existing database schemas, table triggers, and API response contracts |
| **Backend changes** | Minimal to Moderate — new utility file, adjustments in centralized helpers, crons, and admin routes |
| **Dependencies** | None (pure Drizzle ORM and TypeScript) |
| **Reversibility** | Fully reversible — standard modular code adjustments |

---

## 5. Flow Diagram (Mermaid)

```mermaid
flowchart TD
    A[Bulk Data Input / Fan-Out Request] --> B{Operation Type}
    
    B -->|Bulk Multi-Row Insert| C[batchInsert Helper]
    C --> D[Calculate columnsCount per row]
    D --> E["safeChunkSize = min(500, floor(60,000 / columns))"]
    E --> F[Execute Bounded Chunks in Sequence]
    F --> G[All Rows Persisted Without Parameter Overflow]
    
    B -->|Relational Dataset Iteration| H[paginateWithKeysetCursor Helper]
    H --> I["Seek: WHERE following_id = :id AND cursor_col > :lastCursor"]
    I --> J[Order by cursor_col ASC LIMIT chunkSize]
    J --> K[Process Batch Callback]
    K --> L{Rows Returned < chunkSize?}
    L -->|No| M[Update lastCursor and Repeat]
    M --> I
    L -->|Yes| N[Pagination Complete: O(1) Seek, Zero Drift]
    
    B -->|Mass Retention Deletion| O[batchDelete Helper]
    O --> P["DELETE FROM table WHERE id IN (SELECT id FROM table WHERE cond LIMIT 2500)"]
    P --> Q{Affected Rows == 0?}
    Q -->|No| P
    Q -->|Yes| R[Cleanup Complete: Zero Long-Lived Table Locks]
```

---

## 6. Implementation Plan

### Step 1: Standardized Batching Primitives (`src/utils/batch.ts`) — ✅ Completed

**Files:** `src/utils/batch.ts` (NEW), `tests/unit/batch-utils.test.ts` (NEW)
**Effort:** Low

Create type-safe batching helpers:
- `chunkArray<T>(items: T[], chunkSize?: number): T[][]`
- `batchInsert<TTable>(conn, table, rows, options)`
- `paginateWithKeysetCursor<TRow, TCursor>(options)`
- `batchDelete<TTable>(conn, table, idColumn, whereCondition, batchSize)`

**Non-breaking:** Pure additive utility module.

---

### Step 2: Defensive Internal Chunking in `createNotificationsBatch` — ✅ Completed

**Files:** `src/services/notifications.ts:67-90`
**Effort:** Low

Update `createNotificationsBatch` to delegate insertion to `batchInsert(conn, userNotifications, rows, { chunkSize: 500 })`.

**Non-breaking:** Preserves existing function interface; eliminates parameter ceiling crash for all callers.

---

### Step 3: Bounded Batch Inserts for Voucher Generation — ✅ Completed

**Files:** `src/services/voucher.ts:238-256`
**Effort:** Low

Use `batchInsert` to persist generated voucher codes in slices of 500 rows.

**Non-breaking:** Output `{ campaignId, generated, codes }` remains identical.

---

### Step 4: Input Size Boundary Guards on Admin Bulk Endpoints — ✅ Completed

**Files:** `src/routes/admin.ts:609-645, 816-850, 972-1000, 1946-1980`
**Effort:** Low

Introduce `MAX_ADMIN_BULK_IDS = 100` constant. Validate `ids.length <= MAX_ADMIN_BULK_IDS` in all four bulk-status routes, returning standardized `cValidationError` when exceeded.

**Non-breaking:** Normal administrative operations approve/reject 20–50 items per page and are unaffected.

---

### Step 5: Anti-Lock Bounded Deletion Loops in Daily Cleanup Cron — ✅ Completed

**Files:** `src/cron/cleanup.ts:81-86`
**Effort:** Low

Replace monolithic `DELETE FROM user_activity_logs ... RETURNING { id }` with `batchDelete` in chunks of 2,500 rows without `.returning()`.

**Non-breaking:** Removes memory bloat and lock contention; deletes the exact same records.

---

### Step 6: Replica Client Fix & Bounded Archival in Prompt Cleanup — ✅ Completed

**Files:** `src/cron/cleanup-prompts.ts:53-65`
**Effort:** Low

Switch from `dbRead` to `dbWrite` for mutating `user_prompt_history`. Replace monolithic delete with `batchDelete` without `.returning()`.

**Non-breaking:** Fixes replica routing error; preserves retention logic.

---

### Step 7: Keyset Cursor Pagination & Batching for VIP Expiration — ✅ Completed

**Files:** `src/cron/vip-expiration.ts:28-60`
**Effort:** Medium

Replace unpaginated `SELECT` with keyset cursor pagination (`WHERE userId > lastUserId ORDER BY userId ASC LIMIT 100`), processing user downgrades in bounded slices.

**Non-breaking:** Downgrades expired VIPs with identical tier and frame revocations.

---

### Step 8: Cursor-Bounded Chunking for Trending Scores Recalculation — ✅ Completed

**Files:** `src/cron/update-trending-scores.ts:80-140`
**Effort:** Medium

Replace monolithic memory ingestion of active books and favorites with cursor pagination over active books, calculating decay scores per batch.

**Non-breaking:** Produces identical mathematical trending score outputs.

---

### Step 9: Reusable Keyset Walker Integration for Orphaned Users — ✅ Completed

**Files:** `src/services/user.ts:84-116`
**Effort:** Low

Bound initial query of orphaned users to chunks of 500 rows, deleting them via `batchDelete`.

**Non-breaking:** Deletes same orphaned accounts without memory buildup.

---

### Step 10: DRY Refactor of Hand-Rolled Slicers — ✅ Completed

**Files:** `src/services/psychological-profile.ts:580-590`
**Effort:** Low

Replace hand-rolled `chunkSize = 100` slice loop with `chunkArray`.

**Non-breaking:** Clean code cleanup with identical execution.

---

### Step 11: Dedicated Architecture Specification — ✅ Completed

**Files:** `docs/architecture/BOUNDED_BATCHING_AND_FANOUT_ARCHITECTURE.md` (NEW)
**Effort:** Medium

Author comprehensive architecture document outlining the 4 invariants, 4 batching archetypes, mathematical parameter proofs, and implementation recipes.

**Non-breaking:** Architectural documentation.

---

## 7. Open Questions

### Q1. What should the default chunk size be for general inserts? — ✅ Decided

**Decision:** Default to 500 rows, with dynamic down-scaling via `min(500, floor(60,000 / columnsCount))`.
**Rationale:** At 11 columns, 500 rows = 5,500 parameters ($\approx 8.4\%$ of the 65,535 wire-protocol limit), providing high network throughput while maintaining a massive safety margin.

---

### Q2. Should admin bulk endpoints reject or auto-chunk inputs exceeding 100 IDs? — ✅ Decided

**Decision:** Reject inputs $>100$ IDs with a `400 Bad Request` validation error.
**Rationale:** Follows the pattern established in `POST /api/books/likes/bulk` (`src/routes/books.ts:3590`). Admin UI components paginate in pages of 20 to 50 items; accepting unbounded arrays on synchronous HTTP routes invites memory exhaustion and DOS risks.

---

## 8. References & File Touch List

| File | Change |
|---|---|
| `src/utils/batch.ts` | **NEW** — Standardized batching and cursor utilities (`chunkArray`, `batchInsert`, `paginateWithKeysetCursor`, `batchDelete`) |
| `tests/unit/batch-utils.test.ts` | **NEW** — Unit tests for batching primitives |
| `src/services/notifications.ts:67-90` | Add defensive internal chunking to `createNotificationsBatch` |
| `src/services/voucher.ts:238-256` | Apply `batchInsert` to voucher generation |
| `src/routes/admin.ts:609-645, 816-850, 972-1000, 1946-1980` | Add `MAX_ADMIN_BULK_IDS = 100` ceiling validation |
| `src/cron/cleanup.ts:81-86` | Convert activity log mass delete to bounded loop |
| `src/cron/cleanup-prompts.ts:53-65` | Fix `dbWrite` client and convert to bounded delete |
| `src/cron/vip-expiration.ts:28-60` | Keyset cursor pagination over expired VIP subscriptions |
| `src/cron/update-trending-scores.ts:80-140` | Keyset cursor pagination over active books |
| `src/services/user.ts:84-116` | Bound initial query of orphaned users |
| `src/services/psychological-profile.ts:580-590` | Refactor to use `chunkArray` |
| `docs/architecture/BOUNDED_BATCHING_AND_FANOUT_ARCHITECTURE.md` | **NEW** — Comprehensive architectural specification |

### Codebase Findings
1. In `src/cron/cleanup-prompts.ts:53`, the deletion of `userPromptHistory` is performed using `dbRead` instead of `dbWrite`. In production with primary/replica splitting, writes routed to `dbRead` throw transaction errors.
2. In `src/cron/cleanup.ts:84`, the mass deletion uses `.returning({ id })` on historical activity logs. Under high volume, retaining 500,000 UUID strings in V8 memory triggers container termination.

---

## 9. Completion Status

Legend: ✅ Implemented & verified · ⏳ Partial / scoped down · ⬜ Future work · ⏩ Deferred

### Completed
- ✅ Step 1: Standardized Batching Primitives (`src/utils/batch.ts`)
- ✅ Step 2: Defensive Internal Chunking in `createNotificationsBatch` (`src/services/notifications.ts`)
- ✅ Step 3: Bounded Batch Inserts for Voucher Generation (`src/services/voucher.ts`)
- ✅ Step 4: Input Size Boundary Guards on Admin Bulk Endpoints (`src/routes/admin.ts`)
- ✅ Step 5: Anti-Lock Bounded Deletion Loops in Daily Cleanup Cron (`src/cron/cleanup.ts`)
- ✅ Step 6: Replica Client Fix & Bounded Archival in Prompt Cleanup (`src/cron/cleanup-prompts.ts`)
- ✅ Step 7: Keyset Cursor Pagination & Batching for VIP Expiration (`src/cron/vip-expiration.ts`)
- ✅ Step 8: Cursor-Bounded Chunking for Trending Scores Recalculation (`src/cron/update-trending-scores.ts`)
- ✅ Step 9: Reusable Keyset Walker Integration for Orphaned Users (`src/services/user.ts`)
- ✅ Step 10: DRY Refactor of Hand-Rolled Slicers (`src/services/psychological-profile.ts`)
- ✅ Step 11: Dedicated Architecture Specification (`docs/architecture/BOUNDED_BATCHING_AND_FANOUT_ARCHITECTURE.md`)

### In Progress
- *(None — all roadmap items completed and verified)*

### Future / Deferred
- *(None)*
