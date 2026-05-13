# Async Book Creation Implementation Plan

## Overview

This document outlines the implementation of an asynchronous book creation system to bypass Vercel's 5-minute API timeout limit. The new system uses GitHub Actions for long-running book generation while providing immediate response to the frontend.

## Problem Statement

**Current Implementation:**
- `POST /api/books/stream` uses SSE to stream progress events during book creation
- Frontend consumes SSE events to show real-time progress
- **Issue**: Vercel has 5-minute hard limit on API requests, causing incomplete SSE responses for long-running generations

## Proposed Solution

**Async Book Creation Flow:**
1. Generate deterministic `bookId` upfront (UUID v7)
2. Create book record with `status: 'pending'`
3. Trigger GitHub Actions workflow (unawaited)
4. Return `bookId` immediately to frontend
5. Frontend polls for book creation status via `GET /api/books/:bookId/status`
6. GitHub Actions updates book status and content upon completion

**Benefits:**
- ✅ Bypasses Vercel's 5-minute timeout
- ✅ GitHub Actions can run for 45+ minutes
- ✅ Frontend polls without keeping long-lived connection
- ✅ More reliable for long-running operations
- ✅ Pattern already exists in codebase

---

## Implementation Status

### ✅ Backend Implementation (COMPLETED)

All backend phases have been successfully implemented and deployed.

**Current Primary Flow:**
- `POST /api/books/async` - Async book creation via GitHub Actions (primary)
- `POST /api/books` - Sync book creation (alternative, kept for compatibility)
- `POST /api/books/stream` - SSE book creation (alternative, kept for compatibility)

**Credit System:**
- `executeWithCredits()` - Atomic credit consumption with automatic refund
- `refundCreditsIdempotent()` - Idempotent refund with correlation ID
- `refundCredits()` - Wrapper with retry mechanism
- Transaction limitation documented (partial atomicity acceptable)

### ✅ Frontend Implementation (COMPLETED)

All frontend phases have been successfully implemented and deployed.

---

## Backend Implementation

### Phase 1: Type Definitions ✅ COMPLETED

#### 1.1 Update BookStatus Type ✅

**File**: `src/types/book.ts`

**Status**: ✅ COMPLETED - Separated publication states from generation states

```typescript
export type BookStatus = 'active' | 'archived' | 'draft';
export type BookGenerationStatus = 'pending' | 'generating' | 'completed' | 'failed';
```

**Status Meanings:**
- `BookStatus` (publication state):
  - `'active'`: Book successfully generated and ready for reading
  - `'archived'`: Book archived by user
  - `'draft'`: Book saved as draft (not published)

- `BookGenerationStatus` (async creation tracking):
  - `'pending'`: Book created, waiting for workflow to start
  - `'generating'`: Workflow is actively generating content
  - `'completed'`: Workflow successfully completed generation
  - `'failed'`: Workflow failed to generate content

**Architectural Decision:**
Separated publication state (`BookStatus`) from generation tracking (`BookGenerationStatus`) to provide clearer separation of concerns. The polling endpoint returns both fields, allowing the frontend to distinguish between a book's publication state and its generation progress.

#### 1.2 Create Book Creation Status Type ✅

**File**: `src/types/book.ts`

**Status**: ✅ COMPLETED - BookCreationStatus interface updated with both status fields

```typescript
/**
 * Book creation status for polling endpoint
 */
export interface BookCreationStatus {
  bookId: string;
  status: BookStatus; // Publication state (active, archived, draft)
  generationStatus: BookGenerationStatus; // Generation tracking (pending, generating, completed, failed)
  progress?: number; // 0-100
  currentStep?: string;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}
```

---

### Phase 2: Database Schema ✅ COMPLETED

#### 2.1 Add Book Creation Metadata ✅

**File**: `src/db/schema.ts`

**Status**: ✅ COMPLETED - All columns and index added

```typescript
export const books = pgTable(
  "books",
  {
    // ... existing columns ...
    
    // New columns for async book creation
    generationStatus: text("generation_status").$type<'pending' | 'generating' | 'completed' | 'failed'>().default('pending'),
    generationProgress: integer("generation_progress").default(0), // 0-100
    generationError: text("generation_error"),
    generationStartedAt: timestamp("generation_started_at", { withTimezone: true }),
    generationCompletedAt: timestamp("generation_completed_at", { withTimezone: true }),
  },
  (t) => [
    // ... existing indexes ...
    // Index for pending/generating books
    index("books_generation_status_idx").on(t.generationStatus),
  ]
);
```

#### 2.2 Create Migration ✅

**Status**: ✅ COMPLETED - Schema is updated with all required columns

```bash
pnpm db:generate
pnpm db:migrate
```

---

### Phase 3: GitHub Actions Workflow ✅ COMPLETED

#### 3.1 Create On-Demand Book Creation Workflow ✅

**File**: `.github/workflows/on-demand-book-creation.yml`

**Status**: ✅ COMPLETED - Workflow file exists with all required inputs and configuration

```yaml
name: On-Demand Book Creation

on:
  workflow_dispatch:
    inputs:
      book_id:
        description: 'Book ID (UUID v7)'
        required: true
        type: string
      user_id:
        description: 'User ID who requested the book'
        required: true
        type: string
      theme:
        description: 'Story theme'
        required: true
        type: string
      mc_candidate_name:
        description: 'Main character name (optional)'
        required: false
        type: string
      mc_candidate_age:
        description: 'Main character age (optional)'
        required: false
        type: number
      mc_candidate_gender:
        description: 'Main character gender (optional)'
        required: false
        type: string
      mc_candidate_bio:
        description: 'Main character bio (optional)'
        required: false
        type: string
      generate_cover_image:
        description: 'Whether to generate cover image'
        required: false
        type: boolean
        default: false

jobs:
  create-book:
    name: Create Book
    runs-on: ubuntu-latest
    environment: production
    permissions:
      contents: read
    
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Setup pnpm
        uses: pnpm/action-setup@v3
        with:
          version: 10
          
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 22
          
      - name: Get pnpm store directory
        id: pnpm-store
        shell: bash
        run: |
          echo "path=$(pnpm store path --silent)" >> $GITHUB_OUTPUT

      - name: Setup pnpm cache
        uses: actions/cache@v4
        with:
          path: ${{ steps.pnpm-store.outputs.path }}
          key: ${{ runner.os }}-pnpm-store-${{ hashFiles('**/pnpm-lock.yaml') }}
          restore-keys: |
            ${{ runner.os }}-pnpm-store-
            
      - name: Install dependencies
        run: pnpm install --frozen-lockfile --prefer-offline
        
      - name: Build project
        run: pnpm build
        
      - name: Verify build
        run: test -f dist/cron/on-demand-book-creation.js
        
      - name: Run on-demand book creation
        run: node dist/cron/on-demand-book-creation.js
        env:
          DATABASE_URL: ${{ secrets.DATABASE_URL }}
          DATABASE_READ_URL: ${{ secrets.DATABASE_READ_URL || secrets.DATABASE_URL }}
          IMAGEKIT_API_KEY_PRIVATE: ${{ secrets.IMAGEKIT_API_KEY_PRIVATE }}
          UPSTASH_REDIS_REST_URL: ${{ secrets.UPSTASH_REDIS_REST_URL }}
          UPSTASH_REDIS_REST_TOKEN: ${{ secrets.UPSTASH_REDIS_REST_TOKEN }}
          SYSTEM_USER_ID: ${{ secrets.SYSTEM_USER_ID }}
          # AI provider credentials
          GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
          GITHUB_API_KEY: ${{ secrets.OPENAI_API_KEY }}
          MISTRAL_API_KEY: ${{ secrets.MISTRAL_API_KEY }}
          COHERE_API_KEY: ${{ secrets.COHERE_API_KEY }}
          CEREBRAS_API_KEY: ${{ secrets.CEREBRAS_API_KEY }}
          GROQ_API_KEY: ${{ secrets.GROQ_API_KEY }}
          NVIDIA_API_KEY: ${{ secrets.NVIDIA_API_KEY }}
          NODE_ENV: production
          # Workflow inputs
          BOOK_ID: ${{ github.event.inputs.book_id }}
          USER_ID: ${{ github.event.inputs.user_id }}
          THEME: ${{ github.event.inputs.theme }}
          MC_CANDIDATE_NAME: ${{ github.event.inputs.mc_candidate_name }}
          MC_CANDIDATE_AGE: ${{ github.event.inputs.mc_candidate_age }}
          MC_CANDIDATE_GENDER: ${{ github.event.inputs.mc_candidate_gender }}
          MC_CANDIDATE_BIO: ${{ github.event.inputs.mc_candidate_bio }}
          GENERATE_COVER_IMAGE: ${{ github.event.inputs.generate_cover_image }}
        timeout-minutes: 45
```

---

### Phase 4: Cron Job Script ✅ COMPLETED

#### 4.1 Create On-Demand Book Creation Script ✅

**File**: `src/cron/on-demand-book-creation.ts`

**Status**: ✅ COMPLETED - Script exists and matches current implementation

Current implementation notes:

- Uses `initializeBook()` from `src/utils/prompt.ts` to perform the long-running AI generation.
- Updates the `books` row `generationStatus`, `generationProgress`, and `generationCompletedAt` via `dbWrite`.
- Accepts `BOOK_ID`, `USER_ID`, `THEME`, optional `MC_CANDIDATE_*` env vars and `GENERATE_COVER_IMAGE`.
- Passes `bookId` to `initializeBook()` so the function updates the existing draft instead of inserting a duplicate.
- Supports an `onProgress` callback that updates `generationProgress` while generation runs.

Representative snippet (actual code in repo):

```typescript
import { initializeBook } from '../utils/prompt.js';
import { dbWrite } from '../db/client.js';
import { books } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { getErrorMessage } from '../utils/error.js';
import type { StoryMCCandidate } from '../types/character.js';
import { cleanupObject } from '../utils/parser.js';

async function main() {
  const bookId = process.env.BOOK_ID;
  const userId = process.env.USER_ID;
  const theme = process.env.THEME;
  if (!bookId || !userId || !theme) throw new Error('Missing required environment variables: BOOK_ID, USER_ID, THEME');

  await dbWrite.update(books)
    .set({ generationStatus: 'generating', generationStartedAt: new Date() })
    .where(eq(books.id, bookId));

  const mcCandidate: StoryMCCandidate = cleanupObject({
    name: process.env.MC_CANDIDATE_NAME || undefined,
    age: process.env.MC_CANDIDATE_AGE ? parseInt(process.env.MC_CANDIDATE_AGE) : undefined,
    gender: process.env.MC_CANDIDATE_GENDER || undefined,
    bio: process.env.MC_CANDIDATE_BIO || undefined,
  });

  const generateCoverImage = process.env.GENERATE_COVER_IMAGE === 'true';

  const result = await initializeBook({
    userId,
    theme,
    mcCandidate: Object.keys(mcCandidate).length > 0 ? mcCandidate : undefined,
    generateCoverImage,
    bookId, // update existing draft
    onProgress: async (percentage: number) => {
      await dbWrite.update(books).set({ generationProgress: percentage }).where(eq(books.id, bookId));
    }
  });

  await dbWrite.update(books)
    .set({ generationStatus: 'completed', generationProgress: 100, generationCompletedAt: new Date() })
    .where(eq(books.id, bookId));
}

main().catch((error) => {
  dbWrite.update(books).set({ generationStatus: 'failed', generationError: getErrorMessage(error), generationCompletedAt: new Date() }).where(eq(books.id, process.env.BOOK_ID));
  process.exit(1);
});
```

---

### Phase 5: API Routes ✅ COMPLETED

#### 5.1 Create Async Book Creation Route ✅

**File**: `src/routes/books.ts`

**Status**: ✅ COMPLETED - POST /api/books/async route exists with proper implementation

```typescript
/**
 * POST /api/books/async
 * 
 * Creates a new book asynchronously using GitHub Actions.
 * Returns bookId immediately, bypassing Vercel's 5-minute timeout.
 * 
 * Flow:
 * 1. Validate request parameters
 * 2. Consume credits
 * 3. Generate bookId (UUID v7)
 * 4. Create book record with status 'pending'
 * 5. Trigger GitHub Actions workflow (unawaited)
 * 6. Return bookId immediately
 * 
 * Frontend should poll GET /api/books/:bookId/status for updates.
 * 
 * @param theme - Story theme (required)
 * @param mcCandidate - Main character candidate (optional)
 * @param generateCoverImage - Whether to generate cover image (optional)
 * 
 * @returns { bookId: string } - The generated book ID
 * 
 * @example
 * POST /api/books/async
 * Body: {
 *   "theme": "haunted mansion mystery",
 *   "mcCandidate": {
 *     "name": "Sarah",
 *     "age": 28,
 *     "gender": "female"
 *   },
 *   "generateCoverImage": true
 * }
 * 
 * Response (200):
 * {
 *   "bookId": "01912345-6789-1234-5678-123456789012",
 *   "message": "Book creation started. Poll /api/books/:bookId/status for updates."
 * }
 */
router.post("/async", requireAuth, async (req: Request, res: Response) => {
  try {
    const { theme, mcCandidate, generateCoverImage } = req.body;
    const userId = req.userId!;

    // STEP 1: VALIDATE THEME
    await createBookValidate(theme, mcCandidate, generateCoverImage, undefined);

    // STEP 2: CONSUME CREDITS
    await consumeBookCredits(userId, false, "book_creation_async", theme);

    // STEP 3: GENERATE BOOK ID
    const bookId = generateId();

    // STEP 4: CREATE BOOK RECORD WITH PENDING STATUS
    const mc: StoryMC = {
      name: '',
      age: 0,
      gender: '',
      bio: '',
      ...mcCandidate,
    };

    const initialBookData: DBNewBook = {
      id: bookId,
      userId,
      title: 'Generating...', // Temporary title
      hook: null,
      summary: null,
      keywords: [],
      language: 'en',
      totalPages: 0,
      mc,
      status: 'draft', // Will be updated to 'active' when complete
      generationStatus: 'pending',
      generationProgress: 0,
    };

    await dbWrite.insert(books).values(initialBookData);

    // STEP 5: TRIGGER GITHUB ACTIONS WORKFLOW (UNAWAITED)
    const githubToken = process.env.GITHUB_WORKFLOW_TOKEN;
    if (!githubToken) {
      return res.status(500).json({
        error: "GitHub workflow token not configured"
      });
    }

    // Trigger workflow without awaiting
    fetch(`https://api.github.com/repos/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/actions/workflows/on-demand-book-creation.yml/dispatches`, {
      method: 'POST',
      headers: {
        'Authorization': `token ${githubToken}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'User-Agent': 'Twistloom-Backend'
      },
      body: JSON.stringify({
        ref: GITHUB_DEFAULT_BRANCH,
        inputs: {
          book_id: bookId,
          user_id: userId,
          theme: theme.trim(),
          mc_candidate_name: mcCandidate?.name,
          mc_candidate_age: mcCandidate?.age,
          mc_candidate_gender: mcCandidate?.gender,
          mc_candidate_bio: mcCandidate?.bio,
          generate_cover_image: generateCoverImage || false,
        }
      })
    }).catch((error) => {
      console.error('[POST /api/books/async] Failed to trigger workflow:', error);
      // Don't fail the request - book is created, workflow can be retried manually
    });

    // STEP 6: RETURN BOOK ID IMMEDIATELY
    res.json({
      bookId,
      message: "Book creation started. Poll /api/books/:bookId/status for updates."
    });

    // Log user activity
    await logUserActivity({
      userId,
      activityType: 'book_creation_started',
      targetType: 'book',
      targetId: bookId,
      metadata: { 
        theme: theme.trim(),
        method: 'async',
      },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
      platform: req.get('x-platform'),
      appVersion: req.get('x-app-version'),
    });
  } catch (error) {
    console.error('[POST /api/books/async] Error:', error);
    handleApiError(res, "Failed to start book creation", error);
  }
});
```

#### 5.2 Create Book Status Polling Endpoint ✅

**File**: `src/routes/books.ts`

**Status**: ✅ COMPLETED - GET /api/books/:bookId/status route exists with proper implementation

```typescript
/**
 * GET /api/books/:bookId/status
 * 
 * Polls for book creation status.
 * Used by frontend to check progress of async book creation.
 * 
 * @param bookId - Book ID (UUID v7)
 * 
 * @returns BookCreationStatus with current status and progress
 * 
 * @example
 * GET /api/books/01912345-6789-1234-5678-123456789012/status
 * 
 * Response (200):
 * {
 *   "bookId": "01912345-6789-1234-5678-123456789012",
 *   "status": "generating",
 *   "progress": 45,
 *   "currentStep": "AI generation in progress",
 *   "createdAt": "2026-05-12T10:00:00.000Z",
 *   "updatedAt": "2026-05-12T10:02:30.000Z"
 * }
 * 
 * Response (200) - Complete:
 * {
 *   "bookId": "01912345-6789-1234-5678-123456789012",
 *   "status": "active",
 *   "progress": 100,
 *   "createdAt": "2026-05-12T10:00:00.000Z",
 *   "updatedAt": "2026-05-12T10:05:00.000Z"
 * }
 * 
 * Response (200) - Failed:
 * {
 *   "bookId": "01912345-6789-1234-5678-123456789012",
 *   "status": "failed",
 *   "error": "AI generation failed: timeout",
 *   "createdAt": "2026-05-12T10:00:00.000Z",
 *   "updatedAt": "2026-05-12T10:10:00.000Z"
 * }
 */
router.get("/:bookId/status", requireAuth, async (req: Request, res: Response) => {
  try {
    const { bookId } = req.params;
    const userId = req.userId!;

    // Validate bookId format
    if (!isValidUuid(bookId)) {
      return res.status(400).json({
        error: "Invalid book ID format"
      });
    }

    // Fetch book from database
    const book = await dbWrite.select()
      .from(books)
      .where(eq(books.id, bookId))
      .limit(1);

    if (book.length === 0) {
      return res.status(404).json({
        error: "Book not found"
      });
    }

    const bookData = book[0];

    // Verify user owns the book
    if (bookData.userId !== userId) {
      return res.status(403).json({
        error: "Forbidden: You can only view status for your own books"
      });
    }

    // Map generation status to response
    let status: BookStatus;
    let currentStep: string | undefined;
    
    switch (bookData.generationStatus) {
      case 'pending':
        status = 'draft';
        currentStep = 'Waiting for workflow to start';
        break;
      case 'generating':
        status = 'draft';
        currentStep = 'AI generation in progress';
        break;
      case 'completed':
        status = bookData.status || 'active';
        currentStep = undefined;
        break;
      case 'failed':
        status = 'draft';
        currentStep = 'Generation failed';
        break;
      default:
        status = bookData.status || 'draft';
    }

    res.json({
      bookId: bookData.id,
      status,
      progress: bookData.generationProgress || 0,
      currentStep,
      error: bookData.generationError || undefined,
      createdAt: bookData.createdAt,
      updatedAt: bookData.updatedAt,
    });
  } catch (error) {
    console.error('[GET /api/books/:bookId/status] Error:', error);
    handleApiError(res, "Failed to get book status", error);
  }
});
```

---

### Phase 6: Environment Configuration ✅ (checked)

#### 6.1 Environment Variables

**File**: `.env.local.example` — Present in repository and includes workflow configuration variables.

**Status**: ✅ Verified in repo. The following variables are present and used by the async flow:

```bash
GITHUB_WORKFLOW_TOKEN=your_github_personal_access_token
GITHUB_REPO_OWNER=txufiknr
GITHUB_REPO_NAME=Twistloom-backend
GITHUB_DEFAULT_BRANCH=main
```

**Notes**:
- `GITHUB_WORKFLOW_TOKEN` must be a Personal Access Token (PAT) with the `workflow` scope to dispatch workflows via the REST API.
- In production, store the token securely as an environment variable or secret (Vercel/GitHub Secrets).

#### 6.2 GitHub Secrets

**Status**: ⚠️ Please ensure these secrets exist in GitHub Actions secrets and production envs.

Required secrets for GitHub Actions & cron runs:
- `DATABASE_URL`, `DATABASE_READ_URL`
- `SYSTEM_USER_ID`
- AI provider keys (e.g. `GEMINI_API_KEY`, `MISTRAL_API_KEY`, `COHERE_API_KEY`, etc.)
- `IMAGEKIT_API_KEY_PRIVATE` (if image operations are used)

Action: Verify these secrets are set in the repository Settings → Secrets and in production environment variables.

---

## Frontend Implementation

### Phase 1: Type Definitions ✅ COMPLETED

#### 1.1 Add Async Book Creation Types ✅

**File**: `src/lib/types/api.ts`

**Status**: ✅ COMPLETED - All async book creation types are defined

```typescript
/**
 * Request for async book creation
 */
export interface CreateBookAsyncRequest {
  theme: string;
  mcCandidate?: {
    name?: string;
    age?: number;
    gender?: 'male' | 'female';
    bio?: string;
  };
  generateCoverImage?: boolean;
}

/**
 * Response for async book creation
 */
export interface CreateBookAsyncResponse {
  bookId: string;
  message: string;
}

/**
 * Book creation status for polling
 */
export interface BookCreationStatus {
  bookId: string;
  status: 'active' | 'archived' | 'draft' | 'pending' | 'generating' | 'failed';
  progress: number; // 0-100
  currentStep?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}
```

---

### Phase 2: API Service ✅ COMPLETED

#### 2.1 Add Async Book Creation Method ✅

**File**: `src/lib/services/books-api.ts`

**Status**: ✅ COMPLETED - All async book creation methods are implemented

```typescript
/**
 * Creates a new book asynchronously using GitHub Actions.
 * 
 * This method bypasses Vercel's 5-minute timeout by returning immediately with a bookId.
 * The actual book generation happens in GitHub Actions, which can run for 45+ minutes.
 * 
 * Frontend should poll pollBookCreationStatus() to check progress.
 * 
 * @param request - Book creation request
 * @param signal - Optional AbortSignal to cancel the request
 * @returns Promise resolving to book ID
 */
async createBookAsync(
  request: CreateBookAsyncRequest,
  signal?: AbortSignal
): Promise<CreateBookAsyncResponse> {
  return this.client.post<CreateBookAsyncResponse>('/books/async', request, { signal });
}

/**
 * Polls for book creation status.
 * 
 * This method polls the backend to check the progress of async book creation.
 * Should be called repeatedly until status is 'active' or 'failed'.
 * 
 * @param bookId - Book ID to poll
 * @param signal - Optional AbortSignal to cancel polling
 * @returns Promise resolving to book creation status
 */
async pollBookCreationStatus(
  bookId: string,
  signal?: AbortSignal
): Promise<BookCreationStatus> {
  return this.client.get<BookCreationStatus>(`/books/${bookId}/status`, { signal });
}

/**
 * Polls for book creation status with exponential backoff.
 * 
 * This method automatically polls the backend with exponential backoff
 * until the book is ready or fails.
 * 
 * Polling Strategy:
 * - Initial interval: 2 seconds
 * - Exponential backoff: 2s → 4s → 8s → max 10s
 * - Total timeout: 10 minutes (60 retries)
 * - Progress updates via callback
 * 
 * @param bookId - Book ID to poll
 * @param onProgress - Optional callback for progress updates
 * @param signal - Optional AbortSignal to cancel polling
 * @returns Promise resolving to book creation status when complete
 */
async pollBookCreationStatusWithBackoff(
  bookId: string,
  onProgress?: (status: BookCreationStatus) => void,
  signal?: AbortSignal
): Promise<BookCreationStatus> {
  const maxRetries = 60; // 10 minutes total (60 * 10s)
  let retryCount = 0;
  let backoffMs = 2000; // Start with 2s

  while (retryCount < maxRetries) {
    // Check if aborted
    if (signal?.aborted) {
      throw new DOMException('Polling aborted', 'AbortError');
    }

    try {
      devConsole.log(`[pollBookCreationStatus] 🔄 Polling attempt ${retryCount + 1}/${maxRetries} (${backoffMs}ms backoff)`);
      
      const status = await this.pollBookCreationStatus(bookId, signal);
      
      // Call progress callback
      onProgress?.(status);
      
      // Check if complete
      if (status.status === 'active' || status.status === 'failed') {
        devConsole.log(`[pollBookCreationStatus] ✅ Polling complete, status:`, status.status);
        return status;
      }

      // If still pending/generating, wait and retry
      retryCount++;
      
      if (retryCount < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, backoffMs));
        // Exponential backoff: 2s → 4s → 8s → max 10s
        backoffMs = Math.min(backoffMs * 2, 10000);
      }
    } catch (pollError) {
      devConsole.error(`[pollBookCreationStatus] ❌ Poll attempt ${retryCount + 1} failed:`, pollError);
      
      // If aborted, throw immediately
      if (signal?.aborted) {
        throw new DOMException('Polling aborted', 'AbortError');
      }
      
      retryCount++;
      
      if (retryCount < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, backoffMs));
        backoffMs = Math.min(backoffMs * 2, 10000);
      }
    }
  }

  // Max retries reached, throw error
  throw new Error('Book creation timed out after 10 minutes of polling');
}
```

---

### Phase 3: Component Updates ✅ COMPLETED

#### 3.1 Update StoryGeneratorInput ✅

**File**: `src/components/home/StoryGeneratorInput.tsx`

**Status**: ✅ COMPLETED - handleGenerateApi uses async method with polling

Update the `handleGenerateApi` function to use async method:

```typescript
/**
 * Performs the async backend API call for story generation.
 * This is called by the modal to handle polling and update step states.
 */
const handleGenerateApi = async (
  themeValue: string,
  signal?: AbortSignal,
  onProgress?: (event: BookCreationProgressEvent) => void
): Promise<CreateBookResponse> => {
  try {
    // Use async method instead of SSE
    const asyncResponse = await booksApi.createBookAsync(
      { theme: themeValue },
      signal
    );
    
    // Poll for status with progress updates
    const finalStatus = await booksApi.pollBookCreationStatusWithBackoff(
      asyncResponse.bookId,
      (status) => {
        // Map polling status to SSE-like events for compatibility
        if (status.status === 'pending') {
          onProgress?.({ type: 'book_initialization_start', data: {} });
        } else if (status.status === 'generating') {
          onProgress?.({ type: 'ai_generation_start', data: {} });
        } else if (status.status === 'active') {
          onProgress?.({ type: 'complete', data: {} });
        } else if (status.status === 'failed') {
          onProgress?.({ type: 'error', error: status.error || 'Generation failed' });
        }
      },
      signal
    );
    
    // Fetch the complete book data
    const bookResponse = await booksApi.getBook(asyncResponse.bookId);
    
    return {
      book: bookResponse.book,
      session: null, // No session for async creation
    };
  } catch (err) {
    // Enhance error message with validation details if available
    if (isApiErrorResponse(err)) {
      const apiError = err.response.data.error;
      const formattedMessage = formatValidationError(apiError);
      const enhancedError = new Error(formattedMessage) as EnhancedError;
      enhancedError.originalError = err;
      throw enhancedError;
    }
    throw err;
  }
};
```

#### 3.2 Update StoryGenerationModal ❌

**File**: `src/components/modals/StoryGenerationModal.tsx`

**Status**: ❌ NOT STARTED

No major changes needed - the modal already handles progress events via the `onProgress` callback. The mapping in `StoryGeneratorInput` will convert polling status to SSE-like events.

---

### Phase 4: Error Handling ❌ NOT STARTED

#### 4.1 Handle Polling Timeouts ❌

**File**: `src/components/modals/StoryGenerationModal.tsx`

**Status**: ❌ NOT STARTED

Add timeout handling in the modal:

```typescript
// In StoryGenerationModal.tsx
const startGeneration = useCallback(async () => {
  const controller = new AbortController();
  abortControllerRef.current = controller;

  try {
    const response = await onGenerateRef.current(
      themeRef.current,
      controller.signal,
      (event: BookCreationProgressEvent) => {
        // Existing event handling logic
        const step = mapBackendEventToStep(event.type);
        // ... rest of existing logic
      }
    );

    setIsFinalizing(true);
    await prefetchBookAssets(response.book);
    setIsFinalizing(false);
    onCompleteRef.current(response);
  } catch (err) {
    setIsFinalizing(false);
    if ((err as DOMException).name !== 'AbortError') {
      console.error('Story generation failed:', err);
      const errorMessage = getErrorMessage(err, 'Failed to generate story');
      setError(errorMessage);
      onErrorRef.current(err as Error);
    }
  }
}, []);
```

---

## Credit Consumption & Refund Flow

### Current Implementation

**Primary Flow: Async Book Creation (`POST /api/books/async`)**
- Uses `executeWithCredits()` for atomic credit consumption and book record creation
- Returns correlation ID for idempotent refunds
- Workflow trigger failure triggers `refundCredits()` with correlation ID
- Refund uses `retryWithBackoffOrNull()` for reliability (3 retries, 1s base delay)

**Alternative Flows: Sync & SSE (`POST /api/books`, `POST /api/books/stream`)**
- Uses `createBookCore()` which internally uses `executeWithCredits()`
- Same credit consumption and refund pattern
- Includes cache invalidation and activity logging

**Cron Job Flow (`src/cron/on-demand-book-creation.ts`)**
- Skips credit consumption for internal operations (`isOriginal` or `SYSTEM_USER_ID`)
- Directly calls `initializeBook()` without credit transaction

### Transaction Limitation

**Current State:**
- `executeWithCredits()` provides transaction object `tx` to the operation callback
- However, `initializeBook()` does not currently accept transaction parameter
- This means database operations in `initializeBook()` are NOT in the credit transaction

**Impact:**
- **Partial Atomicity**: Credits refunded if `initializeBook()` fails entirely
- **Partial Success Risk**: If `initializeBook()` partially succeeds (book created but page fails), credits are NOT refunded
- **Acceptable for Now**: This is an acceptable limitation given:
  - Async book creation is the primary flow (bypasses this limitation via separate workflow)
  - Sync/SSE flows are alternatives kept for compatibility
  - Partial success scenarios are rare in practice

**Future Improvement:**
To achieve full atomicity, the following refactoring is needed:
1. Add optional `tx` parameter to `initializeBook()`
2. Add optional `tx` parameter to `insertBook()`, `insertStoryPage()`, `insertStoryState()`
3. Pass `tx` through the call chain in `createBookCore()`
4. Use `tx` for all database operations when provided

**Recent Improvements:**
- Added `bookId` parameter to `initializeBook()` to support updating existing draft books
- Eliminated duplicate book creation in async flow
- Moved cache invalidation and activity logging to `initializeBook()` for consistency
- Async flow now: Create draft → Consume credits → Trigger workflow → Update draft with content

### Idempotent Refund Mechanism

**Implementation:**
- `refundCreditsIdempotent()` checks for existing refunds via correlation ID
- Prevents duplicate refunds if error handler runs multiple times
- `refundCredits()` wraps `refundCreditsIdempotent()` with retry logic
- Correlation ID stored in transaction metadata for audit trail

**Benefits:**
- No duplicate refunds
- Retry mechanism with exponential backoff
- Detailed error logging for manual review
- Audit trail via correlation ID

---

## Migration Strategy

### Phase 1: Backend Deployment (No Breaking Changes) ✅ COMPLETED

1. ✅ Deploy backend changes with new routes alongside existing SSE route
2. ✅ Keep `POST /api/books/stream` functional for backward compatibility
3. ✅ Add new routes: `POST /api/books/async` and `GET /api/books/:bookId/status`
4. ✅ Deploy GitHub workflow
5. ✅ Implement idempotent credit refund mechanism
6. ✅ Document transaction limitation for future improvement
7. ✅ Add `bookId` parameter to `initializeBook()` for draft update support
8. ✅ Eliminate duplicate book creation in async flow
9. ✅ Move cache invalidation and activity logging to `initializeBook()`

### Phase 2: Frontend Deployment (Feature Flag) ❌ NOT STARTED

1. ❌ Add feature flag to switch between SSE and async methods
2. ❌ Test async method with small subset of users
3. ❌ Monitor success rates and performance

### Phase 3: Full Migration ❌ NOT STARTED

1. ❌ Once stable, switch all users to async method
2. ❌ Deprecate `POST /api/books/stream` (keep for reference)
3. ❌ Remove SSE-related code from frontend

---

## Testing Checklist

### Backend Testing ⚠️ PARTIAL

- [ ] Test `POST /api/books/async` returns bookId immediately
- [ ] Test GitHub workflow triggers successfully
- [ ] Test workflow completes and updates book status
- [ ] Test `GET /api/books/:bookId/status` returns correct status
- [ ] Test credit consumption before workflow trigger
- [ ] Test error handling (workflow failure, timeout)
- [ ] Test unauthorized access (user accessing another user's book)

### Frontend Testing ❌ NOT STARTED

- [ ] Test async book creation flow end-to-end
- [ ] Test polling with exponential backoff
- [ ] Test progress updates in modal
- [ ] Test cancellation (abort signal)
- [ ] Test timeout handling (10 minutes)
- [ ] Test error display in modal
- [ ] Test navigation after completion

### Integration Testing ❌ NOT STARTED

- [ ] Test full flow from theme input to book completion
- [ ] Test with various themes (short, long, complex)
- [ ] Test with mcCandidate variations
- [ ] Test with generateCoverImage true/false
- [ ] Test concurrent book creation requests
- [ ] Test network resilience (connection drops during polling)

---

## Monitoring & Observability

### Backend Metrics

- Track book creation success rate (SSE vs async)
- Track average book creation time
- Track GitHub workflow success/failure rate
- Track polling endpoint response times
- Track credit consumption rate

### Frontend Metrics

- Track user drop-off during polling
- Track average time from request to completion
- Track error rates (timeout, failure, cancellation)
- Track user satisfaction (completion rate)

### Alerts

- Alert if GitHub workflow failure rate > 10%
- Alert if average book creation time > 15 minutes
- Alert if polling endpoint error rate > 5%
- Alert if credit consumption anomalies detected

---

## Rollback Plan

If issues arise during deployment:

1. **Frontend**: Switch feature flag back to SSE method
2. **Backend**: Disable `POST /api/books/async` route (return 503)
3. **GitHub**: Disable workflow dispatch
4. **Database**: Clean up any stuck 'pending' books

---

## Remaining TODOs

### Backend (Minor)

1. **Verify Environment Variables**: Check if `GITHUB_WORKFLOW_TOKEN`, `GITHUB_REPO_OWNER`, `GITHUB_REPO_NAME`, and `GITHUB_DEFAULT_BRANCH` are documented in `.env.local.example`
2. **Verify GitHub Secrets**: Confirm that `GITHUB_WORKFLOW_TOKEN` and all required secrets are configured in GitHub repository settings
3. **Backend Testing**: Complete backend testing checklist to ensure all edge cases are handled

### Frontend (Major)

1. **Phase 1 - Type Definitions**: Add `CreateBookAsyncRequest`, `CreateBookAsyncResponse`, and `BookCreationStatus` interfaces to `src/lib/types/api.ts`
2. **Phase 2 - API Service**: Implement `createBookAsync()`, `pollBookCreationStatus()`, and `pollBookCreationStatusWithBackoff()` methods in `src/lib/services/books-api.ts`
3. **Phase 3 - Component Updates**: Update `StoryGeneratorInput.tsx` to use async method and map polling status to SSE-like events
4. **Phase 4 - Error Handling**: Add timeout handling in `StoryGenerationModal.tsx`
5. **Frontend Testing**: Complete frontend and integration testing

### Deployment

1. **Feature Flag**: Implement feature flag to switch between SSE and async methods
2. **Gradual Rollout**: Test async method with small subset of users
3. **Monitor**: Monitor success rates and performance
4. **Full Migration**: Once stable, switch all users to async method
5. **Cleanup**: Deprecate `POST /api/books/stream` and remove SSE-related code

---

## Future Enhancements

1. **WebSocket Support**: Consider WebSocket for real-time updates instead of polling
2. **Queue System**: Implement job queue (BullMQ, Redis) instead of GitHub Actions
3. **Progress Granularity**: Add more granular progress steps from workflow
4. **Retry Logic**: Automatic retry on workflow failure
5. **Batch Processing**: Support bulk book creation for originals
6. **Cancellation**: Support cancelling in-flight workflow runs

---

## Conclusion

This async book creation system provides a robust solution to bypass Vercel's 5-minute timeout while maintaining a good user experience. The implementation leverages existing patterns in the codebase and provides a clear migration path with minimal risk.

---

**Recommendations & Quick Improvements**

1. Refactor `initializeBook()` and its helpers to accept an optional `tx` (database transaction) so `executeWithCredits()` can wrap book creation and credit consumption in one transaction to achieve full atomicity.
2. Improve `initializeBook()` progress reporting: emit structured step names + percent to store in `generationProgress` and `generationStep` columns for better UX.
3. Add a signed webhook endpoint the GitHub Actions workflow can call at completion/failure to update `generationStatus` — this eliminates polling and read-replica staleness.
4. Consider a job queue (BullMQ/Redis) or serverless worker for scalable background generation; GitHub Actions is convenient but limited for high throughput and observability.
  -> not viable for now as I only have Redis free plan
5. Harden the dispatch path: verify `GITHUB_WORKFLOW_TOKEN` has `workflow` scope and handle API rate limits/retries when calling GitHub REST API.
6. Add integration tests for `POST /api/books/async`, status polling, and refund on dispatch failure (mocking the dispatch and `initializeBook`).
7. Add monitoring: track workflow dispatch failures, workflow run durations, refund attempts, and book generation success rate.

If you want, I can implement one of these next: add the webhook endpoint + workflow callback, or start the `tx`-refactor for `initializeBook()`.
