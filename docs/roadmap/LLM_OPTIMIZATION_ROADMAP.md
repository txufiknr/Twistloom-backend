# Twistloom LLM Optimization Roadmap — Unified Edition
> **Last updated:** post code-audit of `utils/prompt.ts`, `utils/ai-chat.ts`, `utils/ai-chat-stream.ts`

---

## Status Legend

| Symbol | Meaning |
|--------|---------|
| ✅ | Fully implemented |
| 🔧 | Partially implemented / exists but has bugs |
| 📋 | Planned, not started |
| ⚠️ | Bug or architectural anti-pattern found in audit |
| 💡 | New finding — not in original roadmap |

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

## What Already Exists in Twistloom ✅

Before planning work, here is what the codebase already does well:

- **Multi-provider fallback chain** — `aiStreamSSE` tries all providers and all models in a sequential chain. If Groq fails, it falls back to Gemini, Cerebras, etc. automatically.
- **Rate limiting** — `getRateLimiter(provider).throttle()` is applied before every generation.
- **AbortSignal support** — streaming supports cancellation via `AbortSignal.any()`.
- **Background candidate pre-generation** — after each page is persisted, `triggerCandidateGenerationWorkflow` fires in the background, pre-generating all action branches via GitHub Actions.
- **Batched multi-candidate generation** — `generateNextPages` sends a single AI call that produces N alternative pages at once (rather than N separate calls). This is very efficient for rate-limited free providers.
- **Rolling contextHistory** — rather than sending all pages, `contextHistory` is a rolling AI-maintained summary (`MAX_WORDS_SUMMARIZED_CONTEXT` words). This is a major context reduction already in place.
- **Plot flag compression** — `formatPreviousPagesForPrompt` shows recent full pages + compressed older plot flags. Old minor events are dropped. This prevents prompt bloat over long stories.
- **Dynamic AI config** — `determineAIConfig(state, action)` adjusts temperature/topP/topK based on story phase and action type. Early = more creative, finale = tighter.
- **JSON schema via API params** — when `outputJsonStructure` is provided, it's passed as `response_format: { type: "json_schema" }` to providers that support it (GitHub, Groq, Cerebras, Mistral). This is correct.
- **Prompt length gate** — `AI_MAX_PROMPT_LENGTH[provider]` skips providers if the prompt would exceed their context window.
- **Streaming SSE** — `aiStreamSSE` streams tokens to the frontend as they arrive via Server-Sent Events.

---

## Critical Issues Found in Code Audit ⚠️

These are active problems that hurt performance RIGHT NOW:

### ⚠️ Issue 1: Every streaming token is console.log'd in production

**File:** `utils/ai-chat-stream.ts` line ~207

```ts
console.log(`[${provider}] 🧩 SSE chunk:`, chunk);  // ← fires on every token
```

On a 1 000-token response, this fires 1 000 times during the streaming hot path. Every
`console.log` is a synchronous operation that blocks the event loop. This directly
increases TTFT and slows the streaming pipeline. **Remove immediately (Patch P0).**

---

### ⚠️ Issue 2: Static rules appear AFTER dynamic content in every prompt

**File:** `utils/prompt.ts` — `formatNextPageNarrativePrompt()`

`RULES_ROUTE_MEMORY`, `RULES_FUTURE_NOTES`, `RULES_STORY_CONSISTENCY`, and
`RULES_DIFFICULTY_SCALING` are **pure static string constants**. However, they are
injected deep inside the dynamic narrative section — after psychological flags, hidden
state, threads, and ending plan.

Because prompt caching works by matching the **prefix** (the beginning of the input),
any dynamic content placed *before* the static rules completely prevents those rules
from being cached. This means **0% cache hits on the user message** across all providers.

The fix is to move all four rules constants into the system prompt (see Patch P4).

---

### ⚠️ Issue 3: JSON schema sent at the end of the prompt — uncacheable

**File:** `utils/prompt.ts` — `executePromptForJSON()`

```ts
const finalPrompt = [
  prompt.trim(),       // dynamic content — FIRST ❌
  outputFormatPart,    // static JSON schema — LAST ❌
  fieldInstructionsPart,
  thinkThenOutputPart
].join('\n\n---\n');
```

The JSON schema (`nextPageOutputFormat` / `firstBookOutputFormat`) is ~800–1 200 chars of
static content that is sent at the very end of the user message. It never changes for a
given generation type, yet it cannot benefit from any provider-side caching because it
appears after all the dynamic context. **Move it to the system prompt (Patch P5).**

---

### ⚠️ Issue 4: Gemini does not use `systemInstruction` field

**File:** `utils/ai-chat-stream.ts` — `geminiStreamGenerator()`

```ts
// Current (wrong):
contents: [{ parts: [{ text: `${systemPromptWithDocuments}\n\n${prompt}` }] }]
```

Gemini has a dedicated `systemInstruction` field. When the system prompt is
concatenated into user `contents`, Gemini treats the entire input as a user message.
This:
- Prevents Gemini's automatic system-level caching
- Blocks any future explicit `ai.caches.create()` integration (Patch P7)
- Is semantically incorrect — the model sees no system/user distinction

**Fix immediately (Patch P2).**

---

### ⚠️ Issue 5: JSON schema sent twice (text + structured API param)

**File:** `utils/prompt.ts` + `utils/ai-chat-stream.ts`

For providers that support structured output natively (GitHub, Groq, Cerebras, Mistral,
Gemini), `executePromptForJSON` passes the schema BOTH as:
1. Text inside `outputFormatPart` (in the prompt body)
2. A structured API parameter via `outputJsonStructure` (in the request)

This is redundant. The schema travels twice in every request. For providers with native
structured output, the text version should be replaced with a compact reminder.
**Fix in Patch P3.**

---

## Performance Hierarchy

Impact ranking from highest to lowest:

| Priority | Optimization                          | Impact         | Status |
|----------|---------------------------------------|----------------|--------|
| 0        | Fix production debug logging          | Critical perf  | ⚠️ P0  |
| 1        | Background pre-generation             | Extremely High | 🔧     |
| 2        | Prompt ordering (static-first)        | Extremely High | ⚠️ P4  |
| 3        | Context reduction                     | Extremely High | 🔧     |
| 4        | Incremental memory updates            | Extremely High | 📋     |
| 5        | Fix Gemini systemInstruction          | High           | ⚠️ P2  |
| 6        | Remove duplicate JSON schema          | High           | ⚠️ P3  |
| 7        | Prompt cache optimization             | High           | 📋     |
| 8        | Parallel branch generation            | High           | ✅ (batched) |
| 9        | Provider racing                       | Medium-High    | 📋     |
| 10       | Streaming UX                          | Medium         | ✅     |
| 11       | Dynamic model routing                 | Medium         | 📋     |
| 12       | Semantic caching                      | Medium         | 📋     |
| 13       | Gemini explicit cache objects         | Medium         | 📋 P7  |
| 14       | Micro prompt tuning                   | Low            | 📋     |

---

# Phase 0: Establish Observability
**Status: 📋 Not started**

Before optimizing anything, measure everything. You cannot know whether P4 actually
helped if you have no baseline. This phase costs almost nothing to implement.

## Required Metrics

Track per generation:

```ts
{
  provider,
  model,
  context,              // 'story-page-candidate', 'book-creation', etc.

  promptChars,
  estimatedPromptTokens,

  requestStartedAt,
  firstTokenAt,
  completedAt,

  ttftMs,               // Time To First Token — most important user-facing metric
  generationMs,         // Time from first token to last token
  totalLatencyMs,       // requestStartedAt to completedAt

  cacheHitTokens,       // filled if provider reports cache usage
  cacheMissTokens
}
```

## Key KPIs

### Time To First Token (TTFT)

Most important user-facing metric. This is what the user feels.

```
Excellent:  < 1 000 ms
Good:       < 2 000 ms
Acceptable: < 3 000 ms
Poor:       > 5 000 ms
```

### Total Generation Latency

```
Target: < 8 seconds
```

### Prompt Size

```
Target: < 4 000 tokens for most page generations
Current estimate: 6 000–14 000 tokens (before any optimization)
```

> **How to get baseline:** Apply Patch P1 first. Let it log for 20–30 real
> generations. You'll know exactly where you stand.

---

# Phase 1: Prompt Architecture Refactor
**Status: ⚠️ Active bugs — static content after dynamic content**

## Goal

Create stable prompt prefixes that maximize provider-side prompt caching.

## The Golden Rule

> **The most stable content must always appear FIRST.**

Every provider caches from the beginning of the input. If token #1 changes between
requests, nothing is cached. If the first 5 000 tokens are identical across requests,
they're cached for free.

## What "Stable" Means in Practice

```
MOST STABLE (never changes)
├── System persona (PROMPT_SYSTEM)
├── Writing rules (RULES_*)
├── JSON output schema (nextPageOutputFormat)
└── Hard output constraints

SEMI-STABLE (changes per book/session, not per page)
├── Book summary
├── MC bio (without state-dependent inventory/injuries)
└── World context

DYNAMIC (changes every request)
├── contextHistory
├── Recent pages
├── Current page + situation
├── Psychological state
├── Hidden state
├── Threads + ending plan
└── Selected action
```

## Current Prompt Layout (Broken) ❌

```
USER MESSAGE:
  TASK (dynamic)
  HARD RULES (static — buried!)
  THEME REMINDER (semi-static)
  CURRENT PHASE (dynamic)
  MC INFO (semi-static + dynamic inventory)
  STORY CONTEXT (dynamic)
  PLOT FLAGS (dynamic)
  CURRENT FACTS (dynamic)
  PREVIOUS PAGES (dynamic)
  CURRENT PAGE (dynamic)
  ACTION SELECTION (dynamic)
  ───
  NARRATIVE STYLE (dynamic)
  PSYCH FLAGS (dynamic)
  PSYCH PROFILE (dynamic)
  HIDDEN STATE (dynamic)
  FUTURE NOTES (dynamic)
  ───
  RULES_ROUTE_MEMORY (STATIC — after all dynamic!) ❌
  RULES_STORY_CONSISTENCY (STATIC) ❌
  RULES_DIFFICULTY_SCALING (STATIC) ❌
  THREADS (dynamic)
  ENDING PLAN (dynamic)
  ───
  JSON SCHEMA (STATIC — at the very end!) ❌
  FIELD INSTRUCTIONS (semi-static)
  REVIEW CHECKLIST (semi-static)
```

## Corrected Prompt Layout ✅

```
SYSTEM MESSAGE:
  PROMPT_SYSTEM (static persona + writing style)
  ───
  RULES_ROUTE_MEMORY (static)
  RULES_STORY_CONSISTENCY (static)
  RULES_DIFFICULTY_SCALING (static)
  RULES_FUTURE_NOTES (static)
  ───
  nextPageOutputFormat (static JSON schema)
  ───
  [book documents: semi-static per book]

USER MESSAGE:
  [Semi-static section]
  THEME REMINDER
  MC BASE INFO
  ───
  [Dynamic section]
  CURRENT PHASE
  MC STATE (inventory, injuries)
  STORY CONTEXT
  CURRENT FACTS
  PREVIOUS PAGES
  CURRENT PAGE + SITUATION
  ACTION SELECTION
  ───
  NARRATIVE STYLE
  PSYCH FLAGS + PROFILE
  HIDDEN STATE + ROUTE MEMORY
  FUTURE NOTES
  THREADS + ENDING PLAN
  ───
  FIELD INSTRUCTIONS
  REVIEW CHECKLIST
  ───
  TASK
```

## Benefits

- Every provider benefits from cached system messages
- Gemini benefits additionally from explicit cache objects (Phase 4.5)
- Prompt processing time decreases with every cache hit
- TTFT drops proportionally to the fraction of the prompt that hits cache

## Implementation

See **Patch P4** (move rules) and **Patch P5** (move schema).

---

# Phase 2: Context Reduction
**Status: 🔧 Partially implemented**

## What Already Exists

- `contextHistory` — rolling AI-maintained summary (good ✅)
- `formatPreviousPagesForPrompt` — limits to `MAX_PAGE_HISTORY` recent pages, compresses older ones to plot flags (good ✅)
- `MAX_OLDER_PLOT_FLAGS` — caps how many older flags are sent (good ✅)
- All characters always included (needs fix ⚠️)

## Memory Layers

### Hot Memory — Always included

```
Last 2–3 pages (full text)
Current page
Current action
Immediate situation
```

### Warm Memory — Usually included

```
contextHistory (rolling summary)
Active characters
Current psychological state
Active threads
Future notes (with relevance filter)
Ending plan
Recent plot flags
```

### Cold Memory — Stored in DB, NOT sent to model

```
Archived characters (appeared long ago, inactive)
Resolved threads
Historical locations (not recently visited)
Very old plot flags
```

## Character Relevance Filter 💡 New Finding

**Status: 📋 Not started**

As stories grow, `state.characters` accumulates many characters that are no longer
relevant to the current scene. All are formatted and sent every generation. For a story
with 10 characters but only 2 active in the current scene, 8 characters' worth of
data is dead weight — potentially 1 000–3 000 extra tokens.

Solution: **See Patch P6** — `filterRelevantCharacters()` function.

The filter keeps characters that are:
- Present in the current scene (`charactersPresent`)
- Introduced recently (within last N pages)
- Have active narrative flags (`isMissing`, `isSuspicious`, `hasSecret`)
- Mentioned in recent plot flags by name

All others are silently omitted. They remain in `state.characters` — they're just not
sent to the model this turn.

## Future Note Relevance Filter ✅ Already exists

`formatFutureNotes` already splits notes into "Becoming Relevant" vs "For Later" vs
"Unscheduled". Notes that aren't yet relevant are shown but deprioritized. Good.

## Target

Reduce prompt size by:
```
30–70% compared to unoptimized baseline
```

---

# Phase 3: Incremental Memory System
**Status: 🔧 Partially implemented**

## Goal

Stop rebuilding the world state representation from scratch on every page.

## What Already Exists

`contextHistory` is maintained incrementally by the AI — each generated page produces
an updated `contextHistory` that incorporates the new events. This IS incremental. ✅

`factsHistory`, `plotFlags`, `traumaTags`, `threads` — all use append/delta patterns. ✅

## What Needs Improvement

### `stateDelta` and `applyStateDelta` 🔧

The code has `extractStateDelta` and `applyStateDelta` functions. These extract the
changes from a generation and apply them to the state. This is the correct pattern.

The gap: `contextHistory` is regenerated by the main model as part of every story
page generation. This means the expensive story-writing model is also doing summary
work. A lighter model (Flash/Groq Llama) could handle summary updates separately.

### Incremental Summary Pattern

Instead of:
```ts
// Every generation:
AI writes page + updates contextHistory (expensive model)
```

Consider:
```ts
// After each generation:
AI writes page (expensive model)
FastAI.summarize(contextHistory + newPage.text) → updatedContextHistory (cheap model)
```

This is **Phase 3.5** — not in the original roadmap but highly valuable for Twistloom.

## Benefits

- Smaller prompts
- More consistent story memory
- Less AI drift on long stories
- Fast-model summarization = lower cost + lower latency

---

# Phase 4: Prompt Caching Optimization
**Status: ⚠️ Broken by ordering issues — fixable with P4 + P5**

## Goal

Maximize how many tokens providers can skip re-processing on each request.

## How Prompt Caching Works

Think of it like a book index. If you read a 500-page book and then someone asks you
a question about page 501, you don't re-read pages 1–500. You already processed them.
LLM prompt caching works the same way — if the beginning of the input is identical to
a previous request, the provider skips re-computing it.

**The catch:** The cached prefix must be byte-for-byte identical. Even a single changed
character breaks the cache. This is why static content must come first.

## Cacheable Components (by layer)

### Fully Static — cache forever

```
System Prompt persona text
Writing rules (RULES_*)
JSON output schema
Hard output constraints
```

### Semi-Static per book — cache for the reading session

```
Book summary/theme
MC base bio
Initial world context
```

### Non-Cacheable

```
Current page number
Current scene
Action selected
Psychological state
Recent pages
Inventory/injuries
```

## Provider-Specific Cache Support

| Provider   | Auto-caches system msg | Explicit cache API | Notes |
|------------|------------------------|-------------------|-------|
| **Gemini** | Yes (with systemInstruction) | Yes (`ai.caches.create`) | Best support |
| **OpenAI/GitHub** | Yes (recent models) | Limited | Good |
| **Groq**   | Internal, not exposed  | No                | Benefits from system msg |
| **Cerebras** | Focus on speed, not cache | No             | Raw speed instead |
| **Mistral** | Limited               | No                | Some automatic |
| **NVIDIA NIM** | Deployment-dependent | No             | Not guaranteed |
| **Cohere** | Very limited           | No                | Lowest |

## Metrics to Track

```ts
{
  cacheHitTokens,
  cacheMissTokens,
  cacheHitRate: cacheHitTokens / (cacheHitTokens + cacheMissTokens)
}
```

**Target:** Cache hit rate > 60% on story page generation.

---

# Phase 4.5: KV Cache Retention
**Status: 📋 Not started (requires Phase 1 completion first)**

## What This Is

There are three distinct types of caching in the LLM world. Most discussions only cover
the first two. Understanding all three is important:

| Type                       | Who Controls It | What It Does                             |
|----------------------------|-----------------|------------------------------------------|
| Prompt Layout Optimization | **You**         | Structure prompts for maximum cache hits |
| Prompt Caching             | **Provider**    | Reuse saved prompt processing            |
| KV Cache Retention         | **Provider**    | Persist transformer attention state      |

**KV Cache Retention** is the third category. It goes one level deeper than prompt
caching. Rather than just skipping token re-encoding, it persists the actual *attention
matrices* (Key-Value vectors) that the transformer built for your prefix. This is
dramatically faster because the most expensive part of a transformer forward pass is
building these matrices.

## Why It Matters for Twistloom

### Branch generation is the ideal KV-cache workload

When `generateNextPages` generates N alternative continuations, the N candidates all
share an identical prefix (system prompt + story context). Each alternative only differs
in the last few tokens (the chosen action).

Without KV retention:
```
Each candidate: process 12 000 tokens → generate 500 tokens
Total: 12 000 × N tokens processed
```

With KV retention:
```
Candidate 1: process 12 000 tokens → generate 500 tokens → store KV cache
Candidate 2: REUSE stored KV → generate 500 tokens
Candidate 3: REUSE stored KV → generate 500 tokens
Total: 12 000 + (500 × N) tokens processed
```

On a 3-candidate batch: ~75% reduction in prefix processing.

## Important Caveat

**KV cache retention only works if the prefix is byte-for-byte identical.**

This is why Phase 1 (stable prefix) must come first. A prompt that changes its static
rules every request has effectively no cacheable prefix. With Phase 1 applied, a large
fraction of every prompt becomes a stable, cacheable prefix.

**Common prefix killers to eliminate:**

```ts
// Bad — changes every second
`Current Time: ${new Date().toISOString()}`

// Bad — random variation
`Request ID: ${Math.random()}`

// Bad — static content after dynamic content (current state of codebase)
`${dynamicStoryContext}
 ... 800 lines later ...
 ${RULES_ROUTE_MEMORY}  // ← cache can never reach this
```

## Provider Support

- **Gemini**: Best — explicit `ai.caches.create()` API gives full control
- **OpenAI/GitHub**: Automatic for longer prompts; newer APIs expose more control  
- **Groq**: Automatic for some models/tiers
- **Cerebras**: Focused on raw speed; limited cache control
- **Mistral/NVIDIA**: Limited

## Recommendation for Twistloom

### Phase 4.5-A: Prerequisite

Apply Phase 1 (prompt ordering) first. KV cache without stable prefixes = 0% benefit.

### Phase 4.5-B: Gemini Explicit Cache (High ROI)

Gemini is the only provider in Twistloom's stack with a clear, controllable cache API.

```ts
const cache = await ai.caches.create({
  model,
  config: {
    ttl: '3600s',
    systemInstruction: { parts: [{ text: systemPrompt + staticRules + schema }] },
    contents: [{
      role: 'user',
      parts: [{ text: bookSummary + mcBaseInfo }],
    }]
  }
});

// Store cache.name per storyId
// Reuse across all page generations for that story
```

**See Patch P7 for full implementation.**

### Phase 4.5-C: Cache metadata in DB

Store per-story:

```ts
{
  storyId,
  prefixHash,         // SHA-256 of cached content — invalidate if changed
  geminiCacheId,      // Gemini cache resource name
  cacheCreatedAt,
  expiresAt,
}
```

This allows cache reuse across server restarts and multiple instances.

---

# Phase 5: Parallel Generation Architecture
**Status: ✅ Partially implemented (batched)**

## Current Implementation

`generateNextPages(params, candidateCount)` generates multiple alternative pages in a
**single AI call** with a multi-candidate prompt wrapper:

```ts
// Current approach (single batched request):
const response = await executePromptForJSON({
  prompt: buildNextPagePrompt({ candidateCount: 3 }),  // asks for 3 alternatives at once
  ...
});
// AI returns: { generatedPages: [page1, page2, page3] }
```

This is actually **correct and efficient for rate-limited free providers**. One request
processes the shared prefix once and returns N outputs. The doc's `Promise.allSettled`
approach would make N separate requests, re-processing the prefix N times.

## What Can Still Be Parallelized

`generateCandidatePages` is called per-action (e.g., 3 actions on a page = 3 separate
calls). These calls are currently sequential. They share no prefix (each uses a
different selected action), so they should be parallelized:

```ts
// Before (sequential — each waits for the previous):
for (const action of actions) {
  await generateCandidatePages(action);
}

// After (parallel — all fire simultaneously):
await Promise.allSettled(
  actions.map(action => generateCandidatePages(action))
);
```

Wall-clock reduction:
```
Sequential (3 actions × 8 seconds each): 24 seconds
Parallel (3 actions in parallel):         ~8 seconds
```

---

# Phase 6: Provider Racing
**Status: 📋 Not started**

## Goal

Reduce tail latency by running the same request on multiple providers simultaneously
and using the first valid response.

## Current Behavior

Providers are tried **sequentially** — if provider A takes 12 seconds, provider B
never starts until A finishes or fails.

## Racing Pattern

```ts
const result = await Promise.any([
  generateWithGemini(prompt),
  generateWithGroq(prompt),
]);
// Use whichever responds first; cancel the other
```

## Recommended Usage

**Only race for:**
```
Premium/critical generations (finale pages, book creation)
When the user is actively waiting
```

**Do NOT race:**
```
Background candidate pre-generation (wastes API quota)
Routine candidate generation
```

## Cost Warning

Racing N providers uses N × tokens. Reserve for high-value moments.

---

# Phase 7: Dynamic Model Routing
**Status: 📋 Not started**

## Goal

Use the cheapest and fastest model that can handle the specific task. Not every task
needs the most capable model.

## Suggested Tiers

### Fast Tier — for utility tasks
```
Models:  Gemini Flash, Groq Llama 8B, Cerebras Llama 8B
Tasks:   contextHistory summarization, tag generation, metadata extraction,
         validation, character summary updates
```

### Standard Tier — for normal story generation
```
Models:  Groq Llama 70B, Gemini Flash/Pro, Mistral
Tasks:   Most story page generation
```

### Premium Tier — for critical moments
```
Models:  Gemini Pro, best available
Tasks:   Book initialization, finale pages, evaluator calls
```

## Evaluator Model Routing 💡 New Finding

The `buildNextPageEvaluatorPrompt` evaluator runs as a second AI call after every
story generation. It re-reads the entire story context plus the generated page.

Currently it uses the same expensive writing model. Consider routing evaluator calls
to a fast model:
- Writing model: generates the page (quality matters)
- Fast model: evaluates the page (pattern matching, scoring)

This could halve the cost of every generation that goes through evaluation.

---

# Phase 8: Semantic Caching
**Status: 📋 Not started**

## Goal

Avoid re-running identical or near-identical utility operations.

## Suitable Tasks (deterministic or near-deterministic outputs)

```
Story Summary generation (same book state → same summary)
Character Summary generation
Location Summary generation
Tag/keyword generation
Book metadata generation
```

## Not Suitable (creative outputs must not be cached)

```
Story page generation
Choice generation
Any narrative content
```

## Implementation Sketch

```ts
// Redis-backed semantic cache
async function cachedSummarize(storyId: string, content: string): Promise<string> {
  const cacheKey = `summary:${storyId}:${hashContent(content)}`;
  const cached = await redis.get(cacheKey);
  if (cached) return cached;

  const result = await generateSummary(content);
  await redis.setex(cacheKey, 3600, result);
  return result;
}
```

> **Never cache creative outputs.** Story page text must always be freshly generated.
> Caching it would break the branching narrative system.

---

# Phase 9: Streaming Optimization
**Status: ✅ Implemented — with minor issues**

## What's Working

`aiStreamSSE` provides full SSE streaming with:
- Token-by-token delivery to the frontend
- Provider/model-level start/end events
- Backpressure handling
- AbortSignal cancellation

## What Needs Fixing

### 9-a. Remove debug chunk logging (P0)

Already covered — `console.log` on every chunk.

### 9-b. Add TTFT measurement (P1)

Track when the first non-empty chunk arrives. This is the metric users feel.

### 9-c. Client-side progressive rendering

Once a JSON chunk begins arriving, start rendering the fields as they complete:
- The `text` field can begin rendering as it streams
- Actions can appear as soon as that JSON section closes
- Mood/scene metadata can update incrementally

This requires the frontend to parse partial JSON — libraries like `json-stream-stringify`
or a custom partial-JSON parser can help.

---

# Phase 10: Background Pre-Generation
**Status: 🔧 Partially implemented**

## Current State

✅ **Implemented:**
- After `initializeBook`, `triggerCandidateGenerationWorkflow` fires background candidate
  generation via GitHub Actions webhook
- `MAX_BRANCHING_PREGENERATION_DEPTH` controls how many levels deep to pre-generate
- `ensureCandidatesForPageWithStrategy` handles the generation logic

🔧 **Partially done:**
- Pre-generation fires after book creation, but it's unclear if it also fires after
  every user page selection
- The pre-generation is always at least 1 async step delayed from user action

📋 **Not yet done:**
- Per-session hot cache warming (pre-generate N most likely next actions immediately)
- Confidence-based speculative generation

## Target Architecture

```
User reads page
    │
    ▼
User sees actions A, B, C
    │
    ▼ (immediately, in background)
Generate candidate pages for A, B, C in parallel
    │
    ▼
Store in DB (candidate pages)
    │
    ▼
User selects action B
    │
    ▼
Page B already exists → serve in < 300 ms ✅
```

## Future Enhancement: Confidence-Based Expansion

```json
{
  "likelyNextPlaces": [
    { "place": "Abandoned Hospital", "confidence": 0.82 },
    { "place": "River Bridge",       "confidence": 0.61 }
  ]
}
```

Use predicted next locations to guide speculative generation even before the user
has selected an action.

## Target

Perceived latency:
```
< 300 ms for pre-generated pages
< 8 000 ms for cold generation (first-time or cache miss)
```

---

# Recommended Final Architecture

```
Reader
│
├── Current Page (served from DB)
│
├── Pre-generated Branch Cache (DB, filled by background workers)
│
├── Story Memory Layer
│   ├── Hot Memory (last 2–3 pages + current state)
│   ├── Warm Memory (contextHistory + active chars + threads + ending plan)
│   └── Cold Memory (DB only — archived chars, resolved threads, old events)
│
├── Prompt Builder
│   ├── Static Prefix (system prompt + rules + schema → always first)
│   ├── Semi-Static (book summary + MC base)
│   └── Dynamic Context (current page + action + state)
│
├── Generation Engine
│   ├── Batched Candidates (N alternatives in one call)
│   ├── Parallel Actions (generate candidates for all actions simultaneously)
│   ├── Provider Fallback Chain (Gemini → Groq → Cerebras → Mistral → NVIDIA)
│   └── Model Routing (fast for utility, standard for pages, premium for finale)
│
└── Telemetry
    ├── TTFT per provider
    ├── Prompt tokens (estimated)
    ├── Cache hit rate
    └── Generation latency
```

---

# Implementation Order

## Week 1: Fix active bugs + add observability
- ✅ P0: Remove production SSE debug log (1 line)
- ✅ P1: Add TTFT + prompt size telemetry (~30 lines)
- ✅ P2: Fix Gemini `systemInstruction` field (~10 lines)
- ✅ P3: Remove duplicate schema for structured-output providers (~20 lines)

## Week 2: Prompt architecture (the biggest lever)
- ✅ P4: Move static rules to system prompt
- ✅ P5: Move JSON schema to system prompt
- Measure baseline TTFT before/after using P1 telemetry

## Week 3: Context reduction
- P6: Character relevance filter
- Review and tune `MAX_PAGE_HISTORY`, `MAX_OLDER_PLOT_FLAGS` based on measured token sizes
- Evaluate making evaluator use a fast model

## Week 4: Gemini caching
- P7: Gemini explicit cache objects per story
- Add `geminiCacheId` tracking in DB

## Week 5: Parallel generation
- Parallelize `generateCandidatePages` across actions (Phase 5)

## Week 6: Model routing
- Route evaluator calls to a fast model (Phase 7)
- Route `contextHistory` summarization to a fast model (Phase 3.5)

## Week 7+: Advanced
- Semantic caching for summaries (Phase 8)
- Provider racing for premium generations (Phase 6)
- Confidence-based speculative pre-generation (Phase 10)

---

# Success Criteria

A mature Twistloom generation pipeline should achieve:

```
Prompt Size:
  70–90% smaller than unoptimized baseline (after Phase 1–3)
  or: < 4 000 tokens for normal story pages

TTFT:
  < 1 500 ms (excellent)
  < 2 500 ms (acceptable)

Average Generation Latency:
  < 8 seconds (cold, no cache)
  < 5 seconds (warm, provider cache hit)

Pre-generated Branch Load:
  < 300 ms

Cache Hit Rate (after Phase 4):
  > 60% on system message tokens

Perceived User Wait:
  Near-instant for pre-generated pages
```

---

# Appendix A: Canonical Prompt Architecture

Every Twistloom generation request must be built in this exact layer order.
Deviating from this order directly costs cache hits.

```
SYSTEM MESSAGE
├── [STATIC] System persona (PROMPT_SYSTEM)
├── [STATIC] RULES_ROUTE_MEMORY
├── [STATIC] RULES_STORY_CONSISTENCY
├── [STATIC] RULES_DIFFICULTY_SCALING
├── [STATIC] RULES_FUTURE_NOTES
├── [STATIC] nextPageOutputFormat (JSON schema)
└── [SEMI-STATIC] Book documents (buildBookMetaDocuments)

USER MESSAGE — PART 1 (semi-static per book)
├── Theme reminder (book.summary)
└── MC base info (name, gender, age, bio)

USER MESSAGE — PART 2 (dynamic per page)
├── Current phase
├── MC state (inventory, injuries)
├── Story context (contextHistory)
├── Recent major events (plotFlags)
├── Current facts (factsHistory)
├── Previous pages (compressed)
├── Current page + situation
└── Action selection

USER MESSAGE — PART 3 (dynamic, narrative)
├── Narrative style (createNarrativeStyle)
├── Psychological flags + profile
├── Hidden state
├── Route memory
├── Future notes
├── Threads
└── Ending plan

USER MESSAGE — PART 4 (instructions)
├── Field instructions (buildNextPageFieldInstructions)
├── Review checklist (buildNextPageReviewChecklist)
└── Task directive (LAST — tells model what to do after reading everything)
```

**Cacheability:**
| Layer | Can be cached? | Notes |
|-------|---------------|-------|
| System message | ✅ Always | Identical per generation type |
| Book documents | ✅ Per book | Same for all pages of a book |
| Part 1 (semi-static) | ✅ Per book | Changes only if book meta updates |
| Part 2 (dynamic) | ❌ | Different every page |
| Part 3 (narrative) | ❌ | Different every page |
| Part 4 (instructions) | 🔶 Phase-dependent | Changes with story phase |

---

# Appendix B: Provider Implementation Patterns

## The Unified Pattern

All non-Gemini providers should use the same two-message structure:

```ts
messages = [
  {
    role: "system",
    content: systemPrompt,  // static rules + schema
  },
  {
    role: "user",
    content: prompt,         // everything dynamic
  },
];
```

## Gemini — Special Case

Gemini uses different fields AND supports explicit caching:

```ts
// Standard (no explicit cache):
await ai.models.generateContent({
  model,
  systemInstruction: { parts: [{ text: systemPrompt }] },
  contents: [{ role: "user", parts: [{ text: prompt }] }],
  config: { responseSchema, ... },
});

// With explicit cache (after Phase 4.5):
await ai.models.generateContent({
  model,
  cachedContent: cacheId,      // pre-created cache resource
  contents: [{ role: "user", parts: [{ text: dynamicOnlyPrompt }] }],
  config: { responseSchema, ... },
});
```

> **Current bug:** `geminiStreamGenerator` concatenates system + prompt into `contents`
> instead of using `systemInstruction`. Fix in Patch P2.

## OpenAI / GitHub

```ts
messages = [
  { role: "system", content: systemPrompt },
  { role: "user",   content: prompt },
];
// Optional: split user into two messages for better caching:
// message[1] = semi-static book context
// message[2] = dynamic page context
```

---

# Appendix C: Twistloom-Specific Notes

## On `generateNextPages` Batch Strategy

The current implementation generates multiple candidates in a **single API call** by
asking the model to produce N alternative continuations at once via the
`multiNextPageOutputFormat` wrapper. This is intentional and correct for free/rate-limited
providers — it processes the shared prefix once and returns N outputs.

Do NOT switch to N parallel calls for the same action. That would multiply token usage
by N × (prefix_tokens / output_tokens ratio) which is typically 10x–20x the output.

The place to add parallelism is **across actions** (different actions for the same page)
since those do not share a prefix.

## On the Evaluator Call

`buildNextPageEvaluatorPrompt` triggers a second AI call that re-reads the full story
context plus the generated page. This is effectively doubling the cost of every
evaluated generation.

Consider:
1. Routing evaluator to a fast model (Gemini Flash, Groq 8B)
2. Skipping evaluation for background candidate generation (only evaluate main story pages)
3. Making evaluation conditional on score risk (skip if generation looks clean)

## On `contextHistory`

`contextHistory` is currently updated by the same expensive writing model as part of
every story page generation. The model writes the page AND updates its own running
summary in the same output object.

This is fine now, but as context grows, consider a separate lightweight call:
```ts
// After page generation:
const updatedContextHistory = await fastModel.summarize(
  existingContextHistory + newPageText
);
```

This decouples the expensive creative work from the cheap bookkeeping work.

---

# Sources

- https://latitude.so/blog/latency-optimization-in-llm-streaming-key-techniques
- https://redis.io/blog/what-is-prompt-caching/
- Code audit: `utils/prompt.ts`, `utils/ai-chat.ts`, `utils/ai-chat-stream.ts` (Twistloom)
