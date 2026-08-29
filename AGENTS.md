# AI Agent Development Guidelines

## 📋 Overview

This document outlines the architecture, coding standards, established design patterns, and best practices for AI agents working on the **Twistloom** backend project. Following these guidelines ensures consistency, high performance, strict type safety, data integrity, and adherence to established architectural standards across the codebase.

---

## 🛠️ Technology Stack & Runtime Architecture

### Core Technologies
- **Runtime**: Bun 1.3+ (Local dev via `Bun.serve()`, Vercel Node.js Serverless runtime in production)
- **API Framework**: Hono.js 4.12+ (runtime-agnostic, typed `AppEnv` bindings, Web API standard)
- **Database**: Neon (PostgreSQL 18, serverless connection pooling & WebSocket support)
- **ORM**: Drizzle ORM 0.45+ (type-safe query builder with SQL interval arithmetic)
- **In-Memory Cache**: `lru-cache` 11.5+ (process-level sub-millisecond cache with TTL)
- **Distributed Cache & Rate Limiting**: Upstash Redis (`@upstash/redis`, `@upstash/ratelimit` via REST API)
- **Language**: TypeScript 6.0+ (strict mode, no `any`)
- **Package Manager**: Bun (`bun install`)

### AI Multi-Provider Waterfall (8 Providers)
1. **Mistral**: Primary creative writing prose & natural character voices
2. **Google Gemini**: Large context (1M+ tokens), rapid generation, world-building lore
3. **OpenRouter**: Unified gateway for Qwen, Llama-4, DeepSeek, Nemotron
4. **Cerebras**: Ultra-high-speed inference for GLM-4.7 & reasoning
5. **Groq**: Low-latency fast validation (Llama-3.3, Qwen)
6. **NVIDIA**: Cost-effective Llama-3.3 on NIM
7. **Cloudflare Workers AI**: Edge inference for Mistral-7B / Llama-3.1
8. **Cohere**: Last-resort fallback (Command-R)

---

## ⚡ Established Architectural Patterns & Best Practices

### 1. In-Memory LRU Caching Patterns

The backend employs dedicated in-memory LRU caches (`lru-cache`) for high-frequency, sub-millisecond reads where network trips to Redis or Postgres are unnecessary overhead.

**Primary Implementation**: [`src/services/story-state-cache.ts`](file:///d:/Projects/Twistloom/Twistloom-backend/src/services/story-state-cache.ts) and [`src/utils/branch-traversal.ts`](file:///d:/Projects/Twistloom/Twistloom-backend/src/utils/branch-traversal.ts).

#### Key Principles:
- **Bounded Memory Size & Explicit TTL**: Always configure `max` entries and explicit `ttl` (e.g., 2 minutes for active branch traversal, 30 minutes for deleted state buffers) to prevent memory leaks during serverless warmup or long-running processes.
- **Sliding Expiration**: Enable `updateAgeOnGet: true` for frequently accessed reading session nodes.
- **Telemetry & Logging**: Use the `dispose` callback to monitor evictions and maintain internal hit/miss metrics (`hits`, `misses`, `hitRate`).
- **Scope & Isolation**: In-memory LRU caches are process-local. Never rely on LRU as the single source of truth for globally coordinated state—always back persistent state with Redis or Postgres.

```typescript
import { LRUCache } from "lru-cache";
import type { DBStoryState } from "../types/schema.js";

export const storyStateCache = new LRUCache<string, StoryStateCacheEntry>({
  max: 500,
  ttl: 2 * 60 * 1000, // 2 minutes
  allowStale: false,
  updateAgeOnGet: true,
  dispose: (value, key) => {
    console.log(`[StoryStateCache] 🗑️ Evicted: ${key} (age: ${Date.now() - value.cachedAt}ms)`);
  }
});
```

---

### 2. Redis & Multi-Tier Caching Architecture

Twistloom uses a 3-tier caching hierarchy:
1. **L1 In-Memory LRU**: Process-local, instant access (branch states, prompt templates).
2. **L2 Upstash Redis**: Distributed caching, sliding rate limits, and distributed idempotency locks.
3. **L3 Database Cache (`user_cache` table)**: Persistent, SQL-level TTL-enforced cache for user queries, payloads, and fallback data.

**Primary Implementations**:
- [`src/utils/redis.ts`](file:///d:/Projects/Twistloom/Twistloom-backend/src/utils/redis.ts) - Redis client, atomic rate limiting, idempotency locks
- [`src/services/cache.ts`](file:///d:/Projects/Twistloom/Twistloom-backend/src/services/cache.ts) - High-level Redis service, `withCache` wrapper, pattern invalidations
- [`src/utils/cache.ts`](file:///d:/Projects/Twistloom/Twistloom-backend/src/utils/cache.ts) - Database-backed `user_cache` operations, SQL interval filtering, DJB2/SHA-256 key hashing
- [`src/config/redis.ts`](file:///d:/Projects/Twistloom/Twistloom-backend/src/config/redis.ts) & [`src/config/cache.ts`](file:///d:/Projects/Twistloom/Twistloom-backend/src/config/cache.ts) - TTLs and key namespaces

#### A. Redis Client & Fail-Open Rate Limiting
- Upstash Redis uses serverless-friendly REST calls (`@upstash/redis`).
- `checkRateLimit()` uses atomic `INCR` and sets expiration only when `requestCount === 1` to eliminate race conditions.
- If Redis is unavailable or unconfigured, methods fail open gracefully without throwing 500 errors.

```typescript
import { getRedisClient, checkRateLimit } from "../utils/redis.js";

// Atomic rate limiting
const limit = await checkRateLimit(`auth-attempt:${ip}`, { maxRequests: 5, windowSeconds: 60 });
if (!limit.allowed) {
  return cApiError(c, "Too many requests. Please try again later.", 429);
}
```

#### B. Distributed Idempotency Locks
For sensitive operations (e.g. credit consumption, generation jobs), prevent duplicate submissions via `setIdempotencyProcessing()`:

```typescript
const processing = await setIdempotencyProcessing({
  key: `generate-${userId}-${bookId}`,
  prefix: "gen-lock",
  ttl: 300 // 5 minutes
});

if (!processing.set) {
  return cApiError(c, "Generation already in progress for this story", 409);
}

try {
  // Execute critical operation
} finally {
  await processing.cleanup();
}
```

#### C. Redis Key Namespaces & Invalidation Rules
- **Per-Sort Explore Keys**: Do not use a monolithic `books:explore:page:1` key. Use per-sort keys `books:explore:page:1:${sortBy}` (`EXPLORE_PAGE_1_BY_SORT`) so `top-picks` never collides with `newest`.
- **SCAN Pattern Deletion**: Upstash restricts the raw `KEYS` command in production. Always use cursor-based `SCAN` iteration (`deleteCachePattern`) to purge wildcards.
- **Large Key Hashing**: Cache keys exceeding 16 KB (`CACHE_KEY_HASH_THRESHOLD`) must be hashed with SHA-256 (`createCacheKey()`) to keep Redis memory footprint minimal.

---

### 3. Credits Consumption & Financial Integrity

All credit deductions and rewards must maintain strict transactional guarantees, row-level locking, and idempotency.

**Primary Implementations**:
- [`src/services/credits.ts`](file:///d:/Projects/Twistloom/Twistloom-backend/src/services/credits.ts)
- [`src/config/credits.ts`](file:///d:/Projects/Twistloom/Twistloom-backend/src/config/credits.ts)

#### A. Atomic Operations with `executeWithCredits`
When an action consumes credits and creates database records (e.g. story generation, custom actions, hint purchases), wrap the entire flow in `executeWithCredits()`:

```typescript
import { executeWithCredits } from "../services/credits.js";

const { result, correlationId, transactionId } = await executeWithCredits(
  userId,
  "STORY_GENERATION",
  async (tx) => {
    // 1. MUST use tx for ALL database writes inside this callback
    const [book] = await tx.insert(books).values({ ... }).returning();
    const [page] = await tx.insert(pages).values({ ... }).returning();
    return { book, page };
  },
  {
    context: "book_creation",
    metadata: { mode: "multiverse", theme: "lovecraftian" }
  }
);
```

#### Critical Rules for Credit Transactions:
1. **Single Postgres Transaction**: `executeWithCredits` acquires a row-level lock (`SELECT ... FOR UPDATE`) on `users.credits`. If the callback throws, the database automatically rolls back **both** the credit deduction and all row mutations.
2. **Transaction Propagating (`tx`)**: You MUST pass the `tx` parameter to all internal database operations. Any query running on `dbWrite` directly will bypass the transaction and fail to roll back!
3. **External Side-Effects**: Keep external API calls (e.g., AI generation, Stripe calls) or cache invalidations outside the transaction, or execute them after the transaction successfully commits.
4. **Activity Logging Outside Transaction**: User analytics and audit logging (`logUserActivity`) are intentionally placed outside the transaction boundary so analytics errors never roll back successful user purchases.
5. **Idempotent Refunds**: If an asynchronous step fails *after* a transaction has committed, call `refundCredits(userId, costKey, { correlationId })`. `refundCreditsIdempotent` verifies against the `transactions` table before issuing refunds to prevent duplicate refund attacks.
6. **Free Demo & Demo User Support**: Always respect `FEATURE_FREE_DEMO` and `isDemoUser(userId)` via `getCreditCostForUser()`. When demo mode is active, costs resolve to 0 and skip row locks.

---

### 4. Server-Sent Events (SSE) Streaming Architecture

Twistloom delivers real-time AI generation with Time-To-First-Token < 300ms using W3C-compliant SSE over HTTP.

**Primary Reference**: [`docs/architecture/SERVER_SENT_EVENTS_STREAMING_ARCHITECTURE.md`](file:///d:/Projects/Twistloom/Twistloom-backend/docs/architecture/SERVER_SENT_EVENTS_STREAMING_ARCHITECTURE.md)

#### The 4 Streaming Archetypes:
1. **Pure Prose Text Stream** (e.g. `GET /api/books/prompt`): Unstructured narrative tokens piped via `aiStreamSSE` + `pipeSSEStreamAndExtractText`.
2. **Structured JSON Delta Extraction** (e.g. `POST .../companion/ask/stream`): Intercepts LLM JSON responses with `StreamingJsonAnswerExtractor` to stream pure prose to chat bubbles while delivering full typed JSON on `done`.
3. **Adaptive Cached Replay** (e.g. Cached Prompts): Replays database-cached text with 3-stage human typing cadence via `streamCachedPrompt`.
4. **Long-Running Task Progress** (e.g. `/candidates`, `/stream`): Progress events updating client on multi-step generation milestones.

#### Standard SSE Wire Protocol:
- Headers: `Content-Type: text/event-stream; charset=utf-8`, `Cache-Control: no-cache, no-transform`, `Connection: keep-alive`, `X-Accel-Buffering: no`
- Events: `start`, `chunk`, `done`, `end`, `error`

#### ⛔ Critical Streaming Anti-Patterns:
- ❌ **The Raw Uint8Array Concatenation Trap**: `aiStreamSSE` emits formatted binary SSE protocol lines (`event: chunk\ndata: ...`). Do NOT concatenate raw chunks and decode with `TextDecoder` to save to the database—that pollutes your cache with raw wire envelopes! Use `pipeSSEStreamAndExtractText`.
- ❌ **Double Protocol Wrapping**: Never feed a string containing `event: chunk` into `streamCachedPrompt()`. DB cache MUST store pure text.
- ❌ **Raw JSON Leaks**: Never pipe raw structured JSON tokens to the client when using JSON mode. Use `StreamingJsonAnswerExtractor` to strip outer JSON framing.
- ❌ **Missing AbortSignal**: ALWAYS pass `c.req.raw.signal` into `aiStreamSSE` or provider calls so client disconnections terminate upstream AI GPU workloads immediately.
- ❌ **Manual String Encoding**: Use Hono's typed helper: `await stream.writeSSE({ event: "chunk", data: JSON.stringify(...) })`.

#### Canonical Implementation Recipe (Structured Companion Stream):
```typescript
import { streamSSE } from "hono/streaming";
import { streamCompanionAnswerSSE } from "../utils/companion-stream.js";
import { executeWithCredits } from "../services/credits.js";
import { getErrorMessage } from "../utils/error.js";

router.post("/:identifier/:pageId/companion/ask/stream", requireAuth, async (c) => {
  const userId = c.get("userId")!;
  const { question } = await c.req.json();

  return streamSSE(c, async (stream) => {
    try {
      const { result } = await executeWithCredits(
        userId,
        "COMPANION_ASK",
        async () => {
          return streamCompanionAnswerSSE({
            userPrompt: buildCompanionPrompt(question),
            signal: c.req.raw.signal, // Propagate abort signal
            onChunk: async (proseDelta) => {
              await stream.writeSSE({
                event: "chunk",
                data: JSON.stringify({ content: proseDelta })
              });
            }
          });
        },
        { context: "companion_ask" }
      );

      // Emit complete structured payload
      await stream.writeSSE({
        event: "done",
        data: JSON.stringify(result)
      });
    } catch (err) {
      await stream.writeSSE({
        event: "error",
        data: JSON.stringify({ message: getErrorMessage(err) })
      });
    }
  });
});
```

---

### 5. Database Operations & Drizzle ORM Guidelines

- **Database Client Splitting**: Use `dbRead` for read-only replica queries and `dbWrite` for write operations / transactions (`src/db/client.ts`).
- **Connection Management**: Neon serverless uses WebSockets (`neonConfig.webSocketConstructor = globalThis.WebSocket`).
- **Denormalized Counters**: High-traffic counters (`likesCount`, `readCount`, `favoritesCount`) are maintained via PostgreSQL triggers for $O(1)$ reads without `COUNT(*)` subqueries.
- ⚠️ **Schema Updates & Migration Rules**:
  - **DO NOT automatically execute `bun db:generate` or `bun db:migrate`** when updating schemas.
  - Make changes only to `src/db/schema.ts` and related application types.
  - The human developer will review schema changes and run migrations manually.

---

### 6. Hono Route Handlers & Error Handling

- **Typed Context**: Always type Hono apps and routers with `AppEnv` (`src/hono/env.ts`):
  ```typescript
  import { Hono } from "hono";
  import type { AppEnv } from "../hono/env.js";

  export const booksRouter = new Hono<AppEnv>();
  ```
- **Error Response Helpers**: Use the standardized `c*` helpers in [`src/utils/error.ts`](file:///d:/Projects/Twistloom/Twistloom-backend/src/utils/error.ts):
  ```typescript
  import { cApiError, cValidationError, cNotFoundError, cUnauthorizedError } from "../utils/error.js";

  if (!book) return cNotFoundError(c, "Book not found");
  if (!isValid) return cValidationError(c, "Invalid parameters", errors);
  ```
- **Relative Imports**: All local imports MUST include explicit `.js` extensions (e.g. `import { db } from '../db/client.js';`) to adhere to ESM module resolution.

---

### 7. Hot-Path & Serialization Performance Best Practices

These patterns reduce latency and DB/CPU load at **any** scale—not only under serverless CPU quotas. Apply them whenever you touch a high-frequency endpoint or an AI-generation path.

#### A. Page-Scoped Memoization of Expensive Serialization
Prompt/context builders (`buildCanonicalBlock`, `buildCompanionPageContext`, `createNarrativeStyle`, etc.) re-serialize large, page-stable story state on every request. Within a single page's session that state is immutable until the page is published, so memoize the rendered output:
- Use `cachedRender(key, compute)` from [`src/services/prompt-render-cache.ts`](file:///d:/Projects/Twistloom/Twistloom-backend/src/services/prompt-render-cache.ts) for expensive **string** serialization, keyed by a **page-scoped** identifier (e.g. `canon:${pageId}`, `comp:${bookId}:${pageId}`). The key rotates when the page is published, preventing stale renders.
- For **object**-shaped context (e.g. `buildCompanionPageContext` in [`src/utils/companion-prompt.ts`](file:///d:/Projects/Twistloom/Twistloom-backend/src/utils/companion-prompt.ts)), memoize the resolved arrays in a small page-scoped LRU and attach per-call-only fields (`semanticContext`, `history`, `question`) *after* the lookup.
- This is a pure win: identical output, lower latency, zero behavior change.

#### B. Lightweight Heartbeats / "Last-Seen" Endpoints
Presence endpoints (`POST /touch`, session heartbeats) must be O(1) atomic upserts (e.g. `UPDATE user_sessions SET updatedAt = now(), pageId = $1`, via `touchReadingSession` in [`src/services/story.ts`](file:///d:/Projects/Twistloom/Twistloom-backend/src/services/story.ts)). Never load and re-parse full entity JSON, recompute derived graphs, or fire analytics on every tick.

#### C. Cache Verified Auth Sessions (Short TTL, Invalidated on Logout)
`verifyNextAuthToken` performs JWE decryption + lookups on every request. Cache the resolved `{ userId, sessionId }` in a short-TTL LRU (≤60s) keyed by a **SHA-256 hash of the raw token** (never the plaintext token), and invalidate immediately on logout (`sessionVerifyCache` in [`src/middleware/nextauth.ts`](file:///d:/Projects/Twistloom/Twistloom-backend/src/middleware/nextauth.ts)). Net effect: most repeat requests skip crypto, with only a small, bounded trust window consistent with the existing ban-cache model.

#### D. Coalesce High-Frequency Polls & Allow Edge/Browser SWR for Semi-Static Auth'd Reads
- For status/poll endpoints, collapse burst client calls at the source: return `Retry-After` and serve a coalesced/cached response when the same `(user, resource)` polled within N seconds (see `coalescePoll` / `getCoalesced` in [`src/utils/poll-coalesce.ts`](file:///d:/Projects/Twistloom/Twistloom-backend/src/utils/poll-coalesce.ts)).
- Auth'd reads that don't need per-request freshness may relax `Cache-Control` to `private, max-age=1, s-maxage=1, stale-while-revalidate=2` ([`src/middleware/cache.ts`](file:///d:/Projects/Twistloom/Twistloom-backend/src/middleware/cache.ts)). **Always use `private`** (never `public`) so per-user payloads are never shared across users at the CDN; `s-maxage` lets the edge collapse same-user bursts.

---

## 📝 Coding Standards & Conventions

### Naming Conventions

| Element | Style | Examples |
|---------|-------|----------|
| **Files** | `kebab-case` | `story-state-cache.ts`, `companion-stream.ts`, `credits.ts` |
| **Constants** | `UPPER_SNAKE_CASE` | `BRANCH_CACHE_TTL`, `MAX_STATE_CACHE_SIZE`, `CREDIT_COSTS` |
| **Variables & Functions** | `camelCase` | `executeWithCredits`, `calculateBranchSwitchCost`, `userId` |
| **Classes & Interfaces** | `PascalCase` | `StreamingJsonAnswerExtractor`, `DBStoryState`, `AppEnv` |

### TSDoc/JSDoc Requirements
Write clear TSDoc comments for all exported utilities, functions, and interfaces, detailing behavior, parameters, return types, error cases, and examples.

```typescript
/**
 * Deducts credits and executes an operation within an atomic Postgres transaction.
 *
 * @param userId - ID of the user spending credits
 * @param costKey - Key in CREDIT_COSTS configuration or numeric value
 * @param operation - Async callback containing DB operations using the provided tx
 * @param options - Correlation ID, analytics context, and metadata
 * @returns Result of the operation and transaction identifiers
 * @throws Error with CREDIT_ERRORS.INSUFFICIENT_CREDITS if balance is too low
 */
```

---

## 💻 Development Commands

> **🔧 PowerShell Command Separator**  
> Use `;` as command separator in PowerShell to chain commands:
> ```powershell
> cd "d:\Projects\Twistloom\Twistloom-backend"; bun run check
> ```

### Development Scripts
```bash
bun dev                         # Start dev server with hot reload
bun dev:api                     # Start API server only
bun dev:cron:trending           # Run trending score calculation locally
bun dev:cron:candidate          # Run candidate generation cron locally
bun dev:cron:translate          # Run translation cron locally
```

### Quality & Type Checking
```bash
bun typecheck                   # Run TypeScript compiler check
bun lint                        # Run ESLint
bun lint:fix                    # Auto-fix linting issues
bun lint:imports                # Verify all imports have .js extensions
bun check                       # Run lint + lint:imports + typecheck in sequence
```

### Database Scripts (Manual Developer Execution Only)
```bash
bun db:test                     # Test Neon connection
bun db:studio                   # Open Drizzle Studio UI
bun db:migrate                  # Apply pending migrations (Dev)
bun db:triggers                 # Apply Postgres triggers
```

---

### 7. Data Sanitization & Input Security Guidelines

All user-supplied strings and metadata entering backend routes and mutations must be sanitized to protect against XSS, control-character injection, and corrupt character sequences while strictly preserving emojis and valid formatting.

#### A. Sanitization Utilities (`src/utils/text-processing.ts`)
- **`sanitizeTextForDB(text, options)`**:
  - Decodes HTML entities and strips HTML tags (`<[^>]*>`) and CDATA sections.
  - Strips binary null bytes (`\0`) and invalid control characters while preserving zero-width joiners (`\u200D`), variation selectors (`\uFE0E`/`\uFE0F`), skin-tone modifiers (`\p{Sk}`), and Unicode emojis.
  - When `preserveNewlines: true`, preserves newline breaks (`\n`) and collapses excessive blank lines (`\n{3,}` $\to$ `\n\n`) for multiline fields (summaries, hooks, ending text, notes).
- **`sanitizeText(text, options)`**: Strips XSS and corrects quotation marks.
- **`sanitizeKeywords(keywords)`**: Deduplicates, sanitizes each tag via `sanitizeText`, and converts to lowercase.

#### B. Service & Route Handlers (`src/services/book.ts` & `src/routes/books.ts`)
- **`sanitizeBookTextField(field, value)`**: Sanitizes individual string fields with newline preservation automatically enabled for multiline fields (`hook`, `summary`, `endingText`, `mcBio`).
- **`sanitizeBookEnding(ending)`**: Sanitizes ending `text`, validates `type` against `endingTypes`, and outline beat text.
- **`sanitizeMainCharacter(mc)`**: Validates and sanitizes MC profile fields (`name`, `bio`, `gender`, `age`).
- **Field Length Limits (`src/config/story.ts`)**: Enforce standard length constraints on route parameters (`PEN_TITLE_MAX_LENGTH`, `PEN_SUMMARY_MAX_LENGTH`, `PEN_TARGET_PAGES_MIN/MAX`, etc.).

---

## 📋 Code Review Checklist for AI Agents

Before providing code modifications:
- [ ] User-supplied text and metadata fields are sanitized via `sanitizeText` / `sanitizeBookTextField` / `sanitizeBookEnding` / `sanitizeMainCharacter` with appropriate newline preservation and emoji support.
- [ ] Multi-tier cache rules observed (LRU for process-local reads, Upstash Redis for distributed cache/locks, Postgres `user_cache` for persistent query cache).
- [ ] Credit deductions use `executeWithCredits` with `tx` passed to all internal database operations.
- [ ] Out-of-transaction activity logging for analytics so logging never breaks financial commits.
- [ ] SSE streams pass `c.req.raw.signal` and use `pipeSSEStreamAndExtractText` or `StreamingJsonAnswerExtractor`.
- [ ] All imports use explicit `.js` extensions.
- [ ] No `any` types introduced; all types strictly defined.
- [ ] Schema changes made **only** in `src/db/schema.ts` without triggering auto-migrations.
- [ ] TSDoc comments provided for newly introduced functions and interfaces.
- [ ] Expensive page-stable serialization is memoized with a page-scoped key (not recomputed per request).
- [ ] Heartbeat / last-seen endpoints are lightweight atomic upserts (no full entity load/recompute).
- [ ] Verified auth sessions are cached on hot paths (short TTL, token-hash keyed, invalidated on logout).
- [ ] High-frequency poll endpoints coalesce bursts and use appropriate `private` `Cache-Control`.

---

## 📚 Architecture Documentation Sitemap

Before modifying or adding core backend subsystems, read the respective architectural specification:

| Subsystem | Architectural Specification Document | Key Modules / Implementation |
|---|---|---|
| **Server-Sent Events (SSE)** | [`SERVER_SENT_EVENTS_STREAMING_ARCHITECTURE.md`](file:///d:/Projects/Twistloom/Twistloom-backend/docs/architecture/SERVER_SENT_EVENTS_STREAMING_ARCHITECTURE.md) | `src/utils/ai-chat-stream.ts`, `src/utils/companion-stream.ts` |
| **AI Chat & Streaming** | [`AI_CHAT_STREAM_ARCHITECTURE.md`](file:///d:/Projects/Twistloom/Twistloom-backend/docs/architecture/AI_CHAT_STREAM_ARCHITECTURE.md) | `src/utils/ai-chat.ts`, `src/utils/prompt-stream.ts` |
| **Branch Traversal & Cache** | [`BRANCH_TRAVERSAL_ARCHITECTURE.md`](file:///d:/Projects/Twistloom/Twistloom-backend/docs/architecture/BRANCH_TRAVERSAL_ARCHITECTURE.md) | `src/utils/branch-traversal.ts`, `src/services/story-state-cache.ts` |
| **Payments & Credits** | [`PAYMENTS_ARCHITECTURE_BACKEND.md`](file:///d:/Projects/Twistloom/Twistloom-backend/docs/architecture/PAYMENTS_ARCHITECTURE_BACKEND.md) | `src/services/credits.ts`, `src/config/credits.ts` |
| **Stripe Webhooks & Billing** | [`STRIPE_PAYMENT_ARCHITECTURE.md`](file:///d:/Projects/Twistloom/Twistloom-backend/docs/architecture/STRIPE_PAYMENT_ARCHITECTURE.md) | `src/routes/payments.ts`, `src/services/stripe.ts` |
| **AI LLM Orchestration** | [`AI_LLM_ARCHITECTURE.md`](file:///d:/Projects/Twistloom/Twistloom-backend/docs/architecture/AI_LLM_ARCHITECTURE.md) | `src/utils/ai-clients.ts`, `src/utils/ai-parser.ts` |
| **Explore, Filter & Cache** | [`BOOK_EXPLORE_FILTER_SORTING_ARCHITECTURE.md`](file:///d:/Projects/Twistloom/Twistloom-backend/docs/architecture/BOOK_EXPLORE_FILTER_SORTING_ARCHITECTURE.md) | `src/routes/books.ts`, `src/services/cache.ts` |
| **Dual Authentication** | [`DUAL_AUTH_ARCHITECTURE.md`](file:///d:/Projects/Twistloom/Twistloom-backend/docs/architecture/DUAL_AUTH_ARCHITECTURE.md) | `src/routes/auth.ts`, `src/middleware/auth.ts` |
