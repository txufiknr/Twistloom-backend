# Twistloom — AI/LLM Architecture

> **Revision:** v4 — current implementation audit
> **Stack:** TypeScript / Node.js · Next.js · PostgreSQL (Neon) · Redis (Upstash)
> **Providers:** Gemini, GitHub (OpenAI-compat), Groq, Cerebras, Mistral, NVIDIA NIM, Cohere

---

## Table of Contents

1. [Overview](#1-overview)
2. [System Architecture Diagram](#2-system-architecture-diagram)
3. [Provider Abstraction Layer](#3-provider-abstraction-layer)
4. [Prompt Architecture](#4-prompt-architecture)
5. [AI Sampling Configuration](#5-ai-sampling-configuration)
6. [Context Cache System](#6-context-cache-system)
7. [Generation Pipeline](#7-generation-pipeline)
8. [Optimization Implementations](#8-optimization-implementations)
9. [Performance Results](#9-performance-results)
10. [Telemetry & Observability](#10-telemetry--observability)
11. [Design Decisions Log](#11-design-decisions-log)
12. [Future Enhancements](#12-future-enhancements)
13. [Quick Reference](#13-quick-reference)

---

## 1. Overview

Twistloom is a psychological horror interactive fiction platform. The AI engine
generates branching narrative pages in first-person POV, where every choice the player
makes is tracked, analyzed, and weaponized to increase psychological pressure.

### Core Requirements

- **Multi-provider:** Never depend on a single provider. All are free-tier or low-cost.
- **Low perceived latency:** Players must not feel they are waiting for AI.
- **Narrative consistency:** A 40-page story must feel authored by one writer.
- **Psychological personalization:** The story adapts to the player's behavioral profile.
- **Branching:** Every page offers 2–3 choices; each branch is independently generated.

### The Central Optimization Problem

Free-tier LLM providers are rate-limited. A single story page requires:
- A large context (~5 000 tokens) carrying accumulated story state
- Up to 9 generation calls per page (3 actions × 3 candidates each)
- Consistent style and continuity across all candidates for all branches

The goal is to make as much of that context reusable (cached) across requests as
possible, so each call processes fewer novel tokens.

---

## 2. System Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                         READER (Browser)                        │
│                    Next.js frontend + SSE client                │
└───────────────────────────┬─────────────────────────────────────┘
                            │ SSE stream / REST
┌───────────────────────────▼─────────────────────────────────────┐
│                    API LAYER (Node.js / Next.js)                 │
│   /api/story/generate   /api/story/progress   /api/book/create  │
└───────────┬─────────────────────────┬───────────────────────────┘
            │                         │
┌───────────▼──────────┐   ┌──────────▼──────────────────────────┐
│   GENERATION ENGINE  │   │        BACKGROUND WORKERS            │
│   utils/prompt.ts    │   │   candidate-generation.ts            │
│                      │   │   GitHub Actions webhook triggers    │
│  generateNextPage()  │   │   triggerCandidateGenerationWorkflow │
│  generateNextPages() │   └─────────────────────────────────────┘
│  initializeBook()    │
└──────────┬───────────┘
           │
┌──────────▼───────────────────────────────────────────────────┐
│                   AI ABSTRACTION LAYER                        │
│   aiPrompt()          →  utils/ai-chat.ts                    │
│   aiStreamSSE()       →  utils/ai-chat-stream.ts             │
│   executePromptForJSON() → prompt assembly + schema          │
│                                                               │
│   ┌─────────┬─────────┬─────────┬─────────┬─────────────┐   │
│   │ Gemini  │ GitHub  │  Groq   │Cerebras │ Mistral/NIM │   │
│   │ +L3cache│+kv_24h  │         │         │             │   │
│   └─────────┴─────────┴─────────┴─────────┴─────────────┘   │
│        Provider Fallback Chain — sequential, rate-limited     │
└──────────┬───────────────────────────────────────────────────┘
           │
┌──────────▼───────────────────────────────────────────────────┐
│                   CACHE LAYER                                 │
│   L1: In-memory Map     (per serverless instance, ~0 ms)     │
│   L2: Upstash Redis     (persistent, cross-instance, ~1 ms)  │
│   L3: Gemini API cache  (server-side, 1-hr TTL)              │
│                          create ~300-800 ms, reuse ~0 ms     │
└──────────────────────────────────────────────────────────────┘
           │
┌──────────▼───────────────────────────────────────────────────┐
│                   DATA LAYER                                  │
│   PostgreSQL / Neon  — story state, pages, candidates        │
│   Upstash Redis      — session cache, rate limiting          │
└──────────────────────────────────────────────────────────────┘
```

---

## 3. Provider Abstraction Layer

### Provider Fallback Chain

```
Attempt 1  →  Gemini 2.5 Flash     (preferred: best structured output + explicit cache)
Attempt 2  →  GitHub / OpenAI      (strong quality + KV 24hr retention)
Attempt 3  →  Groq Llama 70B       (fastest raw speed)
Attempt 4  →  Cerebras Llama       (ultra-fast inference)
Attempt 5  →  Mistral Large        (reliable fallback)
Attempt 6  →  NVIDIA NIM           (last resort)
Attempt 7  →  Cohere               (emergency fallback)
```

Model pools are configured per generation type:
- `AI_CHAT_MODELS_WRITING` — story pages
- `AI_CHAT_MODELS_EVALUATION` — evaluator scoring pass
- `AI_CHAT_MODELS_THEME` — book creation prompt generation

### Provider Feature Matrix

| Provider | Structured Output | `systemInstruction` | Auto Cache | KV Retention | Explicit Cache | Hit Tracking |
|----------|:-:|:-:|:-:|:-:|:-:|:-:|
| Gemini | ✅ | ✅ | ✅ | — | ✅ | ✅ `cachedContentTokenCount` |
| GitHub | ✅ | ✅ | ✅ | ✅ `24h` | — | ✅ `prompt_tokens_details` |
| Groq | ✅ | ✅ | ✅ internal | — | — | — |
| Cerebras | ✅ | ✅ | limited | — | — | — |
| Mistral | ✅ | ✅ | limited | — | — | — |
| NVIDIA NIM | ❌ | ✅ | deployment-dep. | — | — | — |
| Cohere | ❌ | ✅ | very limited | — | — | ✅ `cachedTokens` |

### Structured Output Strategy

When `configs.schema` and `configs.requiredFields` are defined, the JSON schema is
passed as a native API parameter (`response_format.json_schema` for OpenAI-compatible
providers, `responseJsonSchema` for Gemini). A compact reminder replaces the full
schema text in the prompt, saving ~770 tokens per request:

```ts
const supportsStructuredOutput = Boolean(configs.schema && configs.requiredFields?.length);
const outputFormatPart = supportsStructuredOutput
  ? `OUTPUT FORMAT: Respond with valid JSON matching the schema provided.\nRequired fields: ${configs.requiredFields.join(', ')}`
  : `OUTPUT FORMAT (JSON):\n${jsonStructure.trim()}`;
// Goes into options.systemPrompt — not the user message.
```

---

## 4. Prompt Architecture

The core principle: **the most stable content must always appear first.**

Every LLM provider caches from the beginning of the input. If even one token changes
between requests, the entire sequence after that point cannot be cached. By front-loading
all static and semi-static content into the system message, Twistloom maximizes the
fraction of each request that is served from cache rather than recomputed.

### The Four-Layer Model

```
┌─────────────────────────────────────────────────────────────────┐
│  LAYER 1 — STATIC PERSONA                       ~876 tokens     │
│  PROMPT_SYSTEM                                   NEVER changes  │
│                                                                 │
│  R.L. Stine persona · writing style · PAGE FORMAT               │
│  narrator behavior · horror mechanics · HARD RULES              │
├─────────────────────────────────────────────────────────────────┤
│  LAYER 2 — STATIC RULE SET                     ~1 570 tokens    │
│  RULES_PAGE_GENERATION (10 rules joined)         NEVER changes  │
│                                                                 │
│  RULES_ROUTE_MEMORY         492 tokens           ┐              │
│  RULES_STORY_CONSISTENCY    146 tokens           │              │
│  RULES_DIFFICULTY_SCALING   110 tokens           │ all static   │
│  RULES_FUTURE_NOTES          69 tokens           │ constants    │
│  RULES_FALSE_PREVIEW        156 tokens           │              │
│  RULES_PLACE                 67 tokens           │              │
│  RULES_CHARACTER            172 tokens           │              │
│  RULES_CHARACTER_RECOGNITION 109 tokens          │              │
│  RULES_PAGE_TEXT             72 tokens           │              │
│  RULES_ACTIONS              154 tokens           ┘              │
├─────────────────────────────────────────────────────────────────┤
│  LAYER 3 — STATIC SCHEMA REMINDER                ~30 tokens     │
│  outputFormatPart (compact)                      NEVER changes  │
│                                                                 │
│  "OUTPUT FORMAT: Respond with valid JSON.                       │
│   Required fields: text, mood, place, ..."                      │
├─────────────────────────────────────────────────────────────────┤
│  LAYER 4 — SEMI-STATIC BOOK DOCUMENTS           ~738 tokens     │
│  buildBookMetaDocuments(book, state)             changes with   │
│                                                  story world    │
│  BOOK META         — title, genre, summary, hook, language      │
│  MAIN CHARACTER    — name, gender, age, bio, archetype only     │
│                      (NO inventory, NO injuries)                 │
│  KNOWN CHARACTERS  — side chars, sorted by recency, max 6       │
│  KNOWN PLACES      — discovered locations with status           │
│                                                                 │
│  ← These 4 layers form the Gemini explicit cache content →      │
│  ← All other providers cache Layer 1–3 automatically      →     │
└─────────────────────────────────────────────────────────────────┘
Total system message:  ~3 213 tokens  (57% of all tokens per request)

┌─────────────────────────────────────────────────────────────────┐
│  LAYER 5 — SEMI-STATIC INSTRUCTIONS             ~250 tokens     │
│  (user message, appears first)                  phase-specific  │
│                                                                 │
│  fieldInstructions   — phase-specific field rules               │
│  reviewChecklist     — self-review before output                │
├─────────────────────────────────────────────────────────────────┤
│  LAYER 6 — FULLY DYNAMIC CONTEXT              ~2 200 tokens     │
│  (user message, after instructions)             changes always  │
│                                                                 │
│  CURRENT PHASE + PHASE GOAL                                     │
│  MAIN CHARACTER (POV) — full bio + inventory + injuries         │
│  STORY CONTEXT       — contextHistory rolling summary           │
│  RECENT MAJOR EVENTS — plot flags                               │
│  CURRENT FACTS       — facts history                            │
│  PREVIOUS PAGES      — last N full pages                        │
│  CURRENT PAGE + SITUATION                                       │
│  ACTION SELECTION    — available choices + selected             │
│  NARRATIVE STYLE     — per-player prose instructions            │
│  PSYCHOLOGICAL FLAGS + PROFILE                                  │
│  HIDDEN STATE + ROUTE MEMORY                                    │
│  FUTURE NOTES · ACTIVE THREADS · ENDING PLAN                    │
└─────────────────────────────────────────────────────────────────┘
Total user message:  ~2 450 tokens  (43% of all tokens per request)
```

### User Message Order Rationale

Instructions (`fieldInstructions`, `reviewChecklist`) appear before the dynamic context.
This is the industry best practice: the model knows WHAT to produce and HOW to evaluate
it before it reads 2 000 tokens of story context. The format expectations are fresh in
working memory when generation begins.

### Why the MC State Is Split Across Layers

The main character profile is separated between layers 4 and 6:

```
Layer 4 (system, cached — never changes):
  MAIN CHARACTER (POV):
  Lisa Carter, female, 16 — Shy teenager with social anxiety.
  Archetype: The Reluctant Hero. Language: English.

Layer 6 (user, dynamic — changes every few pages):
  MAIN CHARACTER (POV):
  Lisa Carter, female, 16 — Shy teenager with social anxiety.
  Inventory: flashlight, torn journal page, brass key
  Injuries: sprained ankle (moderate), cut on left palm (minor)
```

Inventory and injuries change every few pages in a horror game. If placed in layer 4,
the Gemini cache would invalidate on every pickup or injury — paying 300–800ms to
recreate the cache with zero reuse. By placing them in layer 6 only:
- The cache stays valid for entire stretches between character/place discoveries
- The AI receives complete, accurate MC state (in the dynamic section)
- No narrative quality difference (the model reads it either way)

The base bio repeats in both layers (~38 tokens). This small duplication is intentional:
it grounds the model in who is narrating before processing 2 000 tokens of story context.

### `RULES_FALSE_PREVIEW` — Moved to System Prompt

Previously, the `FALSE PREVIEW SYSTEM` block was conditionally included in the user
message for non-finale pages. It is now part of `RULES_PAGE_GENERATION` in the system
prompt. The system prompt is identical for all page types (finale and non-finale),
preserving cache consistency. The `fieldInstructions` for finale pages instruct the
model not to inject false previews, overriding the system rule in context.

### Prompt Assembly Flow

```ts
// prepareNextPageGenerationSetup():
const { systemPrompt, documents, cachedContentId } =
  buildSystemPrompt(book, advancedState, RULES_PAGE_GENERATION);
  //  └─ PROMPT_SYSTEM + RULES_PAGE_GENERATION (layers 1–3)
  //  └─ buildBookMetaDocuments() → documents + cachedContentId (layer 4)

const prompt = buildNextPagePrompt(params);
  // buildNextPagePrompt():
  //   [TASK, storyContext, narrativePrompt, (lastPage: BRANCHING ACTIONS)]
  //   .filter(Boolean).join('---')

// executePromptForJSON():
options.systemPrompt = `${systemPrompt}\n\n---\n${outputFormatPart}`;
// ↑ layers 1–3 finalized

const finalPrompt = [
  fieldInstructionsPart,   // layer 5 (semi-static)
  thinkThenOutputPart,     // layer 5 (semi-static)
  prompt.trim(),           // layer 6 (dynamic)
].join('\n\n---\n');
```

---

## 5. AI Sampling Configuration

### The `determineAIConfig` Function

```ts
function determineAIConfig(state: StoryState): AIChatConfig {
  let config = AI_CHAT_CONFIG_CREATIVE;               // stable creative baseline

  if (state.hiddenState.profileShift?.detected) {
    config = applyActionConfig(config, TWIST_INJECTION_CONFIG);  // targeted boost
  }

  config = applyConfigCaps(config, JSON_RELIABILITY_CAPS);  // always applied last
  return validateAIConfig(config);                           // bounds enforcement
}
```

### Design Philosophy

The function was deliberately simplified from a more complex phase-based system. The
old approach (now commented out) adjusted temperature per story phase:

```ts
// OLD approach — removed:
// isEarlyPhase  → AI_CHAT_CONFIG_HUMAN_STYLE   (higher temp, more varied)
// isMidPhase    → AI_CHAT_CONFIG_DEFAULT        (standard)
// isFinale      → lower temp, tighter prose
// + ACTION_AI_CONFIG[action.type] per-action adjustment
// + FINALE_CONFIG caps
```

The new approach uses a single stable baseline with one targeted exception.

**Why phase-based temperature was removed:**

Sampling parameters control *vocabulary diversity* — how predictable or varied the
model's word choices are. They do NOT control plot quality, character consistency,
psychological realism, pacing, mystery structure, or narrative logic. Those are driven
by the prompt: `contextHistory`, `plotFlags`, `psychologicalProfile`, `hiddenState`,
`threads`, `endingPlan`.

Phase-based temperature changes produced a subtle but real problem: the prose felt like
it was written by progressively different authors — loose and varied early, then
tightening unnaturally toward the finale. A reader who played multiple stories would
notice the pattern. A stable voice is more consistent and more authorial.

**The one remaining adjustment — `TWIST_INJECTION_CONFIG`:**

When `state.hiddenState.profileShift.detected` is `true`, the hidden state system has
detected a significant behavioral shift in the player's psychological profile. This IS
a valid time for more novel phrasing — twists benefit from unexpected imagery,
revelations from less-predictable sentence structure. This is an evidence-based,
state-driven trigger rather than a broad phase-based rule.

**Why `JSON_RELIABILITY_CAPS` is applied last:**

Regardless of the creative baseline or the twist boost, structured JSON output needs
controlled sampling. If temperature is too high, the model may produce malformed JSON.
The cap is the final override, ensuring schema adherence is never sacrificed for
creative variance.

**The config pipeline:**

```
AI_CHAT_CONFIG_CREATIVE          ← stable creative baseline
       ↓ (if twist detected)
applyActionConfig(TWIST_INJECTION_CONFIG)   ← bounded adjustment
       ↓ (always)
applyConfigCaps(JSON_RELIABILITY_CAPS)      ← hard caps for JSON
       ↓ (always)
validateAIConfig()               ← clamp to [MIN, MAX] bounds
       ↓
final AIChatConfig               → passed to provider
```

`applyActionConfig` uses bounded arithmetic (not raw addition):
```ts
temperature: Math.max(min, Math.min(max, config.temperature + adjustment))
```
This ensures no single adjustment can push values out of the configured range, even if
multiple adjustments were ever stacked.

---

## 6. Context Cache System

### Three Storage Layers

```
REQUEST (Gemini, needs cachedContentId)
      │
      ▼
┌─────────────────┐  HIT  ┌──────────────────────────────────┐
│  L1  In-Memory  │──────▶│  Return cacheId — ~0 ms, no I/O  │
│  Map (instance) │       └──────────────────────────────────┘
└────────┬────────┘
         │ MISS
         ▼
┌─────────────────┐  HIT  ┌──────────────────────────────────┐
│  L2  Upstash    │──────▶│  Populate L1, return — ~1 ms     │
│  Redis          │       └──────────────────────────────────┘
└────────┬────────┘
         │ MISS
         ▼
┌─────────────────────────────────────────────────────────────┐
│  Create Gemini Context Cache via API — 300–800 ms           │
│    systemInstruction: layers 1–3 (~2 475 tokens)            │
│    contents[0]:       layer 4 docs (~738 tokens)            │
│  → Write L2 (Redis) THEN L1 (memory)                        │
│  → Update book reverse index in L2 + L1                     │
│  → Return new cacheId                                        │
└─────────────────────────────────────────────────────────────┘
```

**Why L2 before L1 on writes:** Multiple Vercel function instances may run concurrently.
Writing Redis first guarantees other instances see the new entry even if this instance
is recycled before writing L1.

### Redis Key Scheme

```
gemini:content-cache:{cachedContentId}   TTL: 3 900 s (1 hr + 5 min safety buffer)
  value: { cacheId, prefixHash, createdAt, expiresAt }

gemini:book-index:{bookId}               TTL: 28 800 s (8 hours)
  value: current cachedContentId for this book
```

### Cache Key Design

```ts
cachedContentId = createCacheKey([bookId, characters, places])
//  ↑ changes only when story world expands (new char or place)
//  ↑ does NOT change for inventory/injury updates
```

| Field | Included? | Reason |
|-------|:---------:|--------|
| `bookId` | ✅ | Scopes cache to one book |
| `characters` | ✅ | Side chars are in the cached documents |
| `places` | ✅ | Places are in the cached documents |
| `inventory` | ❌ | In dynamic prompt; changes every few pages |
| `injuries` | ❌ | In dynamic prompt; changes every few pages |
| `page number` | ❌ | Not in cached content |

### Stale Cache Cleanup

When `characters` or `places` change, `cachedContentId` changes. Before creating the new
Gemini cache, the old one is explicitly deleted to prevent orphan accumulation:

```ts
// Inside getOrCreateGeminiCache():
if (bookId) {
  const previousId = await readBookIndex(bookId);
  if (previousId && previousId !== cachedContentId) {
    const previous = await readEntry(previousId);
    if (previous?.cacheId) {
      // Best-effort: failure doesn't block generation
      await gemini.caches.delete({ name: previous.cacheId }).catch(warn);
    }
    await removeEntry(previousId);   // evict L1 + L2
  }
}
// Then create new cache, write L2 → L1, update book index
```

**Why cleanup runs here, not after generation:**
At this moment both the old and new `cachedContentId` are in scope (old from the book
index lookup, new as the current parameter). After generation completes, the old ID is
out of scope and cannot be retrieved without an extra lookup.

### Lifecycle Table

| Event | Cache change |
|-------|-------------|
| First page of new book | L1 miss → L2 miss → CREATE (300–800 ms) |
| Same state, next page | L1 hit → return instantly (~0 ms) |
| Cold start (Vercel) | L1 empty → L2 hit → populate L1 → return (~1 ms) |
| New character introduced | `cachedContentId` changes → stale cleanup → CREATE new |
| MC picks up item / gets hurt | `cachedContentId` unchanged → L1 hit → ~0 ms |
| Redis unavailable | L2 miss → CREATE Gemini cache; skip L2 write (graceful) |
| Gemini cache TTL expires | `expiresAt` check fails → CREATE new; overwrite entry |
| Book deleted | Call `invalidateGeminiCache(cachedContentId)` explicitly |

### N=3 Candidate Batch — Cache Benefit

All N candidates for the same page and action share the same `cachedContentId`
(same game state). The first candidate call creates the Gemini cache; subsequent
candidates in the same batch reuse it via L1:

```
Without any caching:           N × ~5 663 tokens processed
With Gemini cache (warm L1):   N × ~2 450 tokens processed  (user message only)
Reduction:                     58% fewer tokens per batch member
```

---

## 7. Generation Pipeline

### Single Page Generation

```
generateNextPage(params)
  │
  ├─ 1. prepareNextPageGenerationContext()
  │       ├── getStoryStateWithBranch()  — reconstruct state from branch tree
  │       ├── getPreviousPages()          — fetch last N pages from DB
  │       └── getStoryStateInfo()         — compute phase, ending proximity, flags
  │
  ├─ 2. prepareNextPageGenerationSetup()
  │       ├── buildSystemPrompt(book, state, RULES_PAGE_GENERATION)
  │       │     └── buildBookMetaDocuments() → {documents, cachedContentId}
  │       ├── buildNextPagePrompt()      — full user dynamic context
  │       ├── buildNextPageFieldInstructions()  — phase-specific rules
  │       ├── buildNextPageReviewChecklist()    — phase-specific self-check
  │       └── buildNextPageEvaluatorPrompt()    — second-pass scoring prompt
  │
  ├─ 3. executePromptForJSON()
  │       ├── Append outputFormatPart to systemPrompt
  │       ├── finalPrompt = [instructions, checklist, dynamicContext]
  │       └── aiPrompt(finalPrompt, { systemPrompt, documents, cachedContentId,
  │                                    meta: { bookId }, modelSelection, config })
  │               └── geminiPrompt():
  │                     ├── getOrCreateGeminiCache()   L1 → L2 → Gemini API
  │                     ├── generateContent({ cachedContent } OR { systemInstruction })
  │                     ├── parse + validate JSON (ai-parser.ts + json-repair)
  │                     └── log cacheHitRate from usageMetadata
  │
  ├─ 4. [Optional] Evaluator pass via AI_CHAT_MODELS_EVALUATION
  │       └── scores: tension, coherence, style, progression, illusion, consistency
  │
  ├─ 5. applyStateDelta()        — merge AI output deltas into story state
  ├─ 6. persistPageWithState()   — write page + new state to DB
  └─ 7. triggerCandidateGenerationWorkflow()  — background pre-gen
```

### Multi-Candidate Batch (`generateNextPages`)

```ts
// One AI call → N outputs
const prompt = buildNextPagePrompt({ candidateCount: 3 });
// prompt wraps in multiNextPageOutputFormat:
// { "generatedPages": [ ...3 alternatives... ] }

// All 3 share the same cachedContentId — L1 cache hit after first
```

**Why batch, not parallel:** One request uses one rate-limit slot and processes the
shared prefix exactly once. N parallel requests would exhaust rate limits simultaneously
and process the cached prefix N times.

### Evaluator Pass

```
Generation → StoryGeneration JSON
                   │
                   ▼
Evaluator (AI_CHAT_MODELS_EVALUATION) → AIJsonEvaluation<StoryGeneration>
  ├── scoreBefore: { total, tension, coherence, style, progression, illusion, consistency }
  ├── scoreAfter:  { total, fixes[] }
  ├── actionFlags: choice quality issues
  └── integrityFlags: JSON structure violations
```

The evaluator uses a separate model pool, enabling independent tuning (fast models
for scoring vs. expensive models for creative writing).

---

## 8. Optimization Implementations

### Opt-1: Full Static Rule Set Moved to System Prompt

**Problem (original state):** `RULES_ROUTE_MEMORY`, `RULES_STORY_CONSISTENCY`,
`RULES_DIFFICULTY_SCALING`, and `RULES_FUTURE_NOTES` were injected inside
`formatNextPageNarrativePrompt()` — after all dynamic content. This made them
completely uncacheable (dynamic prefix before static rules = 0% cache hits on rules).

**Problem (previous iteration):** `RULES_FALSE_PREVIEW`, `RULES_PLACE`,
`RULES_CHARACTER`, `RULES_CHARACTER_RECOGNITION`, `RULES_PAGE_TEXT`, and
`RULES_ACTIONS` still lived in the user message. Additionally, `RULES_FALSE_PREVIEW`
was a conditional inline block that appeared only for non-finale pages, creating an
inconsistent user message across page types — breaking cache reuse between regular
pages and finale pages.

**Current state:**
```ts
// All 10 rules are exported constants joined into one system-prompt string:
export const RULES_PAGE_GENERATION = [
  RULES_ROUTE_MEMORY,              // 492 tokens
  RULES_STORY_CONSISTENCY,         // 146 tokens
  RULES_DIFFICULTY_SCALING,        // 110 tokens
  RULES_FUTURE_NOTES,              // 69 tokens
  RULES_FALSE_PREVIEW,             // 156 tokens — was conditional in user msg
  RULES_PLACE,                     // 67 tokens  — was in user msg
  RULES_CHARACTER,                 // 172 tokens — was in user msg
  RULES_CHARACTER_RECOGNITION,     // 109 tokens — was in user msg
  RULES_PAGE_TEXT,                 // 72 tokens  — now exported constant
  RULES_ACTIONS,                   // 154 tokens — was in user msg
].join('\n\n---\n');               // 1 570 tokens total

// Passed to buildSystemPrompt:
buildSystemPrompt(book, advancedState, RULES_PAGE_GENERATION);
```

`formatNextPageNarrativePrompt()` is now completely clean — pure dynamic narrative
state, zero static rule injections.

`buildNextPagePrompt()` no longer has any conditional rule blocks:
```ts
return [
  `TASK: ${formatNextPageTaskPrompt(state, candidateCount)}`,
  formatNextPageStoryContextPrompt(params),
  formatNextPageNarrativePrompt(params),
  isLastPage && `BRANCHING ACTIONS:\n${getActionRulesText({ isFinale })}`
].filter(Boolean).join(`\n\n---\n`);
```

**Result:** ~1 570 tokens of rules now live entirely in the cached system message.
All page types (early, mid, late, finale) share an identical system prompt prefix.

---

### Opt-2: JSON Schema Moved to System Prompt + Compact Mode

**Problem:** `executePromptForJSON` appended the full JSON output schema (~800 tokens)
to the end of the user message — worst possible position for caching.

**After:**
```ts
// Compact reminder for structured-output providers (saves ~770 tokens vs full schema):
const outputFormatPart = supportsStructuredOutput
  ? `OUTPUT FORMAT: Respond with valid JSON.\nRequired fields: ${fields}`
  : `OUTPUT FORMAT (JSON):\n${jsonStructure.trim()}`;  // full, for non-structured providers

// Schema goes into system prompt — cached, never in user message:
options.systemPrompt = `${options.systemPrompt}\n\n---\n${outputFormatPart}`;

// User message ordering — semi-static before dynamic:
const finalPrompt = [
  fieldInstructionsPart,   // semi-static
  thinkThenOutputPart,     // semi-static
  prompt.trim(),           // dynamic
].join('\n\n---\n');
```

---

### Opt-3: Gemini `systemInstruction` Field Fix

**Problem:** `geminiStreamGenerator` concatenated the system prompt into `contents[0]`
(user body). Gemini treated everything as user content — no system-level caching.

**After:** Both `geminiPrompt` and `geminiStreamGenerator` use the correct field:
```ts
...(cachedContent
  ? { cachedContent }                                              // cache hit path
  : { systemInstruction: { parts: [{ text: systemPromptWithDocuments }] } }  // miss path
),
contents: [{ parts: [{ text: prompt }] }],
```

---

### Opt-4: Gemini Explicit Context Cache (Full Chain)

**Problem:** `getOrCreateGeminiCache` existed in `gemini.ts` but `cachedContentId` was
never forwarded through the generation chain — the cache was completely inert.

**Fix:**
```ts
// generateNextPage — added to destructure + baseOptions:
const { ..., cachedContentId, ... } = await prepareNextPageGenerationSetup(params, 1);

baseOptions: {
  systemPrompt, documents,
  cachedContentId,                    // ← activates Gemini cache lookup
  meta: { bookId: book.id },          // ← enables stale cleanup in getOrCreateGeminiCache
}
```

---

### Opt-5: MC State Split

**Problem:** `buildBookMetaDocuments` included `getMainCharacterInfo(mc, state)` with
the full mutable state. The `cachedContentId` hash included `inventory` and `injuries`,
which change every few pages — effectively invalidating the cache on almost every page.

**After:**
```ts
// In buildBookMetaDocuments (feeds the system prompt / Gemini cache):
documents.push({ snippet: getMainCharacterInfo({mc: book.mc})! });  // base profile only
const cachedContentId = createCacheKey([bookId, chars, places]);     // no inv/inj

// In formatNextPageStoryContextPrompt (dynamic user message):
const mcCurrentState = getMainCharacterInfo({mc: book.mc, state: {inventory, injuries}});
```

---

### Opt-6: Stable Sampling Configuration

**Problem:** `determineAIConfig` previously applied phase-based temperature adjustments
that caused prose to tighten noticeably toward the finale — an audible authorial shift
that broke narrative voice consistency.

**After:** Single stable creative baseline with one state-driven exception:
```ts
function determineAIConfig(state: StoryState): AIChatConfig {
  let config = AI_CHAT_CONFIG_CREATIVE;
  if (state.hiddenState.profileShift?.detected) {
    config = applyActionConfig(config, TWIST_INJECTION_CONFIG);  // only when twist is real
  }
  config = applyConfigCaps(config, JSON_RELIABILITY_CAPS);
  return validateAIConfig(config);
}
```

---

### Opt-7: GitHub KV Cache Retention

```ts
// In githubPrompt:
prompt_cache_retention: "24h"
```

Extends the server-side KV (Key-Value attention matrix) retention to 24 hours.
Subsequent requests with the same prefix skip recomputing the attention matrices
for all cached tokens — deeper than prompt caching, touching the transformer internals.

---

### Opt-8: Per-Provider Cache Hit Tracking

```ts
// Gemini:
const cacheHitRate = cachedContentTokenCount / promptTokenCount;

// GitHub:
const cacheHitRate = prompt_tokens_details.cached_tokens / prompt_tokens;

// Cohere:
const cacheHitRate = usage.cachedTokens / usage.promptTokens;
```

Included in `AIResponse.usage` → surfaced via `logAISuccess`.

---

### Opt-9: Removed Per-Token Debug Log

```ts
// REMOVED from aiStreamSSE hot path:
// console.log(`[${provider}] 🧩 SSE chunk:`, chunk);  ← was firing 1 000×/response
```

---

## 9. Performance Results

> **Methodology:** Token estimates at 4 chars/token. Mid-game story with 6 known
> characters, 4 known places, moderate `contextHistory`, 3 previous pages shown.
> Actual numbers vary by story state.

### Token Budget Across Optimization Stages

| Component | Original | Intermediate | **Current** |
|-----------|:--------:|:------------:|:-----------:|
| **System message** | **1 738** | **2 538** | **3 213** |
| → PROMPT_SYSTEM | 876 | 876 | 876 |
| → RULES in system | 0 | 895 (5 rules) | 1 570 (10 rules) |
| → Compact schema | 0 | 30 | 30 |
| → Book documents | 862 | 738 | 738 |
| **User message** | **4 045** | **2 450** | **2 450** |
| → Rules (buried) | 895 | 0 | 0 |
| → Full JSON schema | 800 | 0 | 0 |
| → Dynamic context | 2 350 | 2 200 | 2 200 |
| → MC mutable state | 0 | 400 | 400 |
| → Instructions | 250 | 250 | 250 |
| **Total** | **5 783** | **4 988** | **5 663** |
| **Cache coverage** | **30%** | **51%** | **57%** |

> The total grows slightly between intermediate and current because RULES_FALSE_PREVIEW,
> RULES_PLACE, RULES_CHARACTER, etc. add new rule content that didn't previously exist
> as explicit system-level guidance. The user message stays the same size while the
> system message grows — the cache coverage percentage is what matters.

### Cache Coverage Over Time

```
Original:     ████████░░░░░░░░░░░░░░░░░░░░  30%  (system msg only)
Intermediate: ████████████████░░░░░░░░░░░░  51%  (+5-rule RULES_PAGE_GENERATION)
Current:      ██████████████████████░░░░░░  57%  (+10-rule RULES_PAGE_GENERATION)
```

### N=3 Candidate Batch (warm Gemini L1 cache)

```
Original  (no cache):            17 349 tokens
Current   (warm L1 cache):        7 350 tokens  →  −58%
```

### Cache Hit Windows

| Event | Effect on cache |
|-------|----------------|
| MC picks up item | ❌ No effect — inventory excluded from key |
| MC gets injured | ❌ No effect — injuries excluded from key |
| New side character | ✅ Cache miss → ~1 s to create new cache |
| New location discovered | ✅ Cache miss → ~1 s to create new cache |
| Serverless cold start | L2 Redis hit → ~1 ms (no Gemini API call) |
| Same state, next page | L1 hit → ~0 ms |

### TTFT Estimate

When Gemini cache is warm, the model processes only the ~2 450-token user message instead
of the full ~5 663 tokens. Assuming linear token-processing latency:
```
Tokens saved per request: ~3 213 tokens (57%)
Estimated TTFT reduction: 25–45%  (accounting for fixed network overhead)
```
> Apply the non-streaming timing log (Gap 2 — implemented) to measure actual TTFT
> across providers in production.

---

## 10. Telemetry & Observability

### Streaming TTFT (`prompt-telemetry.ts`)

```ts
interface GenerationTelemetry {
  provider: string;
  model: string;
  context?: string;
  promptChars: number;
  estimatedPromptTokens: number;
  requestStartedAt: number;
  firstTokenAt: number | null;       // captured on first non-empty chunk
  completedAt: number | null;
  ttftMs: number | null;             // firstTokenAt - requestStartedAt
  generationMs: number | null;
}
```

Auto-logged quality gate:
```
< 1 000 ms → ✅ EXCELLENT
< 2 000 ms → 🟢 GOOD
< 3 000 ms → 🟡 ACCEPTABLE
> 3 000 ms → 🔴 POOR
```

### Non-Streaming Latency (`aiPrompt`) ✅ Implemented

Background candidate generation (`generateNextPage`, `generateNextPages`) now logs
timing via the same telemetry pattern. `totalPromptLength` was already computed for
the provider length gate — the addition was wiring `Date.now()` deltas around the
provider switch.

### Cache Hit Rate (per provider)

```ts
Gemini:  cachedContentTokenCount / promptTokenCount   → in AIResponse.usage
GitHub:  cached_tokens / prompt_tokens                → in AIResponse.usage
Cohere:  cachedTokens / total                         → in AIResponse.usage
```

All flow through `logAISuccess`. **Pending:** Surface cache hit rate in streaming
`logGenerationTelemetry` (Gap 3 — see future enhancements).

### Prompt Length Gate

Before each provider attempt, `aiPrompt` validates prompt size:
```ts
const totalPromptLength = systemPrompt.length + prompt.length + totalDocumentsLength;
if (totalPromptLength > AI_MAX_PROMPT_LENGTH[provider]) {
  // skip this provider, try next in chain
}
```

---

## 11. Design Decisions Log

### Batch N candidates, not N parallel calls

One AI request with `candidateCount=3` uses one rate-limit slot and processes the
shared prefix exactly once. N parallel requests hit the same rate limit simultaneously
(often all fail together) and re-process the prefix N times. The batch approach is
strictly better for rate-limited free-tier providers.

### Character relevance filter (P6) — rejected

All characters are always included, sorted by most recent interaction. Hard cap: 1 MC
+ max 6 side characters. With this cap the maximum character token overhead is bounded
(~500–1 500 tokens). More importantly: filtering dormant characters introduces the risk
that the model writes a re-appearing character as a stranger — no memory of appearance,
history, or relationships. `futureNotes` and `threads` signal re-appearances but carry
no character detail. The narrative inconsistency outweighs the token savings.

### MC bio repeated in both layers

The base bio (~38 tokens) appears in both the cached documents (layer 4) and the dynamic
MC state block (layer 6). This is intentional: the bio in layer 6 grounds the model in
character identity at the start of the dynamic context, before it reads 2 000 tokens of
story state. The duplication cost is accepted for consistency benefit.

### `RULES_FALSE_PREVIEW` always in system, not conditional per page type

Previously the FALSE PREVIEW block was conditionally excluded for finale pages. Now it
is always in the system prompt. This maintains a single identical system prompt for all
page types, maximizing cache reuse between regular and finale page generation. The
`fieldInstructions` for finale pages explicitly tell the model not to inject false
previews — the system rule is effectively overridden in context.

### Stable temperature vs. phase-based

See Section 5. Narrative quality is driven by prompt state, not sampling parameters.
Stable sampling produces consistent prose voice across the full story arc.

### Stale cleanup inside `getOrCreateGeminiCache`, not after generation

At cache-creation time, both the new and old `cachedContentId` are simultaneously in
scope. After generation, the old ID is out of scope. Cleanup here also ensures: if the
Gemini API delete fails, generation still proceeds — the failure is non-blocking.

---

## 12. Future Enhancements

### High Priority

**F1 — Parallel across-action candidate generation**
Currently `generateCandidatePages` is called per-action sequentially:
```ts
// Current: 3 actions × 8 s each = ~24 s wall-clock
for (const action of actions) { await generateCandidatePages(action); }

// Target: ~8 s wall-clock
await Promise.allSettled(actions.map(action => generateCandidatePages(action)));
```
Add Redis `SET NX` guard on Gemini cache creation to handle the parallel cold-start race:
if two instances simultaneously try to create a cache for the same `cachedContentId`,
only one succeeds; the other finds the entry on its next L2 read.

**F2 — `cacheHitRate` in streaming telemetry (Gap 3)**
Gemini streaming returns `usageMetadata` on the final chunk. Capture it and add
`cachedTokens` and `cacheHitRate` to `logGenerationTelemetry`. Patch available —
see `patch-gap3-streaming-cache-hit-rate.md`.

### Medium Priority

**F3 — Persist Gemini cache IDs to DB**
`l1Cache` (in-memory) resets on cold start; Redis L2 handles this within TTL. For
books with sessions separated by more than 65 minutes (L2 TTL), the Gemini cache must
be recreated. A DB table `gemini_caches { bookId, cachedContentId, geminiCacheId, expiresAt }`
gives indefinite durability and enables proactive cache refresh before TTL expiry.

**F4 — Provider racing for critical generations**
```ts
const result = await Promise.any([generateWithGemini(prompt), generateWithGroq(prompt)]);
```
Reserve for: book creation, finale pages. Never for background generation (wastes quota).

**F5 — Verify `AI_CHAT_MODELS_EVALUATION` uses fast models**
The evaluator re-reads full story context for scoring. Routing to Gemini Flash or
Groq Llama 8B instead of Llama 70B would halve evaluator cost and latency.

### Long-term

**F6 — Semantic caching for deterministic utility calls**
```ts
// Safe to cache: contextHistory summaries, tag generation, book metadata
withCache(`story:summary:${storyId}:${contentHash}`, generateFn, CACHE_TTL.LONG)
// Never cache: story pages, choices — must always be fresh
```

**F7 — Fast-model `contextHistory` summarization**
Currently the expensive writing model updates `contextHistory` as part of every page
output. A separate lightweight call after generation decouples bookkeeping from creative
work and enables tuning each independently.

**F8 — Confidence-based speculative pre-generation**
Use story state to predict the most likely next scenes and pre-generate for them before
the user selects an action:
```ts
{ "likelyNextPlaces": [{ "place": "Abandoned Hospital", "confidence": 0.82 }] }
```

---

## 13. Quick Reference

### Key Files

| File | Responsibility |
|------|---------------|
| `utils/prompt.ts` | Prompt building, generation orchestration, config |
| `utils/ai-chat.ts` | Non-streaming provider abstraction, `aiPrompt` |
| `utils/ai-chat-stream.ts` | Streaming SSE, `aiStreamSSE` |
| `utils/gemini.ts` | Gemini explicit cache (L1 + L2 + Gemini API) |
| `utils/prompt-telemetry.ts` | TTFT + size + cache hit telemetry |
| `services/cache.ts` | Redis `getFromCache` / `setCache` / `deleteCache` |
| `utils/redis.ts` | Upstash Redis client singleton |
| `utils/characters.ts` | `getMainCharacterInfo`, character formatting |
| `services/book.ts` | `buildBookMetaDocuments` |

### Key Config Constants

| Constant | Controls |
|----------|---------|
| `MAX_WORDS_PER_PAGE` | Page length cap |
| `MAX_WORDS_SUMMARIZED_CONTEXT` | `contextHistory` rolling summary limit |
| `MAX_PAGE_HISTORY` | Recent full pages shown to model |
| `MAX_OLDER_PLOT_FLAGS` | Compressed older events count |
| `MAX_CHARACTERS` | Hard cap on side characters (6) |
| `MAX_PLACES` | Hard cap on known places |
| `MAX_ACTIVE_THREADS` | Max concurrent narrative threads |
| `MAX_FUTURE_NOTES` | Max scheduled future story events |
| `MAX_BRANCHING_PREGENERATION_DEPTH` | Background pre-gen recursion depth |

### Cache TTL Reference

| Cache | TTL | Reason |
|-------|-----|--------|
| Gemini API cache | 3 600 s (1 hr) | Balances cost vs session span |
| Redis entry (`gemini:content-cache:*`) | 3 900 s | 5-min buffer over Gemini TTL |
| Redis book index (`gemini:book-index:*`) | 28 800 s (8 hr) | Spans multiple sessions |
| `EXPIRY_BUFFER_MS` | 60 000 ms (1 min) | Don't reuse cache near expiry |

### Optimization Summary Table

| Optimization | Tokens moved to cache | Tokens removed from user msg | Impact |
|-------------|:--------------------:|:---------------------------:|--------|
| 5-rule `RULES_PAGE_GENERATION` | +895 sys | −895 user | Cache 30% → 51% |
| JSON schema → system | +30 | −770 user | Compact mode for structured providers |
| Gemini `systemInstruction` fix | — | — | Enables all Gemini caching |
| `cachedContentId` forwarding | — | — | Activates explicit cache |
| MC state split | — | — | Cache stays valid 5–15 pages vs. every page |
| 10-rule `RULES_PAGE_GENERATION` | +675 sys | 0 user | Cache 51% → 57% |
| Stable `determineAIConfig` | — | — | Consistent prose voice |
| GitHub `prompt_cache_retention: "24h"` | — | — | KV retention across sessions |
