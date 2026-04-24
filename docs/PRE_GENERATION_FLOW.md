# Story Page Automatic Pre-Generation Flow

## Overview

This document describes the automatic pre-generation system for story pages in Twistloom. The system proactively generates candidate pages for user actions to provide instant navigation and reduce perceived latency during story progression.

## Architecture

The pre-generation system uses a **fire-and-forget** pattern with **exponential backoff retry** to generate candidate pages asynchronously. This ensures:

- **Instant user experience**: Users can navigate to pre-generated pages immediately
- **Graceful failure handling**: Failed generations don't block user navigation
- **Resource efficiency**: Only generates pages for actions users might take
- **Cascade effect**: Each generated page triggers pre-generation of its own candidates

## Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         BOOK CREATION (initializeBook)                   │
│  Location: src/utils/prompt.ts:1911                                      │
│  Purpose: Create new book with first page and trigger pre-generation     │
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
│  Location: src/utils/prompt.ts:2511                                      │
│  Purpose: Iterate through actions and pre-generate candidate pages        │
│                                                                          │
│  This function is the core of the pre-generation system. It scans all    │
│  actions on a page and generates candidate pages for those without a     │
│  destination.pageId (indicating no pre-generated candidate exists).      │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
                    ┌───────────────────────────┐
                    │  For each action on page:  │
                    │  Check destination.pageId   │
                    └───────────────────────────┘
                                    │
                    ┌───────────────┴───────────────┐
                    ▼                               ▼
          ┌─────────────────┐              ┌─────────────────┐
          │ Has destination │              │ No destination   │
          │ (pre-generated) │              │ (needs gen)      │
          │ Skip this action│              │ Generate candidate│
          └─────────────────┘              └─────────────────┘
                    │                               │
                    │                               ▼
                    │               ┌───────────────────────────┐
                    │               │  retryWithBackoffOrNull() │
                    │               │  (3 retries, 1s/2s/4s)    │
                    │               │  Handles AI failures     │
                    │               └───────────────────────────┘
                    │                               │
                    │                               ▼
                    │               ┌───────────────────────────┐
                    │               │  generateCandidatePage()  │
                    │               │  Generate single page     │
                    │               └───────────────────────────┘
                    │                               │
                    └───────────────┬───────────────┘
                                    ▼
                    ┌───────────────────────────┐
                    │  If success: update action │
                    │  with destination          │
                    │  { branchId, pageId }      │
                    │  Persist to DB             │
                    └───────────────────────────┘
                                    │
                    ┌───────────────┴───────────────┐
                    ▼                               ▼
          ┌─────────────────┐              ┌─────────────────┐
          │ Generation      │              │ Generation      │
          │ succeeded       │              │ failed (3x)     │
          │ Action updated │              │ Leave undefined  │
          │ Persist page    │              │ Filtered in API  │
          └─────────────────┘              └─────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                  GENERATE CANDIDATE PAGE (generateCandidatePage)         │
│  Location: src/utils/prompt.ts:2330                                      │
│  Purpose: Generate a single candidate page for an action                 │
│                                                                          │
│  This function generates a candidate page for a specific action. It     │
│  first checks if a pre-generated page already exists (reuse scenario),   │
│  and if not, generates a new page using AI.                             │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
                    ┌───────────────────────────┐
                    │  Match actionText to page  │
                    │  actions to find Action    │
                    │  (finds which action)     │
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

### 2. Retry Logic with Exponential Backoff

Pre-generation uses `retryWithBackoffOrNull` to handle AI failures gracefully:

```typescript
const candidatePage = await retryWithBackoffOrNull(
  () => generateCandidatePage({userId, actionText: action.text, currentPage: page, currentState}),
  { 
    maxRetries: 3,
    baseDelayMs: 1000,    // 1 second
    maxDelayMs: 4000,     // 4 seconds
    onRetry: (attempt, error) => {
      console.error(`[ensureCandidatesForPage] ⚠️ Retry ${attempt}/3 for action "${action.text}":`, error);
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

### 3. EnrichedAction for Frontend

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

This design choice prioritizes user experience over transparency:
- Users never see failed generation errors
- Navigation continues smoothly
- Frontend only shows viable actions

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

## Database Operations

### Insert Story Page
```typescript
await insertStoryPage(userId, pageNumber, storyPage, { bookId, branchId, parentId });
```
- Persists generated page to database
- Includes branchId for tracking story branches
- Links to parent page for traversal history

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
- Action left with undefined destination
- Filtered out in API response
- No user-facing error messages

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

## Future Enhancements

Potential improvements to consider:

1. **Parallel generation**: Generate multiple candidates simultaneously (with rate limiting)
2. **Priority queue**: Prioritize generation for pages user is likely to visit
3. **Generation status**: Track generation status for debugging
4. **Retry on demand**: Allow users to retry failed generations
5. **Generation analytics**: Track generation success rates and optimize
6. **Smart pre-generation**: Predict user's likely actions and prioritize those

## Summary

The automatic pre-generation system provides instant navigation by proactively generating candidate pages for user actions. It uses a fire-and-forget pattern with retry logic to handle AI failures gracefully, ensuring a smooth user experience while maintaining story integrity through validation during actual navigation.

**Key takeaways:**
- Pre-generation is asynchronous and non-blocking
- Failed generations are silent (actions filtered in API)
- Validation only happens during user navigation
- Cascade effect creates tree of pre-generated pages
- Destination object stores branchId and pageId for navigation
