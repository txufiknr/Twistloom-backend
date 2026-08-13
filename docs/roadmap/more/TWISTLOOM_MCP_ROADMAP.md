# Twistloom MCP Server — Implementation Roadmap

**Status:** Design doc v1 — scoped, phased, grounded against real codebase
**Grounded against:** `src/routes/{books,auth,user,admin,blog,email,payments,social-mentions}.ts`, `src/db/schema.ts`, `src/services/`, `src/types/`, `docs/api/*.md`
**Referenced docs:** `TODO-mcp-gemini.md`, `TODO-mcp-chatgpt.md`, `docs/roadmap/TWISTLOOM_CUSTOM_ACTIONS_ROADMAP.md`, `docs/roadmap/PGVECTOR_SEMANTIC_MEMORY_ROADMAP_V2.md`
**SDK:** `@modelcontextprotocol/sdk` via SSE transport (Vercel-compatible — already uses SSE pattern: `src/utils/sse.ts`)
**Architecture pattern:** MCP Server calls the same service layer as REST (never duplicates logic) — see §1

---

## Table of Contents

- [§0 — Architecture Pattern](#0-architecture-pattern)
- [§1 — Why MCP for Twistloom](#1-why-mcp-for-twistloom)
- [§2 — Implementation Approach](#2-implementation-approach)
- [§3 — Phase 1: Read-Only MCP Tools (Highest Value, Lowest Risk)](#3-phase-1-read-only-mcp-tools-highest-value-lowest-risk)
- [§4 — Phase 2: Write MCP Tools (Medium Value, Medium Risk)](#4-phase-2-write-mcp-tools-medium-value-medium-risk)
- [§5 — Phase 3: AI Writer IDE Tools (High Value, Higher Complexity)](#5-phase-3-ai-writer-ide-tools-high-value-higher-complexity)
- [§6 — Phase 4: Agentic Workflows (Transformative Value, Requires Proven Tool Reliability)](#6-phase-4-agentic-workflows-transformative-value-requires-proven-tool-reliability)
- [§7 — Phase 5: External MCP Client (Twistloom Ingesting Real-World Data)](#7-phase-5-external-mcp-client-twistloom-ingesting-real-world-data)
- [§8 — Security & Auth Model](#8-security--auth-model)
- [§9 — Resources (Read-Only Data Exposure)](#9-resources-read-only-data-exposure)
- [§10 — Tool Reference: Full Inventory](#10-tool-reference-full-inventory)
- [§11 — Existing Roadmaps This Unlocks / Accelerates](#11-existing-roadmaps-this-unlocks--accelerates)

---

## §0 — Architecture Pattern

```
                    ┌─────────────────────┐
                    │  AI Agents           │
                    │  ChatGPT / Claude    │
                    │  Cursor / Gemini     │
                    │  Future AI assistants│
                    └──────────┬──────────┘
                               │ MCP Protocol (SSE)
                    ┌──────────▼──────────┐
                    │   MCP Server         │
                    │  (src/services/mcp/) │
                    │  Thin routing layer  │
                    └──────────┬──────────┘
                               │ calls same functions
                    ┌──────────▼──────────┐
                    │   Service Layer      │
                    │  (shared with REST)  │
                    └─────────────────────┘
```

**Key rule:** MCP tools never contain business logic — they call the same service-layer functions as REST controllers. Every tool maps to an existing `src/services/*.ts` function or an existing REST endpoint. No DTO translation needed; the service layer already returns typed responses.

**Transport:** SSE (`hono/streaming` + `SSEServerTransport`) — proven pattern. See `GET /candidates` SSE endpoint in `src/routes/books.ts` for an existing reference. Vercel `maxDuration: 60` applies; long-generation tools should return a polling URL (same pattern as `POST /custom-actions/submit`).

---

## §1 — Why MCP for Twistloom

Twistloom is uniquely positioned for MCP because:

1. **Existing service layer is already clean** — `src/services/` has well-factored functions (`book.ts`, `story.ts`, `user.ts`, `cache.ts`, `custom-actions.ts`, `credits.ts`, `psychological-profile.ts`, `locked-paths.ts`, `book-controller.ts`, `user-controller.ts`) that MCP tools call directly. No "extract business logic" refactor is needed.

2. **All the "hard AI work" is already backend-side** — story generation, candidate generation, psychological profiling, theme validation, custom-action validation, and the 9-provider LLM waterfall all live server-side. MCP just needs to expose what already exists.

3. **SSE transport fits Vercel** — the codebase already uses SSE for `GET /candidates`, `POST /books/stream`, `GET /books/prompt`. MCP's SSE transport is the same pattern.

4. **pgvector semantic memory** (PGVECTOR_SEMANTIC_MEMORY_ROADMAP_V2.md, complete) gives MCP tools richer context to reason over — critical for the "AI writer IDE" use case (§5).

5. **Custom actions system** (TWISTLOOM_CUSTOM_ACTIONS_ROADMAP.md, being implemented) is the exact kind of intent-based capability that MCP was designed to expose — and its `preview`/`submit` two-phase pattern is the blueprint for how write MCP tools should work.

---

## §2 — Implementation Approach

### 2.1 File layout

```
src/services/mcp/
  ├── index.ts              # MCP server bootstrap, SSE transport setup
  ├── tools/
  │   ├── books.ts          # Phase 1 tools: search_books, get_book, similar_books
  │   ├── story.ts          # Phase 2 tools: create_story, continue_story
  │   ├── user.ts           # Phase 1 tools: get_profile, get_progress
  │   ├── readers.ts        # Phase 1 tools: get_page, list_branches, active_generations
  │   ├── social.ts         # Phase 1 tools: list_testimonials, list_comments
  │   ├── writer.ts         # Phase 3 tools: validate_story, get_psychological_profile, get_locked_paths
  │   ├── credits.ts        # Phase 2 tools: get_balance, estimate_cost
  │   ├── achievements.ts   # Phase 1 tools: list_achievements, get_progress
  │   ├── admin.ts          # Phase 4 tools: system_health, generation_metrics
  │   └── actions.ts        # Phase 1 tools: preview_custom_action, list_actions
  ├── resources/
  │   ├── story-state.ts    # Story state resources
  │   ├── character.ts      # Character memory resources
  │   └── book.ts           # Book metadata resources
  ├── auth.ts               # OAuth token verification → userId resolution
  └── middleware.ts          # Rate limiting, error wrapping, logging
```

### 2.2 Service-layer reuse principle

Every MCP tool body is approximately:

```ts
// ❌ WRONG — duplicated logic
server.tool("get_book", { bookId: z.string() }, async ({ bookId }) => {
  // ... write SQL query here ...
});

// ✅ RIGHT — calls existing service
import { getEnrichedBook } from "../../services/book.js";

server.tool("get_book", { bookId: z.string() }, async ({ bookId }) => {
  const book = await getEnrichedBook(bookId, userId);
  if (!book) return { content: [{ type: "text", text: "Book not found" }] };
  return { content: [{ type: "text", text: JSON.stringify(book) }] };
});
```

### 2.3 Auth model

See §8 for the full auth model. In summary: MCP tools authenticate via OAuth2 with device code flow, or via API token for programmatic access. The resolved `userId` is injected into every tool handler call context — the same way `requireAuth` injects `req.userId` into REST handlers.

---

## §3 — Phase 1: Read-Only MCP Tools (Highest Value, Lowest Risk)

### Rationale

Read-only tools are safe to ship first: no data mutation, no credit charges, no irreversible actions. They let AI agents discover and reason about Twistloom content without risk. Most map 1:1 to existing `GET` endpoints in `src/routes/` whose service-layer functions are already factored.

### Priority ranking (highest value first)

| # | Tool | Maps to REST endpoint | Maps to service function | Value |
|---|------|----------------------|--------------------------|-------|
| 1 | `search_books` | `GET /api/books/explore` | `src/services/book-controller.ts:buildBookQuery` | **Highest** — enables AI to discover all content. Prerequisite for every downstream tool. |
| 2 | `get_book` | `GET /api/books/:identifier` | `src/services/book.ts:getEnrichedBook` | Core retrieval — every agent needs to read book metadata |
| 3 | `get_page` | `GET /api/books/:identifier/:pageId` | `src/services/book.ts:getPageFromDB` + `mapToEnrichedPage` | Core retrieval — read story content |
| 4 | `list_branches` | `GET /api/books/:identifier/branches` | Inline in `routes/books.ts` | Branch-aware queries need this |
| 5 | `get_psychological_profile` | `GET /api/books/:identifier/psychological-profile` | `src/services/psychological-profile.ts:getPsychologicalProfileResult` | Unique Twistloom feature — high AI interest |
| 6 | `get_locked_paths` | `GET /api/books/:identifier/locked-paths` | `src/services/locked-paths.ts:getLockedPaths` | Unique — path-not-taken analysis |
| 7 | `list_testimonials` | `GET /api/books/:identifier/testimonials` | Via `src/db/schema.ts:bookTestimonials` | Social proof for discovery |
| 8 | `list_branches` | `GET /api/books/:identifier/branches` | Inline branch query | Branch-aware queries |
| 9 | `get_similar_books` | `GET /api/books/:id/similar` | Jaccard similarity in `src/services/book-controller.ts` | Discovery / recommendations |
| 10 | `get_user_profile` | `GET /api/user` / `GET /api/users/:identifier` | `src/services/user-controller.ts:getEnrichedUser` | Author/reader profiles |
| 11 | `get_user_progress` | `GET /api/user/progress` | `src/services/story-branch.ts:getStoryProgressWithBranch` | Reading state for agents |
| 12 | `list_achievements` | `GET /api/user/achievements` | `src/services/achievements.ts:getUserAchievements` | Gamification agent access |
| 13 | `list_comments` | `GET /api/books/:id/comments` | Comment query in `src/routes/books.ts` | Social context |
| 14 | `checkin_status` | `GET /api/user/checkin/status` | `src/services/user.ts:getCheckInStatus` | Daily engagement |
| 15 | `get_credit_balance` | `GET /api/user` (returns credits) | `getEnrichedUser().user.credits` | Budget awareness for follow-up actions |
| 16 | `list_blog_posts` | `GET /api/blog/*` | Blog query in `src/routes/blog.ts` | Content marketing |
| 17 | `list_social_mentions` | `GET /api/social-mentions/*` | Social mention query | Public social-proof wall |
| 18 | `get_book_generation_status` | `GET /api/books/:bookId/status` | `src/services/book-creation.ts` | Polling for async creates |

### §3.1 — Tool Detail: `search_books`

```
Tool: search_books
Description: Search and explore published books with filters
Arguments:
  - query (string, optional): Search text (title, hook, summary, keywords)
  - language (string, optional): ISO 639-1 language code filter
  - tags (string, optional): Comma-separated keyword tags (OR logic)
  - sortBy (enum, optional): newest | trending | popular | top-picks | originals
  - limit (integer, optional, default: 20, max: 50)
  - page (integer, optional, default: 1)
Returns: { books: EnrichedBookData[], pagination: PaginationMeta }
```

**Service mapping:** `GET /api/books/explore` → `buildBookQuery()` in `src/services/book-controller.ts`. This function already handles search, language, tags, age range, sort options, pagination, and cache. MCP tool wraps it with minimal glue.

**Why highest priority:** Every downstream use case (recommendation, reading, analysis) starts with book discovery. An AI that can't find books is blind.

### §3.2 — Tool Detail: `get_psychological_profile`

```
Tool: get_psychological_profile
Description: Get the psychological autopsy of a completed book's main character
Arguments:
  - bookId (string, required): Book UUID or slug
Returns: { archetype, stability, dominantTraits, ending, missedTeasers }
```

**Service mapping:** `GET /api/books/:identifier/psychological-profile` → `getPsychologicalProfileResult()` in `src/services/psychological-profile.ts`. No AI calls — purely templated from already-computed story state data.

**Why high priority:** This is a uniquely Twistloom feature that no other storytelling platform exposes. AI agents can use it for book recommendations ("if you liked The Paranoid archetype, try..."), comparative analysis, or as input to the Phase 3 writer tools.

### §3.3 — Tool Detail: `get_locked_paths`

```
Tool: get_locked_paths
Description: Get a timeline of permanently closed paths, connections, and threads
Arguments:
  - bookId (string, required): Book UUID or slug
Returns: { lockedPaths: Array<{ kind, label, restriction, page, context }> }
```

**Service mapping:** `GET /api/books/:identifier/locked-paths` → `getLockedPaths()` in `src/services/locked-paths.ts`. Scans story state history for `place_connection` blockages and `thread` closures.

### §3.4 — Phase 1 Implementation Notes

- **No credit charges** — all Phase 1 tools are free reads
- **No auth required** for public content (books, branches, testimonials, comments, blog). Auth required for user-scoped data (profile, progress, achievements, check-in status)
- **Rate limiting**: Apply the same per-IP rate limits as REST endpoints
- **Cache**: Phase 1 tools benefit from existing Redis cache (`withCache()`, `CACHE_KEYS`, `CACHE_TTL` in `src/services/cache.ts`)
- **Paginated tools**: Wrap all list tools with `{ items: [...], page, totalPages, hasNext }` shape matching existing `PaginationMeta`

---

## §4 — Phase 2: Write MCP Tools (Medium Value, Medium Risk)

### Rationale

Write tools let AI agents *act* on Twistloom — create books, continue stories, manage the reader experience. These require credit checks, auth enforcement, and careful error handling. The pattern is already proven by the custom actions system (`POST /custom-actions/preview` then `POST /custom-actions/submit`).

### Priority ranking

| # | Tool | Maps to REST endpoint | Value | Risk |
|---|------|----------------------|-------|------|
| 1 | `create_story` | `POST /api/books` + `POST /api/books/stream` | **Highest** — AI agents can generate stories on demand | Medium (credit cost, generation failure) |
| 2 | `continue_story` | `POST /api/custom-actions/submit` (via page gen) | **High** — agents can advance existing stories | Medium (same as custom action flow) |
| 3 | `like_book` | `POST /api/books/:id/like` | Medium — social signal | Low (idempotent upsert) |
| 4 | `favorite_book` | `POST /api/books/:id/favorite` | Medium — reading list | Low (idempotent upsert) |
| 5 | `purchase_book` | `POST /api/books/:identifier/purchase` | Medium — unlock paid books | Medium (credit charge) |
| 6 | `daily_checkin` | `POST /api/user/checkin` | Medium — engagement | Low (idempotent, once/day) |
| 7 | `submit_feedback` | `POST /api/user/feedbacks` | Low — product feedback | Low |

### §4.1 — Tool Detail: `create_story`

```
Tool: create_story
Description: Generate a new psychological thriller book using AI
Arguments:
  - theme (string, required): Story theme (max 1000 chars)
  - mcName (string, optional): Main character name
  - mcAge (integer, optional): Main character age (13-25)
  - mcGender (enum, optional): male | female
  - mcBio (string, optional): Character bio
  - mode (enum, optional): novel | interactive | multiverse (default: interactive)
  - generateCoverImage (boolean, optional, default: false)
  - async (boolean, optional, default: false): Use async GitHub Actions workflow
Returns: { bookId, title, firstPage, generationStatus }
```

**Credit cost:** 2 (novel), 5 (interactive), 10 (multiverse) — defined in `src/config/credits.ts:getBookModeCreditCost()`

**Service mapping:** `POST /api/books` or `POST /api/books/async` → `createBookCore()` in `src/services/book-creation.ts`. When `async: true`, returns `{ bookId }` immediately with polling URL.

**Important:** For synchronous creation, the MCP tool should return the book immediately on success. For async, return the `bookId` + `status polling URL`, same pattern as the REST `POST /api/books/async` response. The agent can then call `get_book_generation_status` (Phase 1, §3) to poll.

### §4.2 — Tool Detail: `continue_story`

```
Tool: continue_story
Description: Progress a story forward by selecting or customizing the next action
Arguments:
  - bookId (string, required): Book UUID or slug
  - pageId (string, required): Current page ID
  - actionIndex (integer, optional): Index of the AI-generated action to take
  - customActionText (string, optional): Custom action text (3-60 chars, alternative to actionIndex)
Returns: { nextPageId, text, actions, mood, state }
```

**Credit cost:** 3 (standard), 6 (after existing choice on this page) — defined via `CREDIT_COSTS.CUSTOM_ACTION` and `CREDIT_COSTS.CUSTOM_ACTION_AFTER_CHOICE`

**Service mapping:**
- If `actionIndex` is provided: the MCP tool triggers candidate generation via `ensureCandidatesForPageWithStrategy()` in `src/utils/candidate-generation.ts`, then selects the existing candidate.
- If `customActionText` is provided: calls the same flow as `POST /api/books/:identifier/:pageId/custom-actions/submit` — `runGate0()` → `runGate1()` → `buildCustomActionValidationPrompt()` → `aiPrompt() for validation` → `buildCanonicalAction()` → triggers page generation.

This is the single most powerful creative tool for AI agents — they can read a story, then write the next chapter. The infrastructure is already in place via the custom actions system.

### §4.3 — Phase 2 Implementation Notes

- **Credit charges**: All write tools that consume credits must call `executeWithCredits()` from `src/services/credits.ts` — the same transactional debit + service call pattern the REST endpoints use. Return `402` / `insufficient_credits` error to the agent when balance is low.
- **Two-phase pattern**: For costly operations (story creation, custom actions), follow the `preview` → `submit` pattern: a read-only preview tool (Phase 1, no charge) shows the cost estimate + likely outcome, then the write tool (Phase 2) charges and executes. This is already proven by `POST /custom-actions/preview` and `POST /custom-actions/submit`.
- **Idempotency**: Use the same upsert patterns (`onConflictDoNothing`) as REST for likes, favorites, check-ins.
- **Error handling**: Map REST 400/402/403/404 responses to MCP error content. Never leak hidden state (same rule as custom actions — `getRejectionMessage()` from `src/services/custom-actions.ts`).

---

## §5 — Phase 3: AI Writer IDE Tools (High Value, Higher Complexity)

### Rationale

These tools are what make Twistloom a *co-authoring platform* rather than just a story generator. They give AI agents (and through them, human writers in Cursor/Windsurf-like environments) deep understanding of narrative structure, consistency, and psychology. Most leverage existing computation — no new AI calls, just exposing analyzed data.

### Priority ranking

| # | Tool | Maps to service | Value | Complexity |
|---|------|-----------------|-------|------------|
| 1 | `validate_narrative_consistency` | Story state analysis via `src/utils/branch-traversal.ts` | **High** — plot hole detection | Medium |
| 2 | `get_story_outline` | `src/utils/prompt.ts:formatNextPageStoryContextPrompt` + page traversal | **High** — full narrative map | High |
| 3 | `analyze_choice_balance` | Action type distribution from story state | **Medium** — game design feedback | Low |
| 4 | `get_character_arc` | `src/services/psychological-profile.ts` per page range | **Medium** — character trajectory | Medium |
| 5 | `summarize_branch` | `storyStates.contextHistory` per branch | **Medium** — branch comparison | Low |
| 6 | `get_memory_integrity_report` | `storyStates.memoryIntegrity` + `storyStates.hiddenState` | **Low-Medium** — reality stability analysis | Low |
| 7 | `suggest_custom_action_templates` | Existing custom action templates (Phase 5 of CUSTOM_ACTIONS_ROADMAP) | **Medium** — reuse patterns | High |

### §5.1 — Tool Detail: `validate_narrative_consistency`

```
Tool: validate_narrative_consistency
Description: Check for plot holes, contradictions, or broken threads
Arguments:
  - bookId (string, required): Book UUID
  - pageRange (object, optional): { from: number, to: number } to scope the check
Returns: { issues: Array<{ severity, type, description, location }>, threadStatuses, factConsistency }
```

**Service mapping:** This is a new orchestrator that calls multiple existing readers:
1. Cross-reference `factsHistory` across page range for contradictions (correcting a fact should match its history)
2. Check `threads` status — are any threads left abandoned (`status: 'open'`) for too many pages?
3. Check `viableEnding` vs actual progression — is the story still heading toward a viable ending?
4. Check `plotFlags` — are foreshadowed events still unresolved?

**What doesn't need to change:** No new AI calls needed. All data is already structured in `storyStates` (JSONB). This is a pure analysis tool over existing data.

### §5.2 — Tool Detail: `get_story_outline`

```
Tool: get_story_outline
Description: Build a structured outline of the entire story so far
Arguments:
  - bookId (string, required): Book UUID
  - branchId (string, optional, default: "main"): Branch to outline
Returns: { pages: Array<{ page, mood, keyEvents, sceneType }>, threads, characterArcs }
```

**Service mapping:** Traverses all pages for a given branch (via `pages` table, ordered by `page`), extracts structured metadata from each page's `keyEvents`, `mood`, `sceneType`, `charactersPresent`, and the corresponding `storyStates` entry.

### §5.3 — Tool Detail: `get_character_arc`

```
Tool: get_character_arc
Description: Trace a character's psychological trajectory through the story
Arguments:
  - bookId (string, required): Book UUID
  - characterName (string, required): Character name
Returns: { appearances: Array<{ page, role, emotionalState }>, traits: string[], relationshipChanges }
```

**Service mapping:** Queries `pages.charactersPresent` for appearances and `storyStates.characters[charName]` for `pastInteractions`, `relationship`, `disposition` at each appearance. Pairs with `psychologicalProfile` for archetype trajectory.

---

## §6 — Phase 4: Agentic Workflows (Transformative Value, Requires Proven Tool Reliability)

### Rationale

Once the individual tools are reliable, AI agents can chain them into multi-step workflows. This is the "AI as orchestrator" vision — and it doesn't require new code on Twistloom's side, just robust tool definitions and clear error states.

### Example Workflows

#### Workflow A: "Generate, Validate, Publish"
```
1. create_story(theme: "haunted hospital", mode: "interactive")
   → { bookId: "abc" }
2. continue_story(bookId: "abc", actionIndex: 0) [repeat N times]
   → story progresses
3. validate_narrative_consistency(bookId: "abc")
   → { issues: [] }
4. publish_story(bookId: "abc")   [Phase 2 extension]
   → { status: "active", visibility: "public" }
```

#### Workflow B: "Reader Recommendation + Deep Dive"
```
1. search_books(tags: "psychological, horror", sortBy: "trending")
   → [bookA, bookB, bookC]
2. get_psychological_profile(bookA.id)
   → { archetype: "the_paranoid", missedTeasers: [...] }
3. The agent explains what kind of reader would enjoy bookA based on its psychological profile
```

#### Workflow C: "Co-author Session"
```
1. get_story_outline(bookId: "abc", branchId: "main")
   → story summary
2. get_character_arc(bookId: "abc", characterName: "Emma")
   → Emma is underdeveloped in the middle chapters
3. continue_story(bookId: "abc", pageId: "p123", customActionText: "Emma confronts her fear")
   → chapter advances with Emma-centric development
4. validate_narrative_consistency(bookId: "abc")
   → passes
```

#### Workflow D: "Analytics Dashboard"
```
1. get_book_stats(bookId: "abc")   [Phase 1 extension]
   → { readCount, completionRate, popularBranch }
2. get_locked_paths(bookId: "abc")
   → which paths readers abandoned
3. The agent synthesizes: "60% of readers dropped off at page 12 when they chose 'flee' instead of 'investigate'"
```

### §6.1 — Enabling Tools Needed for Phase 4

These tools bridge gaps between Phase 1-3 tools to enable smooth workflows:

| Tool | Purpose | Dependencies |
|------|---------|-------------|
| `publish_story` | Change visibility to public | Phase 2 (maps to `PATCH /api/books/:id/visibility`) |
| `get_book_stats` | Aggregate analytics | Phase 1 extension (maps to `GET /api/books/stats` + book-specific stats) |
| `list_active_generations` | Find in-progress book creations | Phase 1 (maps to `GET /api/books/generations/active`) |

---

## §7 — Phase 5: External MCP Client (Twistloom Ingesting Real-World Data)

This is the "MCP Client" direction from `TODO-mcp-gemini.md` — Twistloom's backend as an MCP *client* rather than a server. Instead of exposing tools, the backend connects to external MCP servers to enrich story generation with real-world data.

### §7.1 — Candidate External MCP Servers

| Server | Data Twistloom Could Use | Integration Point |
|--------|-------------------------|-------------------|
| **Weather** | Real-time weather for story setting | `buildNextPageNarrativePrompt()` — inject actual weather into scene descriptions |
| **Wikipedia** | Historical facts, urban legends, lore | `PROMPT_SYSTEM` / `formatWorldFactForPrompt` — ground the thriller in real locations |
| **Maps/Geography** | Street layouts, distances, place names | Place memory initialization — generate connected places for a real city |
| **News** | Current events for topical thrillers | Theme generation — "a story set during the 2026 monsoon season in Jakarta" |

### §7.2 — Implementation Pattern

```ts
// During story generation, when the AI needs external data:
// 1. Check if relevant MCP client connections exist
// 2. If yes, call the external tool (e.g., getCurrentWeather)
// 3. Inject the result into the prompt context
// 4. The AI generates the page with real-world grounding

// This is NOT an AI decision — it's a deterministic enrichment layer
// applied by the existing prompt-building pipeline (src/utils/prompt.ts)
```

**Key insight:** Unlike Phases 1-4 (which are purely additive), Phase 5 involves modifying the prompt-building pipeline. The weather/geography data must be injected *deterministically* into the context the AI sees, not left to the AI to decide to fetch. This is safer and more reliable than giving the writing model tool-calling ability during generation.

---

## §8 — Security & Auth Model

### §8.1 — Authentication Flow

```
AI Agent                     MCP Server                     Twistloom Backend
    │                            │                               │
    │── OAuth2 Device Code ──────►                               │
    │                            │── Exchange code for token ────►│
    │◄─── Access Token ──────────│◄──── Return token ────────────│
    │                            │                               │
    │── MCP Request + Token ────►│                               │
    │                            │── Verify token ──────────────►│
    │                            │── Resolve userId ─────────────│
    │                            │── Execute tool(userId) ───────│
    │◄─── Response ─────────────│◄──── Result ──────────────────│
```

**Implementation:**
- MCP tools use the same JWT verification as REST (`requireAuth` / `optionalAuth` middleware)
- For tools that require auth, the MCP server extracts `userId` from the token and passes it to the service layer — identical to REST's `req.userId`
- For tools that work without auth (public book search, testimonials), `userId` is `undefined`

### §8.2 — Permission Mapping

| MCP Tool Category | Auth Required | Credit Charge | Rate Limit |
|---|---|---|---|
| Phase 1: Read (public data) | No | No | Per-IP |
| Phase 1: Read (user data) | Yes | No | Per-user |
| Phase 2: Write (story gen) | Yes | Yes (via `executeWithCredits`) | Per-user + credit balance |
| Phase 2: Write (social) | Yes | No | Per-user |
| Phase 3: Analysis | Yes | No | Per-user |
| Phase 4: Admin | SuperAdmin | No | Per-admin |

### §8.3 — Safety Guards

1. **Credit-aware error messages**: When a tool requires credits and the balance is insufficient, return a structured error with `currentBalance` and `requiredBalance` so the agent can inform the user. Same behavior as REST's `402 Payment Required`.

2. **No hidden-state leakage**: Follow the same rule as custom actions (`getReceptionMessage()` in `src/services/custom-actions.ts`). Never include internal reasoning, matched security patterns, story hidden state, or viable ending details in error responses.

3. **Rate limiting**: Apply per-user RPM limits using the same `RateLimiter` class from `src/services/ai-limiters.ts` — MCP tool calls consume the same rate limit budget as REST API calls.

---

## §9 — Resources (Read-Only Data Exposure)

MCP Resources expose structured data that AI models can read and reason about. These are separate from Tools (which perform actions) and are ideal for "what's my current state" queries.

| Resource URI Pattern | Data Returned | Maps to |
|---|---|---|
| `twistloom://user/{userId}/profile` | User profile + stats | `GET /api/user` |
| `twistloom://book/{bookId}` | Full enriched book data | `GET /api/books/:identifier` |
| `twistloom://book/{bookId}/state` | Current story state (page + state + session) | `GET /api/books/:identifier/:pageId` + `GET /api/user/progress` |
| `twistloom://book/{bookId}/psychological-profile` | Psychological profile + ending | `GET /api/books/:identifier/psychological-profile` |
| `twistloom://book/{bookId}/locked-paths` | Locked/closed paths | `GET /api/books/:identifier/locked-paths` |
| `twistloom://user/{userId}/achievements` | Achievements + progress | `GET /api/user/achievements` |
| `twistloom://user/{userId}/checkin` | Checkin status + streak | `GET /api/user/checkin/status` |
| `twistloom://book/{bookId}/testimonials` | Approved testimonials | `GET /api/books/:identifier/testimonials` |

Resources are Phase 1 tasks (read-only, lower risk) and can be shipped alongside the Phase 1 tools.

---

## §10 — Tool Reference: Full Inventory

### Phase 1 Tools (Read-Only)

```typescript
// Book discovery & retrieval
search_books(params)           → { books: EnrichedBookData[], pagination }
get_book(bookId)               → { book: EnrichedBookData }
get_similar_books(bookId)      → { similarBooks: EnrichedBookData[] }
get_page(bookId, pageId)       → { page: StoryPage, book, selectedAction }
list_branches(bookId)          → Branch[]
get_book_generation_status(bookId) → BookGenerationStatus
list_active_generations()      → BookGenerationStatus[]

// User & social
get_user_profile(userId?)      → { user: User }
get_user_progress()            → StoryProgress
get_credit_balance()           → { credits: number }
checkin_status()               → CheckInStatus
list_testimonials(bookId)      → { testimonials: Testimonial[] }
list_comments(bookId)          → { comments: Comment[] }
list_achievements()            → { badges: Achievement[] }

// Unique Twistloom features
get_psychological_profile(bookId) → PsychologicalProfileResult
get_locked_paths(bookId)       → { lockedPaths: LockedPath[] }

// Content
list_blog_posts(limit)         → BlogPost[]
list_social_mentions()         → SocialMention[]
```

### Phase 2 Tools (Write)

```typescript
create_story(params)           → BookCreationResult
continue_story(params)         → PageGenerationResult
like_book(bookId)              → { liked: boolean, likesCount }
unlike_book(bookId)            → { liked: boolean, likesCount }
favorite_book(bookId)          → { favorited: boolean }
unfavorite_book(bookId)        → { favorited: boolean }
purchase_book(bookId)          → PurchaseResult
daily_checkin()                → CheckInResult
submit_feedback(category, message) → { feedback: Feedback }
```

### Phase 3 Tools (Writer IDE)

```typescript
validate_narrative_consistency(bookId) → { issues: ConsistencyIssue[] }
get_story_outline(bookId, branchId?)   → StoryOutline
get_character_arc(bookId, characterName) → CharacterArc
analyze_choice_balance(bookId)         → ChoiceBalance
summarize_branch(bookId, branchId)     → BranchSummary
get_memory_integrity_report(bookId)    → MemoryIntegrityReport
```

### Phase 4 Tools (Agentic Enablers)

```typescript
publish_story(bookId, visibility)      → { book }
update_book_metadata(bookId, fields)   → { book }
get_book_stats(bookId)                 → BookStats
```

### Phase 5 — Not a tool set; infrastructure change to the prompt pipeline

---

## §11 — Existing Roadmaps This Unlocks / Accelerates

| Existing Roadmap | MCP Impact |
|---|---|
| **TWISTLOOM_CUSTOM_ACTIONS_ROADMAP.md** (being implemented) | The custom actions `preview`/`submit` endpoints are the blueprint for Phase 2 write tools. The `Action.source` field (`ai` / `custom` / `community`) directly maps to MCP's provenance tracking. |
| **PGVECTOR_SEMANTIC_MEMORY_ROADMAP_V2.md** (complete) | Semantic retrieval gives MCP tools richer context — character arc analysis, thematic story outline, and fact-consistency checks all benefit from vector search over trimmed interaction history. |
| **CANDIDATE_GENERATION_ENHANCEMENT_ROADMAP.md** (complete) | SSE progress pattern for candidate generation is the same pattern MCP uses. Per-action progress events become MCP progress notifications natively. |
| **BOOK_SEARCH_ENHANCEMENT_ROADMAP.md** | Facet counts, autocomplete, and "did you mean?" directly improve the `search_books` MCP tool. |
| **AI_ORCHESTRATION_ROADMAP.md** | New providers (OpenRouter, Cloudflare) increase the MCP server's reliability — if tool execution needs an AI call, more providers = less downtime. |
| **PGVECTOR_SEMANTIC_MEMORY_ROADMAP_V2.md**: Use Cases 9/10 (deferred) | MCP resources exposing semantic memory queries could revive these use cases as agent-facing tools rather than prompt injections. |
| **AUTH_ENHANCEMENT_ROADMAP.md** | OAuth-based MCP auth (device code flow) benefits from the existing session management infrastructure (`authSessions` table, `tokenVersion` JWT revocation). |

---

## Appendix A — Phase 1 Implementation Sequence

```
Week 1: MCP server bootstrap
  - Install @modelcontextprotocol/sdk
  - Create src/services/mcp/index.ts with SSE transport
  - Verify SSE connection with a hello-world tool
  - Create src/services/mcp/auth.ts (token → userId resolution)

Week 2: Core read tools
  - Implement search_books, get_book, get_similar_books
  - Implement get_page, list_branches
  - Test against existing REST service layer

Week 3: Twistloom-unique tools
  - Implement get_psychological_profile, get_locked_paths
  - Implement list_testimonials, list_comments
  - Implement get_book_generation_status

Week 4: User-scoped read tools
  - Implement get_user_profile, get_user_progress
  - Implement get_credit_balance, checkin_status
  - Implement list_achievements
  - Implement list_blog_posts, list_social_mentions

Week 5: Testing & hardening
  - Auth flow: OAuth2 device code for AI agent login
  - Rate limiting integration
  - Error handling audit (no hidden-state leakage)
  - Documentation: tool descriptions, argument schemas
```

---

## Appendix B — Cost Impact

| Component | Cost |
|-----------|------|
| **MCP SDK** (`@modelcontextprotocol/sdk`) | Free, MIT license |
| **OAuth2 provider** (custom, uses existing JWT + `authSessions`) | Free |
| **Infrastructure** (same Vercel functions, no new DB) | $0 — reuses existing |
| **AI tool calls** (Phase 1 tools use no AI — pure data retrieval) | $0 |
| **Phase 2 AI costs** (story creation, custom actions) | Same as REST — no new AI calls, just new access paths |
| **Additional load** (MCP queries hit same DB) | Negligible — same Redis cache, same read replicas |

**Bottom line:** MCP adds near-zero marginal infrastructure cost. The only incremental cost is development time.

---

## Appendix C — Tool Naming Convention

All MCP tool names follow `snake_case` to match LLM token-efficiency conventions:

```
search_books          ✅ (not searchBooks or SearchBooks)
continue_story        ✅
get_psychological_profile  ✅
```

Tool descriptions are 5-15 words, precise, and avoid marketing language:
```
❌ "Discover amazing psychological thrillers..."
✅ "Search published books by query, language, tags, or sort option"
```
