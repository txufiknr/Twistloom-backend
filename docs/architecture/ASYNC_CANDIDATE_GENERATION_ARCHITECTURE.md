# Asynchronous Candidate Generation Architecture

> **⚠️ SUPERSEDED — This document is stale.** Progress tracking is now
> **DB-backed** (not the LRU 5-min cache described here), the backend is Hono
> on Bun/Vercel (not Express/Next.js), and the system now includes the
> book-mode branching contract, write-chain serialization, and the custom-action
> on-demand path. See
> **[`NEXT_PAGE_GENERATION_ARCHITECTURE.md`](./NEXT_PAGE_GENERATION_ARCHITECTURE.md)**
> for the current, implementation-accurate architecture. This file is kept for
> historical reference only.

## Overview

This document describes the asynchronous candidate generation system that solves timeout limitations by using on-demand GitHub Actions workflows for Express.js deployments. The system provides reliable background processing with extended timeouts (30 minutes) and real-time progress updates via Server-Sent Events (SSE).

## Problem Statement

### Original Issues
- **Vercel Timeout**: Synchronous AI generation often exceeded 5-minute limit
- **Express.js Incompatibility**: Next.js `after()` and `waitUntil()` don't work in Express.js
- **Poor UX**: Users experienced timeouts and failed page generation
- **Resource Waste**: Long-running serverless functions were inefficient
- **Scalability**: Synchronous processing didn't scale with user load

### Root Cause
The `ensureCandidatesForPage` function performed synchronous AI generation chains that could take 2-10 minutes depending on:
- Number of actions (3-9 per page)
- AI model response times
- Network latency
- Database operations
- Retry attempts for failures

## Solution Architecture

### Core Design Principles
1. **Immediate Response**: API calls return in <10 seconds
2. **Background Processing**: Heavy AI work moved to GitHub Actions workflows
3. **Extended Timeouts**: 30-minute timeout via GitHub Actions (vs 5-minute Vercel limit)
4. **Express.js Compatible**: Works with Express.js deployment (no Next.js dependencies)
5. **Fault Tolerant**: Built-in retries and error handling
6. **Real-time Progress**: SSE polling for generation status updates

### Technology Stack
- **Workflow Trigger**: GitHub Actions `workflow_dispatch` API
- **Processing**: GitHub Actions runners (30-minute timeout)
- **Progress Tracking**: LRU cache for action progress events (5-minute TTL)
- **Polling**: Server-Sent Events (SSE) for real-time updates
- **Database**: Neon PostgreSQL (shared with app data)
- **Retry Logic**: Built-in exponential backoff with network error detection

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           USER REQUEST                                  │
│              (GET /api/books/:id/:pageId/candidates)                    │
└─────────────────────────┬───────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      API LAYER (Express.js)                             │
│  • validateAndRetrievePageForGeneration() - Validation & retrieval      │
│  • triggerCandidateGenerationWorkflow() - Dispatch GitHub workflow                   │
│  • pollForCandidateGeneration() - SSE polling for progress              │
│  • Immediate SSE response with progress updates                         │
└─────────────────────────┬───────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                 GITHUB ACTIONS WORKFLOW                                 │
│  • retry-pending-generations.yml - On-demand workflow dispatch          │
│  • 30-minute timeout (vs 5-minute Vercel limit)                         │
│  • Environment variables: book_id, page_id, triggered_by                │
│  • Full environment access and logging                                  │
└─────────────────────────┬───────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                  CRON JOB PROCESSING                                    │
│  • src/cron/retry-pending-generations.ts                                │
│  • processSpecificPage() - Targeted page generation                     │
│  • ensureCandidatesForPageWithStrategy() - 'cron' strategy              │
│  • 13-minute timeout with parallel processing                           │
└─────────────────────────┬───────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                  AI GENERATION LAYER                                    │
│  • ensureCandidatesForPageWithStrategy() - Strategy-based generation    │
│  • generateCandidatesInParallel() - Parallel processing                 │
│  • AI model calls (Cerebras, Mistral, etc.)                             │
│  • Database updates (pages, actions, destinations)                      │
│  • Progress event storage (LRU cache)                                   │
└─────────────────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                  SSE PROGRESS UPDATES                                   │
│  • pollForCandidateGeneration() - Polls database for completion         │
│  • getActionProgressEvents() - Retrieves progress from cache            │
│  • Real-time updates via SSE (event: progress, action_progress)         │
│  • Exponential backoff polling (2s → 4s → 8s → 10s max)                 │
└─────────────────────────────────────────────────────────────────────────┘
```

## Key Components

### 1. GitHub Workflow Trigger (`src/utils/candidate-generation.ts`)

**Purpose**: Dispatches GitHub Actions workflow for on-demand candidate generation

**Key Features**:
- **Idempotent**: Checks if generation is already in progress (isGeneratingStartedAt)
- **Express.js Compatible**: Works with Express.js (no Next.js dependencies)
- **Extended Timeout**: 30-minute timeout via GitHub Actions (vs 5-minute Vercel limit)
- **State Management**: Sets isGeneratingStartedAt before triggering, resets on errors
- **Error Handling**: Resets isGeneratingStartedAt on failures to allow retry

**Configuration**:
```typescript
// Environment variables required
GITHUB_WORKFLOW_TOKEN=ghp_xxx  // GitHub personal access token
GITHUB_REPO_OWNER=your-username
GITHUB_REPO_NAME=your-repo
GITHUB_DEFAULT_BRANCH=main
```

**Usage Example**:
```typescript
const { triggerCandidateGenerationWorkflow } = await import('../utils/candidate-generation.js');

const result = await triggerCandidateGenerationWorkflow({
  bookId: 'book123',
  pageId: 'page456',
  userId: 'user789',
  context: 'GET /candidates'
});

if (result.success) {
  console.log('Workflow triggered successfully');
} else if (result.alreadyInProgress) {
  console.log('Generation already in progress');
} else {
  console.error('Failed to trigger workflow:', result.error);
}
```

**Idempotency Guarantee**:
- Checks `isGeneratingStartedAt` before triggering
- Sets `isGeneratingStartedAt = now()` before workflow dispatch
- Returns `alreadyInProgress: true` if already generating
- Resets `isGeneratingStartedAt = null` on errors

### 2. SSE Polling (`src/utils/sse.ts`)

**Purpose**: Real-time progress updates via Server-Sent Events

**Key Features**:
- **Exponential Backoff**: 2s → 4s → 8s → 10s max
- **Client Disconnect Detection**: Stops polling if client disconnects
- **Network Error Handling**: Retries on network failures
- **Progress Event Streaming**: Real-time per-action progress
- **LRU Cache Integration**: Retrieves progress from in-memory cache

**Configuration**:
```typescript
const SSE_POLLING_CONFIG: SSEPollingConfig = {
  pollIntervalMs: 2000, // 2 seconds
  maxAttempts: 150, // 5 minutes total
  progressInterval: 5, // Every 5 polls = 10 seconds
};
```

**Usage Example**:
```typescript
await pollForCandidateGeneration({
  pageId,
  userId,
  req,
  res,
  initialMessage: 'Candidate generation started...',
  getPageFromDB: (pid) => getPageFromDB(pid, { client: dbWrite }),
  mapToUserStoryPage,
  getActionProgressEvents,
  clearActionProgressEvents,
  config: SSE_POLLING_CONFIG,
});
```

### 3. Progress Tracking (`src/utils/progress-tracking.ts`)

**Purpose**: In-memory LRU cache for action progress events

**⚠️ Current Status**: Infrastructure exists but **not fully integrated**. The cache functions are defined but not connected to the generation callbacks.

**Key Features**:
- **LRU Cache**: Max 100 entries, 5-minute TTL
- **Per-Action Progress**: Tracks individual action generation status
- **Redis Migration Path**: Clear path to Redis for multi-server deployments
- **Automatic Cleanup**: Expired entries automatically removed

**Configuration**:
```typescript
const PROGRESS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const PROGRESS_CACHE_MAX_SIZE = 100; // Max entries
```

**Intended Usage** (not yet implemented):
```typescript
// During generation, store progress events via callback
const onProgress: ActionProgressCallback = async (action, status, result, error) => {
  await storeActionProgressEvent(pageId, {
    action: action.text,
    status,
    completed: status === 'completed' ? 1 : 0,
    total: actions.length,
    progress: status === 'completed' ? 100 : 0,
    timestamp: new Date().toISOString(),
    error: error ? getErrorMessage(error) : undefined
  });
};

// Retrieve progress events during SSE polling
const events = await getActionProgressEvents(pageId);

// Clear events after completion
await clearActionProgressEvents(pageId);
```

**Integration Required**:
- Connect `ActionProgressCallback` in `generateCandidatesInParallel()` to `storeActionProgressEvent()`
- Pass callback from API routes through to generation functions
- Test SSE polling with actual per-action progress updates

### 4. Cron Job Processing (`src/cron/retry-pending-generations.ts`)

**Purpose**: Processes GitHub workflow triggers and retries failed generations

**Key Features**:
- **Manual Trigger Support**: Accepts environment variables for targeted processing
- **Strategy-Based Generation**: Uses 'cron' strategy with 13-minute timeout
- **Parallel Processing**: Processes actions in parallel for efficiency
- **Progress Event Storage**: Stores progress in LRU cache during generation
- **Cleanup**: Resets isGeneratingStartedAt to null on completion/failure

**Environment Variables** (for manual triggers):
```bash
TRIGGERED_BOOK_ID=book123
TRIGGERED_PAGE_ID=page456
TRIGGERED_BY_USER=user789
```

**Processing Flow**:
1. Check for manual trigger environment variables
2. If present, process specific page via processSpecificPage()
3. Otherwise, process failed generations via retryFailedGenerations()
4. Use 'cron' strategy with extended timeout
5. Store progress events in LRU cache
6. Reset isGeneratingStartedAt to null on completion

### 5. API Endpoints (`src/routes/books.ts`)

**GET /api/books/:identifier/:pageId/candidates**:
- Validates page and user access
- Triggers GitHub workflow if not already in progress
- Polls for completion via SSE
- Returns real-time progress updates

**GET /api/books/:identifier/:pageId/candidates/status**:
- Returns current generation status
- Triggers GitHub workflow if actions incomplete
- Returns progress events from cache
- Fast JSON response (no SSE)

**Common Validation**:
- `validateAndRetrievePageForGeneration()`: Shared validation function
- UUID validation for pageId
- Page lookup from database
- Stuck generation reset (10-minute max)
- User page mapping

## Performance Characteristics

### Response Times
- **API Response**: <1 second (workflow trigger only)
- **Workflow Dispatch**: <500ms (GitHub API call)
- **Generation Processing**: 2-10 minutes (GitHub Actions, no time pressure)
- **SSE Polling**: 2-second intervals with exponential backoff
- **Total UX Time**: ~30-120 seconds (user reads page, candidates ready)

### Throughput
- **Concurrent Workflows**: Limited by GitHub Actions concurrency limits
- **Workflows per Hour**: ~60 (1 per minute per page)
- **Scalability**: Horizontal via GitHub Actions parallelism
- **Cost Efficiency**: Free tier includes 2000 minutes/month

### Reliability
- **Idempotency**: Single workflow per page (isGeneratingStartedAt check)
- **Error Handling**: Automatic reset on failures
- **Monitoring**: GitHub Actions workflow logs
- **Recovery**: Manual retry via status endpoint

## Configuration

### Environment Variables
```bash
# GitHub workflow configuration
GITHUB_WORKFLOW_TOKEN=ghp_xxx  # GitHub personal access token
GITHUB_REPO_OWNER=your-username
GITHUB_REPO_NAME=your-repo
GITHUB_DEFAULT_BRANCH=main

# Database (shared with app)
DATABASE_URL=postgresql://...

# Optional: Manual trigger for cron job
TRIGGERED_BOOK_ID=book123
TRIGGERED_PAGE_ID=page456
TRIGGERED_BY_USER=user789
```

### GitHub Workflow Configuration (`.github/workflows/retry-pending-generations.yml`)
```yaml
name: Retry Pending Generations

on:
  workflow_dispatch:
    inputs:
      book_id:
        description: Book ID to process
        required: true
        type: string
      page_id:
        description: Page ID to process
        required: true
        type: string
      triggered_by:
        description: User who triggered the workflow
        required: true
        type: string

jobs:
  process:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v3
      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '20'
      - name: Install dependencies
        run: pnpm install
      - name: Run generation
        run: pnpm tsx src/cron/retry-pending-generations.ts
        env:
          TRIGGERED_BOOK_ID: ${{ inputs.book_id }}
          TRIGGERED_PAGE_ID: ${{ inputs.page_id }}
          TRIGGERED_BY_USER: ${{ inputs.triggered_by }}
```

## Monitoring and Observability

### Generation Status
```typescript
// Check if generation is in progress
const dbPage = await getPageFromDB(pageId, { client: dbWrite });
const isGenerating = !!dbPage.isGeneratingStartedAt;

// Get progress events from cache
const progressEvents = await getActionProgressEvents(pageId);
```

### Logging Strategy
- **Workflow Trigger**: `[context] 🚀 Triggering GitHub workflow for page {pageId}`
- **Already In Progress**: `[context] ℹ️ Generation already in progress for page {pageId}`
- **Workflow Success**: `[context] 🚀 GitHub workflow triggered successfully`
- **Workflow Failure**: `[context] ❌ Failed to trigger GitHub workflow: {error}`
- **Generation Start**: `[cron] Starting generation for page {pageId}`
- **Generation Complete**: `[cron] ✅ Completed generation for page {pageId} in {duration}ms`

### Error Handling
- **Validation Errors**: Non-retryable, reset isGeneratingStartedAt
- **GitHub API Errors**: Reset isGeneratingStartedAt, return error message
- **Network Errors**: Retry with exponential backoff in SSE polling
- **Timeout Errors**: Reset isGeneratingStartedAt after 10 minutes

## Testing Strategy

### Manual Testing
```bash
# Test GitHub workflow trigger
curl -X GET "https://your-app.com/api/books/book123/page456/candidates" \
  -H "Content-Type: text/event-stream"

# Check generation status
curl -X GET "https://your-app.com/api/books/book123/page456/candidates/status"

# Manual cron trigger (via GitHub Actions UI)
# Navigate to: Actions > Retry Pending Generations > Run workflow
# Input: book_id, page_id, triggered_by
```

### Integration Testing
- End-to-end workflow dispatch
- SSE polling with progress updates
- isGeneratingStartedAt lifecycle
- Error handling and reset logic

## Troubleshooting

### Common Issues

**Workflow Not Triggering**:
- Check GITHUB_WORKFLOW_TOKEN configuration
- Verify GitHub repo owner/name/branch
- Review GitHub API rate limits
- Check workflow file exists in `.github/workflows/`

**Generation Stuck**:
- Check isGeneratingStartedAt timestamp (should reset after 10 minutes)
- Review GitHub Actions workflow logs
- Verify cron job is running
- Check for database connectivity issues

**SSE Polling Failing**:
- Verify SSE headers are set correctly
- Check client disconnect handling
- Review network error retry logic
- Ensure progress cache is accessible

### Debug Commands
```typescript
// Check generation status
const dbPage = await getPageFromDB(pageId, { client: dbWrite });
console.log('isGeneratingStartedAt:', dbPage.isGeneratingStartedAt);

// Get progress events
const events = await getActionProgressEvents(pageId);
console.log('Progress events:', events);

// Manual workflow trigger
const result = await triggerCandidateGenerationWorkflow({
  bookId: 'book123',
  pageId: 'page456',
  userId: 'user789',
  context: 'manual-debug'
});
console.log('Result:', result);
```

## Future Improvements

### Short Term
- **Redis Migration**: Replace LRU cache with Redis for multi-server deployments
- **Webhook Notifications**: Notify frontend when generation completes
- **Retry Queue**: Automatic retry for failed generations

### Long Term
- **Distributed Locking**: Redis-based locks for better scalability
- **Priority Queues**: Different priority levels for different generation types
- **Metrics Dashboard**: Real-time monitoring of generation metrics

## Cost Analysis

### GitHub Actions Costs
- **Free Tier**: 2000 minutes/month
- **Public Repos**: Unlimited free minutes
- **Private Repos**: 2000 free minutes/month
- **Overage**: $0.008 per minute

### Resource Efficiency
- **Reduced Timeouts**: No Vercel timeout issues
- **Better Utilization**: Process only when triggered
- **Scalable Growth**: Linear cost scaling with usage
- **Express.js Compatible**: No Vercel-specific dependencies

## Conclusion

The asynchronous candidate generation architecture using GitHub Actions workflows solves timeout limitations while improving reliability, scalability, and user experience. By leveraging GitHub Actions for background processing, the system provides:

- **Immediate API responses** (<1 second)
- **Extended timeout processing** (30 minutes via GitHub Actions)
- **Express.js compatibility** (no Next.js dependencies)
- **Built-in fault tolerance** (idempotency and error handling)
- **Real-time progress updates** (SSE polling)
- **Cost-effective scaling** (GitHub Actions free tier)

The idempotency guarantee via `isGeneratingStartedAt` ensures single workflow per page, while the SSE polling provides real-time feedback to users. This architecture is production-ready for Express.js deployments.
