# Multi-Turn Page Generation: Comprehensive Audit & Bug Report

> **Document Version:** 2.0.0
> **Date:** 2026-09-01
> **Status:** Review & Decision Pending
> **Audited Files:**
> - `src/utils/prompt.ts` (6085 lines — core orchestration, prompt builders, evaluators)
> - `src/utils/field-instructions.ts` (339 lines — generic field instruction sections)
> - `src/utils/ai-chat.ts` (2057 lines — `runEvaluationPass`, `aiPrompt`)
> - `src/utils/ai-parser.ts` (982 lines — `sanitise`, `parseAISafely`)
> - `src/schema/story.ts` (1229 lines — schema definitions)
> - `src/types/prompt.ts` (141 lines — `GenerationStageDefinition<T>`)
> - `src/config/ai-chat.ts` (121 lines — token budgets, feature flag)
> - `src/services/page-generation-checkpoints.ts` (174 lines — checkpoint cache)
> - `src/db/schema.ts` (checkpoint table definition)

---

## 1. Previous Report Status (BUG-01 through BUG-04, ISSUE-05 through ISSUE-07)

The original report (v1.0.0, 2026-08-19) identified 4 bugs and 3 issues. **All 4 bugs and ISSUE-06 have been fixed** in the current codebase through checkpoints 5–8. ISSUE-05 and ISSUE-07 remain open as documented deferred enhancements (Phases 9–10 in the roadmap).

| ID | Description | Status | Fix Location |
|---|---|---|---|
| **BUG-01** | Gemini cache thrashing — evaluator reused Turn A's `:story_page` slot | ✅ **Fixed** (checkpoint 5) | `prompt.ts:1839` — `createCacheKey([bookId, merged])` derives content-based key |
| **BUG-02** | Structured schema dropped — `outputJsonStructure`/`outputJsonRequired` missing | ✅ **Fixed** (checkpoint 5) | `prompt.ts:1861–1862` — now passes `STORY_GENERATION_SCHEMA_DEFINITION`/`STORY_GENERATION_REQUIRED_FIELDS` |
| **BUG-03** | SSE/DB progress callbacks dropped | ✅ **Fixed** (checkpoint 5) | `prompt.ts:5206–5207` — `onProgress`/`onGenerationProgress` now accepted and threaded through |
| **BUG-04** | `calendarDate` fallback applied too late | ✅ **Fixed** (checkpoint 5) | `prompt.ts:5335` — fallback applied at merge time before evaluation |
| **ISSUE-05** | No server-side slug-ID reconciliation | ⏳ **Deferred** (Phase 9) | Not implemented — documented future enhancement |
| **ISSUE-06** | Schema description said "titles" instead of "IDs" for `closeThreads` | ✅ **Fixed** | `schema/story.ts:601` — now reads "Thread IDs to be closed" |
| **ISSUE-07** | Turn B receives redundant previous-pages prose | ⏳ **Deferred** (Phase 10) | Not implemented — documented future enhancement |

---

## 2. New Issues Found in Current Codebase

### 🔴 NEW-01: Function Name Typo — `buildEvaluatorOuputFormatBlurb`

- **Severity:** Low / Code Quality
- **File:** `src/utils/prompt.ts:1482`

#### Description

The function name contains a typo: `buildEvaluatorOuputFormatBlurb` should be `buildEvaluatorOutputFormatBlurb` (missing `t` in "Output"). This is a public-facing identifier used in 3 locations (`prompt.ts:1482`, `prompt.ts:1503`, `prompt.ts:1910`). While it doesn't affect runtime behavior, it violates the codebase's naming conventions and creates friction for anyone grepping for "output" or "OutputFormat".

#### Proposed Solution

Rename to `buildEvaluatorOutputFormatBlurb` across all 3 call sites. This is a safe mechanical rename with no behavioral change.

```typescript
// Before
function buildEvaluatorOuputFormatBlurb(useStringEvaluatorOutput: boolean): string { ... }
// After
function buildEvaluatorOutputFormatBlurb(useStringEvaluatorOutput: boolean): string { ... }
```

**Effort:** 5 minutes. **Risk:** None.

---

### 🔴 NEW-02: Turn B Receives Full Previous Pages Prose (Token Waste)

- **Severity:** Medium / Cost & Latency
- **Files:** `src/utils/prompt.ts:3488–3563` (`formatNextPageStoryContextPrompt`), `prompt.ts:1218` (`buildStateDeltaPrompt`)

#### Description

Turn B's prompt is built via `buildStateDeltaPrompt`, which calls `formatNextPageStoryContextPrompt(params)` **identically** to Turn A. This means Turn B receives:

| Section | Tokens (est.) | Needed by Turn B? |
|---|---|---|
| `CURRENT PHASE` | ~50 | Yes — drives phase-conditional delta decisions |
| `MAIN CHARACTER (POV)` | ~200 | Marginal — inventory/injuries matter for `newCharacters` updates |
| `STORY CONTEXT` (summary + temporal) | ~150 | Yes — `contextHistory` summarization needs the running clock |
| `RELEVANT PAST EVENTS` (pgvector) | ~300–600 | **No** — semantic recall of past events is for narrative prose continuity, not state derivation |
| `CURRENT FACTS` | ~200 | Yes — `factUpdates` needs to know what's already established |
| `PREVIOUS PAGES` (5 pages of full prose) | ~1500–2500 | **No** — Turn B reads the `GENERATED PAGE` section; it doesn't need verbatim prose from 5 prior pages |
| `CURRENT PAGE` (actioned page prose) | ~400–600 | Marginal — action text is relevant, but full prose is redundant with `GENERATED PAGE` |
| `CURRENT SITUATION` | ~200 | Yes — character presence, scene momentum |
| `ACTION SELECTION` | ~100 | **No** — Turn B doesn't author actions |

**Estimated waste:** ~2,000–3,500 tokens per Turn B call (~25–35% of total input tokens).

#### Why This Matters

With 3 parallel multiverse candidates, each candidate runs Turn A + Turn B. Turn B's redundant tokens multiply: 3 candidates × ~2,500 wasted tokens = ~7,500 wasted tokens per page transition. At current API pricing, this is a non-trivial cost increase for zero quality improvement.

#### Proposed Solution

Create `formatStateDeltaStoryContextPrompt(params)` — a lightweight variant that retains only the sections Turn B needs:

```typescript
function formatStateDeltaStoryContextPrompt(params: BuildNextPagePromptParams): string {
  const { advancedState: state, actionedPage, book } = params;
  const { contextHistory, factsHistory, hiddenState } = state;
  const { calendarDate, elapsedDays } = actionedPage;
  const { storyStartDate } = book;

  // Only the sections Turn B actually reads
  return [
    `CURRENT PHASE:\n${getStoryStateInfo(state).phase} ${getStoryStateInfo(state).phaseGoal}`,
    `STORY CONTEXT:\n${contextHistory || 'No story summary yet.'}`,
    `CURRENT FACTS:\n${formatCurrentFacts(factsHistory)}`,
    `CURRENT SITUATION:\n${formatCurrentSituationForPrompt(actionedPage, state)}`,
  ].filter(Boolean).join('\n\n---\n');
}
```

Then update `buildStateDeltaPrompt` to call `formatStateDeltaStoryContextPrompt(params)` instead of `formatNextPageStoryContextPrompt(params)`.

**Effort:** 45 minutes. **Risk:** Low — Turn B's state derivation accuracy is grounded in the `GENERATED PAGE` section, not historical prose. The conservative design (keep facts, threads, entities) ensures no delta-relevant context is lost.

**Note:** This is the same conclusion as ISSUE-07 in the original report and Phase 10 in the roadmap. Both independently identified this as the single highest-ROI token optimization in the multi-turn pipeline.

---

### 🔴 NEW-03: Evaluator Prompt Duplicates Generation Prompt Content

- **Severity:** Medium / Cost & Prompt Bloat
- **File:** `src/utils/prompt.ts:1495–1524` (`buildNextPageEvaluatorPrompt`)

#### Description

`buildNextPageEvaluatorPrompt` constructs the evaluator's user prompt by including:

```typescript
const taskPrompt = `TASK: Evaluate a newly generated branching story page...

Original task (on previous AI): ${formatNextPageTaskPrompt(state, candidateCount, language, book.mode)}

${formatNextPageStoryContextPrompt(params)}

---
${formatNextPageNarrativePrompt(params)}

---
EXPECTED JSON SCHEMA:
${candidateCount > 1 ? multiNextPageOutputFormat : nextPageOutputFormat}

---
FIELD INSTRUCTIONS:
${buildNextPageFieldInstructions(state, action, sceneType)}`;
```

The evaluator prompt includes the **full story context**, **full narrative style**, **full field instructions**, and **full expected JSON schema** — all of which were already sent in the generation prompt. The evaluator model receives these instructions twice: once baked into the `systemPrompt` (which is passed through from the generation call), and again in the user prompt.

This means the evaluator's ~12k token prompt is ~50% redundant content that was already used to produce the output being evaluated.

#### Impact

- **Cost:** The evaluation pass sends ~6k redundant tokens per call. With 3 parallel candidates, that's ~18k redundant tokens per page transition.
- **Latency:** Extra input tokens increase time-to-first-token on the evaluation call.
- **Quality risk:** The evaluator seeing the same instructions twice may bias it toward the model's own generation style rather than providing an independent assessment.

#### Proposed Solution

Strip the redundant sections from the evaluator prompt. The evaluator only needs:
1. The **task framing** (what was being evaluated)
2. The **scoring rubric** (how to score)
3. The **STEP 3 CORRECT** instructions (how to fix)
4. The **output format** (what shape to return)

The story context, narrative style, and field instructions are already baked into the `systemPrompt` the evaluator receives. Repeating them in the user prompt is pure waste.

```typescript
// Proposed evaluator prompt structure
const taskPrompt = `TASK: Evaluate a newly generated story page...

Original task: ${formatNextPageTaskPrompt(state, candidateCount, language, book.mode)}

---
SCORING RUBRIC:
${buildScoringRubric(state)}

---
STEP 3 — CORRECT
${buildCorrectionInstructions()}`;
```

**Effort:** 1 hour. **Risk:** Low — the evaluator's rubric and correction logic are self-contained; the story context/narrative style/field instructions are not referenced by the rubric dimensions.

---

### 🟡 NEW-04: Missing `AbortSignal` Propagation in Non-Streaming Path

- **Severity:** Medium / UX Degradation on Client Disconnect
- **Files:** `src/utils/prompt.ts:5854` (`executePromptForJSON`), `prompt.ts:5141` (`runGenerationStage`), `prompt.ts:5200` (`generateStoryGenerationMultiTurn`)

#### Description

The SSE streaming path (`aiStreamSSE`) properly propagates `c.req.raw.signal` for client disconnect cancellation. However, the non-streaming structured-output path (`executePromptForJSON` → `aiPrompt`) does **not** accept or propagate an `AbortSignal`:

```typescript
// executePromptForJSON — no signal parameter
export async function executePromptForJSON<T extends Record<string, unknown>>(
  params: AIPromptForJsonParams<T>,
  onProgress?: ProgressCallback,
  onGenerationProgress?: (step: StoryGenerationStep) => Promise<void>,
): Promise<AIResponse<T>> { ... }
```

This means when a client disconnects during a multi-turn generation (or any non-streaming generation), the in-flight AI API calls continue consuming GPU resources until they naturally complete or time out. For multi-turn generation specifically, a client disconnect during Turn A means Turn A + Turn B + Evaluation all continue running wastefully.

#### Proposed Solution

Thread `AbortSignal` through the non-streaming path:

1. Add `signal?: AbortSignal` to `executePromptForJSON`'s signature
2. Pass it to `aiPrompt` (which already supports it internally via `aiStreamSSE` or provider SDK abort handlers)
3. Add `signal?: AbortSignal` to `GenerationStageDefinition<T>` and `generateStoryGenerationMultiTurn`
4. Thread from `generateNextPage`/`generateNextPages` which already receive `c.req.raw.signal` from route handlers

**Effort:** 30 minutes. **Risk:** Low — `aiPrompt` already handles `AbortSignal` internally; this is purely plumbing.

---

### 🟡 NEW-05: Turn B System Prompt Missing `RULES_FALSE_PREVIEW`

- **Severity:** Low / Design Consistency
- **Files:** `src/utils/prompt.ts:353–385` (`buildPresetSystemPrompt`)

#### Description

Turn A uses `buildPresetSystemPrompt('next', nextPreset)` which includes:
- `RULES_ROUTE_MEMORY`
- `RULES_STORY_CONSISTENCY`
- `RULES_FUTURE_NOTES`
- **`RULES_FALSE_PREVIEW`**
- `buildFirstPageRuleSet(preset)`

Turn B uses `buildPresetSystemPrompt('state-delta', nextPreset)` which includes:
- `RULES_ROUTE_MEMORY`
- `RULES_STORY_CONSISTENCY`
- `RULES_FUTURE_NOTES`
- `RULES_CHARACTER`
- `RULES_CHARACTER_RECOGNITION`
- `RULES_PLACE`

Turn B is **missing** `RULES_FALSE_PREVIEW`. This is likely intentional (Turn B doesn't write narrative previews), but it creates an asymmetry: the evaluator scoring the merged object uses the `'next'` system prompt (via the `systemPrompt` parameter passed to `evaluateMergedStoryGeneration`), which includes `RULES_FALSE_PREVIEW`. This means the evaluator was generated under rules that Turn B never saw.

#### Impact

Minimal — `RULES_FALSE_PREVIEW` governs narrative misdirection in prose, which Turn B doesn't write. The evaluator sees it because it evaluates the merged object including Turn A's prose. However, the asymmetry is worth documenting.

#### Proposed Solution

No code change needed. Document the rationale in `buildPresetSystemPrompt`:

```typescript
case 'state-delta':
  return [
    RULES_ROUTE_MEMORY,
    RULES_STORY_CONSISTENCY,
    RULES_FUTURE_NOTES,
    // RULES_FALSE_PREVIEW intentionally omitted: governs narrative
    // misdirection in prose — Turn B authors state deltas, not prose.
    RULES_CHARACTER,
    RULES_CHARACTER_RECOGNITION,
    RULES_PLACE,
  ].join('\n\n---\n');
```

**Effort:** 5 minutes. **Risk:** None.

---

### 🟡 NEW-06: Memoization Key Fragility in `formatNextPageNarrativePrompt`

- **Severity:** Low / Correctness Risk
- **File:** `src/utils/prompt.ts:3580–3631`

#### Description

`formatNextPageNarrativePrompt` memoizes its result using `params` (a `BuildNextPagePromptParams` object) as the cache key via `narrativePromptCache.get(params)`:

```typescript
let perBool = narrativePromptCache.get(params);
if (!perBool) { perBool = new Map<boolean, string>(); narrativePromptCache.set(params, perBool); }
const cached = perBool.get(includeProseStyle);
```

This relies on **object identity** — the same JavaScript object reference. The code comment explains this is safe because `params` is created fresh per `prepareNextPageGenerationSetup` call and reused across parallel fates within one `generateNextPages` call.

However, this is fragile:
1. If someone refactors `prepareNextPageGenerationSetup` to cache/reuse the `promptParams` object across calls, the memoization would return stale results.
2. If `promptParams` properties are mutated after creation (e.g., a field is updated between fates), the cached result would be stale.
3. The `narrativePromptCache` is never explicitly bounded — if `params` objects accumulate without cleanup, it could grow unbounded.

#### Proposed Solution

Two options:

**Option A (conservative):** Add a comment documenting the invariant and the risks of breaking it:

```typescript
// INVARIANT: `params` must be a fresh object created per
// prepareNextPageGenerationSetup call. Never reuse or mutate
// promptParams across calls. Cache is per-request and bounded
// by the number of parallel fates (typically 1–3).
```

**Option B (robust):** Replace identity-based caching with content-based caching using a stable key (e.g., `advancedState.page` + `actionedPage.id` + `includeProseStyle`):

```typescript
const cacheKey = `${advancedState.page}:${actionedPage.id}:${includeProseStyle}`;
const cached = narrativePromptCache.get(cacheKey);
```

**Effort:** 15 minutes (Option A) or 30 minutes (Option B). **Risk:** Low — the current identity-based approach works correctly today; this is a defensive improvement.

---

### 🟡 NEW-07: Evaluator Evaluation Threshold Inconsistency

- **Severity:** Low / Design Inconsistency
- **Files:** `src/utils/prompt.ts:1542` (page generation), `prompt.ts:1950` (book creation)

#### Description

The page generation evaluator corrects when `scoreBefore < 75`:
```typescript
// prompt.ts:1542
Only rewrite if total scoreBefore < 75, ...
```

The book creation evaluator corrects when `scoreBefore < 80`:
```typescript
// prompt.ts:1950
Only rewrite if total scoreBefore < 80, ...
```

The 5-point difference is intentional (the doc comment at line 1901 says "a flawed initialization contaminates every page downstream"), but the threshold values are hardcoded magic numbers scattered across two functions. If the project ever wants to tune these thresholds, they need to be updated in two places.

#### Proposed Solution

Extract to named constants in `config/ai-chat.ts` or `config/story.ts`:

```typescript
// config/story.ts
export const EVALUATION_CORRECTION_THRESHOLD_PAGE = 75;
export const EVALUATION_CORRECTION_THRESHOLD_BOOK_CREATION = 80;
```

**Effort:** 10 minutes. **Risk:** None.

---

### 🟡 NEW-08: `checkGeneratedPage` Sanity Check Is Schema-Only

- **Severity:** Low / Checkpoint Cache Quality
- **Files:** `src/utils/prompt.ts:5272`, `src/utils/page-validation.ts:217`

#### Description

The checkpoint cache uses `checkGeneratedPage(storyPage, undefined, ...)` as a gate before caching Turn A's output:

```typescript
// prompt.ts:5272
const turnAHealthy = checkGeneratedPage(storyPage, undefined, `${baseContext}:turnA`);
```

`checkGeneratedPage` (`page-validation.ts:217`) validates schema compliance: required fields present, valid enum values, valid array lengths, etc. It does **not** validate semantic quality — a page with empty `text`, garbled prose, or a POV break would pass the sanity check as long as the JSON structure is valid.

This means a schema-valid but semantically broken Turn A could be cached and replayed on every retry, defeating the self-healing property the checkpoint is designed to provide.

#### Impact

Low — the evaluator pass runs after the checkpoint write and would catch semantic issues. But the evaluator corrects rather than rejects, so a cached semantically-weak page persists as the "base" that the evaluator corrects from, potentially producing lower-quality corrections than a fresh Turn A would.

#### Proposed Solution

Add lightweight semantic checks to the checkpoint gate:

```typescript
const turnAHealthy = checkGeneratedPage(storyPage, undefined, `${baseContext}:turnA`)
  && (storyPage.text?.length ?? 0) > 100  // minimum viable prose length
  && (storyPage.actions?.length ?? 0) >= MIN_ACTION_CHOICES;  // must offer choices
```

**Effort:** 15 minutes. **Risk:** Low — adding stricter validation to the cache gate only means fewer (higher-quality) cache entries; a miss just means Turn A runs fresh, which is the baseline behavior.

---

### ⚪ NEW-09: No TTL on In-Memory Narrative Prompt Cache

- **Severity:** Informational / Memory Hygiene
- **File:** `src/utils/prompt.ts:3583–3586`

#### Description

`narrativePromptCache` is an in-memory `Map` used for page-scoped memoization of `formatNextPageNarrativePrompt`. The cache is never explicitly cleared — it relies on `params` object references being garbage-collected when the generation request completes.

In a serverless environment (Vercel), this is fine — the process is ephemeral. But in a long-running local dev server (`bun dev`), the cache grows with each generation request and is never pruned. Over a long dev session with many page generations, this could accumulate stale entries.

#### Proposed Solution

Add a `maxSize` bound or use an LRU cache instead of a plain `Map`:

```typescript
import { LRUCache } from 'lru-cache';

const narrativePromptCache = new LRUCache<string, Map<boolean, string>>({
  max: 100,  // bound to ~100 recent generation requests
  ttl: 5 * 60 * 1000,  // 5 minutes
});
```

Or, simpler: export a `clearPromptCaches()` function callable from dev tooling.

**Effort:** 15 minutes. **Risk:** None in serverless; minimal in long-running processes.

---

## 3. Design Improvements (Not Bugs, But Worth Considering)

### IMP-01: Evaluate Turn A Before Turn B (Alternative Evaluation Strategy)

**Current:** Single post-merge evaluation on the combined `StoryGeneration`.
**Alternative:** Evaluate Turn A's prose *before* Turn B runs, so Turn B always extracts state from already-polished prose.

| Approach | Pros | Cons |
|---|---|---|
| **Post-merge (current)** | 1 evaluator call; catches cross-turn inconsistencies; reuses fully-tested rubric | Turn B extracts state from potentially-flawed prose |
| **Turn A only (before B)** | Turn B operates on corrected prose; evaluator focuses 100% on narrative quality; evaluator prompt is smaller (~5k vs ~12k) | Turn B's structural correctness gets no evaluation pass; reintroduces per-turn cost concern (1 extra call) |

**Recommendation:** Keep post-merge for now. The quality difference is marginal (evaluator corrects the merged object anyway), and the cost simplification is valuable. Revisit if Turn B state-derivation accuracy from uncorrected prose becomes a measurable issue.

---

### IMP-02: Deterministic Slug-ID Reconciliation (Phase 9)

**Current:** Pure prompt-level convention (Turn A invents, Turn B reuses).
**Alternative:** Add a server-side reconciliation step after merge that stubs missing `newCharacters`/`newPlaces` entries.

This is already documented as Phase 9 in the roadmap. The implementation sketch exists in the roadmap. Key open question: what should a "minimum-viable synthesized character" contain? (Placeholder name from slug? Inferred from page text? Flagged specially for UI?)

**Recommendation:** Implement when telemetry shows slug-ID mismatch rate exceeds 1% of page generations.

---

### IMP-03: Stage-Tagged SSE Events for Frontend Progress

**Current:** `runGenerationStage` tags progress events with `stage: 'story_page' | 'state_delta'` (checkpoint 5 fix).
**Enhancement:** Expose granular step labels to the frontend:

```typescript
// Frontend could display:
// "Authoring prose..." (Turn A)
// "Updating world state & consequences..." (Turn B)
// "Refining output..." (Evaluation)
```

**Recommendation:** Implement alongside the frontend multi-turn progress UI.

---

## 4. Performance & Rate Limit Analysis

### API Call Count Comparison

| Path | Legacy | Multi-Turn |
|---|---|---|
| Single page (`generateNextPage`) | 1 generation + 1 eval = **2 calls** | 1 Turn A + 1 Turn B + 1 eval = **3 calls** |
| Multiverse 3 candidates (`generateNextPages`) | 1 batch generation + 1 eval = **2 calls** | 3 × (Turn A + Turn B + eval) = **9 calls** |

### Rate Limit Impact

With `candidateCount = 3` (default multiverse):
- **Cerebras (30 RPM):** 9 calls consume ~30% of quota per page transition
- **Groq (30 RPM):** Same
- **Gemini (2000 RPM):** Negligible impact
- **Mistral (varies):** Depends on plan tier

**Mitigation in place:** `src/utils/ai-limiters.ts` Bottleneck token-bucket limiters with `retryWithBackoff`.

**Recommendation:** Ensure the provider waterfall has ≥3 high-capacity providers (Gemini, Mistral, OpenRouter) enabled so parallel bursts spill over without blocking.

---

## 5. Action Plan & Priority Matrix

| Priority | ID | Issue | Effort | Risk |
|---|---|---|---|---|
| **P1** | NEW-02 | Turn B context pruning (~25–35% token savings) | 45 min | Low |
| **P1** | NEW-03 | Evaluator prompt deduplication (~6k tokens saved) | 1 hr | Low |
| **P2** | NEW-04 | AbortSignal propagation in non-streaming path | 30 min | Low |
| **P2** | NEW-08 | Semantic checks in checkpoint cache gate | 15 min | Low |
| **P3** | NEW-01 | Rename `buildEvaluatorOuputFormatBlurb` | 5 min | None |
| **P3** | NEW-05 | Document RULES_FALSE_PREVIEW omission rationale | 5 min | None |
| **P3** | NEW-06 | Memoization key robustness | 15–30 min | Low |
| **P3** | NEW-07 | Extract evaluation thresholds to named constants | 10 min | None |
| **P3** | NEW-09 | Bounded narrative prompt cache | 15 min | None |

---

## 6. Summary

| Category | Count | Status |
|---|---|---|
| Previous bugs (BUG-01–04) | 4 | All fixed |
| Previous issues (ISSUE-05–07) | 3 | 1 fixed, 2 deferred |
| New issues found | 9 | Open |
| Design improvements | 3 | Documented |

**Overall architectural health:** The multi-turn pipeline is structurally sound. The schema composition (same objects, not copies), the field instruction split (single-source array filtered by stage), the checkpoint cache (best-effort, deterministic keying), and the parallel multiverse (`Promise.allSettled` isolation) are all well-designed. The issues found are primarily token-efficiency optimizations and defensive hardening, not correctness bugs.

---

## 7. Pen State Proposal vs Multi-turn Turn B: Overlap Analysis & DRY Opportunity

> **Scope**: This section audits whether Pen's `/finalize/propose` state-inference logic duplicates Turn B's StateDelta pipeline, and proposes a shared abstraction if warranted.

### 7.1 Core Job Comparison

Both systems perform the **same conceptual task**: read a generated story page and infer what changed in the story state. The execution differs significantly, however.

| Dimension | Pen `/finalize/propose` | Multi-turn Turn B (StateDelta) |
|---|---|---|
| **Trigger** | Author calls `POST /api/pen/sessions/:id/finalize/propose` with `draftText` | Automatic after Turn A (StoryPage) completes |
| **Input** | Author's draft prose (plain text) + canon context | AI-generated story page + canon context |
| **Output semantics** | **Full replacement** — model returns COMPLETE resulting inventory/injuries/scene; must carry forward everything that persists | **Delta** — model returns only what changed; engine merges via `resolvePageDelta` |
| **Human-in-the-loop** | Proposal → author accepts/edits in publish dialog → adopted via `/finalize` | Fully automated; no human review step |
| **Schema scope** | 13 fields (scene metadata + inventory + injuries + facts + flags + action classification) | ~30 fields (all of Pen's overlapping fields PLUS characters, places, threads, psychology, future notes, branchNames, minutesPassed, viableEnding) |
| **Context budget** | 2 pages of prose (~3–5k tokens) | 5 previous pages + full story context (~14k+ tokens) |
| **Credit cost** | Free (`PEN_FINALIZE_PROPOSE` = 0) | Part of page generation credit |
| **Audit trail** | `penEdits` row with `editType: 'plan'` | No separate audit; embedded in generation |

### 7.2 Field-Level Overlap Matrix

| Field | Pen Schema | Turn B Schema | Identical? | Notes |
|---|---|---|---|---|
| `inventory` | `PenStateProposalInventoryItem[]` (full replacement) | `INVENTORY_ITEM_SCHEMA[]` (delta) | **Same shape, different semantics** | Pen model carries forward all items; Turn B outputs only changes |
| `injuries` | `PenStateProposalInjury[]` (full replacement) | `INJURY_SCHEMA[]` (delta) | **Same shape, different semantics** | Same pattern as inventory |
| `mood` | `enum moods` | `enum moods` (page stage) | **Identical** | Both constrained to same enum |
| `weather` | `enum placeWeathers` | `enum placeWeathers` (page stage) | **Identical** | Both constrained to same enum |
| `calendarDate` | `string YYYY-MM-DD` | `string yyyy-MM-dd` | **Identical** | Same format |
| `timeOfDay` | `string` | `string` | **Identical** | Same semantics |
| `keyEvents` | `string[]` | `string[]` (page stage) | **Identical** | Both editorial scene metadata |
| `keyObjects` | `string[]` | `string[]` (page stage) | **Identical** | Both editorial scene metadata |
| `plotFlags` | `{fact, type, isMajorEvent}[]` | `addPlotFlags` (same shape) | **Identical** | Same schema structure |
| `facts` | `{key, value, type?, reason?}[]` | `factUpdates` (same shape) | **Near-identical** | Pen uses `facts`, Turn B uses `factUpdates`; Turn B adds `page` field |
| `outline` | Separate `outline` field with `isDone`/`doneAtPage` | Nested in `viableEnding.outline` | **Same concept, different nesting** | Pen surfaces outline as top-level; Turn B nests under viableEnding |
| `actionType` | `enum actionTypes` | ❌ not in delta | **Pen-only** | D-4 core: classifies author's choice text |
| `actionHintText` | `string` | ❌ not in delta | **Pen-only** | D-4 core: AI-inferred reader-facing hint |
| `actionHintType` | `enum actionHintTypes` | ❌ not in delta | **Pen-only** | D-4 core: hint classification |
| `newCharacters` | ❌ | `INITIAL_CHARACTER_SCHEMA[]` | **Turn B-only** | |
| `updatedCharacters` | ❌ | `UPDATE_CHARACTER_SCHEMA[]` | **Turn B-only** | |
| `relationshipUpdates` | ❌ | `RELATIONSHIP_UPDATE_SCHEMA[]` | **Turn B-only** | |
| `newPlaces` / `updatedPlaces` | ❌ | `INITIAL_PLACE_SCHEMA[]` / `UPDATE_PLACE_SCHEMA[]` | **Turn B-only** | |
| `contextHistory` | ❌ (Pen doesn't update running summary) | `string` | **Turn B-only** | |
| `newThreads` / `updateThreads` / `addClues` / `closeThreads` | ❌ | Thread schemas | **Turn B-only** | |
| `futureNoteAdd` / `futureNoteRemove` | ❌ | `FUTURE_NOTE_SCHEMA[]` | **Turn B-only** | |
| `traumaTagAdd` / `traumaTagRemove` | ❌ | `string[]` | **Turn B-only** | |
| `flagUpdates` (psychological) | ❌ | `{type, level}[]` | **Turn B-only** | |
| `viableEnding` | ❌ (Pen uses separate `/ending` endpoint) | `VIABLE_ENDING_SCHEMA` | **Turn B-only** | |
| `minutesPassed` | ❌ | `number` | **Turn B-only** | |
| `branchNames` | ❌ | `string[]` | **Turn B-only** | |

### 7.3 Prompt Context Comparison

**Pen State Proposal** (`buildPenStateProposalPrompt` in `src/utils/pen-prompt.ts:1053`):
```
Stable-per-session: persona, summary, lore, narrative style, language
Per-page: CANONICAL STATE (via buildCanonicalBlock), RECENT STORY (2 pages)
Per-request: CURRENT DRAFT, CURRENT SCENE, CURRENT INVENTORY & INJURIES
Option lists: MOOD OPTIONS, WEATHER OPTIONS, CATEGORY OPTIONS, ACTION TYPE OPTIONS, etc.
Estimated: ~3–5k tokens
```

**Turn B StateDelta** (`buildStateDeltaPrompt` in `src/utils/prompt.ts:1218`):
```
TASK: formatStateDeltaTaskPrompt (delta instructions)
CONTEXT: formatNextPageStoryContextPrompt (~14k tokens)
  - CURRENT PHASE + phase goal
  - MAIN CHARACTER (POV) + inventory + injuries
  - STORY CONTEXT (contextHistory + temporal)
  - RELEVANT PAST EVENTS (vector retrieval)
  - CURRENT FACTS
  - PREVIOUS PAGES (5 pages of prose)
  - CURRENT PAGE (the generated page)
  - CURRENT SITUATION
  - ACTION SELECTION
GENERATED PAGE: formatGeneratedPageForDeltaPrompt
NARRATIVE RULES: formatNextPageNarrativePrompt
FIELD INSTRUCTIONS: buildStateDeltaFieldInstructions (all delta fields)
Estimated: ~14k+ tokens
```

### 7.4 Service Flow Comparison

**Pen** (`proposePenStateUpdates` in `src/services/pen.ts:2332`):
1. Load session + book + state + branch path + page texts
2. Resolve triggered lore entries
3. Build prompt via `buildPenStateProposalPrompt`
4. Execute AI with `PEN_STATE_PROPOSAL_SCHEMA` → `aiPrompt`
5. Coerce via `coerceStateProposal` (validates enums, clamps lengths, merges outline)
6. Write audit trail (`penEdits` editType `plan`)
7. Return proposal to frontend
8. **Human review**: author accepts/edits in publish dialog
9. `finalizePenDraft` injects adopted fields into `generatedStoryPage`
10. `resolvePageDelta` computes state delta from the story page
11. `persistPageWithState` writes page + new state

**Turn B** (automated within `generateStoryGenerationMultiTurn`):
1. Inherited from Turn A (state, action, generated page)
2. `runGenerationStage` → `buildStateDeltaPrompt`
3. Execute AI with `STATE_DELTA_WITH_BRANCH_SCHEMA_DEFINITION` → `runGenerationStage`
4. `resolvePageDelta` computes state delta from AI output
5. `persistPageWithState` writes page + new state

### 7.5 Shared Infrastructure Already in Place

Both systems already share:
- **`buildCanonicalBlock`** (`src/utils/pen-prompt.ts:213`) — renders compact canonical state block; Pen calls it directly, engine uses a different renderer
- **`createNarrativeStyle`** (`src/utils/narrative-style.ts`) — both generate narrative style instructions from state
- **`resolvePageDelta`** (`src/utils/prompt.ts`) — both ultimately call this to compute the final state delta
- **`advanceStoryState`** (`src/utils/story.ts`) — both advance state before delta computation
- **`processPlotFlagUpdates` / `processFactUpdates`** (`src/utils/story.ts`) — both apply flags/facts to state

### 7.6 Recommendation: Targeted DRY Extraction (Not Full Unification)

**Full unification is NOT recommended** because:
1. Different output semantics (replacement vs delta) make a shared schema impractical
2. Different schema scopes (Pen is deliberately narrow; Turn B is comprehensive)
3. Different context budgets (Pen is lightweight for sub-second latency; Turn B has full context)
4. Different execution patterns (proposal+human-review vs automated)

**Targeted DRY extraction IS recommended** for these shared pieces:

#### IMP-04: Shared Inventory/Injury Coercion (Priority: P3, Effort: 1 hr)

Both systems validate and coerce inventory items and injuries with near-identical logic:
- `coerceStateProposalInventoryItem` (`src/services/pen.ts:2051`)
- `coerceStateProposalInjury` (`src/services/pen.ts:2105`)
- Turn B's `INVENTORY_ITEM_SCHEMA` / `INJURY_SCHEMA` (`src/schema/story.ts`)

**Proposal**: Extract shared `coerceInventoryItems(raw: unknown[]) → InventoryItem[]` and `coerceInjuries(raw: unknown[]) → Injury[]` into a new `src/utils/state-coercion.ts` module. Both Pen and Turn B call these instead of implementing their own validation. The `coerceStateProposal` function in `pen.ts` becomes a thin wrapper that calls the shared coercers + Pen-specific fields (outline, plotFlags, facts, actionType/hint).

#### IMP-05: Shared Field Instruction Fragments (Priority: P3, Effort: 45 min)

The overlapping fields (inventory, injuries, facts, flags) have nearly identical instruction prose in:
- `PEN_STATE_PROPOSAL_SYSTEM` (`src/utils/pen-prompt.ts:779`)
- `buildStateDeltaFieldInstructions` (`src/utils/field-instructions.ts:333`)

**Proposal**: Extract shared instruction fragments for inventory/injuries/facts/flags into `src/utils/field-instructions.ts` as named exports (e.g., `INVENTORY_FIELD_INSTRUCTIONS`, `INJURIES_FIELD_INSTRUCTIONS`). Both Pen's system prompt and Turn B's field instructions compose from these fragments. This prevents the two from drifting when inventory semantics evolve (e.g., the `amount: 0 → auto-remove` rule).

#### IMP-06: Shared Plot Flag / Fact Coercion (Priority: P3, Effort: 30 min)

Both systems coerce plot flags and facts with identical validation:
- `coerceStateProposal` (`src/services/pen.ts:2231–2259`)
- Turn B's schema-level validation + `processPlotFlagUpdates` / `processFactUpdates`

**Proposal**: Extract `coercePlotFlags(raw: unknown[]) → PlotFlag[]` and `coerceFacts(raw: unknown[]) → FactUpdate[]` into `src/utils/state-coercion.ts`.

### 7.7 Updated Priority Matrix

| Priority | ID | Issue | Effort | Risk |
|---|---|---|---|---|
| **P1** | NEW-02 | Turn B context pruning (~25–35% token savings) | 45 min | Low |
| **P1** | NEW-03 | Evaluator prompt deduplication (~6k tokens saved) | 1 hr | Low |
| **P2** | NEW-04 | AbortSignal propagation in non-streaming path | 30 min | Low |
| **P2** | NEW-08 | Semantic checks in checkpoint cache gate | 15 min | Low |
| **P3** | NEW-01 | Rename `buildEvaluatorOuputFormatBlurb` | 5 min | None |
| **P3** | NEW-05 | Document RULES_FALSE_PREVIEW omission rationale | 5 min | None |
| **P3** | NEW-06 | Memoization key robustness | 15–30 min | Low |
| **P3** | NEW-07 | Extract evaluation thresholds to named constants | 10 min | None |
| **P3** | NEW-09 | Bounded narrative prompt cache | 15 min | None |
| **P3** | IMP-04 | Shared inventory/injury coercion | 1 hr | Low |
| **P3** | IMP-05 | Shared field instruction fragments | 45 min | Low |
| **P3** | IMP-06 | Shared plot flag / fact coercion | 30 min | Low |

### 7.8 Updated Summary

| Category | Count | Status |
|---|---|---|
| Previous bugs (BUG-01–04) | 4 | All fixed |
| Previous issues (ISSUE-05–07) | 3 | 1 fixed, 2 deferred |
| New issues found | 9 | Open |
| Design improvements | 3 | Documented |
| Pen/Turn B overlap analysis | 1 | Documented (§7) |
| New DRY improvements | 3 | Proposed (IMP-04–06) |
