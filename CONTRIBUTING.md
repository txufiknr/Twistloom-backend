# Contributing to Twistloom Backend

Welcome to the **Twistloom** backend repository! We are excited that you want to contribute to building our next-generation AI-powered psychological horror interactive fiction engine.

This document serves as a comprehensive guide for human developers and contributors on setting up the local environment, understanding our architecture, following established coding patterns, and submitting high-quality contributions.

---

## 📑 Table of Contents

1. [Project Overview & Architecture](#-project-overview--architecture)
2. [Prerequisites & Tooling](#-prerequisites--tooling)
3. [Local Development Setup](#-local-development-setup)
4. [Environment Variables](#-environment-variables)
5. [Database Management & Migrations](#-database-management--migrations)
6. [Core Architectural Guidelines](#-core-architectural-guidelines)
   - [6.1 Hono Framework & Route Conventions](#61-hono-framework--route-conventions)
   - [6.2 Multi-Tier Caching (LRU + Redis + Database)](#62-multi-tier-caching-lru--redis--database)
   - [6.3 Credits & Transactional Financial Integrity](#63-credits--transactional-financial-integrity)
   - [6.4 Server-Sent Events (SSE) Streaming](#64-server-sent-events-sse-streaming)
    - [6.5 AI Provider Orchestration & Fallback](#65-ai-provider-orchestration--fallback)
    - [6.6 Hot-Path & Serialization Performance](#66-hot-path--serialization-performance)
7. [Code Quality & Standards](#-code-quality--standards)
8. [Testing & Debugging](#-testing--debugging)
9. [Pull Request & Contribution Process](#-pull-request--contribution-process)

---

## 🩸 Project Overview & Architecture

Twistloom is a multiverse storytelling engine where reader decisions shape outcomes through dynamic character psychology, environmental lore, and multi-layered horror mechanics.

### Key Architectural Highlights:
- **Runtime**: High-performance [Bun](https://bun.sh) runtime locally and Vercel Node.js Serverless execution in production.
- **Web Framework**: [Hono.js](https://hono.dev) with fully typed `AppEnv` context bindings.
- **Database**: Serverless PostgreSQL via [Neon](https://neon.tech) and [Drizzle ORM](https://orm.drizzle.team).
- **Caching**: 3-tier caching (In-memory `lru-cache` $\to$ Upstash Redis REST $\to$ PostgreSQL `user_cache` table).
- **AI Waterfall**: 8-tier multi-provider fallback (Mistral, Google Gemini, OpenRouter, Cerebras, Groq, NVIDIA, Cloudflare, Cohere).
- **Streaming**: W3C Server-Sent Events (SSE) with real-time text extraction, adaptive typing replay, and structured JSON parsing.

For in-depth architectural blueprints, consult the documents in [`docs/architecture/`](file:///d:/Projects/Twistloom/Twistloom-backend/docs/architecture/).

---

## 🛠️ Prerequisites & Tooling

Before contributing, make sure you have the following installed on your development machine:

1. **Bun (1.3+)**: Primary JavaScript runtime, package manager, and test runner.
   ```bash
   # Install Bun (macOS/Linux/WSL)
   curl -fsSL https://bun.sh/install | bash

   # Install Bun (Windows PowerShell)
   powershell -c "irm bun.sh/install.ps1 | iex"
   ```
2. **Node.js (v20+)**: Required exclusively for running Drizzle Kit CLI migrations and Drizzle Studio.
3. **PostgreSQL / Neon Account**: A Neon serverless Postgres instance or a local PostgreSQL 16+ database.
4. **Upstash Redis**: An Upstash Redis instance (REST API URL and Token) for distributed rate limiting and caching.
5. **Git**: Version control.

---

## 🚀 Local Development Setup

### 1. Clone the Repository
```bash
git clone https://github.com/your-org/twistloom-backend.git
cd twistloom-backend
```

### 2. Install Dependencies
```bash
bun install
```

### 3. Configure Environment Variables
Copy the example environment file and populate the required API keys and connection strings:
```bash
cp .env.example .env.local
```
*(See the [Environment Variables](#-environment-variables) section below for key descriptions).*

### 4. Setup Database
Initialize extensions, apply migrations, and create triggers:
```bash
bun run db:test          # Verify connection to Neon/PostgreSQL
bun run db:extensions    # Install required PostgreSQL extensions
bun run db:migrate       # Apply schema migrations
bun run db:triggers      # Create PostgreSQL denormalization triggers
```

### 5. Start the Development Server
```bash
bun run dev
```
The server will start at `http://localhost:3000` with hot reloading enabled.

---

## 🔑 Environment Variables

The backend requires key configuration variables in `.env.local`:

| Variable | Description | Example / Note |
|---|---|---|
| `DATABASE_URL` | Neon/PostgreSQL primary connection string | `postgres://user:pass@ep-xyz.neon.tech/neondb?sslmode=require` |
| `DATABASE_URL_READ` | (Optional) Read replica connection string | Defaults to `DATABASE_URL` if omitted |
| `UPSTASH_REDIS_REST_URL` | Upstash Redis REST endpoint | `https://xyz.upstash.io` |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis REST bearer token | `AX...=` |
| `AUTH_SECRET` | NextAuth v5 session signing secret | Random 32+ character string |
| `FEATURE_FREE_DEMO` | Demo pricing flag (`true`/`false`) | Set to `true` to make all credit actions 0 credits |
| `DEMO_USER_ID` | User ID exempt from credit consumption | e.g. `usr_demo123` |
| `MISTRAL_API_KEY` | Mistral AI API key (Primary prose) | `...` |
| `GEMINI_API_KEY` | Google Gemini API key (Large context) | `AIzaSy...` |
| `GROQ_API_KEY` | Groq API key (Low-latency inference) | `gsk_...` |
| `OPENROUTER_API_KEY` | OpenRouter unified gateway key | `sk-or-...` |
| `STRIPE_SECRET_KEY` | Stripe secret API key (Billing) | `sk_test_...` |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signature secret | `whsec_...` |
| `RESEND_API_KEY` | Resend API key for transactional emails | `re_...` |

---

## 🗄️ Database Management & Migrations

We use **Drizzle ORM** with PostgreSQL. Schema definitions reside in [`src/db/schema.ts`](file:///d:/Projects/Twistloom/Twistloom-backend/src/db/schema.ts).

### Migration Commands
> **⚠️ Important Notice**: Drizzle Kit runs under Node.js via `node --env-file=.env.local` to maintain full compatibility with Neon's WebSocket driver.

```bash
bun run db:generate      # Generate new SQL migration files from src/db/schema.ts
bun run db:migrate       # Apply pending migrations to the local/dev database
bun run db:studio        # Open Drizzle Studio visual database inspector
bun run db:triggers      # Apply PostgreSQL performance triggers
bun run db:reset         # Reset database (clear, migrate, and rebuild triggers)
```

### Schema Best Practices:
1. **Denormalized Counters**: Fields like `likesCount`, `readCount`, and `favoritesCount` on the `books` table are updated automatically by PostgreSQL triggers. Do not manually increment these counters in application code.
2. **Type Exports**: Whenever you add or alter a table in `schema.ts`, export its `InferSelectModel` and `InferInsertModel` types in [`src/types/schema.ts`](file:///d:/Projects/Twistloom/Twistloom-backend/src/types/schema.ts).

---

## 🏛️ Core Architectural Guidelines

### 6.1 Hono Framework & Route Conventions
- **Typed Context**: Always pass `AppEnv` (`src/hono/env.ts`) when creating Hono routers:
  ```typescript
  import { Hono } from "hono";
  import type { AppEnv } from "../hono/env.js";

  export const booksRouter = new Hono<AppEnv>();
  ```
- **Error Helpers**: Never construct manual raw JSON error objects. Use standardized helpers from [`src/utils/error.ts`](file:///d:/Projects/Twistloom/Twistloom-backend/src/utils/error.ts):
  - `cApiError(c, message, statusCode)`
  - `cValidationError(c, message, details)`
  - `cNotFoundError(c, resourceName)`
  - `cUnauthorizedError(c, message)`

---

### 6.2 Multi-Tier Caching (LRU + Redis + Database)
When adding or updating caching logic, choose the appropriate cache tier:

```
┌────────────────────────────────────────────────────────────────────────┐
│                        3-TIER CACHING TOPOLOGY                         │
│                                                                        │
│  [ Tier 1: In-Memory LRU ]  ──> High-speed reading session nodes &     │
│                                  branch traversal state (<1ms)         │
│                                                                        │
│  [ Tier 2: Upstash Redis ]  ──> Explore sorting slots, rate limits,    │
│                                  distributed idempotency locks (5-20ms)│
│                                                                        │
│  [ Tier 3: DB user_cache ]  ──> Persistent SQL-TTL cached responses,   │
│                                  fallback data & prompt cache (20-50ms)│
└────────────────────────────────────────────────────────────────────────┘
```

1. **In-Memory LRU (`lru-cache`)**:
   - Location: [`src/services/story-state-cache.ts`](file:///d:/Projects/Twistloom/Twistloom-backend/src/services/story-state-cache.ts).
   - Use for: Branch traversal paths, active story state reconstructions.
   - Always set `max` entries and explicit `ttl`.
2. **Upstash Redis (`src/services/cache.ts` & `src/utils/redis.ts`)**:
   - Use for: Rate limiting (`checkRateLimit`), idempotency locks (`setIdempotencyProcessing`), and public catalog caches.
   - **Per-Sort Explore Cache**: Explore page 1 is cached per sort key (`books:explore:page:1:${sortBy}`). Never use a shared key.
   - **Pattern Invalidation**: Use `deleteCachePattern()` (which executes `SCAN` loops, avoiding the forbidden `KEYS` command).
3. **Database-Backed Cache (`src/utils/cache.ts`)**:
   - Use for: Content requiring SQL-level interval TTL filtering and automatic cleanup (`cleanupUserCache`).

---

### 6.3 Credits & Transactional Financial Integrity
Credits represent spendable user currency and must be managed with strict ACID guarantees.

**Primary Service**: [`src/services/credits.ts`](file:///d:/Projects/Twistloom/Twistloom-backend/src/services/credits.ts).

#### Golden Rule: Use `executeWithCredits`
Wrap all credit-consuming actions (e.g. generating books, custom actions, buying hints) in `executeWithCredits()`:

```typescript
import { executeWithCredits } from "../services/credits.js";

const { result, correlationId, transactionId } = await executeWithCredits(
  userId,
  "STORY_GENERATION",
  async (tx) => {
    // ⚠️ CRITICAL: ALL database mutations inside must use `tx`!
    const [book] = await tx.insert(books).values({ ... }).returning();
    return book;
  },
  {
    context: "book_creation",
    metadata: { theme: "psychological" }
  }
);
```

- **Row Locks**: `executeWithCredits` uses `SELECT ... FOR UPDATE` on `users.credits`.
- **Automatic Rollback**: If the callback throws, both the credit deduction and all database inserts roll back simultaneously.
- **Analytics Isolation**: Activity logging (`logUserActivity`) runs *outside* the transaction so analytics errors never rollback financial transactions.
- **Idempotent Refunds**: Post-commit asynchronous failures must use `refundCreditsIdempotent(userId, costKey, correlationId)`.

---

### 6.4 Server-Sent Events (SSE) Streaming
Twistloom uses W3C SSE for real-time narrative streaming.

**Comprehensive Guide**: [`docs/architecture/SERVER_SENT_EVENTS_STREAMING_ARCHITECTURE.md`](file:///d:/Projects/Twistloom/Twistloom-backend/docs/architecture/SERVER_SENT_EVENTS_STREAMING_ARCHITECTURE.md).

#### Streaming Rules:
1. **Always Pass `c.req.raw.signal`**: Ensures that when the user cancels or closes their browser tab, upstream AI inference is immediately terminated.
2. **Prose Streams**: Use `aiStreamSSE` + `pipeSSEStreamAndExtractText` to pipe SSE chunks to the client while simultaneously extracting clean prose for caching.
3. **Structured Streams (Q&A / Companion)**: Use `streamCompanionAnswerSSE` with `StreamingJsonAnswerExtractor` so users never see raw JSON brackets (`{"answer": ...}`) streaming in their chat bubbles.
4. **Use Hono's Helper**: Use `await stream.writeSSE({ event: "chunk", data: JSON.stringify(...) })`.

---

### 6.5 AI Provider Orchestration & Fallback
AI generation is orchestrated through a ranked waterfall (`src/utils/ai-chat.ts`, `src/utils/ai-clients.ts`):
1. Provider Ranking: Mistral $\to$ Gemini $\to$ OpenRouter $\to$ Cerebras $\to$ Groq $\to$ NVIDIA $\to$ Cloudflare $\to$ Cohere.
2. Fast vs. Writing Models: Validation and theme checks use `AI_CHAT_MODELS_FAST` (Groq/Cerebras); rich prose uses `AI_CHAT_MODELS_WRITING` (Mistral/Gemini).
3. JSON Auto-Repair: Structured responses are validated with schema checks and auto-repaired using `jsonrepair`.

---

### 6.6 Hot-Path & Serialization Performance

A few general performance patterns improve latency and reduce load at **any** scale—not just under serverless CPU quotas. Prefer them on high-frequency or AI-generation paths:

- **Memoize page-stable serialization**: Re-serializing large story state on every request is wasteful. Use `cachedRender()` from [`src/services/prompt-render-cache.ts`](file:///d:/Projects/Twistloom/Twistloom-backend/src/services/prompt-render-cache.ts) (or a small page-scoped LRU) keyed by a page identifier so repeated chat turns / generation calls skip redundant work. The key must rotate when the page is published to avoid stale renders.
- **Keep heartbeats cheap**: Last-seen / touch endpoints (`POST /touch`) should be a single atomic `UPDATE`, never a full entity load + recompute.
- **Verified auth sessions on hot paths**: Where an endpoint requires both authentication and high throughput, cache the verified auth session token hash for a short TTL (e.g. 5 minutes) and invalidate on logout/profile changes.
- **Coalesce burst requests on poll endpoints**: Deduplicate concurrent requests for the same resource into a single backend read, and set appropriate `private` `Cache-Control` headers.

---

### 6.7 Input Sanitization & Security Best Practices

To protect against XSS attacks, null-byte injection, and corrupt unicode sequences while preserving international text and emojis:

1. **`sanitizeTextForDB(text, options)` (`src/utils/text-processing.ts`)**:
   - Decodes HTML entities and strips HTML tags (`<[^>]*>`) and CDATA sections.
   - Cleans binary null bytes (`\0`) and invalid control characters while preserving zero-width joiners (`\u200D`), variation selectors (`\uFE0E`/`\uFE0F`), skin-tone modifiers (`\p{Sk}`), and Unicode emojis.
   - Pass `{ preserveNewlines: true }` for multiline text fields (hooks, summaries, notes, endings) to preserve user paragraphs while collapsing excessive blank lines.
2. **`sanitizeBookTextField(field, value)` (`src/services/book.ts`)**:
   - Centralized sanitizer for book metadata updates with automatic multiline detection.
3. **`sanitizeBookEnding` & `sanitizeMainCharacter` (`src/services/book.ts`)**:
   - Sanitizes structured ending beats, validates ending type against `endingTypes`, and sanitizes MC profile fields.
4. **Parameter bounds (`src/config/story.ts`)**:
   - Enforce standard character and numeric boundaries on route handlers (`PEN_TITLE_MAX_LENGTH`, `PEN_SUMMARY_MAX_LENGTH`, `PEN_TARGET_PAGES_MIN/MAX`).

---

## 📐 Code Quality & Standards

### 1. TypeScript Strictness
- No `any` types (use `unknown`, generics, or concrete types).
- Explicit return types on all exported functions.
- Strict null checks enabled.

### 2. Module Import Rules (ESM)
All relative imports in the codebase **MUST include explicit `.js` extensions** to ensure standard ESM compatibility:
```typescript
// ✅ Good
import { db } from "../db/client.js";
import { FeedRow } from "../types/feed.js";

// ❌ Bad
import { db } from "../db/client";
```
Run `bun run lint:imports` to validate your imports.

### 3. TSDoc Documentation
Document all exported functions, interfaces, and complex algorithms using TSDoc:
```typescript
/**
 * Short summary of the function purpose.
 *
 * @param userId - ID of the target user
 * @param options - Configuration options
 * @returns Resulting payload
 */
```

### 4. Running Quality Checks
Before committing code, run the full validation suite:
```bash
bun run check
```
This runs `lint`, `lint:imports`, and `typecheck` in a single command.

---

## 🧪 Testing & Debugging

Twistloom uses an on-demand testing approach for isolated components and scripts.

### Running Test Scripts
```bash
# Windows PowerShell (use semicolon separator)
cd "d:\Projects\Twistloom\Twistloom-backend"; bun test-my-feature.ts

# Clean up temporary test files
Remove-Item test-*.ts
```

### Testing Guidelines:
- Write lightweight, self-contained test scripts using Bun (`bun test-*.ts`).
- Avoid adding permanent test files that require mock database engines unless explicitly requested.
- Always clean up temporary debug/test files before submitting your pull request.

---

## 🤝 Pull Request & Contribution Process

### 1. Branch Naming Conventions
- `feature/short-description` (e.g. `feature/story-sanity-decay`)
- `fix/short-description` (e.g. `fix/explore-cache-invalidation`)
- `refactor/short-description` (e.g. `refactor/ai-stream-orchestrator`)
- `docs/short-description` (e.g. `docs/update-contributing-guide`)

### 2. Commit Message Standards
Follow [Conventional Commits](https://www.conventionalcommits.org/):
- `feat(credits): add branch switch dynamic cost calculation`
- `fix(cache): resolve explore page 1 sort key collision`
- `perf(branch): optimize hybrid checkpoint delta reconstruction`
- `docs(agents): update LRU and SSE streaming guidelines`

### 3. PR Submission Checklist
Before opening a pull request, ensure:
- [ ] `bun run check` passes without any lint or type errors.
- [ ] No `any` types or unhandled promise rejections.
- [ ] All relative imports have `.js` extensions.
- [ ] Multi-tier caching conventions and cache invalidation rules are respected.
- [ ] Credit-gated mutations use `executeWithCredits` with `tx`.
- [ ] SSE endpoints propagate `c.req.raw.signal` and use established stream helpers.
- [ ] Database schema changes are documented in `src/db/schema.ts` without committed auto-generated migrations.
- [ ] Expensive page-stable serialization is memoized with a page-scoped key rather than recomputed per request.
- [ ] Heartbeat / last-seen endpoints use lightweight atomic updates.
- [ ] Verified session results are cached on hot paths (short TTL, token-hash keyed, invalidated on logout).
- [ ] Temporary test/scratch files have been removed.

---

Thank you for helping make Twistloom an incredible interactive storytelling platform! 🩸
