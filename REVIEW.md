# 🛡️ Twistloom AI Code Review Protocol (`REVIEW.md`)

> **Authoritative Quality Gate**: This specification defines the mandatory code review policy, evidence standards, severity triage rubrics, and anti-pattern radar for all code reviews across the Twistloom backend repository.
> **Audience**: AI Review Agents (Antigravity, Claude Code, Copilot, Cursor), human maintainers, and automated audit workflows.
> **Complementary Documentation**: Architectural Constitution lives in [`AGENTS.md`](file:///d:/Projects/Twistloom/Twistloom-backend/AGENTS.md); Operational Authoring Rules live in [`.github/copilot-instructions.md`](file:///d:/Projects/Twistloom/Twistloom-backend/.github/copilot-instructions.md).

---

## 1. Review Mandate & Evidence Standards

### 1.1 The High-Signal Review Mandate
The sole purpose of an AI code review in Twistloom is to **prevent production outages, security vulnerabilities, financial regressions, and silent data corruption**.

#### What Reviewers MUST Audit:
- **Functional Regressions:** Endpoints that crash, broken routing paths, lost parameters, or silently broken business contracts.
- **Architectural Invariants:** Violations of core rules defined in [`AGENTS.md`](file:///d:/Projects/Twistloom/Twistloom-backend/AGENTS.md) and [`docs/architecture/`](file:///d:/Projects/Twistloom/Twistloom-backend/docs/architecture/).
- **Financial & Data Integrity:** Unbounded credits consumption, double-spend race conditions, missing row locks, or transactions failing due to coupled auxiliary side effects.
- **Scale Bottlenecks:** Queries violating the 10M concurrent user principle (e.g., unbounded `$rows \times cols > 65,535$` parameter explosions, $O(N^2)$ `OFFSET` pagination, serverless heap memory bloat).
- **Deployment Prerequisites:** Unapplied database migrations, unverified client deprecations, or missing environment secrets.

#### What Reviewers MUST IGNORE (Anti-Noise Invariant):
- ❌ **Cosmetic Style & Naming:** Do not debate variable names, parameter order, or file formatting unless they violate existing lint rules or cause naming collisions.
- ❌ **Speculative Refactorings:** Do not request moving code into helper functions or introducing architectural abstractions unless a concrete bug or severe duplication exists.
- ❌ **Hypothetical Edge Cases:** Do not flag edge cases that are prevented by upstream middleware (e.g. `requireAuth`, `parseJsonBody`) or database constraints.
- ❌ **Pre-Existing Technical Debt:** Only flag pre-existing issues if the incoming change directly worsens them or makes them unrecoverable.

---

### 1.2 The Strict Evidence Standard
Every reported finding **MUST** provide an end-to-end execution path proving the defect is real:

```
[Finding Trigger] ──▶ [Execution Trace] ──▶ [Concrete Failure] ──▶ [Production Impact]
```

A finding that fails to provide this concrete trace is classified as a **False Positive** and must be discarded.

---

### 1.3 Positive Highlights & Architectural Commendations (Informational)
While the primary purpose of an AI code review is finding defects and regressions, reviews should also document **substantive positive improvements** for informational transparency.

#### What Qualifies as a Positive Highlight:
- **Architectural Invariant Adherence:** Clean adoption of core patterns (e.g., decoupling side-effects from financial transactions, proper `executeWithCredits` wrapping).
- **Scale & Performance Enhancements:** Adoption of bounded batching (`batchInsert`), keyset seek cursor pagination, or reduced round-trip database queries.
- **Robust Test Coverage:** Thorough unit/regression tests covering boundary conditions, idempotency, or contract regressions.
- **Resilience & Concurrency Safeguards:** Clean implementation of atomic row claims, anti-phantom notification checks, or safe partial indexes.

#### Anti-Noise Rules for Positive Highlights:
- ❌ **No Superficial Flattery:** Do not include conversational fluff (e.g., *"Looks clean!"*, *"Nice job!"*). Every highlight must cite a concrete architectural, performance, or testing merit.
- ❌ **Strictly Non-Blocking:** Positive highlights are purely informational. They must **never** soften, dilute, or override a `BLOCK MERGE` or `BLOCK DEPLOY` verdict when real defects are present.

---

## 2. Severity Taxonomy & Decision Rubric

| Severity | Definition | Merge Decision | Deploy Decision | Examples |
|---|---|---|---|---|
| **Critical** | Remote Code Execution, Auth Bypass, Silent Financial Loss / Unbounded Credits, Unrecoverable Data Corruption, Mass Serverless Crash | **BLOCK MERGE** | **BLOCK DEPLOY** | Bypassing `executeWithCredits` row locks; SQL injection; unhandled stream closure causing infinite loop. |
| **High** | Route-level crash, Accidental endpoint deletion/shadowing, Contract breakage without client deprecation, Auxiliary side-effect rolling back financial commits | **BLOCK MERGE** | **BLOCK DEPLOY** | Calling `c.req.raw.clone().json()` on already-read stream; replacing `POST /:id/export` with new route; notification write inside credit transaction. |
| **Medium** | Unbounded memory scan without `LIMIT`/cursor, Missing migration backfill on new counter column, Phantom notifications, Lock contention on hot-path tables | **PROCEED WITH CAUTION** | **BLOCK DEPLOY (if migration unapplied)** | Adding `likes_count integer DEFAULT 0` without backfill; unchunked loop in background worker; notification sent after unlike. |
| **Low** | Type safety gap (`as any`), Inconsistent logging, Minor schema annotation omissions, Sub-optimal memoization key | **APPROVE** | **APPROVE** | Unsafe type cast bypassing strict taxonomy union; missing log correlation ID. |

### Merge Blocker vs. Deployment Blocker
- **Merge Blocker (Code Defect):** The code itself contains a defect, functional regression, or broken contract. The pull request **must not be merged into `main`** until fixed.
- **Deployment Blocker (Operational Requirement):** The code is correct and approved for merge, but requires operational prerequisites (running `bun db:migrate:prod`, configuring an environment variable, or waiting for mobile client rollout) **before deploying to production**.

---

## 3. Twistloom Anti-Pattern Radar

Review agents must actively scan the diff against these five high-risk failure modes discovered in production audits:

### 3.1 HTTP & Hono Stream Lifecycle
- **Disturbed Request Stream:** Hono's global `parseJsonBody` consumes the raw request stream. Never call `c.req.raw.clone().json()` or `c.req.raw.text()` in route handlers — it throws a fatal synchronous `TypeError`. Always retrieve the parsed payload via `c.get("body")`.
- **Accidental Route Deletion / Shadowing:** When adding routes to large routers (e.g. [`src/routes/books.ts`](file:///d:/Projects/Twistloom/Twistloom-backend/src/routes/books.ts)), verify that existing handlers were not accidentally overwritten or replaced.
- **Contract Cutover & Cross-Client Safety:** Never delete or change active endpoints without deprecation shims (`426 Upgrade Required`) or cross-client verification (`Twistloom-web` and `Twistloom-flutter`).

### 3.2 Financial & Credits Integrity (`executeWithCredits`)
- **Row Locking (`SELECT FOR UPDATE`):** All operations that consume user credits must be wrapped in `executeWithCredits()`. Never deduct credits via direct `dbWrite.update()` or outside a transaction.
- **Side-Effect Decoupling:** Non-critical side-effects (push/in-app notifications, analytics logging, welcome emails) must **never** be executed inside financial credit transactions. If an auxiliary table or migration lags, it must not roll back a user's purchase.
- **Refund Idempotency:** Asynchronous refund paths must use `refundCreditsIdempotent()` to verify against the `transactions` ledger before issuing refunds.

### 3.3 Database, Migrations & Bounded Batching
- **Counter Column Backfills:** Adding a denormalized counter column with `DEFAULT 0` (e.g., `likes_count`) must always include an immediate backfill query in `src/db/triggers.ts` or migration SQL.
- **PostgreSQL Parameter Ceiling ($65,535$):** Multi-row batch inserts (`createNotificationsBatch`, voucher generation) must be sliced into bounded chunks ($\le 500$ rows) via [`src/utils/batch.ts:batchInsert`](file:///d:/Projects/Twistloom/Twistloom-backend/src/utils/batch.ts) to stay well under wire-protocol limits ($rows \times columns \le 60,000$).
- **Keyset Cursor Pagination over `OFFSET`:** Bulk data iterations and background fan-outs must use keyset seek pagination (`WHERE id > :cursor ORDER BY id ASC LIMIT :chunk`), never `OFFSET` ($O(N^2)$ cumulative work).
- **Anti-Lock Mass Deletes:** Retention purges must use subquery batching (`batchDelete`) in slices of 2,500 without `.returning()` memory bloat.

### 3.4 Concurrency & Post-Commit Races
- **Phantom Notifications:** When an event fires after a user interaction (e.g. testimonial like), verify that the underlying relationship is still active (`WHERE targetId = :id AND userId = :userId`) before persisting the notification to prevent phantom alerts under rapid toggle (like $\to$ unlike).
- **Atomic Batch Claims:** When claiming batch rewards (e.g. beta duties, quests), execute `UPDATE ... RETURNING id` and calculate awards strictly from affected rows to eliminate concurrent double-spending.

### 3.5 Runtime Boundaries & Type Safety
- **Dual-Runtime Hygiene:** Serverless functions run on Node.js (Netlify/Vercel); background jobs/CLI run on Bun. Do not use Bun-only globals in request-serving paths.
- **ESM Explicit Extensions:** Every local import must include explicit `.js` extensions (e.g., `import { db } from '../db/client.js';`).
- **No `as any` Bypasses:** Never bypass TypeScript's type system with `as any`. Use proper type guards and validated schemas.

---

## 4. Standardized AI Review Output Schema

When presenting review findings, AI agents and automated review scripts must format their output using this exact structure:

```markdown
# Twistloom Code Review Report

## Executive Assessment
- **Verdict:** [Approve | Approve with Notes | Request Changes (Block Merge) | Block Deployment]
- **Summary:** [1-2 sentences summarizing findings and overall stability]
- **Finding Counts:** [N] Critical, [N] High, [N] Medium, [N] Low

---

## Positive Highlights (Informational)
- **Architectural Alignment:** [e.g., Clean decoupling of notifications from executeWithCredits in src/services/credits.ts]
- **Performance & Scale:** [e.g., Keyset cursor pagination correctly adopted in cron workers to eliminate O(N²) offset scans]
- **Test Coverage:** [e.g., Thorough regression test suite covering all 8 boundary conditions]

---

## Findings

### [Severity: Critical/High/Medium/Low] — [Title]
- **Affected Files:** `path/to/file.ts:line-numbers`
- **Block Decision:** [Block Merge / Block Deploy / Non-Blocking]
- **Concrete Execution Path:**
  1. Trigger: [User request / Webhook / Cron trigger]
  2. Execution Trace: [Route -> Middleware -> Service -> DB call]
  3. Failure: [Exact runtime error, parameter overflow, or functional regression]
  4. Impact: [Impact on user, data integrity, or infrastructure]
- **Recommended Remediation:** [Concrete, type-safe drop-in code fix]

---

## Verification & Missing Tests
- [ ] [Unit / Integration test required to prevent future regression]
- [ ] [Edge case that must be verified before deployment]

## Deployment Prerequisites
- [ ] [Database migration required: drizzle/xxxx_xxx.sql]
- [ ] [Environment secret required]
- [ ] [Cross-client deployment coordination required]
```
