# Twistloom LLM Optimization Roadmap — Unified Edition
> **Revision:** v3 — post full implementation audit
> **Stack:** TypeScript / Node.js, Gemini, GitHub, Groq, Cerebras, Mistral, NVIDIA, Cohere
> **Cache infra:** Upstash Redis (L2) + in-memory Map (L1)

---

## Status Legend

| Symbol | Meaning |
|--------|---------|
| ✅ | Fully implemented and verified in code |
| 🔧 | Partially done / has a known gap |
| 📋 | Planned, not started |
| 💡 | New finding — not in original roadmap |

---

## What Has Been Implemented (Verified)

This section is a ground-truth checklist against the actual codebase.

### Prompt Architecture
- ✅ `RULES_PAGE_GENERATION` constant consolidates all four rule sets (`RULES_ROUTE_MEMORY`, `RULES_STORY_CONSISTENCY`, `RULES_DIFFICULTY_SCALING`, `RULES_FUTURE_NOTES`)
- ✅ `buildSystemPrompt(book, state, RULES_PAGE_GENERATION)` puts all static rules in the system prompt
- ✅ `executePromptForJSON` appends `outputFormatPart` to `options.systemPrompt` — JSON schema lives in the system message, never in the user message
- ✅ Compact schema reminder for structured-output providers (2-line hint instead of full template)
- ✅ `buildSystemPrompt` state type narrowed to `Pick<StoryState, 'characters' | 'places' | 'page'>` — inventory/injuries excluded from cache key
- ✅ Static rules removed from `formatNextPageNarrativePrompt` (no duplication in user message)
- ✅ User message ordering: `[fieldInstructions] → [reviewChecklist] → [dynamicContext]` (semi-static before dynamic)

### MC State Split
- ✅ `buildBookMetaDocuments` calls `getMainCharacterInfo({mc: book.mc})` — base profile only (name, gender, age, bio). Never changes.
- ✅ `formatNextPageStoryContextPrompt` adds `getMainCharacterInfo({mc: book.mc, state: {inventory, injuries}})` to the dynamic prompt — current mutable state changes freely without touching the cache
- ✅ `cachedContentId` hash includes only `(bookId, characters, places)` — stable across most pages

### Gemini Explicit Cache
- ✅ `utils/gemini.ts` — two-layer cache (L1 in-memory Map + L2 Upstash Redis)
- ✅ `getOrCreateGeminiCache(cachedContentId, model, systemInstruction, semiStaticContext, bookId)` — creates Gemini context cache with 1-hour TTL
- ✅ Book index (`gemini:book-index:{bookId}` in Redis) — tracks current `cachedContentId` per book for stale cleanup
- ✅ Stale cleanup in `getOrCreateGeminiCache`: when `cachedContentId` changes for a known book, previous Gemini cache is deleted via API before creating the new one
- ✅ Hash-based invalidation (`prefixHash`) — content change detected even when `cachedContentId` is the same
- ✅ Minimum-length guard (8 000 chars) — skips cache creation for short prefixes that Gemini would reject
- ✅ `cachedContentId` forwarded in `generateNextPage` (line 3321) and `generateNextPages` (line 3431)
- ✅ `bookId` passed via `meta: { bookId: book.id }` in both generation paths
- ✅ `meta?.bookId` flows through `aiPrompt` → `opts` spread → `geminiPrompt` → `getOrCreateGeminiCache`
- ✅ Cache hit path: `cachedContent` passed to `generateContent`, `systemInstruction` omitted
- ✅ Cache miss path: `systemInstruction` passed in full, Gemini auto-caches it
- ✅ `invalidateGeminiCache` removed from post-generation path (no longer called after every use)

### KV Cache Retention
- ✅ `prompt_cache_retention: "24h"` on GitHub non-streaming — extends KV retention to 24 hours
- ✅ `cacheHitRate` computed in Gemini usage (`cachedContentTokenCount / promptTokenCount`), GitHub usage (`prompt_tokens_details.cached_tokens`), and Cohere usage

### Observability
- ✅ `prompt-telemetry.ts` — `estimateTokens`, `logGenerationTelemetry`
- ✅ Streaming TTFT wired in `aiStreamSSE`
- ✅ Per-provider `cacheHitRate` in usage metadata (via `logAISuccess`)
- ✅ `totalDocumentsLength` included in `aiPrompt` prompt-length validation (`totalPromptLength = systemPrompt + prompt + documents`)

### Other
- ✅ Debug SSE chunk log removed
- ✅ Gemini `systemInstruction` field used correctly (not concatenated into user content)
- ✅ `AI_CHAT_MODELS_EVALUATION` — evaluator uses separate model pool
- ✅ Multi-candidate batching — `generateNextPages` sends one AI call for N alternatives
- ✅ Background candidate pre-generation via GitHub Actions

---

## Active Gaps / Minor Issues

### 💡 Gap 1 — `mcCurrentState` always rendered even when empty

**File:** `utils/prompt.ts` line 2029–2035

When both `inventory` and `injuries` are empty (very early game), `getMainCharacterInfo({mc: book.mc, state: {inventory: [], injuries: []}})` returns just the base bio — identical to what the documents already contain. The "MAIN CHARACTER (POV)" section in the dynamic prompt becomes a bio duplicate.

**Fix — add an early-out guard:**

```ts
// Current (always renders):
const mcCurrentState = getMainCharacterInfo({mc: book.mc, state: { inventory, injuries }});

return `...
MAIN CHARACTER (POV):
${mcCurrentState}
...`;

// Fixed (only renders when there's mutable state to show):
const hasMutableState = inventory.length > 0 || injuries.length > 0;
const mcCurrentState = hasMutableState
  ? getMainCharacterInfo({mc: book.mc, state: { inventory, injuries }})
  : null;

return `...
${mcCurrentState ? `MAIN CHARACTER (POV):\n${mcCurrentState}\n` : ''}
...`;
```

**Why it matters:** In the first 2–3 pages before the MC picks anything up or gets hurt, this section silently duplicates the bio from the cached documents. Low urgency, but clean.

---

### 💡 Gap 2 — Non-streaming `aiPrompt` has no latency telemetry

**File:** `utils/ai-chat.ts`

`aiPrompt` powers all background candidate generation (`generateNextPage`, `generateNextPages`). The streaming path has TTFT logging via `logGenerationTelemetry`. The non-streaming path has no equivalent — it's a complete black box for timing.

`totalPromptLength` is already computed for the length validation gate (line 853–854). Adding timing is trivial:

```ts
// In aiPrompt, add inside the provider loop, before the switch:
const _requestStartAt = Date.now();

// After result is returned (inside the success branch, around line 88):
console.log(
  `[${provider}/${model}] ⏱ Non-stream: ${Date.now() - _requestStartAt}ms` +
  ` | prompt ~${Math.ceil(totalPromptLength / 4).toLocaleString()} tokens` +
  ` | context: ${context}`
);
```

**Why it matters:** Background generation is where the majority of wall-clock time goes (candidates are generated for all actions). Without timing data, you can't tell whether a slow session is caused by the AI call, the DB read before it, or the state reconstruction after it.

---

### 💡 Gap 3 — `cacheHitRate` not surfaced in streaming telemetry

**File:** `utils/ai-chat-stream.ts` — `logGenerationTelemetry` call

The streaming path calls `logGenerationTelemetry(...)` which logs TTFT and prompt size. But `cacheHitRate` (from `usageMetadata.cachedContentTokenCount`) is only available in the non-streaming `geminiPrompt` usage block.

In `geminiStreamGenerator`, the equivalent would be reading usage from the final streaming chunk. Most Gemini streaming responses include `usageMetadata` in the last chunk. This is slightly more involved than the non-streaming case — add it as a future enhancement.

---

## Performance Hierarchy (Current)

| Priority | Optimization | Status |
|----------|-------------|--------|
| 0 | Remove SSE chunk debug log | ✅ Done |
| 1 | Streaming TTFT telemetry | ✅ Done |
| 2 | Prompt ordering (static-first) | ✅ Done |
| 3 | Static rules → system prompt | ✅ Done |
| 4 | JSON schema → system prompt | ✅ Done |
| 5 | Compact schema for structured-output providers | ✅ Done |
| 6 | Fix Gemini `systemInstruction` field | ✅ Done |
| 7 | GitHub `prompt_cache_retention: "24h"` | ✅ Done |
| 8 | Gemini explicit cache (full chain) | ✅ Done |
| 9 | MC state split (base profile in cache / mutable in dynamic) | ✅ Done |
| 10 | Character cap (max 6 side chars + MC) | ✅ Done by design |
| 11 | `mcCurrentState` early-out guard | 💡 Minor gap |
| 12 | Non-streaming latency telemetry | 💡 Gap 2 |
| 13 | Streaming `cacheHitRate` | 💡 Gap 3 |
| 14 | Parallel action candidate generation | 📋 Not started |
| 15 | Context reduction (incremental memory updates) | 🔧 Partial |
| 16 | Provider racing | 📋 Not started |
| 17 | Evaluator model routing | 🔧 Pool exists, models unknown |
| 18 | Semantic caching (summaries) | 📋 Not started |
| 19 | Gemini cache IDs persisted to DB | 📋 Future |

---

# Phase 0: Observability
**Status: ✅ Streaming done — 🔧 Non-streaming missing**

## What's Done

`prompt-telemetry.ts` with `estimateTokens` and `logGenerationTelemetry` is implemented.
Streaming TTFT is wired into `aiStreamSSE`.

Per-provider `cacheHitRate` is computed from usage metadata:

```ts
// Gemini (ai-chat.ts):
const cacheHitRate = promptTokens && cachedTokens ? cachedTokens / promptTokens : 0;

// GitHub (ai-chat.ts):
const cachedTokens = usage.prompt_tokens_details?.cached_tokens ?? 0;
const cacheHitRate = promptTokens && cachedTokens ? cachedTokens / promptTokens : 0;
```

These flow through `logAISuccess` and appear in the usage object of every `AIResponse`.

## TTFT Quality Gate

```
Excellent:  < 1 000 ms  → ✅
Good:       < 2 000 ms  → 🟢
Acceptable: < 3 000 ms  → 🟡
Poor:       > 3 000 ms  → 🔴
```

## What's Missing

**Non-streaming timing** (Gap 2): `aiPrompt` processes all background candidate generation.
`totalPromptLength` is already computed for the length gate — it just isn't logged.
Add a `Date.now()` delta around the provider switch. Low effort, high diagnostic value.

---

# Phase 1: Prompt Architecture Refactor
**Status: ✅ Fully implemented**

## Verified Layout

### System Message (per generation type — fully cacheable)
```
[PROMPT_SYSTEM]
    Persona, writing style, page format, branching rules
    ~2 800 chars | STATIC

[RULES_PAGE_GENERATION]
    RULES_ROUTE_MEMORY
    RULES_STORY_CONSISTENCY
    RULES_DIFFICULTY_SCALING
    RULES_FUTURE_NOTES
    ~800 chars | STATIC

[outputFormatPart]
    "OUTPUT FORMAT: Respond with valid JSON. Required fields: ..."
    (compact reminder when structured output active; full schema otherwise)
    ~120 chars | STATIC per generation type

[Book documents via formatSystemPromptWithDocuments]
    BOOK META snippet (title, genre, summary, hook, language)
    MAIN CHARACTER (POV) — base profile ONLY (name, gender, age, bio)
    KNOWN CHARACTERS — side characters, sorted by recency
    KNOWN PLACES — discovered locations with status
    SEMI-STATIC per (bookId, characters, places)
```

### User Message (dynamic — changes every request)
```
[fieldInstructions]   — phase-specific field guidance    SEMI-STATIC
[reviewChecklist]     — phase-specific review steps      SEMI-STATIC
[formatNextPageStoryContextPrompt output]                DYNAMIC
    CURRENT PHASE
    MAIN CHARACTER (POV) — mutable state only (inventory, injuries)
    STORY CONTEXT (contextHistory rolling summary)
    Recent Major Events (plot flags)
    CURRENT FACTS (facts history)
    PREVIOUS PAGES (compressed)
    CURRENT PAGE + SITUATION
    ACTION SELECTION
[formatNextPageNarrativePrompt output]                   DYNAMIC
    NARRATIVE STYLE
    PSYCHOLOGICAL FLAGS + PROFILE
    HIDDEN STATE + ROUTE MEMORY
    FUTURE NOTES
    THREADS + ENDING PLAN
```

## Why MC State Is Split

The main character's base profile (name, gender, bio) belongs in the cached documents:
- It never changes across the whole story
- The Gemini context cache stores it once per `(bookId, characters, places)` state
- All page generations for the same state hit the same cache

The main character's mutable state (inventory, injuries) is in the dynamic prompt:
- Inventory and injuries change every few pages in a horror game
- Putting them in documents would invalidate the cache on every pickup or injury
- The AI needs current state for narrative accuracy, but the delivery channel (dynamic prompt) doesn't affect quality

This split means the Gemini cache stays valid for entire stretches of pages between character/place discoveries — typically 5–15 pages.

## Why Static-First Matters

LLM providers cache from the beginning of the input. Token at position 0 must be identical
across requests for any caching to occur. By placing all static content (rules, schema) in
the system message and all dynamic content at the end of the user message, the cacheable
prefix spans the majority of the input:

```
Uncacheable prefix (old):  0% (dynamic task was first)
Cacheable prefix (current): ~60–80% of total tokens
```

---

# Phase 2: Context Reduction
**Status: ✅ Stable by design — no P6 filter needed**

## What Exists

- Rolling `contextHistory` summary (AI-maintained) ✅
- `MAX_PAGE_HISTORY` limits recent full pages ✅
- `MAX_OLDER_PLOT_FLAGS` caps older compressed events ✅
- Hard cap of max 6 side characters + 1 MC via `formatCharactersForPrompt` ✅
- Characters sorted by most recent interaction ✅
- MC inventory/injuries in dynamic prompt (not cached docs) ✅

## Why No Character Relevance Filter (P6)

P6 was evaluated and dropped. With the 7-character hard cap already enforced by
`formatCharactersForPrompt`, the maximum token overhead from characters is bounded and
small (~500–1 500 tokens). More importantly, filtering out "inactive" characters
introduces a real narrative risk:

In a psychological horror branching narrative, a character who last appeared 20 pages ago
may be scheduled to re-appear with critical narrative weight (see: `futureNotes` and
`threads`). If that character was filtered from the model's context, the model would
write them as a stranger without memory of their history, appearance, or what the MC
knows about them. `futureNotes` signals the re-appearance but carries no character
detail. The inconsistency would be a story quality failure, not a minor glitch.

The sort-by-recency approach correctly surfaces the most relevant characters without
discarding any information.

---

# Phase 3: Incremental Memory
**Status: 🔧 Partially implemented**

## What Exists

`contextHistory` is updated incrementally by the main AI generation call — each page
produces an updated summary that incorporates the new events. `factsHistory`, `plotFlags`,
`traumaTags`, and `threads` all use append/delta patterns. `extractStateDelta` and
`applyStateDelta` handle state propagation. ✅

## What Could Improve (Phase 3.5) 📋

`contextHistory` is regenerated by the expensive writing model as part of every story
page output. A lightweight fast-model call after generation would decouple bookkeeping
from creative work:

```ts
// After page generation completes:
const updatedSummary = await fastModel.summarize(
  existingContextHistory + newPage.text
);
```

Not urgent — the current approach works correctly. Revisit when model tiers are clearer.

---

# Phase 4: Prompt Caching (Automatic)
**Status: ✅ All providers benefit**

All non-Gemini providers receive a system message that is identical across every
story page generation of the same type. This enables whatever automatic caching each
provider implements:

| Provider   | Mechanism | Status |
|------------|-----------|--------|
| Gemini     | `systemInstruction` auto-cache + explicit cache | ✅ Both active |
| GitHub     | Auto prompt cache + `prompt_cache_retention: "24h"` | ✅ |
| Groq       | Internal auto-cache | ✅ Benefits from static system prompt |
| Cerebras   | Speed-focused, minimal cache | ✅ Benefits from system prompt fix |
| Mistral    | Limited auto-cache | ✅ Benefits |
| NVIDIA NIM | Deployment-dependent | ✅ Benefits |
| Cohere     | Very limited | ✅ `cacheHitRate` tracked in usage |

---

# Phase 4.5: KV Cache Retention + Explicit Caching
**Status: ✅ Fully implemented**

## Three Cache Layers (all active)

| Layer | Mechanism | Status |
|-------|-----------|--------|
| Prompt ordering | Static-first layout | ✅ |
| Automatic prompt cache | Provider-side (system msg matching) | ✅ |
| KV retention | GitHub `prompt_cache_retention: "24h"` | ✅ |
| Explicit context cache | Gemini `ai.caches.create()` | ✅ |

## Gemini Explicit Cache — Full Flow

### What Is Cached

```
systemInstruction: PROMPT_SYSTEM + RULES_PAGE_GENERATION + outputFormatPart
semiStaticContext: BOOK META + MC base profile + KNOWN CHARACTERS + KNOWN PLACES
```

These are the two arguments to `getOrCreateGeminiCache`. Together they form the
stable prefix that Gemini stores server-side and reuses across requests.

### Key Design Decisions

**`cachedContentId` = hash of `(bookId, characters, places)`**

Chosen because characters and places are the semi-static book state. They change
when the story world expands, but not on every page. Inventory and injuries were
explicitly excluded — they change too frequently and don't affect the cached content
(they live in the dynamic prompt instead).

**Two-layer cache storage:**

```
L1: in-memory Map (l1Cache, l1BookIndex)
    → Zero I/O within a warm serverless instance
    → Resets on cold start

L2: Redis (redisEntryKey, redisBookIndexKey)
    → Persists across cold starts and instance recycling
    → Single network hop (~1 ms Upstash roundtrip)
    → TTL: entry = 3 900 s (1 hr + 5 min buffer), book index = 28 800 s (8 hrs)
```

**Read path:** L1 → L2 → Gemini API (create new cache)

**Write path:** Gemini API → L2 → L1
(L2 written before L1 so other instances see the entry even if this instance
crashes between writes)

**Book-scoped stale cleanup:**

```ts
// In getOrCreateGeminiCache, when bookId is provided:
const previousId = await readBookIndex(bookId);
if (previousId && previousId !== cachedContentId) {
  // Characters or places changed — old cache is now stale
  await gemini.caches.delete({ name: previousEntry.cacheId }); // best-effort
  await removeEntry(previousId);
}
// Then create new cache and update book index
```

This runs when `cachedContentId` changes — i.e., when characters or places are
updated. Deletion is best-effort: if the Gemini API call fails, we log a warning,
evict from L1/L2, and continue. The orphaned cache on Google's side will expire
via its own 1-hour TTL.

**Why cleanup is inside `getOrCreateGeminiCache`, not after generation:**

Stale cleanup happens at the moment a NEW cache is needed for the same book.
At that point the old cache is definitively no longer needed (the state that
required it has already been superseded). Doing it after generation would mean:
- The new state S2 cache was just used → success
- We then try to find and delete the old S1 cache
- But we have no reference to the old `cachedContentId` at that point

Putting cleanup inside `getOrCreateGeminiCache` gives us the old `cachedContentId`
naturally (from the book index lookup), at exactly the right moment.

**Why NOT delete after every successful generation:**

The sole purpose of the cache is REUSE. Deleting after use means:
```
Every request: CREATE cache (300–800 ms) → generate → DELETE cache
```
Which is strictly worse than no caching at all. The correct lifecycle is:
```
Request 1 (state S1):  miss → CREATE → generate → KEEP
Requests 2–N (state S1): L1/L2 hit → generate (no Gemini API overhead)
State changes to S2:   new cachedContentId → cleanup S1 cache → CREATE S2 → …
```

### Cache Hit Pattern

```
Pages 1–4 (no new chars/places):
  Page 1: L1 miss, L2 miss → CREATE Gemini cache (one-time cost)
  Pages 2–4: L1 hit → zero overhead

Page 5 (new character introduced):
  cachedContentId changes → stale cleanup of page 1–4 cache → CREATE new cache

Pages 5–10 (no further discoveries):
  L1/L2 hits → zero overhead

Page 11 (new location discovered):
  Same cycle
```

MC picks up items and gets injured freely throughout — zero cache impact.

### Expected Reduction

For `generateNextPages` (N-candidate batch), all N candidates share the same
`cachedContentId` (same game state). The first call in a cold L1 creates the
Gemini cache; subsequent candidates reuse it:

```
Without caching:  N × (prefix_tokens)  processed
With caching:     1 × (prefix_tokens) + N × (suffix_tokens)
Typical ratio:    prefix ~12 000 tokens, suffix ~500 tokens
Reduction:        ~63% for N=3
```

---

# Phase 5: Parallel Generation
**Status: ✅ Within-action batched — 📋 Across-action parallelism not started**

## What's Done

`generateNextPages(params, candidateCount)` generates N alternatives in a single
AI call using `multiNextPageOutputFormat`. This is correct for rate-limited free
providers — the shared prefix is processed once and N outputs are returned.

## What's Missing

`generateCandidatePages` is called per-action sequentially. For a page with 3 actions:

```
Sequential (current):
  generate candidates for action A  →  ~8 s
  generate candidates for action B  →  ~8 s (waits for A)
  generate candidates for action C  →  ~8 s (waits for B)
  Total wall-clock: ~24 s

Parallel (target):
  generate A, B, C simultaneously
  Total wall-clock: ~8 s
```

These calls are independent — different selected actions mean different prompts.
`Promise.allSettled` is the right tool:

```ts
await Promise.allSettled(
  page.actions.map(action =>
    generateCandidatePages({ ...params, actionedPage: { ...page, action } })
  )
);
```

**Caveat:** All three calls may hit the same Gemini cache key (same `cachedContentId`)
simultaneously. The first call will miss L1 and L2 and attempt to create a Gemini cache.
The second and third calls will race to the same empty L1/L2 and also attempt creation.
This causes a brief cache-creation race at cold start. Mitigations:
- Gemini cache creation is idempotent for the same content (creates a new resource each
  time, but only one will win the L2 write due to Redis `SET`'s last-write-wins)
- The worst case is two extra Gemini cache objects that expire in an hour
- Use Redis `SET NX` (set if not exists) on the L2 write to make it race-safe

---

# Phase 6: Provider Racing
**Status: 📋 Not started**

## Goal

Run two providers simultaneously and use the first valid response. Best for
high-stakes generations where tail latency is unacceptable.

```ts
const result = await Promise.any([
  generateWithGemini(prompt, opts),
  generateWithGroq(prompt, opts),
]);
```

**Use only for:** Book creation, finale pages, first page of a story.
**Never for:** Background candidate generation (wastes API quota).

---

# Phase 7: Dynamic Model Routing
**Status: 🔧 Evaluation pool exists — composition unknown**

## What Exists

`AI_CHAT_MODELS_EVALUATION` is a separate model selection pool used exclusively for
evaluator calls in `aiPrompt` (line 909). The evaluator re-reads the full story context
plus the generated page — structurally identical to a generation call. Routing it to
fast models (Gemini Flash, Groq Llama 8B) would halve the cost and latency of every
evaluated generation.

The infrastructure is correct. The key question is what models populate
`AI_CHAT_MODELS_EVALUATION`. If they're the same expensive models as
`AI_CHAT_MODELS_WRITING`, no benefit is gained.

## Suggested Tier Mapping

```
Fast tier (utility tasks):
  Models:  Gemini 2.0 Flash, Groq Llama 3.1 8B, Cerebras Llama 3.1 8B
  Tasks:   Evaluator scoring, contextHistory summarization (Phase 3.5)

Standard tier (story pages):
  Models:  Groq Llama 3.3 70B, Gemini 2.5 Flash, Mistral Large
  Tasks:   Normal story page generation

Premium tier (critical moments):
  Models:  Best available (Gemini Pro, etc.)
  Tasks:   Book initialization, finale pages, book creation evaluator
```

---

# Phase 8: Semantic Caching
**Status: 📋 Not started**

## Goal

Cache outputs of deterministic utility operations to avoid re-running identical AI calls.

## Suitable Tasks

```
contextHistory summarization (same state → same output)
Tag/keyword generation
Book metadata generation
```

## Never Cache

```
Story page generation — must always be fresh (branching narrative)
Choice/action generation — must always be fresh
```

Implementation sketch using the existing `withCache` from `services/cache.ts`:

```ts
async function cachedContextSummary(
  storyId: string,
  contentHash: string,
  generateFn: () => Promise<string>
): Promise<string> {
  return withCache(
    `story:context-summary:${storyId}:${contentHash}`,
    generateFn,
    CACHE_TTL.LONG  // e.g. 24 hours
  );
}
```

---

# Phase 9: Streaming
**Status: ✅ Fully implemented**

SSE streaming is complete with TTFT measurement, AbortSignal cancellation,
backpressure handling, and start/end/error events.

---

# Phase 10: Background Pre-Generation
**Status: 🔧 Partially implemented**

## What Exists

`triggerCandidateGenerationWorkflow` fires after book creation. `MAX_BRANCHING_PREGENERATION_DEPTH`
controls recursive pre-generation depth.

## What's Missing

- Confirmed trigger after every user page selection (not only after book creation)
- Parallel across-action candidate generation (Phase 5 prerequisite)
- Confidence-based speculative generation

---

# Implementation Order (Remaining Work)

## Immediate (trivial)
1. `mcCurrentState` early-out guard (Gap 1) — 3 lines
2. Non-streaming timing log in `aiPrompt` (Gap 2) — 3 lines

## Short-term
3. Parallel across-action candidate generation (Phase 5) — `Promise.allSettled`; add Redis `SET NX` guard for race safety
4. Verify `AI_CHAT_MODELS_EVALUATION` uses fast models (Phase 7)

## Medium-term
5. Persist Gemini cache IDs to DB/Redis for cross-cold-start durability (Phase 4.5 enhancement)
6. `cacheHitRate` in streaming telemetry (Gap 3)

## Long-term
7. Semantic caching for summaries (Phase 8)
8. Provider racing for book creation / finale (Phase 6)
9. Fast-model contextHistory summarization (Phase 3.5)

---

# Appendix A: Gemini Cache Key Design

```
cachedContentId = createCacheKey([bookId, characters, places])
```

| Field | In cachedContentId? | Rationale |
|-------|-------------------|-----------|
| `bookId` | ✅ | Scopes cache to one book |
| `characters` | ✅ | Side chars appear in cached documents |
| `places` | ✅ | Places appear in cached documents |
| `inventory` | ❌ | In dynamic prompt, not documents |
| `injuries` | ❌ | In dynamic prompt, not documents |
| `page number` | ❌ | Not in cached content |

## Redis Key Scheme

```
gemini:content-cache:{cachedContentId}  → GeminiCacheEntry   TTL: 3 900 s
gemini:book-index:{bookId}              → cachedContentId    TTL: 28 800 s
```

## Full Lifecycle Table

| Event | cachedContentId | Action |
|-------|----------------|--------|
| First page of new book | New hash | Create Gemini cache; write L2 + L1; write book index |
| Same page, same state | Same hash | L1 hit → return existing cacheId |
| Cold start (Vercel) | Same hash | L1 empty → L2 hit → populate L1; no Gemini API call |
| New character introduced | Hash changes | Read book index → evict old from L2+L1+Gemini → create new cache |
| MC picks up item | Hash unchanged | No cache change (inventory excluded from hash) |
| MC gets injured | Hash unchanged | No cache change (injuries excluded from hash) |
| Redis unavailable | Any | getFromCache returns miss → create Gemini cache; skip L2 write |
| Gemini cache TTL expires | Same hash | `expiresAt` check fails → create new cache; overwrite entry |
| Book deleted | Any | Call `invalidateGeminiCache(cachedContentId)` explicitly |

---

# Appendix B: Provider Reference

| Provider | Structured output | Prompt cache | KV retention | Explicit cache |
|----------|------------------|-------------|-------------|---------------|
| Gemini | ✅ `responseJsonSchema` | ✅ `systemInstruction` auto | — | ✅ `ai.caches.create()` |
| GitHub | ✅ `response_format` | ✅ auto | ✅ `prompt_cache_retention` | — |
| Groq | ✅ `response_format` | ✅ internal | — | — |
| Cerebras | ✅ `response_format` | Limited | — | — |
| Mistral | ✅ `response_format` | Limited | — | — |
| NVIDIA | ❌ prompt-only | Depends on deployment | — | — |
| Cohere | ❌ prompt-only | Very limited | — | — |

---

# Sources

- https://latitude.so/blog/latency-optimization-in-llm-streaming-key-techniques
- https://redis.io/blog/what-is-prompt-caching/
- Code audit: `utils/prompt.ts`, `utils/ai-chat.ts`, `utils/ai-chat-stream.ts`, `utils/gemini.ts`, `utils/characters.ts`
