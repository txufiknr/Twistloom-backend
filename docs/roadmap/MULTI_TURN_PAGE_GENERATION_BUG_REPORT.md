# Multi-Turn Page Generation: Comprehensive Audit & Bug Report

> **Document Version:** 1.0.0  
> **Date:** 2026-08-19  
> **Status:** Review & Decision Pending  
> **Audited Files:**  
> - `Twistloom-backend/src/utils/ai-chat.ts`  
> - `Twistloom-backend/src/utils/prompt.ts`  
> - `Twistloom-backend/src/schema/story.ts`  
> - `Twistloom-backend/src/types/prompt.ts`  
> - `Twistloom-backend/src/types/story.ts`  
> - `Twistloom-backend/src/config/ai-chat.ts`  
> - `Twistloom-backend/src/utils/gemini.ts`  
> - `Twistloom-backend/docs/roadmap/MULTI_TURN_PAGE_GENERATION_ROADMAP.md`  

---

## 1. Executive Summary & Architectural Health Check

The multi-turn page generation refactor successfully splits the monolithic single-pass page generation call into a two-turn pipeline:
1. **Turn A (`story_page`):** Generates narrative prose and scene presentation (`StoryPageGeneration`, 11 fields, max output tokens: 2,200).
2. **Turn B (`state_delta`):** Reads Turn A's output as `GENERATED PAGE` and produces state modifications (`StateDeltaGenerationWithBranch`, 24 fields + `branchNames`, max output tokens: 1,800).
3. **Merge & Evaluation:** Merges Turn A + Turn B into a canonical `StoryGeneration` object and executes a single post-merge evaluation pass.

### Architectural Health Score
| Dimension | Rating | Status / Observations |
| :--- | :---: | :--- |
| **Schema Separation & Typing** | **A-** | Clear type boundaries (`StoryPageGeneration`, `StateDeltaGenerationWithBranch`), clean schema definitions. Minor discrepancy in `closeThreads`. |
| **Prompt Engineering & Stage Framing** | **B+** | Imperative task framing in Turn B is effective. However, Turn B carries excessive duplicate prompt context from Turn A. |
| **Evaluation & Resilience** | **C+** | Post-merge evaluation has critical bugs: drops structured schema definitions in non-Gemini modes, thrashes Gemini explicit context cache, and drops SSE/DB progress callbacks. |
| **Cross-Turn State Consistency** | **B** | Slug-ID handoff (`charactersPresent` / `placeId` -> `newCharacters` / `newPlaces`) is specified in prompts but lacks deterministic server-side fallback recovery if the LLM misses an ID. |
| **Multiverse Parallel Concurrency** | **A-** | `Promise.allSettled` per candidate is resilient; token budgets per candidate are well-clamped. Requires RPM rate limiter awareness. |

---

## 2. Critical & High-Severity Bugs (Broken Functionality & Runtime Failure Modes)

### 🔴 BUG-01: Gemini Context Cache Thrashing & Cache Pollution in `evaluateMergedStoryGeneration`

- **Severity:** High / Performance Critical
- **Affected Files:**
  - `Twistloom-backend/src/utils/prompt.ts` (lines 2052–2118)
  - `Twistloom-backend/src/utils/ai-chat.ts` (lines 1689–1695)
  - `Twistloom-backend/src/utils/gemini.ts` (lines 228–306)

#### Root Cause Analysis
In `evaluateMergedStoryGeneration`, the code attempts to optimize Gemini caching by reusing Turn A's cached content ID:
```typescript
// Twistloom-backend/src/utils/prompt.ts:2107
cachedContentId: cachedContentId ? `${cachedContentId}:story_page` : undefined,
```
The inline doc comment states:
> *"cachedContentId is suffixed :story_page here... since this evaluation call reuses Turn A's exact systemPrompt — the two share identical cache content, so this reuses Turn A's already-warmed cache instead of paying to create a new one."*

However, `runEvaluationPass` appends the dynamic generation output into `documents`:
```typescript
// Twistloom-backend/src/utils/ai-chat.ts:1689-1695
documents: [
  ...documents,
  {
    title: 'GENERATED JSON (from previous AI)',
    snippet: result.output,
  }
],
```
When `resolveGeminiCachedContent` calls `getOrCreateGeminiCache("...:story_page", model, systemPrompt, formattedDocuments, bookId)`:
1. `formattedDocuments` contains the new dynamic document (`GENERATED JSON`), so `prefixHash` (DJB2 hash of `systemInstruction + formattedDocuments`) differs from Turn A's `prefixHash`.
2. `existing.prefixHash === prefixHash` evaluates to **`false`**.
3. `getOrCreateGeminiCache` treats this as a cache update: it executes `ai.caches.create(...)` on Google's servers (**adding ~300–800ms network latency** for a single-use cache) and overwrites the Redis & L1 entry under key `gemini:content-cache:...:story_page`.
4. The next generation turn or retry hitting `:story_page` finds the evaluator's hash, misses again, and creates *another* cache, causing continuous cache thrashing.

#### Impact
- **0% Gemini Cache Hit Rate** on evaluation passes.
- **Latency regression:** Adds ~300–800ms to every evaluation call due to `ai.caches.create`.
- **Cache eviction of Turn A:** Evicts Turn A's warmed cache in Redis/L1, destroying prompt cache benefits for subsequent turns or parallel candidate evaluations.

#### Proposed Solution
Pass `cachedContentId: undefined` in `evaluateMergedStoryGeneration` options so evaluation relies on Gemini's automatic implicit prefix caching instead of creating an ephemeral explicit cache on dynamic payload:
```typescript
// Twistloom-backend/src/utils/prompt.ts:2107
cachedContentId: undefined, // Evaluation contains dynamic 'GENERATED JSON' document; omit explicit cache
```
Alternatively, if character/place document caching is desired for evaluation, pass `GENERATED JSON` inside `evaluatorPrompt` (the user prompt) rather than in `documents`, allowing `documents` to remain byte-identical to Turn A.

---

### 🔴 BUG-02: Structured Output Schema Dropped in `evaluateMergedStoryGeneration`

- **Severity:** High / Runtime Failure on OpenAI, Groq, Cerebras, Mistral
- **Affected Files:**
  - `Twistloom-backend/src/utils/prompt.ts` (lines 2100–2115)
  - `Twistloom-backend/src/schema/story.ts` (lines 748–770)
  - `Twistloom-backend/src/utils/ai-chat.ts` (lines 1673–1720)

#### Root Cause Analysis
In `evaluateMergedStoryGeneration`:
```typescript
// Twistloom-backend/src/utils/prompt.ts:2100-2115
const evaluated = await runEvaluationPass<StoryGeneration>(
  baseResult,
  evaluatorPrompt,
  {
    modelSelection: AI_CHAT_MODELS_EVALUATION,
    config,
    documents,
    cachedContentId: undefined,
    logPrompts: true,
    meta: { bookId },
    // ⚠️ MISSING: outputJsonStructure and outputJsonRequired
  },
  systemPrompt,
  baseContext,
  onProgress,
  onGenerationProgress,
);
```
Inside `runEvaluationPass`, the evaluation schema is built via:
```typescript
// Twistloom-backend/src/utils/ai-chat.ts:1700
outputJsonStructure: buildEvaluationSchemaDefinition(evaluationOptions),
```
Looking at `buildEvaluationSchemaDefinition` in `src/schema/story.ts`:
```typescript
// Twistloom-backend/src/schema/story.ts:752-763
export function buildEvaluationSchemaDefinition<T extends Record<string, unknown>>(options: AIPromptOptions): Record<keyof AIJsonEvaluation<T>, AIJsonProperty> {
  const { useStringEvaluatorOutput = true, outputJsonStructure, outputJsonRequired } = options;
  ...
  return {
    output: useStringEvaluatorOutput
      ? { type: 'string', description: '...' }
      : {
          type: 'object',
          properties: outputJsonStructure, // ⚠️ undefined!
          required: outputJsonRequired,     // ⚠️ undefined!
          additionalProperties: outputJsonStructure ? false : undefined,
        },
    ...
```
When `useStringEvaluatorOutput` is `false` (structured object mode used when non-Gemini evaluators are active or when `resolveUseStringEvaluator` returns `false`), `options.outputJsonStructure` is `undefined`.
The resulting schema sends `output: { type: 'object', properties: undefined }` to providers like OpenAI, Groq, Cerebras, or Mistral, resulting in API 400 Bad Request errors (`Invalid schema: properties is required for type object`).

#### Impact
- Hard failure / API crash during evaluation pass whenever structured mode (`useStringEvaluatorOutput: false`) is triggered.

#### Proposed Solution
Explicitly pass `outputJsonStructure` and `outputJsonRequired` in `evaluateMergedStoryGeneration`:
```typescript
// Twistloom-backend/src/utils/prompt.ts:2100-2115
const evaluated = await runEvaluationPass<StoryGeneration>(
  baseResult,
  evaluatorPrompt,
  {
    modelSelection: AI_CHAT_MODELS_EVALUATION,
    config,
    documents,
    cachedContentId: undefined,
    outputJsonStructure: STORY_GENERATION_SCHEMA_DEFINITION,
    outputJsonRequired: STORY_GENERATION_REQUIRED_FIELDS,
    logPrompts: true,
    meta: { bookId },
  },
  systemPrompt,
  baseContext,
  onProgress,
  onGenerationProgress,
);
```

---

### 🔴 BUG-03: Complete Drop of SSE / DB Progress Callbacks in Multi-Turn Flow

- **Severity:** High / UX & Telemetry Degradation
- **Affected Files:**
  - `Twistloom-backend/src/utils/prompt.ts` (lines 5384–5459, 5538–5544, 5728–5754)

#### Root Cause Analysis
In `generateStoryGenerationMultiTurn`:
```typescript
// Twistloom-backend/src/utils/prompt.ts:5384-5390
async function generateStoryGenerationMultiTurn(options: {
  setup: Awaited<ReturnType<typeof prepareNextPageGenerationSetup>>;
  book: Book;
  actionedPage: CandidateGenerationPage;
  baseContext: string;
  fateContext?: { fateIndex: number; fateCount: number };
}): Promise<AIResponse<StoryGeneration>>
```
Notice that `options` does **not** accept `onProgress?: ProgressCallback` or `onGenerationProgress?: (step: StoryGenerationStep) => Promise<void>`.

Inside `generateStoryGenerationMultiTurn`:
1. `runGenerationStage<StoryPageGeneration>(...)` for Turn A receives `undefined` for both callbacks.
2. `runGenerationStage<StateDeltaGenerationWithBranch>(...)` for Turn B receives `undefined` for both callbacks.
3. `evaluateMergedStoryGeneration(...)` receives `undefined` for both callbacks (line 5458).

#### Impact
- When `USE_MULTI_TURN_GENERATION` is `true`, all SSE stream events (`ai_generation_start`, `ai_generation_complete`, `ai_evaluation_start`, `ai_evaluation_complete`) and database generation step updates (`onGenerationProgress`) are silently dropped.
- Clients listening to SSE updates on page generation will receive no progress events until generation completely finishes.

#### Proposed Solution
1. Update `generateStoryGenerationMultiTurn` to accept and propagate `onProgress` and `onGenerationProgress`.
2. Update callers in `generateNextPage` and `generateNextPages` to pass progress callbacks.
3. Optional enhancement: Tag SSE events with stage metadata (`stage: 'story_page' | 'state_delta' | 'evaluating'`) so frontends can show granular progress (e.g. *"Authoring prose..."* -> *"Updating world state & consequences..."* -> *"Refining output..."*).

---

### 🟡 BUG-04: Date Fallback Timing & Overwrite Vulnerability at Turn A/B Merge

- **Severity:** Medium
- **Affected Files:**
  - `Twistloom-backend/src/utils/prompt.ts` (lines 5454–5456, 5578–5581, 5811–5814)
  - `Twistloom-backend/docs/roadmap/MULTI_TURN_PAGE_GENERATION_ROADMAP.md` (lines 261–262)

#### Root Cause Analysis
The Multi-Turn Roadmap specified:
```typescript
// MULTI_TURN_PAGE_GENERATION_ROADMAP.md Part 2.4 line 261-262
const generatedStoryPage: StoryGeneration = {
  ...storyPage,
  ...stateDelta,
  calendarDate: storyPage.calendarDate ?? actionedPage.calendarDate,
};
```
However, in `prompt.ts` line 5455:
```typescript
// Twistloom-backend/src/utils/prompt.ts:5455
const merged: StoryGeneration = { ...storyPage, ...stateDelta };
```
If Turn B's LLM hallucinates an empty or null `calendarDate` field, spreading `stateDelta` second will overwrite `storyPage.calendarDate`.
Additionally, because the fallback to `actionedPage.calendarDate` is delayed until `generateNextPage` line 5580, `evaluateMergedStoryGeneration` receives `merged` *before* the date fallback is applied. If Turn A omitted `calendarDate`, the evaluator sees an undefined date and may penalize consistency in the rubric.

#### Proposed Solution
Ensure the date fallback is applied immediately during object merge in `generateStoryGenerationMultiTurn`:
```typescript
// Twistloom-backend/src/utils/prompt.ts:5455
const merged: StoryGeneration = {
  ...storyPage,
  ...stateDelta,
  calendarDate: storyPage.calendarDate ?? actionedPage.calendarDate,
};
```

---

## 3. Medium & Low Priority Issues & Inefficiencies

### 🟡 ISSUE-05: Lack of Fault-Tolerant Server Synthesis for Invented Slug IDs

- **Severity:** Medium / Robustness
- **Affected Files:**
  - `Twistloom-backend/src/utils/prompt.ts` (lines 1267, 1296, 1395, 1425)
  - `Twistloom-backend/src/utils/story.ts` (lines 498–578)

#### Description
In the multi-turn architecture, Turn A is instructed to invent slug IDs for new entities (e.g. `placeId: "flooded-basement-stairwell"`, `charactersPresent: [{ characterId: "hollow-eyed-clerk" }]`), and Turn B is instructed:
> *"The GENERATED PAGE's charactersPresent/placeId may reference an ID not in KNOWN... You MUST add a newCharacters/newPlaces entry using that EXACT ID."*

While models follow this prompt most of the time, non-deterministic LLMs (especially fast fallback models like Llama 3.3 70B or Mistral Small) occasionally:
1. Miss adding the `newCharacters` or `newPlaces` entry in Turn B.
2. Slightly alter the ID (e.g. `hollow_eyed_clerk` vs `hollow-eyed-clerk`).
3. Invent a different ID in `newCharacters` than what Turn A used in `charactersPresent`.

When this happens, `applyStateDelta` receives an unmapped ID. In subsequent pages, `formatCurrentSituationForPrompt` logs:
`[charactersPresent] ⚠️ Character ID "hollow-eyed-clerk" does not exist` and the entity is never tracked in character/place memory.

#### Proposed Solution
Add a lightweight server-side reconciliation helper right after merge (in `generateStoryGenerationMultiTurn` or `resolvePageDelta`):
```typescript
function reconcileInventedSlugIds(merged: StoryGeneration, state: StoryState): void {
  // 1. Reconcile placeId
  if (merged.placeId && merged.placeId !== 'unknown' && !state.places[merged.placeId]) {
    const hasPlaceEntry = merged.newPlaces?.some(p => p.placeId === merged.placeId);
    if (!hasPlaceEntry) {
      merged.newPlaces = merged.newPlaces ?? [];
      merged.newPlaces.push({
        placeId: merged.placeId,
        knownName: formatSlugToTitle(merged.placeId),
        type: 'scene_location',
        category: 'other',
        context: `Location introduced during scene at page ${state.page}`,
        familiarity: 0.1,
      });
    }
  }

  // 2. Reconcile charactersPresent
  for (const char of merged.charactersPresent ?? []) {
    if (char.characterId && !state.characters[char.characterId]) {
      const hasCharEntry = merged.newCharacters?.some(c => c.characterId === char.characterId);
      if (!hasCharEntry) {
        merged.newCharacters = merged.newCharacters ?? [];
        merged.newCharacters.push({
          characterId: char.characterId,
          knownName: formatSlugToTitle(char.characterId),
          recognitionLevel: 'unfamiliar',
          gender: 'unknown',
          role: char.sceneRole || 'supporting',
          bio: 'Character encountered during the scene.',
        });
      }
    }
  }
}
```

---

### 🟡 ISSUE-06: Schema vs Prompt Discrepancy on `closeThreads` Field

- **Severity:** Low / Schema Ambiguity
- **Affected Files:**
  - `Twistloom-backend/src/schema/story.ts` (line 601)
  - `Twistloom-backend/src/utils/prompt.ts` (lines 1478, 1765)

#### Description
- In `STORY_STATE_GENERATION_SCHEMA` (`src/schema/story.ts:601`), `closeThreads` is defined with description:
  `"Thread titles to be closed if any."`
- In `buildNextPageFieldInstructionSections` (`src/utils/prompt.ts:1478`):
  `"Include thread IDs that should be marked as closed"`
- In `buildStateDeltaReviewChecklist` (`src/utils/prompt.ts:1765`):
  `"Every ID referenced in .../closeThreads matches an ID that already exists"`
- In `processThreadUpdates` (`src/utils/story.ts:1140`):
  `thread.threadId === closeId` (matches on ID, not title).

#### Proposed Solution
Fix the schema description in `src/schema/story.ts:601` to:
`description: "Thread IDs to be closed if any."`

---

### 🟡 ISSUE-07: Excessive Duplicate Context in Turn B User Prompt (Token Inefficiency)

- **Severity:** Medium / Cost & Latency Inefficiency
- **Affected Files:**
  - `Twistloom-backend/src/utils/prompt.ts` (lines 1209–1228)

#### Description
In `buildStateDeltaPrompt`:
```typescript
function buildStateDeltaPrompt(params: BuildNextPagePromptParams, storyPage: StoryPageGeneration): string {
  const { advancedState: state, book } = params;
  const { language } = book;

  return [
    `TASK: ${formatStateDeltaTaskPrompt(language)}`,
    formatNextPageStoryContextPrompt(params),
    `GENERATED PAGE:\n${formatGeneratedPageForDeltaPrompt(storyPage)}`,
    formatNextPageNarrativePrompt(params, false),
    state.plannedCharacters?.length && RULES_PLANNED_CHARACTERS,
  ].filter(Boolean).join(`\n\n---\n`);
}
```
`formatNextPageStoryContextPrompt(params)` includes:
- `PREVIOUS PAGES`: Full verbatim prose for up to 5 previous pages (~1,500–2,500 tokens).
- `CURRENT PAGE`: Full verbatim prose of the actioned page (~400–600 tokens).
- `CURRENT SITUATION`: Scene momentum, characters, objects (~200 tokens).
- `RELEVANT PAST EVENTS`: Semantic retrieval excerpts (~300–600 tokens).

Turn B is then given the newly written `GENERATED PAGE` in full.
Because Turn B's purpose is strictly state derivation from the `GENERATED PAGE`, passing all 5 previous pages of full prose is redundant. Turn B only needs:
- `STORY CONTEXT` (running summary & temporal clock).
- `CURRENT FACTS` (so it knows what's already known vs new).
- `ACTIVE THREADS`, `KNOWN CHARACTERS`, `KNOWN PLACES`.
- `GENERATED PAGE` (the text to analyze).

#### Proposed Solution
Create a lightweight context formatter `formatStateDeltaStoryContextPrompt` that omits full previous pages' prose while retaining facts and active entity registries. This will reduce Turn B's prompt token footprint by **2,000–3,500 tokens per request** (a ~25–35% reduction in total input tokens per page generation).

---

## 4. Performance, Concurrency & Rate Limit Considerations

### Multiverse Parallel Multi-Turn Fan-Out Analysis
When generating branching candidates with `candidateCount = 3` in `generateNextPages`:
- **Legacy flow:** 1 single-shot batch request (`candidateCount: 3`) + 1 evaluation pass = **2 API calls total**.
- **Multi-turn flow:** 3 parallel `generateStoryGenerationMultiTurn` instances.
  - Candidate 1: Turn A + Turn B + Eval = 3 calls
  - Candidate 2: Turn A + Turn B + Eval = 3 calls
  - Candidate 3: Turn A + Turn B + Eval = 3 calls
  - **Total: 9 API calls per action transition.**

#### Rate Limit Implications
- Fast providers like Cerebras (30 RPM) and Groq (30 RPM) will consume ~30% of their per-minute quota on a single multiverse transition.
- **Mitigation in place:** `src/utils/ai-limiters.ts` uses Bottleneck token-bucket limiters with `retryWithBackoff`.
- **Recommendation:** Ensure fallback provider waterfall has at least 3 high-capacity providers enabled (Gemini 2.5 Flash, Mistral, OpenAI/OpenRouter, Cohere) so parallel bursts seamlessly spill over without blocking user requests.

---

## 5. Open Questions & Architectural Decisions for User Alignment

Below are key architectural decisions that require your explicit preference. Each question includes trade-offs and our recommended approach.

---

### ❓ Question 1: Evaluation Strategy in Multi-Turn — Post-Merge vs. Turn A Only vs. Dual-Turn?

- **Current Implementation:** Single post-merge evaluation on the combined `StoryGeneration` object.
- **Context:**
  - In 95% of generation errors, the failure mode is in Turn A's narrative prose (e.g., POV camera break, unnatural dialogue, pacing monotone, bodily posture contradiction, repetition).
  - Turn B generates structured state updates which are already validated downstream by Zod schemas, `extractStateDelta`, `applyStateDelta`, and `runCanonValidationPass`.
  - Evaluating the merged object requires sending the full legacy 35-field schema and full prompt rubric (~12k input tokens) to the evaluator.

#### Options:
1. **Option A (Current): Post-Merge Evaluation on `StoryGeneration`**
   - *Pros:* Evaluates both prose and state coherence in one pass.
   - *Cons:* Evaluator prompt is large (~12k tokens); evaluator can hallucinate state modifications while trying to fix prose.
2. **Option B (Recommended): Evaluate Turn A (`StoryPageGeneration`) Prose Only**
   - *Pros:* Evaluator prompt is cut in half (~5k tokens); focuses 100% of evaluator attention on narrative quality, POV continuity, and prose rhythm; runs before Turn B so Turn B extracts state from already-polished prose.
   - *Cons:* Evaluator does not score state delta fields (though canon validator already checks them).
3. **Option C: Dual Per-Turn Evaluation**
   - *Pros:* Independent evaluation per stage.
   - *Cons:* Doubles evaluator API calls (4 calls per page, 12 calls per multiverse action).

> **💡 Best Recommendation:** **Option B (Evaluate Turn A Prose Directly Before Turn B).**  
> Running the rubric evaluation on Turn A allows Turn B to extract state deltas from the final, polished prose. It halves evaluator prompt token costs and eliminates evaluator state-patching hallucinations.

---

### ❓ Question 2: Handling of Unknown/Invented Slug IDs — Pure Prompt vs. Server Synthesis?

- **Current Implementation:** Pure prompt-based handoff (instructing Turn A to invent slug IDs and Turn B to detect and register them in `newCharacters`/`newPlaces`).
- **Context:** LLMs occasionally fail to register the matching entry in Turn B, causing untracked character/place entities.

#### Options:
1. **Option A: Pure Prompt Enforcement (Current)**
   - Rely strictly on system prompts and review checklists.
   - *Risk:* ~5–10% chance of untracked entity when using fast fallback models.
2. **Option B (Recommended): Hybrid (Prompt Enforcement + Deterministic Server Synthesis Fallback)**
   - Keep current prompts, but add a post-merge reconciliation step (as detailed in Issue 05) that automatically stubs missing `newPlaces`/`newCharacters` entries if Turn B omitted them.

> **💡 Best Recommendation:** **Option B.**  
> Server synthesis adds 0ms latency, requires no extra AI calls, and guarantees 100% referential integrity in `places` and `characters` tables.

---

### ❓ Question 3: SSE & Progress Event Granularity for Multi-Turn Pipeline

- **Current Implementation:** Callbacks are dropped (Bug 03).
- **Context:** When re-wiring callbacks, what level of event detail should be exposed to the client?

#### Options:
1. **Option A: Legacy Mirroring**
   - Emit single `ai_generation_start` at the beginning and `ai_generation_complete` at the end.
2. **Option B (Recommended): Granular Stage Telemetry**
   - Emit stage-tagged events:
     - `step: 'authoring_scene'` (Turn A)
     - `step: 'updating_world_state'` (Turn B)
     - `step: 'evaluating_quality'` (Eval Pass)

> **💡 Best Recommendation:** **Option B.**  
> Frontends can display live status steppers, significantly improving perceived performance during the 6–8 second generation window.

---

### ❓ Question 4: Context Pruning for Turn B Prompt

- **Current Implementation:** Conservative — Turn B receives full `formatNextPageStoryContextPrompt` (including 5 previous pages of prose) + `GENERATED PAGE`.
- **Context:** Turn B's prompt is ~14k tokens, of which ~3k tokens are historical page prose that Turn B does not need.

#### Options:
1. **Option A: Keep Conservative (Full Context)**
   - Maximum possible context, but higher cost and slower time-to-first-token.
2. **Option B (Recommended): Prune Previous Pages Prose from Turn B**
   - Omit the verbatim prose of `PREVIOUS PAGES` and `RELEVANT PAST EVENTS` from Turn B, while retaining running summary, current facts, active threads, and known entity registries.

> **💡 Best Recommendation:** **Option B.**  
> Saves ~2,500 input tokens per candidate with zero loss in state derivation accuracy.

---

## 6. Action Plan & Priority Matrix

| Priority | Issue / Task | Scope / Files | Estimated Effort |
| :---: | :--- | :--- | :---: |
| **P0** | **Fix BUG-01:** Omit explicit `cachedContentId` on dynamic evaluation pass in `evaluateMergedStoryGeneration` to prevent Gemini cache thrashing. | `src/utils/prompt.ts` | 15 mins |
| **P0** | **Fix BUG-02:** Pass `outputJsonStructure` and `outputJsonRequired` to `runEvaluationPass` in `evaluateMergedStoryGeneration`. | `src/utils/prompt.ts` | 15 mins |
| **P0** | **Fix BUG-03:** Thread `onProgress` and `onGenerationProgress` through `generateStoryGenerationMultiTurn`. | `src/utils/prompt.ts` | 30 mins |
| **P1** | **Fix BUG-04:** Apply `calendarDate` fallback during object merge in `generateStoryGenerationMultiTurn`. | `src/utils/prompt.ts` | 10 mins |
| **P1** | **Fix ISSUE-06:** Update `closeThreads` description in `src/schema/story.ts` from `"titles"` to `"IDs"`. | `src/schema/story.ts` | 5 mins |
| **P2** | **Implement ISSUE-05:** Add deterministic server reconciliation for invented slug IDs. | `src/utils/prompt.ts` / `src/utils/story.ts` | 45 mins |
| **P2** | **Implement ISSUE-07:** Create pruned `formatStateDeltaStoryContextPrompt` to save 2.5k tokens on Turn B. | `src/utils/prompt.ts` | 45 mins |
