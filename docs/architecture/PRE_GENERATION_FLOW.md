# Story Page Automatic Pre-Generation Flow

## Overview

This document describes the automatic pre-generation system for story pages in Twistloom. The system proactively generates candidate pages for user actions to provide instant navigation and reduce perceived latency during story progression.

## Multi-Level Pre-Generation

The system supports configurable **multi-level depth pre-generation** to create comprehensive story trees:

- **Level 1 (Synchronous)**: Immediate parallel generation of direct action candidates (returned to user)
- **Level 2+ (Fire-and-Forget)**: Background generation of deeper levels without blocking response
- **Configurable Depth**: Controlled via `MAX_BRANCHING_PREGENERATION_DEPTH` (default: 2)
- **Exponential Growth**: 3 actions × 3 candidates × 3 candidates = 27 total pages at depth 3

### Example Flow:
```
Page A (3 actions) → Generate 3 candidates (Level 1 - sync)
                    ├── Candidate A1 (3 actions) → Generate 3 candidates (Level 2 - async)
                    ├── Candidate A2 (3 actions) → Generate 3 candidates (Level 2 - async)  
                    └── Candidate A3 (3 actions) → Generate 3 candidates (Level 2 - async)
```

## Architecture

The pre-generation system uses a **fire-and-forget** pattern with **distributed locking**, **database-level generation flags**, **parallel processing**, and **exponential backoff retry** to generate candidate pages asynchronously. This ensures:

- **Instant user experience**: Level 1 candidates generated synchronously and returned immediately
- **Deep pre-generation**: Levels 2+ processed in background without blocking user response
- **Graceful failure handling**: Failed generations don't block user navigation or background processing
- **Resource efficiency**: Only generates pages for actions users might take
- **Cascade effect**: Each generated page triggers pre-generation of its own candidates
- **Concurrent safety**: Distributed locks prevent duplicate generation in serverless environments
- **Single operation guarantee**: `isGeneratingStartedAt` timestamp ensures only one generation operation per page and supports heartbeat/stale detection
- **SSE waiting**: Clients can wait for in-progress generations via Server-Sent Events
- **Configurable depth**: `MAX_BRANCHING_PREGENERATION_DEPTH` controls how deep the pre-generation goes

## Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    BOOK CREATION (createBookCore)                      │
│  Location: src/services/book-creation.ts:66                           │
│  Purpose: Create new book with first page and trigger pre-generation     │
│                                                                          │
│  Flow: validateTheme → initializeBook → enrichActions → invalidate caches│
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
                    ┌───────────────────────────┐
                    │  Create book & first page │
                    │  insertStoryPage()        │
                    │  Persists page to DB       │
                    └───────────────────────────┘
                                    │
                                    ▼
                    ┌───────────────────────────┐
                    │  Insert story state       │
                    │  insertStoryState()       │
                    │  Persists initial state   │
                    └───────────────────────────┘
                                    │
                                    ▼
                    ┌───────────────────────────┐
                    │  🔥 FIRE-AND-FORGET        │
                    │  ensureCandidatesForPage() │
                    │  (for first page)          │
                    │  Returns immediately       │
                    └───────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                  ENSURE CANDIDATES FOR PAGE (ensureCandidatesForPage)  │
│  Location: src/utils/prompt.ts:2804                                      │
│  Purpose: Iterate through actions and pre-generate candidate pages        │
│                                                                          │
│  This function is the core of the pre-generation system. It scans all    │
│  actions on a page and generates candidate pages for those without a     │
│  complete destination (both branchId and pageId).                        │
│                                                                          │
│  Key features:                                                           │
│  - Distributed lock prevents concurrent processing of same page           │
│  - Re-checks pending actions after acquiring lock (idempotent)            │
│  - Removes invalid actions with non-retryable errors                      │
│  - Adds fallback "Continue." action if all actions are invalid            │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
                    ┌───────────────────────────┐
                    │  Skip if last page         │
                    │  (page >= totalPages)      │
                    └───────────────────────────┘
                                    │
                                    ▼
                    ┌───────────────────────────┐
                    │  Filter actions without    │
                    │  complete destination      │
                    │  (!pageId || !branchId)    │
                    └───────────────────────────┘
                                    │
                                    ▼
                    ┌───────────────────────────┐
                    │  Set isGeneratingStartedAt = now() in database (pages table)
                    └───────────────────────────┘
                                    │
                                    ▼
                    ┌───────────────────────────┐
                    │  Acquire distributed lock  │
                    │  withLock()                │
                    │  Key: lock:candidate:{id}  │
                    │  TTL: 300 seconds (5 min)  │
                    └───────────────────────────┘
                                    │
                                    ▼
                    ┌───────────────────────────┐
                    │  Re-check after lock       │
                    │  (another instance may     │
                    │   have processed)          │
                    └───────────────────────────┘
                                    │
                                    ▼
                    ┌───────────────────────────┐
                    │  For each pending action:  │
                    │  Generate candidate        │
                    └───────────────────────────┘
                                    │
                                    ├─────────────────────────────────────────────────────────────────┐
                                    ▼                                                               ▼
          ┌─────────────────┐              ┌─────────────────┐
          │ Has complete    │              │ No complete      │
          │ destination      │              │ destination      │
          │ (pre-generated)  │              │ (needs gen)       │
          │ Skip this action │              │ Generate candidate│
          └─────────────────┘              └─────────────────┘
                    │                               │
                    │                               ▼
                    │               ┌───────────────────────────┐
                    │               │  PARALLEL GENERATION     │
                    │               │  Promise.allSettled()    │
                    │               │  All actions at once     │
                    │               └───────────────────────────┘
                    │                               │
                    │                               ▼
                    │               ┌───────────────────────────┐
                    │               │  generateCandidatesInParallel() │
                    │               │  - Parallel processing     │
                    │               │  - Depth tracking          │
                    │               │  - Fire-and-forget deeper  │
                    │               └───────────────────────────┘
                    │                               │
                    │               ├───────────────────────────┤
                    │               ▼                           ▼
                    │     ┌─────────────────┐         ┌─────────────────┐
                    │     │ Level 1 (Sync)  │         │ Level 2+ (Async)│
                    │     │ Return to user  │         │ Background proc │
                    │     └─────────────────┘         └─────────────────┘
                    │               │                           │
                    │               ▼                           ▼
                    │     ┌─────────────────┐         ┌─────────────────┐
                    │     │ For each action:│         │ For each success:│
                    │     │ retryWithBackoff│         │ ensureCandidates │
                    │     │ generateCandidate│         │ WithDepth()      │
                    │     └─────────────────┘         └─────────────────┘
                    │               │                           │
                    │               ▼                           ▼
                    │     ┌─────────────────┐         ┌─────────────────┐
                    │     │ Success/Invalid│         │ Recursive depth │
                    │     │ Update/Remove  │         │ Until maxDepth  │
                    │     └─────────────────┘         └─────────────────┘
                    │                                            │
                    └────────────────────────────────────────────┘
                                    ▼
                    ┌───────────────────────────┐
                    │  Update page in DB:       │
                    │  - actions[]              │
                    │  - pendingGenerationCount  │
                    │  - isGeneratingStartedAt = NULL
                    │  - updatedAt              │
                    └───────────────────────────┘
                                    │
                                    ▼
                    ┌───────────────────────────┐
                    │  Release distributed lock │
                    └───────────────────────────┘
                                    │
                                    ▼
                    ┌───────────────────────────┐
                    │  If lock not acquired:    │
                    │  Clear isGeneratingStartedAt = NULL
                    └───────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                  GENERATE CANDIDATE PAGE (generateCandidatePage)         │
│  Location: src/utils/prompt.ts:2624                                      │
│  Purpose: Generate a single candidate page for an action                 │
│                                                                          │
│  This function generates a candidate page for a specific action. It     │
│  validates the action, checks if a pre-generated page already exists,   │
│  and generates a new page using AI if needed.                            │
│                                                                          │
│  Validation: Throws non-retryable error if action.text is empty         │
│  Duplicate Prevention: Checks for existing destinations to avoid         │
│  duplicate database insertions during retry operations                    │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
                    ┌───────────────────────────┐
                    │  Validate action.text      │
                    │  (throw if empty)          │
                    └───────────────────────────┘
                                    │
                                    ▼
                    ┌───────────────────────────┐
                    │  Get story progress       │
                    │  (book, state, session)    │
                    │  Use provided if available │
                    └───────────────────────────┘
                                    │
                                    ▼
                    ┌───────────────────────────┐
                    │  Match action to page     │
                    │  actions (text + type)    │
                    └───────────────────────────┘
                                    │
                                    ▼
                    ┌───────────────────────────┐
                    │  Check if pre-generated    │
                    │  page exists via           │
                    │  getStoryPageById()        │
                    │  using action.destination  │
                    │     ?.pageId               │
                    └───────────────────────────┘
                                    │
                    ┌───────────────┴───────────────┐
                    ▼                               ▼
          ┌─────────────────┐              ┌─────────────────┐
          │ Page exists     │              │ No page exists  │
          │ (reuse it)      │              │ (generate new)  │
          │ Log: Using      │              │ Create actioned  │
          │ pre-generated  │              │ page with action│
          │ Return page     │              │ Call buildNext  │
          └─────────────────┘              └─────────────────┘
                    │                               │
                    │                               ▼
                    │               ┌───────────────────────────┐
                    │               │  buildNextPage()          │
                    │               │  - advanceStoryState()   │
                    │               │  - buildSystemPrompt()   │
                    │               │  - AI generation         │
                    │               │  - Duplicate Prevention  │
                    │               │    Check action dest     │
                    │               │  - insertStoryPage()     │
                    │               │  Returns PersistedStoryPage│
                    │               └───────────────────────────┘
                    │                               │
                    └───────────────┬───────────────┘
                                    ▼
                    ┌───────────────────────────┐
                    │  Return PersistedStoryPage│
                    │  { id, branchId, page,    │
                    │    text, actions, ... }    │
                    └───────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    USER NAVIGATION (POST /api/books/.../page/visit)      │
│  Location: src/routes/books.ts:888                                        │
│  Purpose: Track user navigation and validate action choices              │
│                                                                          │
│  This endpoint handles user navigation between pages. It validates      │
│  that the action exists on the previous page and checks if the user     │
│  has already chosen a different action (branching restriction).          │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
                    ┌───────────────────────────┐
                    │  Resolve book by ID/slug  │
                    │  resolveBook()            │
                    └───────────────────────────┘
                                    │
                                    ▼
                    ┌───────────────────────────┐
                    │  Get page by branch & num │
                    │  SELECT pages.id, branchId,│
                    │        page               │
                    └───────────────────────────┘
                                    │
                                    ▼
                    ┌───────────────────────────┐
                    │  Validate action exists   │
                    │  on previous page         │
                    │  Fetch previous page      │
                    │  Check actions array      │
                    └───────────────────────────┘
                                    │
                    ┌───────────────┴───────────────┐
                    ▼                               ▼
          ┌─────────────────┐              ┌─────────────────┐
          │ Action exists   │              │ Action invalid  │
          │ Continue        │              │ Return 400 error │
          └─────────────────┘              └─────────────────┘
                    │
                                    ▼
                    ┌───────────────────────────┐
                    │  Check if user already    │
                    │  chose different action  │
                    │  Query userPageProgress   │
                    │  deepEqualSimple()        │
                    └───────────────────────────┘
                                    │
                    ┌───────────────┴───────────────┐
                    ▼                               ▼
          ┌─────────────────┐              ┌─────────────────┐
          │ Same action or  │              │ Different action │
          │ no previous     │              │ Return 400 error │
          │ Continue        │              │ (branching       │
          └─────────────────┘              │  restriction)    │
                    │                       └─────────────────┘
                                    ▼
                    ┌───────────────────────────┐
                    │  markPageVisited()        │
                    │  - setActiveSession()     │
                    │    (updates active page)  │
                    │  - insertUserPageProgress()│
                    │    (records chosen action)│
                    └───────────────────────────┘
                                    │
                                    ▼
                    ┌───────────────────────────┐
                    │  Return { pageId,          │
                    │          branchId, page }  │
                    │  Navigation context for   │
                    │  frontend                 │
                    └───────────────────────────┘
```

## Key Components

### 1. Action Type with Destination

The `Action` type includes a `destination` object that stores the target page information:

```typescript
export type Action = {
  text: string;
  type: ActionType;
  hint: ActionHint;
  destination: {
    branchId?: string;  // Destination branch ID
    pageId?: string;    // Destination page ID
  };
};
```

- **Complete destination**: Both `branchId` and `pageId` are set → Action is navigable
- **Incomplete destination**: Either field is missing → Action filtered out in API response
- **No destination**: Both fields are undefined → Candidate not yet generated

### 2. Distributed Locking

Pre-generation uses distributed locking to prevent concurrent processing of the same page in serverless environments:

```typescript
const lockKey = LOCK_KEYS.CANDIDATE_GENERATION(page.id);
const lockResult = await withLock(lockKey, async () => {
  // Read current page state
  const currentDBPage = await getPageFromDB(page.id, dbWrite);
  
  // Re-check pending actions after acquiring lock (idempotent)
  const recheckedPendingDBActions = initialDBActions.filter(
    action => !action.destination?.pageId || !action.destination?.branchId
  );
  
  // Process actions...
}, DEFAULT_LOCK_TTL); // 300 seconds (5 minutes)
```

**Lock details:**
- **Key pattern**: `lock:candidate:{pageId}`
- **TTL**: 300 seconds (5 minutes) from `DEFAULT_LOCK_TTL`
- **Purpose**: Prevents multiple serverless instances from processing the same page simultaneously
- **Idempotent**: Re-checks pending actions after acquiring lock to skip if already processed
- **Combined with isGeneratingStartedAt timestamp**: Database timestamp provides persistent visibility and staleness detection; lock provides runtime safety

### 3. Retry Logic with Exponential Backoff

Pre-generation uses `retryWithBackoffOrNull` to handle AI failures gracefully:

```typescript
const candidatePage = await retryWithBackoffOrNull(
  () => generateCandidatePage({userId, action, currentPage, currentState, currentBook, generateNewBranchId}),
  { 
    maxRetries: MAX_BRANCHING_RETRIES, // 3 from config/story.ts
    baseDelayMs: 1000,    // 1 second
    maxDelayMs: 4000,     // 4 seconds
    onRetry: (attempt, error) => {
      lastError = error;
      console.error(`[ensureCandidatesForPage] ⚠️ Retry ${attempt}/${MAX_BRANCHING_RETRIES} for action "${action.text}":`, error);
    },
    shouldRetry: (error) => {
      const err = error as ErrorWithCustomProperties;
      if (err.shouldRetry === false || err.code === 'INVALID_ACTION' || err.code === 'ACTION_ALREADY_HAS_DESTINATION') {
        console.warn(`[ensureCandidatesForPage] ⛔ Non-retryable error detected:`, getErrorMessage(error));
        return false;
      }
      return true;
    }
  }
);
```

**Retry pattern:**
- Attempt 1: Immediate
- Attempt 2: Wait 1 second
- Attempt 3: Wait 2 seconds
- Attempt 4: Wait 4 seconds
- After 3 failures: Return `null`, leave destination undefined
- **Non-retryable errors**: Actions with `INVALID_ACTION`, `ACTION_ALREADY_HAS_DESTINATION` code or `shouldRetry: false` are removed
- **Duplicate prevention**: `ACTION_ALREADY_HAS_DESTINATION` prevents duplicate database insertions during retries

### 4. Invalid Action Handling

When an action is marked as non-retryable (e.g., validation error):

```typescript
if (isInvalidAction) {
  console.error(`[ensureCandidatesForPage] ❌ Invalid action "${action.text}" detected, removing from actions`);
  const actionIndex = updatedDBActions.findIndex(a => deepEqualSimple(a, action));
  if (actionIndex !== -1) {
    updatedDBActions.splice(actionIndex, 1);
    hasRealChanges = true;
  }
}
```

**Fallback action:** If all actions are invalid, a fallback "Continue." action is added:

```typescript
if (updatedDBActions.length === 0) {
  console.warn(`[ensureCandidatesForPage] ⚠️ All actions are invalid, replaced with 1 continue action.`);
  updatedDBActions.push({
    text: "Continue.",
    type: "other",
    hint: { text: "See what happens next.", type: "none" },
    destination: {} // Will be pre-generated on next run
  });
  hasRealChanges = true;
}
```

This ensures the page always has at least one navigable action.

### 5. Duplicate Prevention in Retry Operations

To prevent duplicate database insertions during retry operations, the system implements a dual-check mechanism:

#### In `generateNextPage` (Retry Handler)
```typescript
// Check if this specific action already has a destination pageId
const currentAction = freshActionedPage.actions.find(a => 
  a.text === selectedAction.text && a.type === selectedAction.type
);

if (currentAction?.destination?.pageId) {
  throw createNonRetryableError(
    `Action "${selectedAction.text}" already has destination pageId ${currentAction.destination.pageId}`,
    'ACTION_ALREADY_HAS_DESTINATION'
  );
}
```

#### In `generateCandidatePage` (Caller)
```typescript
try {
  newPage = await generateNextPage({...});
} catch (error) {
  if ((error as ErrorWithCustomProperties).code === 'ACTION_ALREADY_HAS_DESTINATION') {
    // Retrieve existing page instead of generating duplicate
    const existingPageId = action.destination?.pageId;
    if (existingPageId) {
      newPage = await getStoryPageById(userId, bookId, existingPageId);
    }
  } else {
    throw error; // Re-throw other errors
  }
}
```

**How it works:**
1. **Race Condition Detection**: During retry operations, fresh page data is read from database
2. **Action Matching**: Compares action text and type to find the exact action
3. **Early Exit**: If destination exists, throws non-retryable error to prevent insertion
4. **Graceful Fallback**: Caller catches error and retrieves existing page
5. **No Duplication**: Prevents creating duplicate pages when multiple instances process same action

### 6. Multi-Level Depth Configuration

The system supports configurable pre-generation depth via `MAX_BRANCHING_PREGENERATION_DEPTH`:

```typescript
// From src/config/story.ts
export const MAX_BRANCHING_PREGENERATION_DEPTH = 2; // TODO: use
```

**Depth Behavior:**
- **Level 1**: Synchronous parallel generation, results returned to user immediately
- **Level 2+**: Fire-and-forget background processing, doesn't block user response
- **Depth Limit**: Generation stops when `currentDepth > maxDepth`
- **Exponential Growth**: Each level can multiply the total pages (3³ = 27 pages at depth 3)

**Implementation:**
```typescript
// Level 1: Synchronous (main response)
const generationResults = await generateCandidatesInParallel({
  userId,
  actions: recheckedPendingDBActions,
  currentPage,
  currentState,
  currentBook,
  initialGenerateNewBranchId: generateNewBranchId,
  timeoutMs: AI_GENERATION_TIMEOUT_MS,
  currentDepth: 1,
  maxDepth: MAX_BRANCHING_PREGENERATION_DEPTH
});

// Level 2+: Fire-and-forget background
if (currentDepth < maxDepth) {
  Promise.all(
    successfulResults.map(async (result) => {
      await ensureCandidatesForPageWithDepth(userId, candidateUserPage, null, currentBook, currentDepth + 1, maxDepth);
    })
  ); // No await - runs in background
}
```

**Benefits:**
- **Instant Response**: Level 1 completes quickly and returns to user
- **Deep Coverage**: Background processing ensures deeper levels are ready when needed
- **Resource Control**: Configurable depth prevents excessive resource usage
- **Timeout Resilience**: Background processing has more generous timeouts

## Implementation Details

### Branch ID Logic

The system uses sophisticated branch ID management to ensure proper story tree structure:

#### Synchronous Processing (ensureCandidatesForPage)
```typescript
let generateNewBranchId = recheckedPendingDBActions.length < initialDBActions.length;

// Process results sequentially to maintain branch ID state
for (let i = 0; i < generationResults.length; i++) {
  const result = generationResults[i];
  
  if (result.success && result.candidatePage) {
    // After first successful generation, subsequent actions use new branches
    generateNewBranchId = true;
  }
}
```

**Logic Flow:**
- **Initial State**: `generateNewBranchId = true` if some actions already have destinations
- **First Action**: Uses existing branch (or new branch if none exist)
- **Subsequent Actions**: Always use new branches (`generateNewBranchId = true`)
- **Purpose**: Ensures proper story tree branching without conflicts

#### Background Processing (ensureCandidatesForPageWithDepth)
```typescript
const generateNewBranchId = recheckedPendingDBActions.length < initialDBActions.length;

// Note: generateNewBranchId logic not used in background processing
// as each action generates independently without affecting others
```

**Why Different Logic:**
- **Independent Generation**: Each background action generates without affecting others
- **No Sequential Dependencies**: Background processing doesn't need to maintain state between actions
- **Simplified Architecture**: Reduces complexity in fire-and-forget operations

### Timeout Calculation

The system implements dynamic timeout calculation to optimize for different scenarios:

#### Synchronous Processing (User-Facing)
```typescript
const timeElapsed = Date.now() - requestStartTime;
const AI_GENERATION_TIMEOUT_MS = Math.max(VERCEL_TIMEOUT_MS - timeElapsed - RESPONSE_BUFFER_MS, 60000);
```

**Parameters:**
- `VERCEL_TIMEOUT_MS`: 300,000ms (5 minutes - Vercel limit)
- `RESPONSE_BUFFER_MS`: 5,000ms (response processing buffer)
- **Minimum Timeout**: 60,000ms (1 minute)

**Logic:**
- Calculate remaining time before Vercel timeout
- Subtract buffer for response processing
- Ensure minimum 1 minute for AI generation
- **Result**: Adaptive timeout based on request progress

#### Background Processing (Fire-and-Forget)
```typescript
const requestStartTime = Date.now(); // Track at function start
const BACKGROUND_TIMEOUT_MS = 180000; // 3 minutes for background
const timeElapsed = Date.now() - requestStartTime;
const AI_GENERATION_TIMEOUT_MS = Math.max(BACKGROUND_TIMEOUT_MS - timeElapsed - 5000, 30000);
```

**Parameters:**
- `BACKGROUND_TIMEOUT_MS`: 180,000ms (3 minutes - more generous)
- **Buffer**: 5,000ms (processing buffer)
- **Minimum Timeout**: 30,000ms (30 seconds)

**Logic:**
- Fixed 3-minute background timeout (more generous than user-facing)
- Track elapsed time from function start (not request start)
- Ensure minimum 30 seconds for AI generation
- **Result**: Consistent background processing timeout

### Error Handling Patterns

#### Synchronous Processing
```typescript
if (result.success && result.candidatePage) {
  // Update action with destination
  updatedDBActions[actionIndex] = { 
    ...action, 
    destination: { 
      branchId: result.candidatePage.branchId, 
      pageId: result.candidatePage.id 
    } 
  };
  generateNewBranchId = true; // Affects subsequent actions
} else {
  // Handle validation errors vs retryable errors
  const isInvalidAction = result.error && (
    (result.error as ErrorWithCustomProperties).code === 'INVALID_ACTION' ||
    (result.error as ErrorWithCustomProperties).shouldRetry === false
  );
  
  if (isInvalidAction) {
    // Remove invalid actions permanently
    updatedDBActions.splice(actionIndex, 1);
  }
  // Valid actions with errors remain for future retry
}
```

#### Background Processing
```typescript
// Fire-and-forget with proper error handling
void Promise.allSettled(
  successfulResults.map(async (result) => {
    try {
      // Validate required fields before processing
      if (!candidatePage.id || !candidatePage.bookId || !candidatePage.branchId) {
        console.error(`Invalid candidate page missing required fields`);
        return;
      }
      
      // Process without await for true fire-and-forget
      void ensureCandidatesForPageWithDepth(userId, candidateUserPage, null, currentBook, currentDepth + 1, maxDepth)
        .catch(error => console.error(`Background generation failed:`, getErrorMessage(error)));
    } catch (error) {
      console.error(`Background processing error:`, getErrorMessage(error));
    }
  })
).then(results => {
  // Monitor rejected promises without blocking
  const rejectedCount = results.filter(r => r.status === 'rejected').length;
  if (rejectedCount > 0) {
    console.warn(`${rejectedCount} background operations failed`);
  }
});
```

### Type Safety & Validation

#### Runtime Validation
```typescript
// Validate required fields before casting
if (!candidatePage.id || !candidatePage.bookId || !candidatePage.branchId) {
  console.error(`Invalid candidate page missing required fields:`, {
    id: candidatePage.id,
    bookId: candidatePage.bookId,
    branchId: candidatePage.branchId
  });
  return;
}

// Safe type conversion
const candidateUserPage: UserStoryPage = {
  ...candidatePage,
  selectedActions: []
};
```

#### Interface Contracts
```typescript
// Type-safe parameter passing
interface GenerateCandidatesInParallelParams {
  userId: string;
  actions: Action[];
  currentPage: UserStoryPage;
  currentState: StoryState | null | undefined;
  currentBook: Book | null;
  initialGenerateNewBranchId: boolean;
  timeoutMs: number;
  currentDepth: number;
  maxDepth: number;
}
```

### Resource Management

#### Distributed Locking
```typescript
// Synchronous: 5-minute lock
await withLock(lockKey, async () => { /* ... */ }, 300);

// Background: 10-minute lock (more generous)
await withLock(lockKey, async () => { /* ... */ }, 600);
```

**Lock Duration Rationale:**
- **Synchronous**: Shorter lock prevents blocking user requests
- **Background**: Longer lock accommodates extended processing time
- **Purpose**: Prevents duplicate generation across serverless instances

#### Memory & Performance
- **Parallel Processing**: `Promise.allSettled()` for concurrent action generation
- **Fire-and-Forget**: Background operations don't block main response
- **Type Safety**: Runtime validation prevents memory leaks from invalid objects
- **Error Boundaries**: Proper error handling prevents cascade failures

### 7. Generation timestamp and SSE waiting

The `isGeneratingStartedAt` timestamp column in the `pages` table provides durable visibility into candidate generation status and supports heartbeat/staleness detection:

```typescript
// Timestamp when generation started; NULL means not generating
isGeneratingStartedAt: timestamp("is_generating_started_at", { withTimezone: true })
```

**How it works:**
1. **Before lock acquisition**: `ensureCandidatesForPage` sets `isGeneratingStartedAt = now()` in the database (inside the distributed lock)
2. **During generation**: `isGeneratingStartedAt` remains non-null while the worker owns the job; worker may periodically refresh heartbeats by updating this timestamp
3. **After completion**: Worker clears `isGeneratingStartedAt = NULL` when generation finishes or fails
4. **Stale detection**: A watchdog process or reclaim logic can detect stale timestamps (older than a configured TTL) and either re-enqueue work or clear the timestamp safely

**SSE (Server-Sent Events) Pattern:**

The manual candidate generation endpoint (`GET /api/books/:identifier/:pageId/candidates`) uses SSE to wait for in-progress generations. Check the timestamp existence instead of a boolean:

```typescript
// Check if generation is already in progress
if (dbPage.isGeneratingStartedAt) {
  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // Poll for completion (every 2 seconds, max 5 minutes)
  while (attempts < maxAttempts) {
    const freshPage = await getPageFromDB(pageId);
    if (!freshPage.isGeneratingStartedAt) {
      // Generation complete, send result via SSE
      res.write(`event: complete\n`);
      res.write(`data: ${JSON.stringify(userPage)}\n\n`);
      res.end();
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
}
```

**SSE Events:**
- `progress`: Sent every 10 seconds with waiting status and elapsed time
- `complete`: Sent when generation finishes with the updated page data
- `error`: Sent if page is deleted during polling
- `timeout`: Sent after 5 minutes if generation hasn't completed

**Benefits:**
- **Single operation guarantee**: Multiple concurrent requests don't trigger duplicate AI generation
- **Real-time updates**: Clients receive progress updates without polling
- **Resource efficiency**: Expensive AI operations run only once per page
- **Better UX**: Users see progress instead of waiting blindly

### Frontend Implementation Example (Auto-Detection with TanStack Query)

Here's how to implement the SSE handling for the candidate generation endpoint in a React frontend that auto-detects missing actions and integrates with TanStack Query:

```typescript
// utils/candidate-generation.ts
interface GenerationProgress {
  status: 'waiting' | 'complete' | 'error' | 'timeout';
  message?: string;
  warning?: string;
  error?: string;
}

interface StoryPage {
  id: string;
  page: number;
  text: string;
  mood?: string;
  place?: string;
  timeOfDay?: string;
  actions: Action[];
  originalActionsCount?: number;
  createdAt: string;
  warning?: string;
}

interface Action {
  text: string;
  type: string;
  hint: {
    text: string;
    type: string;
  };
  destination?: {
    branchId?: string;
    pageId?: string;
  };
}

export async function generateCandidates(
  bookIdentifier: string,
  pageId: string,
  onProgress?: (progress: GenerationProgress) => void
): Promise<StoryPage> {
  const response = await fetch(`/api/books/${bookIdentifier}/${pageId}/candidates`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
    },
  });

  // Check if response is SSE (text/event-stream)
  const contentType = response.headers.get('content-type');
  
  if (contentType?.includes('text/event-stream')) {
    // Handle SSE response
    return new Promise((resolve, reject) => {
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      
      if (!reader) {
        reject(new Error('Response body is not readable'));
        return;
      }

      let buffer = '';
      
      const processChunk = (chunk: Uint8Array) => {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line in buffer
        
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6); // Remove 'data: ' prefix
            if (data.trim()) {
              try {
                const parsed = JSON.parse(data);
                
                // Handle different event types
                if (parsed.status === 'complete') {
                  resolve(parsed);
                } else if (parsed.status === 'error') {
                  reject(new Error(parsed.error || 'Generation failed'));
                } else if (parsed.status === 'timeout') {
                  resolve(parsed); // Return with warning
                } else if (parsed.status === 'waiting') {
                  onProgress?.(parsed);
                }
              } catch (error) {
                console.error('Failed to parse SSE data:', error);
              }
            }
          }
        }
      };

      reader.read().then(function pump({ done, value }) {
        if (done) {
          // Connection closed
          reject(new Error('SSE connection closed unexpectedly'));
          return;
        }
        
        processChunk(value);
        return reader.read().then(pump);
      }).catch(reject);
    });
  } else {
    // Handle regular JSON response
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const data = await response.json();
    return data;
  }
}

// API client function for TanStack Query
export async function booksApiGenerateCandidates(
  bookSlug: string,
  pageId: string,
  onProgress?: (progress: GenerationProgress) => void
): Promise<StoryPage> {
  return generateCandidates(bookSlug, pageId, onProgress);
}
```

```typescript
// hooks/useAutoCandidateGeneration.ts
import { useEffect, useRef } from 'react';
import { useMutation } from '@tanstack/react-query';
import { booksApiGenerateCandidates } from '../utils/candidate-generation';

interface UseAutoCandidateGenerationProps {
  page: StoryPage | null;
  book: { id: string } | null;
  bookSlug: string;
  updatePageData: (pageId: string, bookId: string, updates: Partial<StoryPage>) => void;
  onProgress?: (progress: GenerationProgress) => void;
  onError?: (error: Error) => void;
}

export function useAutoCandidateGeneration({
  page,
  book,
  bookSlug,
  updatePageData,
  onProgress,
  onError,
}: UseAutoCandidateGenerationProps) {
  // Track which pages have generation in progress to prevent duplicates
  const generatedCandidatesRef = useRef<Set<string>>(new Set());

  const generateCandidatesMutation = useMutation({
    mutationFn: ({ bookSlug, pageId }: { bookSlug: string; pageId: string }) =>
      booksApiGenerateCandidates(bookSlug, pageId, onProgress),
    onSuccess: (candidatesResponse) => {
      devConsole.log('[useAutoCandidateGeneration] ✅ Candidates generated successfully', candidatesResponse);
      
      // Update page data with new actions from candidates response
      const { actions } = candidatesResponse;
      if (page && book) {
        updatePageData(page.id, book.id, { actions });
        devConsole.log(`[useAutoCandidateGeneration] 👉 ${actions.length} actions should be displayed now:`, actions);
      }
      
      // Clean up ref on success
      const generationKey = `${bookSlug}-${page?.id}`;
      generatedCandidatesRef.current.delete(generationKey);
    },
    onError: (error) => {
      devConsole.error('[useAutoCandidateGeneration] ❌ Failed to generate candidates:', error);
      
      // Remove from ref on error to allow retry
      const generationKey = `${bookSlug}-${page?.id}`;
      generatedCandidatesRef.current.delete(generationKey);
      
      onError?.(error as Error);
    },
  });

  // Auto-detect and generate missing candidates
  useEffect(() => {
    if (page && book) {
      const hasMissingActions = page.originalActionsCount && page.originalActionsCount > page.actions.length;
      const generationKey = `${bookSlug}-${page.id}`;
      
      if (hasMissingActions && !generatedCandidatesRef.current.has(generationKey)) {
        // Mark as generating to prevent duplicate calls
        generatedCandidatesRef.current.add(generationKey);
        
        devConsole.log('[useAutoCandidateGeneration] 🔄 Missing actions detected, generating candidates...', {
          originalActionsCount: page.originalActionsCount,
          currentActionsCount: page.actions.length,
          pageId: page.id
        });

        generateCandidatesMutation.mutate({ bookSlug, pageId: page.id });
      }
    }
  }, [page, book, bookSlug, generateCandidatesMutation]);

  return {
    isGenerating: generateCandidatesMutation.isPending,
    error: generateCandidatesMutation.error,
  };
}
```

```typescript
// components/ReaderPageClient.tsx
import React from 'react';
import { useAutoCandidateGeneration } from '../hooks/useAutoCandidateGeneration';

interface ReaderPageClientProps {
  page: StoryPage | null;
  book: { id: string } | null;
  bookSlug: string;
  updatePageData: (pageId: string, bookId: string, updates: Partial<StoryPage>) => void;
}

export function ReaderPageClient({
  page,
  book,
  bookSlug,
  updatePageData,
}: ReaderPageClientProps) {
  // Auto-generate candidates when actions are missing
  const { isGenerating, error } = useAutoCandidateGeneration({
    page,
    book,
    bookSlug,
    updatePageData,
    onProgress: (progress) => {
      devConsole.log('[ReaderPageClient] 📊 Generation progress:', progress.message);
      // Optional: Show progress indicator in UI
    },
    onError: (error) => {
      devConsole.error('[ReaderPageClient] ❌ Generation error:', error.message);
      // Optional: Show error notification
    },
  });

  return (
    <div>
      {/* Page content */}
      {page && (
        <div>
          <h1>Page {page.page}</h1>
          <p>{page.text}</p>
          
          {/* Generation progress indicator */}
          {isGenerating && (
            <div className="mb-4 p-3 bg-blue-50 rounded">
              <p className="text-sm text-blue-700">
                🔄 Generating candidate actions...
              </p>
            </div>
          )}

          {/* Generation error */}
          {error && (
            <div className="mb-4 p-3 bg-red-50 rounded">
              <p className="text-sm text-red-700">
                ❌ Failed to generate actions: {error.message}
              </p>
            </div>
          )}
          
          {/* Actions */}
          <div className="mt-4">
            {page.actions.map((action, index) => (
              <div key={index} className="mb-2">
                {action.destination ? (
                  <button className="action-button">
                    {action.text}
                  </button>
                ) : (
                  <div className="text-gray-400">
                    {action.text} (generating...)
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
```

**Key Implementation Points:**

1. **Auto-Detection**: Uses `originalActionsCount` vs `actions.length` to detect missing candidates
2. **TanStack Query Integration**: Leverages `useMutation` for state management and caching
3. **Duplicate Prevention**: Ref-based tracking prevents multiple generation calls for same page
4. **SSE Support**: Handles both SSE and JSON responses transparently
5. **Progress Callbacks**: Optional progress reporting during SSE waiting
6. **Error Handling**: Automatic retry capability and error cleanup
7. **Cache Updates**: Integrates with existing TanStack Query cache via `updatePageData`

**Usage Pattern:**
- Component automatically detects when actions are missing
- Triggers generation without user intervention
- Shows progress indicators during generation
- Updates UI automatically when candidates are ready
- Handles errors gracefully with retry capability

**Benefits of Auto-Detection Approach:**
- **Seamless UX**: Users don't need to manually trigger generation
- **Efficient**: Only generates when actually needed (missing actions)
- **Integrated**: Works seamlessly with existing TanStack Query setup
- **Robust**: Proper error handling and state management
- **Real-time**: SSE progress updates during long operations

### 7. EnrichedAction for Frontend

The frontend receives `EnrichedAction` with navigation metadata:

```typescript
export type EnrichedAction = Action & {
  nextPageNumber?: number;   // Current page + 1 if destination.pageId exists
  isUserChosen?: boolean;    // Whether current user chose this action
};
```

**Note**: `nextBranchId` was removed - frontend uses `action.destination.branchId` directly.

## Cascade Effect

The pre-generation system creates a cascade of generated pages as the user navigates:

```
Book Creation
    ↓
Pre-generate Page 1 candidates (A, B, C)
    ↓
User chooses action A → Page 2
    ↓
Pre-generate Page 2 candidates (D, E)
    ↓
User chooses action D → Page 3
    ↓
Pre-generate Page 3 candidates (F, G)
    ↓
...and so on
```

This ensures:
- **Fast navigation**: Most pages are pre-generated before user reaches them
- **Efficient resource usage**: Only generates pages for actions user might take
- **Natural progression**: Generation follows user's story path

**Important**: Pre-generation is **one level deep per call**. It does NOT loop to generate page 3, 4, 5, etc. all at once during book creation. Each call to `ensureCandidatesForPage()` generates candidates only for the immediate next level (the actions on the current page).

**Why only one level deep?**
- **Resource efficiency**: Only generates pages user might actually visit
- **Story branching**: User might choose different paths; generating all branches is wasteful
- **Instant experience**: One level deep is sufficient for perceived speed
- **Natural progression**: Generation follows user's actual story path incrementally

**How the cascade works:**
1. Book creation: Pre-generate page 2 candidates (from page 1 actions)
2. User visits page 2: Pre-generate page 3 candidates (from page 2 actions)
3. User visits page 3: Pre-generate page 4 candidates (from page 3 actions)
4. And so on... each navigation triggers pre-generation for the next level only

## Incomplete Destination Handling

When candidate generation fails after all retries:

1. **Action destination remains undefined**: `{ branchId?: string, pageId?: string }`
2. **No error shown to user**: Silent failure, doesn't block navigation
3. **Filtered in API response**: GET page endpoint filters actions without complete destination
4. **User experience**: Action simply doesn't appear (as if it never existed)
5. **Automatic retry**: Failed generations are tracked and retried via cron job
6. **Invalid actions removed**: Non-retryable errors cause action removal
7. **Fallback action**: "Continue." added if all actions are invalid

This design choice prioritizes user experience over transparency:
- Users never see failed generation errors
- Navigation continues smoothly
- Frontend only shows viable actions
- Background retry system eventually completes failed generations
- Invalid actions are cleaned up automatically
- Fallback ensures page is never completely dead-ended

## No User Validation in Pre-Generation

Important: `generateCandidatePage` does NOT validate user's previous choices.

**Why?**
- Pre-generation is fire-and-forget, not tied to specific user sessions
- Same page might be visited by different users via different paths
- Validation only matters during actual user navigation (POST /visit)

**Validation happens in POST /visit:**
- Checks if action exists on previous page
- Checks if user already chose a different action (branching restriction)
- Prevents users from selecting alternate branches on revisited pages

**Action validation in generateCandidatePage:**
- Throws non-retryable error if `action.text` is empty
- Uses `createNonRetryableError` with `INVALID_ACTION` code
- This causes the action to be removed from the page

## Database Operations

### Insert Story Page
```typescript
await insertStoryPage(userId, pageNumber, storyPage, { bookId, branchId, parentId });
```
- Persists generated page to database
- Includes branchId for tracking story branches
- Links to parent page for traversal history
- Sets initial `pendingGenerationCount` based on actions without destinations

### Update Story Page
```typescript
await updateStoryPage(page.id, { ...page });
```
- Updates actions with destination information
- Called only when candidates are successfully generated
- Persists new candidate page references

### User Page Progress
```typescript
await insertUserPageProgress(userId, bookId, pageId, action);
```
- Records user's chosen action for a page
- Used for branching restriction validation
- Prevents re-choosing different actions on same page

## Performance Considerations

### Fire-and-Forget Pattern
- Pre-generation runs asynchronously
- Doesn't block user responses
- Uses `void` to discard promises
- Distributed lock ensures safe concurrent execution

### Sequential Generation
- Candidates generated one at a time (not parallel)
- Prevents overwhelming AI API
- Typical: 2-3 actions per page, manageable load

### Retry Logic
- Exponential backoff reduces API pressure
- Failed retries don't cascade
- Silent failure prevents error propagation

## Error Handling

### Generation Failures
- Logged to console with context
- Non-retryable errors: Action removed from page
- Retryable errors: Action left with undefined destination
- Filtered out in API response
- No user-facing error messages
- Fallback action added if all actions invalid

### Database Failures
- Wrapped in try-catch
- Logged with error context
- Propagated to caller
- May result in HTTP 500

### Validation Errors
- User-facing (400 Bad Request)
- Clear error messages
- Prevents invalid navigation
- Protects story integrity

## API Endpoints

### GET /api/books/:identifier/:pageId/candidates
- Manually triggers candidate generation for a specific page
- Checks `isGeneratingStartedAt` timestamp to detect in-progress generation (non-null means in-progress)
- If `isGeneratingStartedAt` is set: Uses SSE to wait for completion instead of retriggering
- If `isGeneratingStartedAt` is null: Calls `ensureCandidatesForPage` to start generation
- **SSE Response**: Sends `progress`, `complete`, `error`, or `timeout` events
- **JSON Response**: Returns updated page when generation completes immediately
- Prevents duplicate expensive AI generation operations

### GET /api/books/:identifier/:branchId/:page
- Fetches page with enriched actions
- Filters actions without complete destination
- Includes `isUserChosen` flag for user's selected action
- Returns `EnrichedAction[]` with navigation metadata

### POST /api/books/:identifier/:branchId/:page/visit
- Tracks user navigation between pages
- Validates action exists on previous page
- Checks user's previous choice (branching restriction)
- Updates session and progress records
- Returns `{ pageId, branchId, page }` for navigation context

## Type Definitions

### Action
```typescript
export type Action = {
  text: string;
  type: ActionType;
  hint: ActionHint;
  destination: {
    branchId?: string;
    pageId?: string;
  };
};
```

### EnrichedAction
```typescript
export type EnrichedAction = Action & {
  nextPageNumber?: number;
  isUserChosen?: boolean;
};
```

### PersistedStoryPage
```typescript
export type PersistedStoryPage = StoryPage & Pick<DBPage, 'id' | 'bookId' | 'branchId' | 'parentId' | 'page'>;
```

## Best Practices

1. **Always use destination object**: Never access `pageId` directly on action
2. **Check both fields**: Ensure both `branchId` and `pageId` exist before navigation
3. **Fire-and-forget**: Pre-generation should never block user responses
4. **Silent failure**: Failed generations should not surface to users
5. **Validate on navigation**: Only validate user choices during POST /visit
6. **Log context**: Include userId, pageId, actionText in error logs
7. **Prevent duplicates**: Always check for existing destinations during retry operations
8. **Use non-retryable errors**: For duplicate prevention to stop unnecessary retries

## Retry Mechanism for Failed Generations

Failed candidate generations are automatically retried via a cron job system:

### Cron Job: retry-pending-generations
**Location**: `src/cron/retry-pending-generations.ts`
**Schedule**: Every hour via GitHub Actions
**Purpose**: Retry failed candidate page generations for unvisited pages

**How it works:**
1. Queries pages with `pendingGenerationCount > 0`
2. Excludes last pages (`page.number < totalPages`) since they don't need candidates
3. Processes up to 50 pages per run (ordered by `desc(books.trendingScore), desc(pages.pendingGenerationCount)`)
4. For each page, calls `ensureCandidatesForPage` to retry generation
5. Updates `pendingGenerationCount` after each attempt
6. Logs success/failure statistics for monitoring
7. Also generates missing cover images for original books (see below)

**Database tracking:**
- `pages.pendingGenerationCount`: Integer column tracking actions without destinations
- `pages.isGeneratingStartedAt`: Nullable timestamp indicating when generation started (NULL means not generating)
- Indexed via `pages_pending_generation_idx` for efficient cron job queries
- Set during page insertion based on actions without destinations
- Updated by `ensureCandidatesForPage` after generation attempts
- `isGeneratingStartedAt` set to `now()` before generation, cleared to `NULL` after completion or failure

**Benefits:**
- Automatic recovery from transient AI failures
- No manual intervention required
- Efficient processing with batch limits
- Prioritizes trending books and pages with most pending actions

### Missing Cover Image Generation

The same cron job also generates missing cover images for original books:

**Function**: `generateMissingOriginalBookCovers()`
**Purpose**: Generate AI cover images for original books without covers

**How it works:**
1. Queries books where `isOriginal: true` and `image: null`
2. Prioritizes by lowest `branchesCount`, then by highest `trendingScore`
3. Processes up to 25 books per run
4. Calls `generateAndUpdateBookCoverImage` for each book
5. Updates book with new image URL and ID

**Benefits:**
- Ensures original books have attractive covers
- Prioritizes books that need more exposure (low branches)
- Leverages trending score for quality assurance

### Cron Job: generate-originals
**Location**: `src/cron/generate-originals.ts`
**Schedule**: Daily via GitHub Actions
**Purpose**: Generate one Twistloom Original book per day

**How it works:**
1. Generates creative theme using AI (non-streaming)
2. Calls `createBookCore` with `isOriginal: true` and `generateCoverImage: true`
3. Retries up to 3 times with new themes on failure
4. Invalidates explore cache so new original appears

**Benefits:**
- Daily fresh content for users
- Automatic cover image generation
- Theme retry ensures quality

## Future Enhancements

Potential improvements to consider:

1. **Parallel generation**: Generate multiple candidates simultaneously (with rate limiting)
2. **Priority queue**: Prioritize generation for pages user is likely to visit
3. **Generation status**: Track generation status for debugging
4. **Retry on demand**: Allow users to retry failed generations
5. **Generation analytics**: Track generation success rates and optimize
6. **Smart pre-generation**: Predict user's likely actions and prioritize those

## Summary

The automatic pre-generation system provides instant navigation by proactively generating candidate pages for user actions. It uses a fire-and-forget pattern with distributed locking and retry logic to handle AI failures gracefully, ensuring a smooth user experience while maintaining story integrity through validation during actual navigation.

**Key takeaways:**
- Pre-generation is asynchronous and non-blocking
- Distributed locks prevent concurrent processing in serverless environments
-- `isGeneratingStartedAt` timestamp provides database-level visibility into generation status and enables stale detection
- SSE pattern allows clients to wait for in-progress generations without duplicates
- Failed generations are tracked via `pendingGenerationCount` and retried by cron job
- Non-retryable errors cause action removal with fallback "Continue." action
- Validation only happens during user navigation
- Cascade effect creates tree of pre-generated pages
- Destination object stores branchId and pageId for navigation
- Automatic retry system ensures eventual completion of failed generations
- Separate cron jobs for retrying generations and creating original books
- Cover image generation integrated into retry cron job
- Single operation guarantee per (bookId + pageId) combination via isGenerating flag
