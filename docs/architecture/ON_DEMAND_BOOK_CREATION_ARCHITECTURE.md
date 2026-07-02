# On-Demand Book Creation Architecture

## Overview

The on-demand book creation system allows users to create AI-generated psychological thriller books asynchronously, bypassing Vercel's 5-minute function timeout. The flow accepts a theme input from the frontend, validates it, consumes credits, inserts draft records, dispatches a GitHub Actions workflow for the long-running AI generation, and returns immediately with HTTP 202. The frontend polls for progress until the book is ready.

## Problem Statement

### Original Issues

- **Vercel 5-minute timeout**: Synchronous AI generation of an entire book (theme → first page → story state → cover image) often exceeds 5 minutes.
- **Poor UX**: Users stared at loading spinners with no visibility into progress.
- **Credit atomicity risk**: If the AI generation succeeded but the DB write failed mid-way, credits were consumed with no book to show.
- **No cancellation**: Users had no way to abort a stuck or unwanted generation.

### Root Cause

The `initializeBook` function performs a multi-step AI pipeline:
1. Build and execute a complex AI prompt for full book creation (title, hook, summary, keywords, first page, initial story state, characters, places, threads, future notes)
2. Validate AI response
3. Persist book metadata, first page, and initial story state
4. Optionally generate a cover image via AI
5. Pre-generate candidate pages for first-page actions

Each step involves one or more AI API calls with retry logic, easily totalling 2–10+ minutes.

## Solution Architecture

### Core Design Principles

1. **Immediate Response**: API returns HTTP 202 in <2 seconds (validation + credit check + DB insert only).
2. **Background Processing**: Heavy AI work moved to a GitHub Actions workflow with a 30-minute timeout.
3. **Credit Atomicity**: Credits consumed and draft rows inserted in a single Postgres transaction — if either fails, credits are automatically preserved.
4. **Progress Visibility**: Polling endpoint (`GET /api/books/:bookId/status`) exposes step-level progress.
5. **Self-Healing**: Stale-detection logic re-dispatches the workflow if it never starts or crashes mid-run.
6. **Cancellation Support**: Users can cancel and receive stage-based refunds. If the generation is past the point of no return, the book is archived instead of published.

### Technology Stack

| Component | Technology |
|-----------|-----------|
| API Framework | Express.js |
| Database | Neon PostgreSQL |
| ORM | Drizzle ORM |
| Background Processing | GitHub Actions (`on-demand-book-creation.yml`) |
| AI Providers | Gemini, Groq, Cohere, etc. |
| Progress Polling | REST (`GET /api/books/:bookId/status`) |
| Cancellation | REST (`POST /api/books/:bookId/cancel`) |
| GitHub API | `workflow_dispatch` via REST |

## Architecture Diagram

```
FRONTEND                          BACKEND (Vercel)                    GITHUB ACTIONS
─────────                         ────────────────                    ──────────────

POST /api/books/async
  { theme, mcCandidate }
         │
         ▼
  ┌─────────────────────┐
  │ createBookValidate() │── Structural + AI theme validation
  └─────────┬───────────┘
            │
            ▼
  ┌──────────────────────┐
  │ executeWithCredits() │── SINGLE TX:
  │                      │    • Deduct STORY_GENERATION credits
  │                      │    • INSERT books (draft, status='draft')
  │                      │    • INSERT bookGenerations (status='pending')
  └─────────┬────────────┘
            │
            ▼
  ┌──────────────────────────────────────┐
  │ triggerBookGenerationWorkflow()      │── Fire-and-forget GitHub API call
  │ (dispatch on-demand-book-creation.yml│
  │  with inputs: { book_id })           │
  └─────────┬────────────────────────────┘
            │
            ▼
  HTTP 202 { bookId, message }  ──────────╮
            │                              │
            │    ┌──────────────────┐      │
            │    │ Poll /status     │      │
            ├────│  every 2-5 sec   │      │
            │    └────────┬─────────┘      │
            │             │                │
            │    generationStatus          │
            │    = 'completed'? ──► Done   │
            │             │                │
            │         still                │
            │      'in_progress'           │
            │             │                │
            │        retry poll            │
            │                             │
            │                             ▼
            │              ┌──────────────────────────────┐
            │              │  GitHub Actions Runner        │
            │              │                              │
            │              │  on-demand-book-creation.ts  │
            │              │  (BOOK_ID env var)            │
            │              │                              │
            │              │  1. Atomic lock acquisition   │
            │              │     (isGeneratingStartedAt)   │
            │              │                              │
            │              │  2. Fetch generation params   │
            │              │     from bookGenerations row  │
            │              │                              │
            │              │  3. initializeBook()          │
            │              │     ├─ AI prompt → full book  │
            │              │     ├─ UPDATE books SET       │
            │              │     │   title, hook, summary, │
            │              │     │   keywords, mc,         │
            │              │     │   totalPages,           │
            │              │     │   status='active'       │
            │              │     ├─ INSERT first story page│
            │              │     ├─ INSERT initial state   │
            │              │     ├─ Generate cover image   │
            │              │     │  (fire-and-forget)      │
            │              │     └─ Dispatch candidate     │
            │              │        generation workflow    │
            │              │     (fire-and-forget)         │
            │              │                              │
            │              │  4. await status='complete'   │
            │              │  5. Clear lock                │
            │              │  6. process.exit(0)           │
            │              └──────────────────────────────┘
            │                             │
            │                    ┌────────┴────────┐
            │                    │                 │
            │              On success         On failure
            │                    │                 │
            │              ╔══════════════╗  ╔══════════════╗
            │              ║ status:      ║  ║ status:      ║
            │              ║ 'completed'  ║  ║ 'failed'     ║
            │              ║ step:        ║  ║ error:       ║
            │              ║ 'complete'   ║  ║ '...'        ║
            │              ╚══════════════╝  ╚══════════════╝
            │                    │                 │
            ◄────────────────────┴─────────────────┘
            │
      Frontend sees
      generationStatus='completed'
            │
            ▼
      Book is ready — user can read it
```

## Database Schema

### `books` table (draft → active)

| Column | Type | Description |
|--------|------|-------------|
| `id` | `uuid` (PK) | Generated client-side via `generateId()` (UUID v7) |
| `user_id` | `uuid` (FK → users) | Book owner |
| `title` | `text` | Placeholder `"Generating…"` until `initializeBook` populates it |
| `total_pages` | `integer` | Default: `80` (`BOOK_MIN_PAGES`). Overwritten by `initializeBook` |
| `status` | `text` | `'draft'` → `'active'` (or `'archived'` if cancelled at PoNR) |
| `mc` | `jsonb` | Main character profile |
| `hook`, `summary` | `text` | Null until generation completes |
| `keywords` | `text[]` | Empty until generation completes |
| `is_original` | `boolean` | `false` for user-initiated books |

### `book_generations` table (tracking)

| Column | Type | Description |
|--------|------|-------------|
| `book_id` | `uuid` (PK, FK → books) | One-to-one with books |
| `user_id` | `uuid` (FK → users) | Book owner |
| `theme` | `text` | Original theme input |
| `mc_candidate` | `jsonb` | MC candidate params |
| `generation_status` | `text` | `'pending'` → `'in_progress'` → `'completed'` / `'failed'` / `'cancelled'` |
| `generation_step` | `text` | Current step: `'theme_validation'`, `'book_initialization'`, `'ai_generation'`, `'ai_evaluation'`, `'finalizing'`, `'complete'` |
| `generation_error` | `text` | Error message if failed |
| `generation_started_at` | `timestamp` | When workflow first reported progress |
| `generation_completed_at` | `timestamp` | When generation reached terminal status |
| `is_generating_started_at` | `timestamp` | **Lock** — set when a runner picks up the job, cleared on completion |
| `is_refunded` | `timestamp` | Set when credits have been refunded (prevents double-refund) |
| `cancellation_requested_at` | `timestamp` | Set when user cancels past point of no return |
| `ai_final_comment` | `text` | AI-generated completion message |

## Detailed Flow

### Step 1: Frontend sends theme

```typescript
// POST /api/books/async
// Body: { theme: "haunted mansion mystery", mcCandidate?: {...}, generateCoverImage?: false }
```

### Step 2: Validation (`createBookValidate`)

Two-pass validation:
1. **Structural** — theme non-empty & within length limit, MC candidate fields valid types/ranges, `generateCoverImage` is boolean.
2. **AI theme validation** (`validateTheme`) — calls an AI provider to check for:
   - Inappropriate/religious content
   - Invalid POV instructions (Twistloom only supports first-person)
   - Generic or low-effort themes

```typescript
const { aiResult } = await createBookValidate(theme, mcCandidate, generateCoverImage);
const { comment: aiComment, language = 'en', titleIdea, mcCandidate } = aiResult || {};
```

### Step 3: Draft record creation + Credit consumption

A single Postgres transaction (`executeWithCredits`):

```typescript
await executeWithCredits(userId, 'STORY_GENERATION', async (tx) => {
  await tx.insert(books).values(initialBookData);       // status: 'draft'
  await tx.insert(bookGenerations).values(initialBookGenerationData); // status: 'pending'
}, { context: 'book_creation_async', metadata: { theme, bookId } });
```

If either insert fails, the entire transaction rolls back and credits are preserved. No explicit refund is needed.

### Step 4: GitHub Workflow dispatch

```typescript
// Fire-and-forget — the response is sent before this completes.
triggerBookGenerationWorkflow(bookId, 'POST /api/books/async');
```

The dispatch function calls the GitHub API with up to 3 retries (1s, 2s, 4s exponential backoff). If all retries fail, the error is logged and the stale-detection mechanism (see below) handles recovery.

### Step 5: HTTP 202 Accepted

```typescript
res.status(202).json({
  bookId,
  message: 'Book creation started. Poll /api/books/:bookId/status for updates.',
});
```

User activity logging happens after the response to guarantee no double-response error:

```typescript
void logUserActivity({...}).catch(err => { console.error(...); });
```

### Step 6: GitHub Actions Runner (`processBookGeneration`)

The runner executes `src/cron/on-demand-book-creation.ts` with `BOOK_ID` environment variable:

#### 6a. Atomic Lock Acquisition

```typescript
// Single atomic UPDATE — no TOCTOU race between checking and setting the lock.
const ONE_MINUTE_AGO = new Date(Date.now() - 60000);
const [locked] = await dbWrite
  .update(bookGenerations)
  .set({ isGeneratingStartedAt: new Date() })
  .where(
    and(
      eq(bookGenerations.bookId, bookId),
      or(
        isNull(bookGenerations.isGeneratingStartedAt),
        lt(bookGenerations.isGeneratingStartedAt, ONE_MINUTE_AGO)
      )
    )
  )
  .returning({ id: bookGenerations.bookId });

if (!locked) {
  // Another runner already holds a fresh lock — skip.
  return;
}
```

This prevents duplicate processing when multiple workflow runs target the same book (e.g., stale-detection re-trigger races with original dispatch).

#### 6b. Fetch Generation Params

All generation parameters are read from the `bookGenerations` row — no sensitive data flows through GitHub workflow inputs:

```typescript
const [generationData] = await dbRead
  .select({
    userId, theme, mcCandidate, generateCoverImage,
    language, titleIdea, aiComment,
  })
  .from(bookGenerations)
  .where(eq(bookGenerations.bookId, bookId))
  .limit(1);
```

#### 6c. AI Book Generation (`initializeBook`)

Called with the existing `bookId` to update the draft rather than insert a new book:

```typescript
const result = await initializeBook({
  ...generationData,
  bookId,
  theme,
});
```

Inside `initializeBook`:

1. **AI Prompt** → `executePromptForJSON` with `BOOK_CREATION_SCHEMA_DEFINITION`
2. **AI Evaluation** → `buildFirstBookEvaluatorPrompt` — scores quality (passing: 80/100), re-generates if below threshold
3. **Update draft book** → `UPDATE books SET title, hook, summary, keywords, mc, totalPages, language, status='active'` (or `'archived'` if cancellation was requested past point of no return)
4. **Insert page 1** → `insertStoryPage` with first page content and actions
5. **Insert story state** → `insertStoryState` with initial flags, characters, places, threads, future notes
6. **Generate cover image** → fire-and-forget (non-blocking for user flows)
7. **Dispatch candidate generation workflow** → fire-and-forget (separate workflow for isolation)
8. **Invalidate caches** → user books cache, explore cache, popular tags cache

#### 6d. Terminal Status Write

```typescript
// Await the debounced write so it's persisted before process.exit()
await updateBookGenerationStatus({
  bookId,
  step: 'complete',
  aiFinalComment: result.aiFinalComment,
});

// Clear the lock
await clearLock();
```

#### 6e. Process Exit

```typescript
process.exit(0); // or process.exit(1) on failure
```

### Step 7: Frontend polls for status

```typescript
// GET /api/books/:bookId/status
// Response:
{
  "bookId": "...",
  "status": "active",           // Publication state
  "generationStatus": "completed", // Generation tracking
  "generationStep": "complete",
  "generationStepDescription": "Book generation complete",
  "aiFinalComment": "...",
  "createdAt": "...",
  "updatedAt": "..."
}
```

The polling endpoint joins `books` with `bookGenerations` via `LEFT JOIN`, so books created through sync/SSE routes (which have no `bookGenerations` row) also return a valid response.

## Status Derivation Rules

The `updateBookGenerationStatusCore` function derives `generationStatus` from `step`:

| `step` | Derived `generationStatus` |
|--------|---------------------------|
| `'complete'` | `'completed'` |
| `'theme_validation'` | `'pending'` |
| Any other step | `'in_progress'` |
| `undefined` | Uses `status` param as-is |

This ensures callers only need to supply the step — the status is always consistent.

## Stale Detection & Self-Healing

The polling endpoint (`GET /api/books/:bookId/status`) includes staleness detection:

```typescript
const isStale = isGenerationStale(data);
if (isStale && !data.isRefunded && GITHUB_REPO_CONFIG.token) {
  triggerBookGenerationWorkflow(bookId, 'GET /api/books/:bookId/status');
}
```

A generation is considered stale in two scenarios:

| Scenario | Condition | Threshold |
|----------|-----------|-----------|
| **Stuck in `'pending'`** | `generationStartedAt` is set AND older than threshold | 5 minutes (`PENDING_TIMEOUT_MS`) |
| **Workflow dispatch failed silently** | `generationStartedAt` is null AND `createdAt` is older than threshold | 5 minutes |
| **Crashed mid-run (`'in_progress'`)** | `isGeneratingStartedAt` is set AND older than threshold | 30 minutes (`MAX_GENERATION_DURATION_MS`) |

Additionally, an **hourly cron routine** (`processHourlyRoutine`) scans for pending/failed books and re-dispatches workflows for up to 5 books per run:

```typescript
const pendingBooks = await dbRead
  .select({ bookId: bookGenerations.bookId })
  .from(bookGenerations)
  .where(
    and(
      or(
        eq(bookGenerations.generationStatus, 'pending'),
        eq(bookGenerations.generationStatus, 'failed')
      ),
      isNull(bookGenerations.isRefunded),
      or(
        isNull(bookGenerations.isGeneratingStartedAt),
        lt(bookGenerations.isGeneratingStartedAt, lockTimeout)
      )
    )
  )
  .orderBy(bookGenerations.createdAt)
  .limit(HOURLY_RETRY_BATCH_SIZE);
```

## Cancellation Flow

```
POST /api/books/:bookId/cancel
         │
         ▼
  ┌─────────────────────┐
  │ Validate ownership  │
  │ & book state        │
  └─────────┬───────────┘
            │
      ┌─────┴─────┐
      │           │
   Completed    Not completed
      │           │
  400 "Cannot    │
   cancel"       ▼
      ┌──────────────────┐
      │ Already refunded?│─── Yes ──► 400 "Already refunded"
      └────────┬─────────┘
               │ No
               ▼
      ┌──────────────────────┐
      │ At point of no       │
      │ return?              │
      │ (step >= 'finalizing')│
      └────────┬─────────────┘
               │
        ┌──────┴──────┐
        │             │
       Yes            No
        │             │
        ▼             ▼
  Set cancelled-   Cancel GitHub
  RequestedAt      workflow runs
  (book will be    (best-effort)
  archived on      │
  completion)      ▼
  Return 202     UPDATE status
                 → 'cancelled'
                 │
                 ▼
           Calculate refund
           based on step:
           • 'theme_validation': full refund
           • 'book_initialization': partial
           • 'ai_generation': partial
           • finalizing+: no refund (PoNR)
                 │
                 ▼
           Add credits + stamp isRefunded
                 │
                 ▼
           Return 200 { success: true }
```

### Stage-Based Refunds

| Generation Step | Refund % | Rationale |
|----------------|----------|-----------|
| `theme_validation` (pending) | 100% | No AI generation cost incurred |
| `book_initialization` | 80% | AI just started |
| `ai_generation` | 40% | Significant AI cost sunk |
| `ai_evaluation` | 20% | Most work done |
| `finalizing` (PoNR) | 0% | Book is fully generated; archived instead |

## Key Design Decisions

### 1. Credit Atomicity via `executeWithCredits`

**Decision**: Credits are consumed in the same Postgres transaction as the draft row inserts.

**Rationale**: If `initializeBook` were called first and credits deducted second, a crash between the two would leave the user credited but bookless. By wrapping everything in `executeWithCredits`, failures in either the credit deduction or the DB inserts roll back the entire transaction.

```typescript
await executeWithCredits(userId, 'STORY_GENERATION', async (tx) => {
  await tx.insert(books).values(initialBookData);
  await tx.insert(bookGenerations).values(initialBookGenerationData);
}, { context: 'book_creation_async', metadata: { theme, bookId } });
```

### 2. Generation Params Stored in DB, Not Workflow Inputs

**Decision**: The GitHub workflow receives only `book_id` as input. All generation parameters (`theme`, `mcCandidate`, `generateCoverImage`, etc.) are read from the `bookGenerations` row.

**Rationale**:
- Workflow inputs are visible in GitHub UI logs — storing them in the DB keeps sensitive data secure.
- The polling and status endpoints can read the same params without additional API calls.
- Enables the hourly retry routine to pick up any pending book without re-supplying inputs.

### 3. Debounced Status Writes

**Decision**: Progress updates go through `debounceAsync` with a 500ms trailing window, keyed by `bookId`.

**Rationale**: `initializeBook` can fire rapid progress events. Without debouncing, every step change would hit the database. The 500ms window collapses intermediate steps so only the latest value is persisted. Terminal states (`'complete'`, `'failed'`) are awaited in the cron job before `process.exit()`.

```typescript
const debouncedUpdateStatus = debounceAsync(
  updateBookGenerationStatusCore,
  { delay: 500, trailing: true, leading: false }
);
```

### 4. Atomic Lock via Conditional UPDATE

**Decision**: Lock acquisition uses a single `UPDATE ... WHERE isGeneratingStartedAt IS NULL OR isGeneratingStartedAt < NOW() - 1 minute` rather than a separate SELECT + UPDATE.

**Rationale**: The original code had a TOCTOU race between reading the lock state and setting it. Two concurrent runners could both see `isGeneratingStartedAt` as null and both proceed. The conditional UPDATE eliminates this race entirely — only one runner can succeed.

### 5. Terminal Status Guard in Webhook Handler

**Decision**: The `updateBookGenerationStatusCore` function adds `WHERE generationStatus NOT IN ('cancelled', 'completed')` to every write.

**Rationale**: A delayed webhook from a dying GitHub runner could arrive after the user cancelled the generation, overwriting `'cancelled'` with `'completed'`. The WHERE clause makes this impossible — terminal statuses are final.

```typescript
await dbWrite
  .update(bookGenerations)
  .set(update)
  .where(
    and(
      eq(bookGenerations.bookId, bookId),
      ne(bookGenerations.generationStatus, 'cancelled'),
      ne(bookGenerations.generationStatus, 'completed'),
    )
  );
```

### 6. Separate Workflow for Candidate Generation

**Decision**: The on-demand book creation workflow does NOT generate candidate pages inline. Instead, it fires a separate `candidate-generation.yml` workflow (fire-and-forget).

**Rationale**:
- **Separation of concerns**: Book creation and candidate generation are independent concerns with different failure modes.
- **Isolated run logs**: Each workflow run has its own logs, making debugging easier.
- **Parallelism**: The candidate generation can run in parallel with the user's first read session.
- The original flow (`isOriginal`) is the only exception — it awaits candidate generation inline for cleaner sequential cron logging.

## Error Handling Matrix

| Failure Point | Effect | Recovery |
|--------------|--------|----------|
| Theme validation fails | 400 error, no credits consumed | User fixes theme |
| Credit deduction fails | 402 error | User purchases credits |
| Draft DB insert fails | Transaction rollback, credits preserved | Automatic |
| GitHub workflow dispatch fails | 202 still sent, but runner never starts | Stale-detection re-dispatches after 5 min |
| Runner crashes mid-generation | Lock remains set (`isGeneratingStartedAt`) | Hourly routine re-dispatches after 30 min |
| AI generation fails | Runner sets status='failed', clears lock | User can retry via cancel + new creation |
| Webhook arrives after cancellation | WHERE guard prevents overwrite | Manual |
| Process exits before status write | `await` ensures debounced write completes before `process.exit()` | N/A |

## Key Code Paths

| File | Purpose |
|------|---------|
| `src/routes/books.ts:418` | `POST /api/books/async` — entry point |
| `src/routes/books.ts:257` | `POST /api/books/workflow-webhook` — runner progress updates |
| `src/routes/books.ts:578` | `GET /api/books/:bookId/status` — polling + stale detection |
| `src/routes/books.ts:729` | `POST /api/books/:bookId/cancel` — cancellation with refund |
| `src/services/book-creation.ts:67` | `createBookValidate` — input + AI theme validation |
| `src/services/book-creation.ts:196` | `createBookCore` — shared sync/SSE book creation |
| `src/services/book-creation.ts:468` | `updateBookGenerationStatus` — debounced progress writes |
| `src/services/book-creation.ts:502` | `triggerBookGenerationWorkflow` — GitHub dispatch |
| `src/services/book-creation.ts:558` | `isGenerationStale` — staleness detection |
| `src/cron/on-demand-book-creation.ts:56` | `processBookGeneration` — runner's main logic |
| `src/cron/on-demand-book-creation.ts:256` | `processHourlyRoutine` — hourly retry batch |
| `src/utils/prompt.ts:3505` | `initializeBook` — full AI generation pipeline |
| `src/config/book-creation.ts` | Timeout constants |
| `src/config/generation-refund.ts` | Stage-based refund amounts |
