# Twistloom LLM Optimization Roadmap — Unified Edition
> **Last updated:** post-implementation audit (v2)

---

## Status Legend

| Symbol | Meaning |
|--------|---------|
| ✅ | Fully implemented and verified |
| 🔧 | Partially implemented / has a known issue |
| 📋 | Planned, not started |
| ⚠️ | Bug or anti-pattern found — action needed |
| 💡 | New finding not in original roadmap |

---

## Executive Summary

The goal of this roadmap is not merely to make AI generations faster.

The ultimate objectives are:

1. **Reduce perceived latency** for readers — the feeling of waiting.
2. **Reduce actual generation latency** — raw speed.
3. **Reduce prompt token usage** — cost and throughput.
4. **Increase generation reliability** — fewer failures, better fallback.
5. **Improve scalability** across free LLM providers.
6. **Enable near-instant page delivery** through pre-generation.

The most important realization is that **provider and model selection is only a small part of performance**.

For Twistloom, the largest gains come from:

- Fixing prompt ordering (static content before dynamic)
- Context reduction
- Prompt caching (both automatic and explicit)
- Incremental memory management
- Parallel generation
- Background pre-generation

These improvements compound together and can reduce perceived latency by over 90%.

---

## What's Already Implemented ✅

The following have been fully verified in the codebase:

- **Multi-provider fallback chain** — `aiStreamSSE` and `aiPrompt` try all providers and models sequentially.
- **Rate limiting** — `getRateLimiter(provider).throttle()` before every call.
- **AbortSignal support** — Full cancellation threading through streaming path.
- **Background candidate pre-generation** — `triggerCandidateGenerationWorkflow` fires on book creation; `MAX_BRANCHING_PREGENERATION_DEPTH` controls depth.
- **Batched multi-candidate generation** — `generateNextPages` sends one AI call producing N alternatives.
- **Rolling `contextHistory`** — AI-maintained summary caps context growth.
- **Plot flag compression** — `formatPreviousPagesForPrompt` compresses older pages to flags; drops old minor events.
- **Dynamic AI config** — `determineAIConfig(state, action)` adjusts sampling per phase/action type.
- **JSON schema via API params** — `response_format: { type: "json_schema" }` for GitHub, Groq, Cerebras, Mistral, Gemini.
- **Prompt length gate** — `AI_MAX_PROMPT_LENGTH[provider]` skips providers on oversize prompts.
- **TTFT + telemetry** (`prompt-telemetry.ts`) ✅ — `logGenerationTelemetry` wired into `aiStreamSSE`.
- **`RULES_PAGE_GENERATION` in system prompt** ✅ — `RULES_ROUTE_MEMORY`, `RULES_STORY_CONSISTENCY`, `RULES_DIFFICULTY_SCALING`, `RULES_FUTURE_NOTES` all consolidated into `RULES_PAGE_GENERATION` constant and injected via `buildSystemPrompt(book, state, RULES_PAGE_GENERATION)`.
- **JSON schema moved to system prompt** ✅ — `executePromptForJSON` appends `outputFormatPart` to `options.systemPrompt`; schema no longer appended to user message.
- **Compact schema for structured-output providers** ✅ — When `configs.schema && configs.requiredFields` are set, sends a 2-line reminder instead of the full JSON template, saving ~1 000–2 000 tokens per request.
- **Gemini `systemInstruction` field** ✅ — Both `geminiPrompt` (non-streaming) and `geminiStreamGenerator` (streaming) now use `systemInstruction: { parts: [{ text: ... }] }` correctly.
- **GitHub `prompt_cache_retention: "24h"`** ✅ — KV cache retention param wired into `githubPrompt`. This is Phase 4.5 for GitHub.
- **`gemini.ts` cache module** ✅ — Full explicit Gemini context cache with `getOrCreateGeminiCache`, hash-based invalidation, 1-hour TTL, and minimum-length guard.
- **`AI_CHAT_MODELS_EVALUATION`** ✅ — Evaluator uses a separate model pool from the writing pool.
- **Debug SSE chunk log removed** ✅ — The per-token `console.log` that fired 1 000+ times per response is gone.

---

## Active Bugs Found in Audit ⚠️

### ⚠️ Bug 1 — CRITICAL: Gemini Explicit Cache Never Actually Fires

**File:** `utils/prompt.ts` — `generateNextPage` and `generateNextPages`

`buildSystemPrompt()` returns an object with `{ systemPrompt, documents, cachedContentId }`.
`prepareNextPageGenerationSetup` spreads it with `...systemPromptWithDocuments`.
**But `cachedContentId` is never destructured** and therefore never passed to `executePromptForJSON`:

```ts
// prepareNextPageGenerationSetup return:
return {
  ...systemPromptWithDocuments, // contains cachedContentId ← buried here
  prompt,
  systemPrompt, // explicitly extracted ✅
  documents,    // explicitly extracted ✅
  config,
  ...
};

// generateNextPage destructure — cachedContentId silently DROPPED:
const { prompt, config, systemPrompt, documents, fieldInstructions, ... }
  = await prepareNextPageGenerationSetup(params, 1);

// baseOptions passed to executePromptForJSON — NO cachedContentId:
baseOptions: {
  config,
  modelSelection: AI_CHAT_MODELS_WRITING,
  context: 'story-page-candidate',
  systemPrompt,
  documents,
  // cachedContentId: ??? ← never here
}
```

**Result:** `geminiPrompt` and `geminiStreamGenerator` always see `cachedContentId = undefined`. `getOrCreateGeminiCache` is never called for story page generation. The entire Gemini cache system is dead code in the main generation paths.

**Fix — two-line change in `generateNextPage` and `generateNextPages`:**

```ts
// In generateNextPage — change destructure:
const { prompt, config, systemPrompt, documents, cachedContentId,
        fieldInstructions, thinkThenOutput, evaluatorPrompt,
        generationContext, advancedState, currentState, expectedPageNumber, action }
  = await prepareNextPageGenerationSetup(params, 1);

// Then pass it in baseOptions:
baseOptions: {
  config,
  modelSelection: AI_CHAT_MODELS_WRITING,
  context: 'story-page-candidate',
  logPrompts: true,
  systemPrompt,
  documents,
  cachedContentId, // ← add this
}
```

Apply the same fix to `generateNextPages` (line ~3483).

---

### ⚠️ Bug 2 — MEDIUM: Gemini Cache Entries Accumulate Without Cleanup

**File:** `utils/gemini.ts`

`cachedContentId` is computed from `createCacheKey([bookId, characters, places])`. Every time a character is introduced or a place is updated (which happens on most page generations), `cachedContentId` changes → a new Gemini cache entry is created → the old entry is **never deleted**. 

Over a 40-page story with 8 characters, this could create 10–20 Gemini cache entries for the same book, each wasting storage on Gemini's side and accumulating forever in `contentCacheMap`.

**Fix — book-scoped cleanup in `getOrCreateGeminiCache`:**

The cleanest solution is to track a reverse index from `bookId` to the current `cachedContentId`, so old entries can be cleaned up when a new cache is created for the same book:

```ts
// In gemini.ts, add a reverse index:
const bookCacheIndex = new Map<string, string>(); // bookId → current cachedContentId

export async function getOrCreateGeminiCache(
  cachedContentId: string,
  model: string,
  systemInstruction: string,
  semiStaticContext: string,
  bookId?: string, // ← add optional bookId parameter
): Promise<string | null> {
  // ... existing validity check ...

  // Before creating a new cache, clean up the previous one for this book
  if (bookId) {
    const previousCachedContentId = bookCacheIndex.get(bookId);
    if (previousCachedContentId && previousCachedContentId !== cachedContentId) {
      const previous = contentCacheMap.get(previousCachedContentId);
      if (previous?.cacheId) {
        await ai.caches.delete({ name: previous.cacheId }).catch(() => {}); // best-effort
        contentCacheMap.delete(previousCachedContentId);
      }
    }
  }

  // ... create new cache as before ...

  if (bookId) bookCacheIndex.set(bookId, cachedContentId);
  return cache.name;
}
```

Then pass `book.id` through the chain from `buildSystemPrompt` → `baseOptions` → `geminiPrompt`.

> **Serverless note:** In serverless environments (Vercel), `contentCacheMap` resets on each cold start. The memory leak is only a concern for persistent server deployments. However, the Gemini-side cache accumulation (orphaned caches on Google's servers) applies in all environments.

---

### ⚠️ Bug 3 — MINOR: `promptChars` Telemetry Underestimates Actual Size

**File:** `utils/ai-chat-stream.ts` line 185

```ts
// Current — misses documents:
const promptChars = (options.systemPrompt?.length ?? 0) + prompt.length;

// Fix — include documents (same pattern used in aiPrompt for prompt-length gating):
const totalDocumentsLength = options.documents?.reduce(
  (sum, doc) => sum + (doc.title?.length ?? 0) + doc.snippet.length, 0
) ?? 0;
const promptChars = (options.systemPrompt?.length ?? 0) + prompt.length + totalDocumentsLength;
```

Documents include BOOK META + KNOWN CHARACTERS + KNOWN PLACES and can add 2 000–8 000+ chars to the actual prompt. Without them, the "estimated tokens" log is systematically low, which makes it unreliable for planning.

---

## Performance Hierarchy

| Priority | Optimization                          | Impact         | Status           |
|----------|---------------------------------------|----------------|------------------|
| 0        | Fix SSE chunk debug log               | Critical       | ✅ Done          |
| 1        | TTFT + prompt size telemetry          | Observability  | ✅ Done (minor issue) |
| 2        | Prompt ordering (static-first)        | Extremely High | ✅ Done          |
| 3        | Static rules → system prompt          | Extremely High | ✅ Done          |
| 4        | JSON schema → system prompt           | High           | ✅ Done          |
| 5        | Compact schema for structured output  | High (tokens)  | ✅ Done          |
| 6        | Fix Gemini `systemInstruction`        | High (cache)   | ✅ Done          |
| 7        | GitHub KV retention (`prompt_cache_retention: "24h"`) | Medium-High | ✅ Done |
| 8        | Gemini explicit cache module          | Medium-High    | 🔧 Built, but not wired (Bug 1) |
| 9        | Context reduction                     | Extremely High | 🔧 Partial       |
| 10       | Incremental memory (delta updates)    | Extremely High | 🔧 Partial       |
| 11       | Parallel action candidate generation  | High           | 📋 Not started   |
| 12       | Provider racing                       | Medium-High    | 📋 Not started   |
| 13       | Character relevance filter            | Medium         | 📋 Not started   |
| 14       | Dynamic model routing (evaluator)     | Medium         | 🔧 Has separate pool |
| 15       | Semantic caching                      | Medium         | 📋 Not started   |

---

# Phase 0: Establish Observability
**Status: ✅ Implemented (minor fix needed)**

## What's Done

`prompt-telemetry.ts` exists with `estimateTokens` and `logGenerationTelemetry`. TTFT tracking
is wired into `aiStreamSSE`:

- `requestStartedAt = Date.now()` before the stream starts.
- `firstTokenAt` captured on the first non-empty chunk.
- `logGenerationTelemetry(...)` called on stream completion.

## TTFT Quality Gate (in telemetry)

```
Excellent:  < 1 000 ms  → ✅
Good:       < 2 000 ms  → 🟢
Acceptable: < 3 000 ms  → 🟡
Poor:       > 3 000 ms  → 🔴
```

## Remaining: Fix `promptChars` underestimate (Bug 3)

See Bug 3 above. The `documents` field is not counted in the telemetry's `promptChars`.
Documents can add 2 000–8 000+ chars. Fix is a one-liner.

## What Telemetry Does NOT Yet Cover

- `aiPrompt` (non-streaming) has no TTFT measurement. Non-streaming is used for all background candidate generation — this is where the most wall-clock time actually goes.
- No cache hit reporting (Groq/Gemini provide `cached_tokens` in usage, but it's not surfaced in `logGenerationTelemetry`).

```ts
// Future enhancement — log cache hit rate from Gemini usage:
const cachedTokens = response.usageMetadata?.cachedContentTokenCount ?? 0;
const promptTokens = response.usageMetadata?.promptTokenCount ?? 0;
const cacheHitRate = promptTokens > 0 ? cachedTokens / promptTokens : 0;
```

---

# Phase 1: Prompt Architecture Refactor
**Status: ✅ Fully implemented**

## What Was Done

All four phases of the prompt ordering fix are complete:

**`RULES_PAGE_GENERATION` constant** — `RULES_ROUTE_MEMORY`, `RULES_STORY_CONSISTENCY`,
`RULES_DIFFICULTY_SCALING`, and `RULES_FUTURE_NOTES` are joined into a single constant
and passed to `buildSystemPrompt` as `staticRules`.

**`buildSystemPrompt(book, state, staticRules)`** — signature now accepts optional `staticRules`
and appends them to `PROMPT_SYSTEM`. The resulting system prompt is:
```
PROMPT_SYSTEM
+ RULES_PAGE_GENERATION (static)
+ outputFormatPart (static — appended by executePromptForJSON)
```

**`formatNextPageNarrativePrompt`** — all four `RULES_*` constants have been removed from
the user message. No duplication.

**`executePromptForJSON` prompt ordering** — user message is now:
```
[Semi-static] fieldInstructions  (changes by story phase)
[Semi-static] thinkThenOutput    (changes by story phase)
[Dynamic]     prompt             (changes every request)
```
This is actually better than the ordering I originally recommended — instructions before
context is the industry standard for prompt caching.

## What "HARD RULES" in User Message Means

The 4-line `HARD RULES:` block at the top of `formatNextPageStoryContextPrompt` remains
in the user message. These are technically static, but they're short (~200 chars) and
contextually correct at the start of the dynamic context section — their impact on cache
hits is negligible. Low priority to move.

---

# Phase 2: Context Reduction
**Status: 🔧 Partially implemented**

## What Already Exists

- `contextHistory` — rolling AI-maintained summary ✅
- `formatPreviousPagesForPrompt` — limits to `MAX_PAGE_HISTORY` recent pages, compresses older ones ✅
- `MAX_OLDER_PLOT_FLAGS` — caps older plot flags ✅

## What's Missing

### Character Relevance Filter (P6) 📋

All characters from `state.characters` are formatted and sent every generation, even if they
last appeared 30 pages ago and have no active narrative flags. On a long story with 8+ characters,
this can be 1 500–4 000 extra tokens per request.

**Implementation:** A filter that keeps characters that are: in the current scene, introduced
recently (within last N pages), have active narrative flags (`isMissing`, `isSuspicious`,
`hasSecret`), or are mentioned in recent plot flags.

```ts
export function filterRelevantCharacters(
  characters: Record<string, CharacterMemory>,
  currentPage: CandidateGenerationPage,
  state: StoryState,
  recentPageWindow: number = 5,
): Record<string, CharacterMemory> {
  const threshold = state.page - recentPageWindow;
  const presentNames = new Set(currentPage.charactersPresent ?? []);
  const recentFlagText = state.plotFlags
    .filter(f => f.page >= threshold)
    .map(f => f.fact)
    .join(' ');

  return Object.fromEntries(
    Object.entries(characters).filter(([name, char]) =>
      presentNames.has(name) ||
      (char.introducedAtPage ?? 0) >= threshold ||
      char.narrativeFlags?.isMissing ||
      char.narrativeFlags?.isSuspicious ||
      char.narrativeFlags?.hasSecret ||
      char.status === 'active' ||
      recentFlagText.includes(name)
    )
  );
}
```

---

# Phase 3: Incremental Memory System
**Status: 🔧 Partially implemented**

## What Already Exists

- `contextHistory` is updated incrementally by the AI on each generation ✅
- `factsHistory`, `plotFlags`, `traumaTags`, `threads` all use append/delta patterns ✅
- `extractStateDelta` and `applyStateDelta` exist for state propagation ✅

## What Could Improve

`contextHistory` is generated by the same expensive writing model as part of the story page
output. A separate lightweight model call for summarization after generation would decouple
creative work from bookkeeping. This is a future Phase 3.5 item.

---

# Phase 4: Prompt Caching Optimization
**Status: ✅ Implemented for all providers**

## Current System Prompt Structure (verified)

Every story page generation builds a system prompt of:
```
PROMPT_SYSTEM (persona + writing style)
+ RULES_PAGE_GENERATION (4 rule sets)
+ "OUTPUT FORMAT: Respond with valid JSON..." (compact reminder)
```

This system prompt is identical for every page of the same generation type — making it
fully cacheable by every provider's automatic system-message cache.

## Provider Status

| Provider   | Caching mechanism             | Status       |
|------------|-------------------------------|--------------|
| GitHub     | Auto + `prompt_cache_retention: "24h"` | ✅ Best coverage |
| Gemini     | Auto (system instruction) + explicit | 🔧 System instruction ✅, explicit cache wired but Bug 1 |
| Groq       | Automatic (internal)          | ✅ Benefits from system prompt fix |
| Cerebras   | Speed-focused, minimal cache  | ✅ Benefits from system prompt fix |
| Mistral    | Limited automatic             | ✅ Benefits from system prompt fix |
| NVIDIA NIM | Deployment-dependent          | ✅ Benefits from system prompt fix |
| Cohere     | Very limited                  | ✅ Benefits from system prompt fix |

---

# Phase 4.5: KV Cache Retention
**Status: 🔧 GitHub ✅, Gemini wired but not active (Bug 1)**

## Three Layers of Caching

Understanding the difference matters:

| Layer | What it saves | Who controls it |
|-------|--------------|-----------------|
| **Prompt ordering** | Maximizes cache hit surface | You |
| **Prompt caching** | Skips re-tokenizing the prefix | Provider |
| **KV Cache Retention** | Skips re-building attention matrices | Provider |

KV retention goes one step deeper than prompt caching. The transformer's most expensive
operation is building the Key-Value attention matrices for your prefix tokens. With KV
retention, those matrices are stored after the first request and reused — the model only
processes the new tokens at the suffix.

## GitHub — `prompt_cache_retention: "24h"` ✅

```ts
// In githubPrompt — already implemented:
prompt_cache_retention: "24h",
```

This instructs OpenAI/GitHub to retain the computed KV state for the prompt for 24 hours.
For Twistloom, this means the expensive system prompt computation is cached across all story
page generations for an entire day.

## Gemini — Explicit Cache ✅ (module built) / ⚠️ Not active (Bug 1)

`gemini.ts` implements `getOrCreateGeminiCache` correctly. It:
- Accepts `(cachedContentId, model, systemInstruction, semiStaticContext)`
- Creates a Gemini context cache with 1-hour TTL
- Uses hash-based invalidation — if content changes, creates a new cache
- Falls back gracefully if prefix is too short or creation fails

The logic for deciding WHAT to cache is correct:
- `systemInstruction`: the full system prompt (PROMPT_SYSTEM + rules + schema) — static
- `semiStaticContext`: formatted documents (BOOK META + KNOWN CHARACTERS + KNOWN PLACES) — semi-static per book

**The only problem is Bug 1 (cachedContentId never forwarded).** Fix that single bug and the
entire Gemini explicit cache becomes active for all story page generations.

## Why Twistloom Is an Ideal KV Workload

`generateNextPages` generates N alternatives from the same prefix. Without KV retention:
```
N candidates × 12 000 token prefix = 36 000 prefix tokens processed (for N=3)
```
With KV retention:
```
1 × 12 000 token prefix + N × suffix ≈ 12 000 + 3 × 500 = 13 500 tokens processed
```
~63% reduction in prefix processing for a 3-candidate batch.

---

# Phase 5: Parallel Generation Architecture
**Status: ✅ Batched (within-action), 📋 Not started (across-actions)**

## What's Done

`generateNextPages` batches multiple candidates in a single AI call with `multiNextPageOutputFormat`.
This is the correct approach for rate-limited free providers — it processes the shared prefix once.

## What's Missing — Parallel Across Actions

Currently, candidate generation for each ACTION is sequential. For a page with 3 actions,
this means:

```
generate candidates for action A  →  ~8s
then generate for action B        →  ~8s
then generate for action C        →  ~8s
────────────────────────────────────
Total wall-clock:                    ~24s
```

These three calls share NO common prefix (each uses a different selected action) and can be
parallelized:

```ts
// In whatever calls generateNextPages per-action:
await Promise.allSettled(
  page.actions.map(action => 
    generateNextPages({ ...params, actionedPage: { ...page, action } })
  )
);
// Wall-clock: ~8s (all three in parallel)
```

---

# Phase 6: Provider Racing
**Status: 📋 Not started**

## Goal

Reduce tail latency by racing two providers simultaneously and using the first valid response.

```ts
const result = await Promise.any([
  generateWithGemini(prompt, opts),
  generateWithGroq(prompt, opts),
]);
```

## When to Use

Only for premium moments (book creation, finale pages) where the user is actively waiting.
Do NOT race for background candidate generation — wastes API quota.

---

# Phase 7: Dynamic Model Routing
**Status: 🔧 Has separate evaluation pool, story generation pool is uniform**

## What Exists

`AI_CHAT_MODELS_EVALUATION` — evaluator calls use a separate model selection pool. The actual
models in this pool aren't visible in the uploaded files, but the infrastructure for routing
evaluator calls to different (potentially faster) models already exists. ✅

## What's Missing

Story generation always uses `AI_CHAT_MODELS_WRITING`. There's no routing based on task type:

```ts
// Opportunity — use fast models for utility tasks:
// contextHistory summarization  →  Gemini Flash / Groq 8B
// tag generation                →  Gemini Flash
// evaluator scoring             →  AI_CHAT_MODELS_EVALUATION (already done ✅)
// story page generation         →  AI_CHAT_MODELS_WRITING (current)
// book creation / finale pages  →  best available model
```

---

# Phase 8: Semantic Caching
**Status: 📋 Not started**

## Goal

Avoid re-running identical or near-identical utility operations.

## Suitable Tasks

```
contextHistory summarization (same state → same output)
Tag/keyword generation
Book metadata generation
```

## Not Suitable

```
Story page generation — must always be fresh
Choice generation — must always be fresh
```

Never cache creative outputs. Only deterministic/near-deterministic utility outputs.

---

# Phase 9: Streaming Optimization
**Status: ✅ Implemented**

SSE streaming is fully operational with:
- Token-by-token delivery
- TTFT measurement
- AbortSignal cancellation
- Backpressure handling
- Start/end/error events

---

# Phase 10: Background Pre-Generation
**Status: 🔧 Partially implemented**

## What's Done

- `triggerCandidateGenerationWorkflow` fires after book creation (fire-and-forget) ✅
- `MAX_BRANCHING_PREGENERATION_DEPTH` controls recursive depth ✅

## What's Missing

- Pre-generation is not confirmed to fire after every USER PAGE SELECTION (only after book creation in the visible code)
- No confidence-based speculative generation
- No per-session warmup

---

# Recommended Implementation Order (Updated)

## Immediate (this week) — Bug fixes

1. **Fix Bug 1** — add `cachedContentId` to destructure in `generateNextPage` + `generateNextPages` (2-line fix, activates all Gemini caching immediately)
2. **Fix Bug 3** — add documents to `promptChars` in telemetry (1-line fix, fixes observability)
3. **Fix Bug 2** — add book-scoped cleanup in `getOrCreateGeminiCache` (prevents orphaned caches)

## Short-term (next 2 weeks)

4. **P6** — Character relevance filter (reduces tokens for long stories)
5. **Parallel action candidate generation** — `Promise.allSettled` across actions (3× speed for candidate pre-generation)
6. **Non-streaming telemetry** — add `aiPrompt` TTFT/size logging (background generation is currently a black box)

## Medium-term (next month)

7. **Persist `cachedContentId`/Gemini cache ID in DB** — allows cache reuse across serverless cold starts and server restarts
8. **Provider racing for book creation** — race Gemini + Groq for the expensive book initialization call
9. **Fast model for evaluator** — confirm/set `AI_CHAT_MODELS_EVALUATION` to fast models (Gemini Flash, Groq 8B)

## Long-term

10. Semantic caching for summaries
11. Confidence-based speculative pre-generation
12. Phase 7 full model tiering

---

# Success Criteria

```
Prompt tokens per story page:
  Target: < 4 000
  Current (estimated, pre-fix): 6 000–14 000

TTFT:
  Excellent: < 1 000 ms
  Acceptable: < 2 500 ms

Cache hit rate (Gemini, after Bug 1 fixed):
  Target: > 60% on system/document tokens
  Current: 0% (Bug 1)

Cache hit rate (GitHub):
  Passive via prompt_cache_retention: "24h" — active for all requests

Pre-generated branch load time:
  Target: < 300 ms (from DB, no AI call)

Candidate generation (3 actions × 2 candidates):
  Sequential (current): ~24–48 seconds
  Parallel (after Phase 5 fix): ~8–16 seconds
```

---

# Appendix A: Verified Prompt Layout

The system prompt for every story page generation now contains exactly:

```
[1. PROMPT_SYSTEM]
    — persona, writing style, page format, branching rules, hard rules
    — ~2 800 chars, STATIC

[2. RULES_PAGE_GENERATION]
    — RULES_ROUTE_MEMORY
    — RULES_STORY_CONSISTENCY
    — RULES_DIFFICULTY_SCALING
    — RULES_FUTURE_NOTES
    — ~800 chars, STATIC

[3. outputFormatPart]
    — compact: "OUTPUT FORMAT: Respond with valid JSON. Required fields: ..."
    — ~120 chars, STATIC per generation type

[4. buildBookMetaDocuments documents (via formatSystemPromptWithDocuments)]
    — BOOK META snippet
    — KNOWN CHARACTERS snippet
    — KNOWN PLACES snippet
    — SEMI-STATIC per book state (changes as chars/places update)
```

**User message:**

```
[fieldInstructions]  — phase-specific field guidance, SEMI-STATIC
[thinkThenOutput]    — phase-specific review checklist, SEMI-STATIC
[prompt]             — full story context (all dynamic content), DYNAMIC
```

This layout is correct. The system message has the maximum stable prefix. The user message
starts with instructions (semi-stable) before the dynamic context.

---

# Appendix B: Provider Patterns (Verified)

## All Non-Gemini Providers

```ts
messages = [
  { role: "system", content: systemPromptWithDocuments },  // PROMPT_SYSTEM + rules + schema + docs
  { role: "user",   content: prompt },                     // dynamic context
];
```

## Gemini (non-streaming)

```ts
// Cache miss path (current behavior, always active since Bug 1 not yet fixed):
{
  model,
  systemInstruction: { parts: [{ text: systemPromptWithDocuments }] },  // ✅ correct field
  contents: [{ parts: [{ text: prompt }] }],
  config: { responseJsonSchema, ... },
}

// Cache hit path (active after Bug 1 fix):
{
  model,
  cachedContent: cacheId,           // points to pre-cached prefix
  contents: [{ parts: [{ text: prompt }] }],   // dynamic suffix only
  config: { responseJsonSchema, ... },
}
```

## GitHub (non-streaming only in `ai-chat.ts`)

```ts
{
  messages: [
    { role: "system", content: systemPromptWithDocuments },
    { role: "user",   content: prompt },
  ],
  prompt_cache_retention: "24h",   // ✅ KV cache retention
  ...
}
```

---

# Appendix C: Gemini Cache Key Design

```
cachedContentId = createCacheKey([bookId, characters, places])
```

**When cache is created:** First Gemini call for a given (bookId, characters, places) combination
after Bug 1 is fixed.

**When cache is INVALIDATED:** Any change to `state.characters` or `state.places` (new character,
character update, new place, place update) triggers a new `cachedContentId` → new cache created
→ old one orphaned (Bug 2).

**After Bug 2 fix:** When a new cache is created for `bookId`, the previous cache entry for
that book is explicitly deleted from Gemini's servers and from `contentCacheMap`.

**Serverless consideration:** `contentCacheMap` is in-memory and resets on cold starts. For
serverless production use, persist `cachedContentId → cacheId` in Redis or DB:

```ts
{
  table: "gemini_caches",
  bookId: string,        // foreign key
  cachedContentId: string,
  geminiCacheId: string, // Gemini resource name
  createdAt: timestamp,
  expiresAt: timestamp,
}
```

This avoids re-creating the cache on every cold start (which would happen multiple times per
hour in serverless with the current in-memory approach).

---

# Sources

- https://latitude.so/blog/latency-optimization-in-llm-streaming-key-techniques
- https://redis.io/blog/what-is-prompt-caching/
- Code audit: `utils/prompt.ts`, `utils/ai-chat.ts`, `utils/ai-chat-stream.ts`, `utils/gemini.ts`
