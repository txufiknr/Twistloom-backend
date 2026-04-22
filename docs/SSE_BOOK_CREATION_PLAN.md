# SSE Book Creation Implementation Plan

## Overview

Migrate the current single-response POST /api/books endpoint to support SSE (Server-Sent Events) for real-time progress tracking, while maintaining DRY principles to avoid code duplication.

**Goal**: Create `POST /api/books/stream` endpoint that emits step-by-step progress events, while reusing the core logic from POST /api/books.

**Status**: ✅ COMPLETED

---

## Current Implementation Flow (POST /api/books)

### Route Handler (`src/routes/books.ts`)

```typescript
router.post("/", guestOrAuthMiddleware, async (req: Request, res: Response) => {
  const { theme, mcCandidate, generateCoverImage } = req.body;
  
  // STEP 1: VALIDATING THEME
  // - Basic validation (theme exists, non-empty string)
  // - Theme validation (heuristic + AI) via validateTheme(theme)
  // - If invalid, return error via handleThemeValidationError
  
  // Validate mcCandidate if provided
  // Validate generateCoverImage if provided
  
  // STEP 2: INITIALIZING BOOK
  const result = await initializeBook({ userId, theme, mcCandidate, generateCoverImage });
  
  // Enrich actions with navigation metadata
  // Invalidate caches
  // Return 201 with enriched result
});
```

### Key Functions

1. **validateTheme(theme)** (`src/utils/theme-validation.ts`)
   - Calls `validateThemeHeuristic(theme)` - fast check
   - If passes, calls `validateThemeWithAI(theme)` - AI validation
   - Returns `ThemeValidationResult`

2. **initializeBook(params)** (`src/utils/prompt.ts`)
   - Creates AI prompt via `createBookCreationPrompt`
   - Calls `executePromptForJSON` with evaluatorPrompt
   - **STEP 3: EVALUATING** (inside executePromptForJSON)
   - **STEP 4: FINALIZING** (extract and process results)
   - Persists book to database
   - Inserts first page
   - Sets active session
   - Returns `InitializeBookResult`

3. **executePromptForJSON(params)** (`src/utils/prompt.ts`)
   - Constructs final prompt
   - Calls `aiPrompt` with evaluatorPrompt
   - Returns `AIResponse<T>`

4. **aiPrompt(prompt, options, evaluatorPrompt)** (`src/utils/ai-chat.ts`)
   - **STEP 3: EVALUATING** (if evaluatorPrompt provided)
   - Returns `AIResponse<T>`

---

## Proposed DRY Architecture

### Core Principle

Extract the core business logic into reusable functions that accept optional progress callbacks. Both POST (synchronous) and POST /stream (SSE) endpoints will use the same core logic, with:
- POST: No callbacks (existing behavior)
- POST /stream: Progress callbacks that emit SSE events

---

## Implementation Plan

**All phases completed ✅**

### Phase 1: Define Progress Callback Types ✅

**File**: `src/types/sse.ts` (NEW)

```typescript
/**
 * Progress event types for book creation
 */
export type BookCreationProgressEvent =
  | { type: 'theme_validation_start' }
  | { type: 'theme_validation_complete'; data: ThemeValidationResult }
  | { type: 'book_initialization_start' }
  | { type: 'ai_generation_start' }
  | { type: 'ai_evaluation_start' }
  | { type: 'ai_evaluation_complete' }
  | { type: 'ai_generation_complete' }
  | { type: 'finalizing_start' }
  | { type: 'complete'; data: CreateBookResponse }
  | { type: 'error'; error: string };

/**
 * Progress callback for emitting events
 */
export type ProgressCallback = (event: BookCreationProgressEvent) => void | Promise<void>;
```

### Phase 2: Add Progress Callbacks to Functions ✅

#### 2.1 Modify validateTheme

**File**: `src/utils/theme-validation.ts`

```typescript
export async function validateTheme(
  theme: string,
  onProgress?: ProgressCallback
): Promise<ThemeValidationResult> {
  await onProgress?.({ type: 'theme_validation_start' });
  
  const heuristicResult = validateThemeHeuristic(theme);
  
  if (!heuristicResult.isValid) {
    await onProgress?.({ type: 'theme_validation_complete', data: { isValid: false, heuristicResult } });
    return { isValid: false, heuristicResult };
  }
  
  const aiResult = await validateThemeWithAI(theme);
  
  await onProgress?.({ 
    type: 'theme_validation_complete', 
    data: { isValid: !aiResult.isViolating, heuristicResult, aiResult } 
  });
  
  if (aiResult.isViolating) {
    return { isValid: false, heuristicResult, aiResult };
  }
  
  return { isValid: true, heuristicResult, aiResult };
}
```

#### 2.2 Modify initializeBook

**File**: `src/utils/prompt.ts`

```typescript
export async function initializeBook(
  params: InitializeBookParams,
  onProgress?: ProgressCallback
): Promise<InitializeBookResult> {
  await onProgress?.({ type: 'book_initialization_start' });
  await onProgress?.({ type: 'ai_generation_start' });
  
  // Existing logic...
  
  await onProgress?.({ type: 'ai_generation_complete' });
  await onProgress?.({ type: 'finalizing_start' });
  
  // Existing finalizing logic...
  
  return result;
}
```

#### 2.3 Modify executePromptForJSON (Optional)

**File**: `src/utils/prompt.ts`

```typescript
async function executePromptForJSON<T>(
  params: AIPromptForJsonParams<T>,
  onProgress?: ProgressCallback
): Promise<AIResponse<T>> {
  // If evaluatorPrompt provided, emit evaluation start
  if (params.evaluatorPrompt) {
    await onProgress?.({ type: 'ai_evaluation_start' });
  }
  
  // Existing logic...
  
  if (params.evaluatorPrompt) {
    await onProgress?.({ type: 'ai_evaluation_complete' });
  }
  
  return response;
}
```

### Phase 3: Extract Core Book Creation Logic ✅

**File**: `src/services/book-creation.ts` (NEW)

```typescript
/**
 * Core book creation logic (shared between POST and SSE)
 * 
 * @param params - Book creation parameters
 * @param onProgress - Optional progress callback for SSE events
 * @returns Complete book creation result
 *
 * Note: Events are emitted inside validateTheme and initializeBook functions,
 * not in this function. The onProgress callback is passed through to those functions.
 *
 * @example
 * ```typescript
 * // POST endpoint (no progress)
 * const result = await createBookCore({ userId, theme, mcCandidate });
 *
 * // SSE endpoint (with progress)
 * const result = await createBookCore(
 *   { userId, theme, mcCandidate },
 *   (event) => sendSSEEvent(res, event)
 * );
 * ```
 */
export async function createBookCore(
  params: BookCreationParams,
  onProgress?: ProgressCallback
): Promise<CreateBookResponse> {
  const { userId, theme, mcCandidate, generateCoverImage } = params;

  try {
    // STEP 1: VALIDATING THEME
    // validateTheme emits theme_validation_start and theme_validation_complete events
    const validationResult = await validateTheme(theme, onProgress);

    if (!validationResult.isValid) {
      throw new BookCreationError('Theme validation failed', validationResult);
    }

    // Validate mcCandidate
    // Validate generateCoverImage

    // STEP 2: INITIALIZING BOOK
    // initializeBook emits book_initialization_start, ai_generation_start,
    // ai_generation_complete, and finalizing_start events
    const result = await initializeBook({ userId, theme, mcCandidate, generateCoverImage }, onProgress);

    // Enrich actions
    const enrichedResult = {
      ...result,
      firstPage: {
        ...result.firstPage,
        actions: enrichActions(result.firstPage.actions, { page: 1, branchId: 'main' })
      }
    } satisfies CreateBookResponse;

    // Invalidate caches
    await invalidateUserBooksCache(userId);
    await invalidateUserProfileCache(userId);
    if (result.book.status === 'active') {
      await invalidateExploreCache();
    }

    // Emit final complete event
    await onProgress?.({ type: 'complete', data: enrichedResult });

    return enrichedResult;
  } catch (error) {
    await onProgress?.({ type: 'error', error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

/**
 * Custom error for book creation failures
 */
class BookCreationError extends Error {
  constructor(
    message: string,
    public validationResult?: ThemeValidationResult
  ) {
    super(message);
    this.name = 'BookCreationError';
  }
}
```

### Phase 4: Create SSE Response Handler Utility ✅

**File**: `src/utils/sse.ts` (EXISTING - added Express utilities)

```typescript
import type { Response } from 'express';
import type { BookCreationProgressEvent } from '../types/sse.js';

/**
 * SSE response headers for Express
 * 
 * Headers specifically optimized for Express.js SSE responses.
 * Different from SSE_HEADERS (serverless) - Express handles headers differently.
 */
export const EXPRESS_SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  'Connection': 'keep-alive',
  'X-Accel-Buffering': 'no', // Disable nginx buffering
} as const;

/**
 * Sends SSE event to Express response
 * 
 * Formats event with event field and removes redundant type from data payload.
 * 
 * @param res - Express response object
 * @param event - Event to send
 */
export function sendSSEEvent(res: Response, event: BookCreationProgressEvent): void {
  const { type, ...data } = event;
  res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * Initializes SSE response headers
 * 
 * Uses EXPRESS_SSE_HEADERS constant for consistency.
 * 
 * @param res - Express response object
 */
export function initSSEHeaders(res: Response): void {
  Object.entries(EXPRESS_SSE_HEADERS).forEach(([key, value]) => {
    res.setHeader(key, value);
  });
}

/**
 * Sends SSE keep-alive comment
 * 
 * @param res - Express response object
 */
**File**: `src/routes/books.ts`

```typescript
/**
 * POST /api/books/stream
 *
 * Creates a new psychological thriller book with AI-generated content using SSE.
 * Provides real-time progress updates for each step in the book creation process.
 *
 * Request Body:
 * - theme: Story theme (required)
 * - mcCandidate: Main character candidate object (optional)
 * - generateCoverImage: boolean (optional, default: false)
 *
 * @example
 * POST /api/books/stream
 * Body: {
 *   "theme": "haunted mansion",
 *   "mcCandidate": {"name":"Sarah","age":28,"gender":"female"}
 * }
 *
 * SSE Events:
 * - theme_validation_start
 * - theme_validation_complete
 * - book_initialization_start
 * - ai_generation_start
 * - ai_evaluation_start (if evaluatorPrompt provided)
 * - ai_evaluation_complete (if evaluatorPrompt provided)
 * - ai_generation_complete
 * - finalizing_start
 * - complete (with book data)
 * - error (if failed)
 */
router.post("/stream", guestOrAuthMiddleware, async (req: Request, res: Response) => {
  const { theme, mcCandidate, generateCoverImage } = req.body;

  // Robust validation for theme
  if (!theme || typeof theme !== 'string' || theme.trim().length === 0) {
    return res.status(400).json({
      error: "Missing required field: theme is required and must be a non-empty string"
    });
  }

  if (theme.trim().length > MAX_THEME_LENGTH) {
    return res.status(400).json({
      error: `Theme exceeds maximum length of ${MAX_THEME_LENGTH} characters`
    });
  }

  // Robust validation for mcCandidate
  let parsedMcCandidate: StoryMCCandidate | undefined;
  if (mcCandidate !== undefined && mcCandidate !== null) {
    if (typeof mcCandidate !== 'object' || Array.isArray(mcCandidate)) {
      return res.status(400).json({
        error: "Invalid mcCandidate: must be an object"
      });
    }

    // Validate name, age, gender, bio fields with proper constraints
    // (see full implementation for complete validation logic)
    parsedMcCandidate = mcCandidate as StoryMCCandidate;
  }

  // Robust validation for generateCoverImage
  let parsedGenerateCoverImage: boolean | undefined;
  if (generateCoverImage !== undefined) {
    if (typeof generateCoverImage !== 'boolean') {
      return res.status(400).json({
        error: "Invalid generateCoverImage: must be a boolean"
      });
    }
    parsedGenerateCoverImage = generateCoverImage;
  }

  // Initialize SSE headers
  initSSEHeaders(res);

  // Create progress callback for SSE events
  const onProgress: ProgressCallback = (event) => {
    sendSSEEvent(res, event);
  };

  // Create book with progress events
  const result = await createBookCore(
    {
      userId: req.userId!,
      theme: theme.trim(),
      mcCandidate: parsedMcCandidate,
      generateCoverImage: parsedGenerateCoverImage
    },
    onProgress
  );

  // Send final complete event
  sendSSEEvent(res, { type: 'complete', data: result });

  // End response
  res.end();
});
```

### Phase 6: Refactor POST /api/books to Use Shared Core Logic ✅

**File**: `src/routes/books.ts`

```typescript
router.post("/", guestOrAuthMiddleware, async (req: Request, res: Response) => {
  try {
    const { theme, mcCandidate, generateCoverImage } = req.body;
    
    // Use shared core logic (no progress callbacks)
    const result = await createBookCore({
      userId: req.userId!,
      theme,
      mcCandidate,
      generateCoverImage
    });
    
    res.status(201).json(result);
  } catch (error) {
    if (error instanceof BookCreationError && error.validationResult) {
      return handleThemeValidationError(res, error.validationResult);
    }
    handleApiError(res, "Failed to create book", error);
  }
});
```

---

## API Reference

### POST /api/books

Creates a new psychological thriller book with AI-generated content. Returns complete book data in a single response.

**Authentication**: Required (guest or auth user)

**Request Method**: POST

**Content-Type**: application/json

**Request Body**:
```typescript
{
  theme: string;                    // Required: Story theme
  mcCandidate?: {                   // Optional: Main character candidate
    name?: string;                  // Character name
    age?: number;                   // Age (0-150)
    gender?: 'male' | 'female';     // Strict, explicit
    bio?: string;                   // Character bio
  };
  generateCoverImage?: boolean;     // Optional: Generate cover image (default: false)
}
```

**Success Response** (201):
```typescript
{
  book: {
    id: string;
    title: string;
    hook: string;
    summary: string;
    keywords: string[];
    image: string | null;
    status: 'active' | 'draft';
    totalPages: number;
    language: string;
    mc: {
      name: string;
      age: number;
      gender: string;
      bio: string;
    };
    createdAt: string;              // ISO 8601 timestamp
    updatedAt: string;              // ISO 8601 timestamp
  };
  firstPage: {
    id: string;
    page: number;
    text: string;
    actions: Array<{
      id: string;
      text: string;
      nextPageId?: string;
      branchId: string;
    }>;
  };
  initialState: {
    currentPage: number;
    currentBranch: string;
    psychologicalState: Record<string, number>;
  };
}
```

**Error Response** (400/500):
```typescript
{
  error: string;
  details?: string;
}
```

**Theme Validation Error Response** (400):
```typescript
{
  error: "Theme validation failed";
  details: {
    isValid: false;
    heuristicResult: {
      isValid: boolean;
      reason?: string;
    };
    aiResult?: {
      isViolating: boolean;
      reason?: string;
    };
  }
}
```

---

### POST /api/books/stream

Creates a new psychological thriller book with AI-generated content using Server-Sent Events (SSE). Emits real-time progress events for each step in the book creation process.

**Authentication**: Required (guest or auth user)

**Request Method**: POST

**Content-Type**: application/json

**Request Body**:
```typescript
{
  theme: string;                    // Required: Story theme
  mcCandidate?: {                   // Optional: Main character candidate
    name?: string;                  // Character name
    age?: number;                   // Age (0-150)
    gender?: 'male' | 'female';     // Strict, explicit
    bio?: string;                   // Character bio
  };
  generateCoverImage?: boolean;     // Optional: Generate cover image (default: false)
}
```

**Example Request**:
```
POST /api/books/stream
Body: {
  "theme": "haunted mansion",
  "mcCandidate": {
    "name": "Sarah",
    "age": 28,
    "gender": "female",
    "bio": "Shy librarian with hidden past"
  },
  "generateCoverImage": true
}
```

**Response Headers**:
```
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
X-Accel-Buffering: no
```

**SSE Event Format**:
```
event: <event_type>
data: <json_payload>

```

**Event Types**:

| Event Type | Data Shape | Description |
|------------|-----------|-------------|
| `theme_validation_start` | `{}` | Theme validation started |
| `theme_validation_complete` | `ThemeValidationResult` | Theme validation completed |
| `book_initialization_start` | `{}` | Book initialization started |
| `ai_generation_start` | `{}` | AI content generation started |
| `ai_evaluation_start` | `{}` | AI evaluation phase started (if evaluatorPrompt provided) |
| `ai_evaluation_complete` | `{}` | AI evaluation phase completed |
| `ai_generation_complete` | `{}` | AI content generation completed |
| `finalizing_start` | `{}` | Database operations started |
| `complete` | `CreateBookResponse` | Book creation completed with full data |
| `error` | `{ error: string }` | Error occurred during process |

**Data Shape Reference**:

**ThemeValidationResult**:
```typescript
{
  isValid: boolean;
  heuristicResult: {
    isValid: boolean;
    reason?: string;
  };
  aiResult?: {
    isViolating: boolean;
    reason?: string;
  };
}
```

**CreateBookResponse**:
```typescript
{
  book: {
    id: string;
    title: string;
    hook: string;
    summary: string;
    keywords: string[];
    image: string | null;
    status: 'active' | 'draft';
    totalPages: number;
    language: string;
    mc: {
      name: string;
      age: number;
      gender: string;
      bio: string;
    };
    createdAt: string;
    updatedAt: string;
  };
  firstPage: {
    id: string;
    page: number;
    text: string;
    actions: Array<{
      id: string;
      text: string;
      nextPageId?: string;
      branchId: string;
    }>;
  };
  initialState: {
    currentPage: number;
    currentBranch: string;
    psychologicalState: Record<string, number>;
  };
}
```

---

## SSE Event Flow

```
Client Request (POST /api/books/stream)
Body: { theme, mcCandidate?, generateCoverImage? }
         ↓
Server: Initialize SSE headers
         ↓
event: theme_validation_start
data: {}
         ↓
event: theme_validation_complete
data: {"isValid":true,...}
         ↓
event: book_initialization_start
data: {}
         ↓
event: ai_generation_start
data: {}
         ↓
event: ai_evaluation_start (if evaluatorPrompt provided)
data: {}
         ↓
event: ai_evaluation_complete (if evaluatorPrompt provided)
data: {}
         ↓
event: ai_generation_complete
data: {}
         ↓
event: finalizing_start
data: {}
         ↓
event: complete
data: {"book":{...},"firstPage":{...},...}
         ↓
Server: Close connection
```

---

## Error Handling

### Validation Errors

- Emit `theme_validation_complete` with validation result
- Emit `error` event with details
- Close connection

### AI Errors

- Emit `error` event with AI error details
- Close connection

### Database Errors

- Emit `error` event with database error details
- Close connection

---

## Frontend Integration

### Overview

The backend provides two endpoints for book creation:
1. **POST /api/books** - Synchronous, single response (backward compatible)
2. **POST /api/books/stream** - SSE streaming with real-time progress (recommended for better UX)

Frontend should prefer the SSE endpoint for better user experience, with POST as fallback.

**Note**: Since the SSE endpoint uses POST (not GET), you cannot use the native `EventSource` API which only supports GET. Instead, use the Fetch API with stream reading to consume SSE events.

### Using Fetch with SSE (Recommended)

For POST-based SSE, use the Fetch API with stream reading. This provides full control over the SSE connection and works with POST requests.

**Basic Implementation**:
```typescript
interface BookCreationState {
  step: 'idle' | 'validating_theme' | 'initializing' | 'generating' | 'finalizing' | 'complete' | 'error';
  status: 'in_progress' | 'complete';
  progress: number;
  bookData?: CreateBookResponse;
  error?: string;
}

async function createBookWithSSE(theme: string, mcCandidate?: StoryMCCandidate, generateCoverImage?: boolean) {
  const state: BookCreationState = {
    step: 'idle',
    status: 'in_progress',
    progress: 0,
  };

  // Build request body
  const body: any = { theme };
  if (mcCandidate) {
    body.mcCandidate = mcCandidate;
  }
  if (generateCoverImage !== undefined) {
    body.generateCoverImage = generateCoverImage;
  }

  const response = await fetch('/api/books/stream', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    credentials: 'include',
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to create book');
  }

  const reader = response.body?.getReader();
  const decoder = new TextDecoder();

  if (!reader) {
    throw new Error('Response body is not readable');
  }

  let buffer = '';
  let currentEventType = '';

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep the last incomplete line in buffer

      for (const line of lines) {
        if (line.startsWith('event: ')) {
          currentEventType = line.slice(7).trim();
        } else if (line.startsWith('data: ')) {
          const data = line.slice(6).trim();
          if (!data) continue;
          try {
            const parsedData = JSON.parse(data);
            handleSSEEvent(currentEventType, parsedData, state);
          } catch (e) {
            console.error('Failed to parse SSE data:', e);
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return state;
}

function handleSSEEvent(eventType: string, data: any, state: BookCreationState) {
  switch (eventType) {
    case 'theme_validation_start':
      state.step = 'validating_theme';
      state.status = 'in_progress';
      state.progress = 10;
      updateUI(state);
      break;
    case 'theme_validation_complete':
      if (!data.isValid) {
        state.step = 'error';
        state.error = data.heuristicResult.reason || data.aiResult?.reason || 'Theme validation failed';
        updateUI(state);
        return;
      }
      state.progress = 20;
      updateUI(state);
      break;
    case 'book_initialization_start':
      state.step = 'initializing';
      state.status = 'in_progress';
      state.progress = 30;
      updateUI(state);
      break;
    case 'ai_generation_start':
      state.step = 'generating';
      state.status = 'in_progress';
      state.progress = 40;
      updateUI(state);
      break;
    case 'ai_evaluation_start':
      state.progress = 50;
      updateUI(state);
      break;
    case 'ai_evaluation_complete':
      state.progress = 60;
      updateUI(state);
      break;
    case 'ai_generation_complete':
      state.progress = 70;
      updateUI(state);
      break;
    case 'finalizing_start':
      state.step = 'finalizing';
      state.status = 'in_progress';
      state.progress = 80;
      updateUI(state);
      break;
    case 'complete':
      state.step = 'complete';
      state.status = 'complete';
      state.progress = 100;
      state.bookData = data;
      updateUI(state);
      break;
    case 'error':
      state.step = 'error';
      state.error = data.error;
      updateUI(state);
      break;
    default:
      console.log('Unknown event:', eventType, data);
  }
}

function updateUI(state: BookCreationState) {
  // Update your UI based on state
  console.log('Current state:', state);
}
```

**AbortController for Cancellation**:
```typescript
async function createBookWithCancellation(theme: string, mcCandidate?: StoryMCCandidate, signal?: AbortSignal) {
  const body: any = { theme };
  if (mcCandidate) {
    body.mcCandidate = mcCandidate;
  }

  const response = await fetch('/api/books/stream', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    credentials: 'include',
    body: JSON.stringify(body),
    signal,
  });

  // ... stream processing

  // If signal.abort() is called, the fetch will be aborted
}
```

**React Hook Implementation**:
```typescript
import { useState, useRef, useCallback } from 'react';

function useBookCreation() {
  const [state, setState] = useState<BookCreationState>({
    step: 'idle',
    status: 'in_progress',
    progress: 0,
  });
  const abortControllerRef = useRef<AbortController | null>(null);

  const createBook = useCallback(async (theme: string, mcCandidate?: StoryMCCandidate, generateCoverImage?: boolean) => {
    // Cancel previous request if exists
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    abortControllerRef.current = new AbortController();

    try {
      const result = await createBookWithSSE(theme, mcCandidate, generateCoverImage, abortControllerRef.current.signal);
      setState(result);
    } catch (error) {
      setState(prev => ({
        ...prev,
        step: 'error',
        error: error instanceof Error ? error.message : 'An error occurred',
      }));
    } finally {
      abortControllerRef.current = null;
    }
  }, []);

  // Cleanup on unmount
  const cleanup = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
  }, []);

  return { state, createBook, cleanup };
}
```

---

### Authentication

Both endpoints require authentication. The backend uses `guestOrAuthMiddleware` which accepts:
- Guest users (no auth required)
- Authenticated users (with session/cookie auth)

**For Guest Users**:
No additional headers needed. The session is managed automatically.

**For Authenticated Users**:
Ensure authentication cookies are included with the request. Most browsers include cookies automatically for same-origin requests.

**For Cross-Origin Requests**:
```typescript
const response = await fetch('/api/books/stream', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
  },
  credentials: 'include', // Include cookies for cross-origin requests
  body: JSON.stringify({ theme: 'haunted mansion' }),
});
```

---

### UI State Management

**Recommended State Structure**:
```typescript
interface BookCreationUIState {
  // Progress tracking
  currentStep: string;
  stepProgress: number; // 0-100
  overallProgress: number; // 0-100

  // Data
  bookData?: CreateBookResponse;
  themeValidationResult?: ThemeValidationResult;

  // Status
  isLoading: boolean;
  isComplete: boolean;
  hasError: boolean;
  errorMessage?: string;

  // Connection
  isConnected: boolean;
  connectionId?: string;
}
```

**Progress Calculation**:
```typescript
const stepWeights = {
  theme_validation: 20,    // 0-20%
  book_initialization: 10, // 20-30%
  ai_generation: 40,       // 30-70%
  finalizing: 30,          // 70-100%
};

function calculateProgress(currentStep: string, stepProgress: number): number {
  let baseProgress = 0;
  switch (currentStep) {
    case 'validating_theme':
      baseProgress = 0;
      break;
    case 'initializing':
      baseProgress = 20;
      break;
    case 'generating':
      baseProgress = 30;
      break;
    case 'finalizing':
      baseProgress = 70;
      break;
    default:
      baseProgress = 0;
  }
  return baseProgress + (stepProgress * (stepWeights[currentStep] / 100));
}
```

---

### Error Handling Patterns

**Validation Errors**:
```typescript
// In handleSSEEvent function
case 'theme_validation_complete':
  if (!data.isValid) {
    // Show validation error to user
    const reason = data.heuristicResult.reason || data.aiResult?.reason;
    showValidationUI({
      isValid: false,
      message: reason || 'Theme validation failed',
      suggestions: ['Try a different theme', 'Be more specific', 'Avoid sensitive topics']
    });
  }
  break;
```

**Network Errors**:
```typescript
try {
  const result = await createBookWithSSE(theme, mcCandidate);
} catch (error) {
  showNetworkError({
    message: 'Connection lost during book creation',
    retryAction: () => createBookWithSSE(theme, mcCandidate),
    fallbackAction: () => createBookWithPOST(theme, mcCandidate)
  });
}
```

**Timeout Handling**:
```typescript
async function createBookWithTimeout(theme: string, mcCandidate?: StoryMCCandidate, timeoutMs = 300000, signal?: AbortSignal) {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
    showTimeoutError('Book creation timed out. Please try again.');
  }, timeoutMs);

  try {
    const result = await createBookWithSSE(theme, mcCandidate, controller.signal);
    clearTimeout(timeout);
    return result;
  } catch (error) {
    clearTimeout(timeout);
    if (error.name === 'AbortError') {
      throw new Error('Book creation timed out');
    }
    throw error;
  }
}
```

---

### Fallback to POST Endpoint

If SSE is not supported or fails, fall back to POST:

```typescript
async function createBookWithPOST(theme: string, mcCandidate?: StoryMCCandidate, generateCoverImage?: boolean) {
  const response = await fetch('/api/books', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    credentials: 'include',
    body: JSON.stringify({
      theme,
      mcCandidate,
      generateCoverImage
    }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to create book');
  }

  const result = await response.json();
  return result;
}

// Usage with fallback
async function createBookWithFallback(theme: string) {
  try {
    return await createBookWithSSE(theme);
  } catch (sseError) {
    console.warn('SSE failed, falling back to POST:', sseError);
    return await createBookWithPOST(theme);
  }
}
```

---

## Testing Strategy

### Manual Testing

Test the SSE endpoint using PowerShell:

```powershell
$body = @{
    theme = "haunted mansion"
    mcCandidate = @{
        name = "Sarah"
        age = 28
        gender = "female"
        bio = "Shy librarian with hidden past"
    }
    generateCoverImage = $true
} | ConvertTo-Json -Depth 10

Invoke-WebRequest -Uri "http://localhost:3000/api/books/stream" -Method POST -Body $body -ContentType "application/json" -UseBasicParsing
```

### Unit Tests

- Test `createBookCore` with and without progress callbacks
- Test SSE event emission
- Test error handling

### Integration Tests

- Test POST /api/books/stream endpoint
- Verify SSE event sequence
- Test error handling
- Test validation errors

```powershell
# Test SSE endpoint with PowerShell
Invoke-WebRequest -Uri "http://localhost:3000/api/books/stream?theme=haunted+mansion" -Method POST -Headers @{"Content-Type"="text/event-stream"} -UseBasicParsing
```

**Expected SSE Event Sequence:**
```
event: theme_validation_start
data: {}

event: theme_validation_complete
data: {"isValid":true,...}

event: book_initialization_start
data: {}

event: ai_generation_start
data: {}

event: ai_evaluation_start
data: {}

event: ai_evaluation_complete
data: {}

event: ai_generation_complete
data: {}

event: finalizing_start
data: {}

event: complete
data: {"book":{...},"firstPage":{...},...}
```

---

## Rollout Plan

### Phase 1: Core Infrastructure (Week 1)
- Define SSE types
- Create SSE utility functions
- Add progress callbacks to functions

### Phase 2: Core Logic Extraction (Week 2)
- Create `createBookCore` function
- Refactor POST /api/books to use shared logic

### Phase 3: SSE Endpoint (Week 3)
- Create POST /api/books/stream endpoint
- Test SSE event flow

### Phase 4: Frontend Integration (Week 4)
- Update frontend to consume SSE events
- Test end-to-end flow

### Phase 5: Production Rollout (Week 5)
- Deploy to staging
- Monitor performance
- Deploy to production

---

## Benefits

1. **DRY Principle**: Core logic shared between POST and SSE endpoints
2. **Real-time Progress**: Users see step-by-step progress
3. **Better UX**: Long-running operations no longer appear frozen
4. **Backward Compatible**: POST endpoint remains unchanged
5. **Maintainable**: Single source of truth for business logic

---

## Implementation Summary

**Date Completed**: April 22, 2026

**Files Created:**
- `src/types/sse.ts` - SSE event type definitions
- `src/services/book-creation.ts` - Core book creation logic

**Files Modified:**
- `src/utils/theme-validation.ts` - Added progress callback support
- `src/utils/prompt.ts` - Added progress callback support to initializeBook and executePromptForJSON
- `src/utils/sse.ts` - Added Express SSE utilities
- `src/routes/books.ts` - Added POST /api/books/stream endpoint with robust validation, refactored POST endpoint

**Key Features:**
- ✅ SSE types with progress event definitions
- ✅ Progress callbacks in validateTheme, initializeBook, and executePromptForJSON
- ✅ Shared core logic via createBookCore function
- ✅ SSE utilities (initSSEHeaders, sendSSEEvent, sendSSEKeepAlive)
- ✅ POST /api/books/stream endpoint with real-time progress
- ✅ POST /api/books refactored to use shared logic
- ✅ Separate header constants for Express vs serverless
- ✅ Robust validation for theme, mcCandidate, and generateCoverImage

**Next Steps:**
- Manual testing with PowerShell command
- Frontend integration to consume SSE events
- Optional: Add progress callbacks to executePromptForJSON for evaluation phase events

---

## Risks & Mitigations

### Risk: Increased Complexity

**Mitigation**: Clear separation of concerns, well-documented types, comprehensive testing

### Risk: SSE Connection Issues

**Mitigation**: Proper error handling, connection timeout, client-side retry logic

### Risk: Performance Impact

**Mitigation**: Progress callbacks are optional (no overhead for POST endpoint), efficient event emission
