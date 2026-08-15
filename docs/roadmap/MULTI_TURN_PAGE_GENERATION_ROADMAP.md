# Twistloom — Multi-Turn (Stage-Split) Page Generation Roadmap

**Date:** August 15, 2026
**Scope:** Split the single monolithic "page + state delta" AI request into **2 sequential structured generation turns** — `StoryPage` then `StateDelta` — with parallel per-alternative turns for the multiverse `generatedPages` flow, plus idempotent partial-persistence + cron retry so a succeeded `StoryPage` never needs to be regenerated when only its `StateDelta` failed.

Every feasibility verdict below was verified against the actual source in `src/schema/story.ts`, `src/utils/prompt.ts`, `src/utils/ai-chat.ts`, `src/types/ai-chat.ts`, `src/config/ai-chat.ts`, `src/services/book.ts`, `src/utils/candidate-generation.ts`, `src/db/schema.ts`, and `src/cron/retry-pending-generations.ts`.

> **How to read this doc.** Part 0 = the design decision taken from `TODO-multi-turn-request.md` (and what we are deliberately *not* doing). Part 1 = what already exists in the code so proposals don't re-build machinery. Part 2 = the target architecture (schemas, prompts, orchestration, token budgets, retry). Part 3 = the phased, step-by-step execution plan with `file:line` references and concrete patch snippets. Part 4 = risks & mitigations. Part 5 = decisions needed from you before starting.

---

## ✅ Implementation Status (at a glance)

| Status | Phase / Item | Effort | Impact (before → after) | Files changed |
|---|---|---|---|---|
| ⏳ **TODO** | **Phase 0 — schema split** (page vs delta schema definitions + required fields) | small | One 30-key combined schema → two ~10-key / ~20-key schemas; Gemini constrained-decoder (depth >6 / >100 props) pressure drops | `src/schema/story.ts`, `src/types/story.ts` |
| ⏳ **TODO** | **Phase 1 — per-turn prompt builders** (page vs delta task/field-instructions/review-checklist/output-format/evaluator) | medium | Same giant user prompt → two specialized prompts; each turn's context is trimmed to what it needs | `src/utils/prompt.ts`, `src/config/book-creation.ts` |
| ⏳ **TODO** | **Phase 2 — per-turn output-token budgets** (halved `DEFAULT_MAX_OUTPUT_TOKEN` / `EVALUATION_SCORING_OUTPUT_TOKEN`) | tiny | `generateNextPages` `*candidateCount` multiplication removed; per-turn budgets | `src/config/ai-chat.ts`, `src/utils/prompt.ts` |
| ⏳ **TODO** | **Phase 3 — stage orchestration types** in the AI-chat layer | small | `executePromptForJSON` stays single-shot; new `runGenerationStage` orchestrates turn A → turn B, threads turn-A output into turn-B `documents` | `src/types/prompt.ts`, `src/utils/prompt.ts` |
| ⏳ **TODO** | **Phase 4 — `generateNextPage` 2-turn refactor** | medium | `generateNextPage` becomes: StoryPage → StateDelta → merge → master validate → persist (persist unchanged) | `src/utils/prompt.ts` |
| ⏳ **TODO** | **Phase 5 — `generateNextPages` parallel multi-turn refactor** | medium | `generatedPages` batch request → N parallel StoryPage turns → N parallel StateDelta turns → merge each → existing per-alt persist loop | `src/utils/prompt.ts` |
| ⏳ **TODO** | **Phase 6 — partial-persistence tracking (DB)** | medium | New `page_generation_tasks` table so a succeeded StoryPage survives a failed StateDelta; rows are idempotency keys | `src/db/schema.ts`, `src/utils/prompt.ts`, migration |
| ⏳ **TODO** | **Phase 7 — idempotent state-delta retry cron** | medium | `retry-pending-generations.ts` (or a sibling cron) completes only the missing StateDelta turn, reusing existing locking/cleanup | `src/cron/retry-pending-generations.ts` |
| ⏳ **TODO** | **Phase 8 — verification & flag** | small | `USE_MULTI_TURN_GENERATION` feature flag + typecheck/lint + manual multiverse test; rollback is flipping the flag | `.env.example`, `src/config/*` |

**Quality gates (post-change):** `bun run typecheck` · `bun run lint:fast` · `bun run lint:imports`.

---

## Part 0 — The Design Decision (from `TODO-multi-turn-request.md`)

The ChatGPT answer's core thesis, which we adopt verbatim:

> **One narrative generation → several small structured generation stages → deterministic server-side merge → final validation.**

We are **NOT** doing a literal conversational multi-turn where every turn re-sends accumulated JSON (that "recreates the large-context problem through accumulation"). We are doing **independent structured stages** where each request gets only what it needs, and the server merges the stage outputs deterministically.

### 0.1 Why 2 turns, and why sequential (not parallel) between them

`StateDeltaGeneration` (characters/places/threads/facts/inventory/injuries/viableEnding/contextHistory…) is **derived from what happened in the page text**. The ChatGPT doc explicitly calls this out as the one case where sequencing pays off:

- **Stage A — StoryPage:** `story context + writing instructions + small page schema` → `{ text, mood, placeId, weather, calendarDate, timeOfDay, sceneType, charactersPresent, keyEvents, keyObjects, actions }`.
- **Stage B — StateDelta:** `story context + the generated page + state instructions + small delta schema` → `{ newCharacters, updatedCharacters, newPlaces, ..., futureNoteAdd, factUpdates, contextHistory, inventory, injuries, viableEnding, minutesPassed, branchNames }`.

Turn B *reads* Turn A's output. The codebase already has a clean precedent for "feed previous AI output as a document": the evaluator pass passes `GENERATED JSON (from previous AI)` via `documents` (`src/utils/ai-chat.ts:1590–1597`). Turn B reuses that exact mechanism.

### 0.2 Why `generatedPages` is parallel per alternative

`CANDIDATE_GENERATION_SCHEMA_DEFINITION` today asks for `generatedPages: [StoryGeneration × candidateCount]` in **one** request with `maxOutputToken = DEFAULT_MAX_OUTPUT_TOKEN * candidateCount` (`src/utils/prompt.ts:4783`). Target shape:

```text
            ┌─ StoryPage (alt 1) ─┐   ┌─ StateDelta (alt 1) ─┐
Story ──────┼─ StoryPage (alt 2) ─┼───┼─ StateDelta (alt 2) ─┼──→ merge each alt → validate → persist
            └─ StoryPage (alt 3) ─┘   └─ StateDelta (alt 3) ─┘
                 Phase 1: parallel          Phase 2: parallel
```

Phase 1 runs all StoryPage turns in parallel (`Promise.all`), Phase 2 runs all StateDelta turns in parallel once Phase 1 resolves. Latency ≈ 2 sequential layers regardless of `candidateCount` (the ChatGPT doc's "2 sequential latency layers instead of 4").

### 0.3 Known trade-off: RPM/RPD increase

Splitting turns multiplies request count (~1 → 2 per candidate, plus 2 evaluation calls when the evaluator is enabled). We accept it because:
- the primary pain point is **schema complexity / prompt length** (Gemini constrained-decoder depth, Cohere prompt caps), which the split directly fixes;
- per-candidate parallelism keeps wall-clock similar;
- request multiplication is bounded (`candidateCount ≤ 3`, 2 turns).

See Part 4 for the full cost analysis and the mitigation (context specialization: each turn omits blocks the other doesn't need).

---

## Part 1 — What the Codebase Already Has (so we don't re-build it)

### 1.1 The two generation types (the actual split target)

`src/types/story.ts`:

- `StoryPageGeneration` (line 1321) — `Omit<StoryPage, 'provider' | 'stateDelta' | 'momentum' | 'elapsedDays'>`. **This is Turn A's output type.**
- `StateDeltaGeneration` (line 1317) — `Omit<StateDelta, keyof PsychologicalStateDelta | 'isMajorEvent'>` with `futureNoteAdd?: FutureNoteGeneration[]`. **This is Turn B's output type.** Engine-owned fields (`psychologicalProfileUpdates`, `hiddenStateUpdates`, `memoryIntegrity`, `difficulty`, `sanityState`) are computed in `advanceStoryState`/`calculatePsychologicalDeltas` — never AI-authored.
- `StoryGeneration = StoryPageGeneration & StateDeltaGeneration & { branchNames?: string[] }` (line 1322) — the **merged** object, i.e. what `validateGeneratedPage` and `extractStateDelta` consume today. It stays as the merge-validation target.
- `InitialStoryPageGeneration` (line 1326) — a page-only schema variant already used for book-creation's `firstPage`. **This proves a page-only schema already works across the provider waterfall.**

### 1.2 The schemas

`src/schema/story.ts`:

- `STORY_PAGE_GENERATION_SCHEMA` (line 488) — `Record<keyof StoryPageGeneration, AIJsonProperty>`: `text, mood, placeId, weather, calendarDate, timeOfDay, sceneType, charactersPresent, keyEvents, keyObjects, actions`.
- `STORY_STATE_GENERATION_SCHEMA` (line 557) — `Record<keyof StateDeltaGeneration, AIJsonProperty>`: `newCharacters, updatedCharacters, addPlannedCharacters, relationshipUpdates, newPlaces, updatedPlaces, placeConnections, contextHistory, newThreads, updateThreads, addClues, closeThreads, futureNoteAdd, futureNoteRemove, factUpdates, traumaTagAdd, traumaTagRemove, flagUpdates, addPlotFlags, viableEnding, minutesPassed, inventory, injuries`.
- `STORY_GENERATION_SCHEMA_DEFINITION` (line 675) = `{ ...STORY_PAGE_GENERATION_SCHEMA, ...STORY_STATE_GENERATION_SCHEMA, branchNames }` — the single big schema sent to the AI today. `STORY_GENERATION_REQUIRED_FIELDS = ['text', 'actions', 'calendarDate']` (line 685).
- `CANDIDATE_GENERATION_SCHEMA_DEFINITION` (line 690) — `{ generatedPages: [StoryGeneration × N], output }`. `CANDIDATE_GENERATION_REQUIRED_FIELDS = ['generatedPages']` (line 700).

The big schema is exactly what trips `isSchemaTooComplex` (`src/utils/ai-chat.ts:1722`, thresholds: >100 props, >100 enum items, depth >6, >30KB). The split collapses the effective schema depth/property count substantially.

### 1.3 The prompt builders (user vs system separation)

`src/utils/prompt.ts`:

- **System prompt** — `buildPresetSystemPrompt('first' | 'next', preset)` (line 321) wraps `PROMPT_SYSTEM_WRITING_STYLE[preset]` + `RULES_LANGUAGE_LOCALIZATION` + a ruleset (`RULES_DIFFICULTY_SCALING`, `RULES_ENDING_ARCHETYPES`, `RULES_STORY_MOMENTUMS`, `RULES_SCENE_TYPES`, `RULES_PLACE`, `RULES_CHARACTER`, `RULES_CHARACTER_RECOGNITION`, `RULES_EMBODIED_SCENE_CONTINUITY`, preset page-text rules, `RULES_ACTIONS`) via `buildFirstPageRuleSet` (line 301). For `'next'` it prepends `RULES_ROUTE_MEMORY`, `RULES_STORY_CONSISTENCY`, `RULES_FUTURE_NOTES`, `RULES_FALSE_PREVIEW`. Export `PROMPT_SYSTEM` (line 70).
- **User prompt** — `buildNextPagePrompt` (line 871) = `TASK` (`formatNextPageTaskPrompt`, line 2612) + `formatNextPageStoryContextPrompt` (line 2966: phase, MC, STORY CONTEXT, current facts, previous pages, current situation, action selection) + `formatNextPageNarrativePrompt` (line 3033: narrative style, psych flags/profile, hidden state, composure, route memory, future notes, threads, ending rules) + optional `RULES_PLANNED_CHARACTERS` + `BRANCHING ACTIONS`.
- `buildNextPageFieldInstructions` (line 885) — the per-field rules for every StoryGeneration key.
- `buildNextPageReviewChecklist` (line 1160) — 10-section self-review rubric (language, spoilers, tension, continuity, embodied-scene, characters, threads, illusion, prose, choices, JSON integrity).
- `nextPageOutputFormat` (line 658) / `multiNextPageOutputFormat` (line 863) — the prose-described JSON example appended into the **system** prompt (via `shouldAppendOutputFormat`, `src/utils/ai-chat.ts:1450–1451`).
- `buildNextPageEvaluatorPrompt` (line 1259) — evaluation phase prompt.

### 1.4 The orchestration & persistence

- `prepareNextPageGenerationSetup` (`src/utils/prompt.ts:4396`) — one-time shared setup: advance state, pgvector recall blocks, prompt, config (`determineAIConfig`), system prompt, field instructions, review checklist, evaluator prompt. **Both** `generateNextPage` and `generateNextPages` call it.
- `generateNextPage` (`src/utils/prompt.ts:4618`) — single page: `executePromptForJSON<StoryGeneration>` with `STORY_GENERATION_SCHEMA_DEFINITION` → `validateGeneratedPage` → optional canon pass → `resolvePageDelta` → `determineBranchIdForPage` → `persistPageWithState` → fire-and-forget embeds.
- `generateNextPages` (`src/utils/prompt.ts:4756`) — multiverse: `executePromptForJSON<CandidatePagesGeneration>` with `CANDIDATE_GENERATION_SCHEMA_DEFINITION` and `maxOutputToken: DEFAULT_MAX_OUTPUT_TOKEN * candidateCount` (line 4783) → per-alt `checkGeneratedPage` → canon → `resolvePageDelta` → branchId → `persistPageWithState`; partial-success tolerant (line 4914).
- `executePromptForJSON` (`src/utils/prompt.ts:4937`) → `createAIOptionsWithSchema` (`src/utils/ai-chat.ts:1818`) → `aiPrompt` (`src/utils/ai-chat.ts:1406`) — provider waterfall, prompt-length gate, evaluator phase, `parseAISafely`. **Single-shot; callers orchestrate turns.**
- `resolvePageDelta` (`src/utils/prompt.ts:4526`) → `extractStateDelta` (`src/utils/story.ts:284`, reads `StateDeltaGeneration` fields off the merged `StoryGeneration`) + `applyStateDelta` + `calculatePsychologicalDeltas` (`src/utils/story.ts:391`). **Works unchanged on the merged object.**
- `persistPageWithState` (`src/services/book.ts:538`) — atomic-ish page+state+branch insert, `resolveBranchDisplayName` reads `generatedStoryPage.branchNames` (book.ts:655). **Unchanged — it consumes the merged `StoryGeneration`.**

### 1.5 Candidate-generation entry points & retry cron

- `generateCandidatePage` (`src/utils/candidate-generation.ts:450–553`) calls `generateNextPages` for fresh (`:517`) and top-up (`:498`) generation; reuses existing `destinationPageIds` otherwise. Top-up passes `candidateCount: needed` (already reduced).
- `retry-pending-generations.ts` cron: `retryPendingGenerations()` (line 41) scans `pages.pendingGenerationCount > 0` (DB-generated column, `src/db/schema.ts:97`), `processPageGeneration` (line 220) → `ensureCandidatesForPageWithStrategy({ strategy: 'cron' })`. Locking via `pages.isGeneratingStartedAt` (`src/db/schema.ts:109`) + `cleanupStuckGenerations` (cron line 349). Idempotency: `determineBranchIdForPage` throws `ACTION_ALREADY_HAS_DESTINATION` when a fresh parent read shows an action already at `MAX_CANDIDATE_PAGE_PER_ACTION` (`src/utils/prompt.ts:4378–4383`).
- `bookGenerations` table (`src/db/schema.ts:622`) + `updateBookGenerationStatus` (`src/services/book-creation.ts:645`) power the async book-creation progress (`storyGenerationSteps`, `src/types/book.ts:59`) — separate from page-level generation, but the same `isGeneratingStartedAt` locking idiom applies.

### 1.6 Token constants

`src/config/ai-chat.ts`: `DEFAULT_MAX_OUTPUT_TOKEN = 4000` (line 3), `EVALUATION_SCORING_OUTPUT_TOKEN = 2000` (line 4), `MAX_SCHEMA_LENGTH = 30_000` (line 6). `AI_CHAT_CONFIG_CREATIVE.maxOutputToken` = 4000 (line 66). The evaluator adds `EVALUATION_SCORING_OUTPUT_TOKEN` to `config.maxOutputToken` (`src/utils/ai-chat.ts:1585`).

---

## Part 2 — Target Architecture

### 2.1 Schema split (`src/schema/story.ts`)

**Additive, non-breaking exports:**

```ts
// Page turn — the schema currently already exists as a Record; export a full definition.
export const STORY_PAGE_SCHEMA_DEFINITION: Record<keyof StoryPageGeneration, AIJsonProperty> =
  { ...STORY_PAGE_GENERATION_SCHEMA };
export const STORY_PAGE_REQUIRED_FIELDS = ['text', 'actions', 'calendarDate'] satisfies (keyof StoryPageGeneration)[];

// Delta turn — all StateDeltaGeneration fields are optional arrays/scalars; required stays minimal.
export const STATE_DELTA_SCHEMA_DEFINITION: Record<keyof StateDeltaGeneration, AIJsonProperty> =
  { ...STORY_STATE_GENERATION_SCHEMA };
export const STATE_DELTA_REQUIRED_FIELDS: (keyof StateDeltaGeneration)[] = [];

// Kept for backward compatibility + as the server-side merge-validation target.
export const STORY_GENERATION_SCHEMA_DEFINITION = {
  ...STORY_PAGE_SCHEMA_DEFINITION,
  ...STATE_DELTA_SCHEMA_DEFINITION,
  branchNames: { /* existing */ },
} satisfies Record<keyof StoryGeneration, AIJsonProperty>;
```

**Multiverse split** — replace the "array of full StoryGeneration" contract with per-alternative contracts used by the parallel orchestrator:

```ts
// Single-alternative StoryPage turn (used N× in parallel)
export const CANDIDATE_PAGE_SCHEMA_DEFINITION = STORY_PAGE_SCHEMA_DEFINITION;
// Single-alternative StateDelta turn (used N× in parallel, after its StoryPage resolves)
export const CANDIDATE_DELTA_SCHEMA_DEFINITION = {
  ...STATE_DELTA_SCHEMA_DEFINITION,
  branchNames: { type: 'array', items: { type: 'string' }, description: 'Suggest 3 creative, distinct names for this timeline. Evocative, spoiler-free.' },
} satisfies Record<keyof (StateDeltaGeneration & { branchNames?: string[] }), AIJsonProperty>;
```

`STORY_GENERATION_REQUIRED_FIELDS` (line 685) is reused as `STORY_PAGE_REQUIRED_FIELDS`; the merged object still requires `['text', 'actions', 'calendarDate']`.

> `branchNames` placement: recommend **Turn B (StateDelta)**. The alternative names describe the *whole* divergence, which only exists after the delta is known; the delta prompt already carries the generated page text as input, so it can name the branch sensibly. (Alternatively a cheap third micro-turn; not recommended — see Part 5.)

### 2.2 Per-turn prompts (user & system separation)

**Turn A — StoryPage.** Reuses the existing `buildPresetSystemPrompt('next', preset)` unchanged (it already carries the page-staging + action rules). User prompt = page-scoped slices of the current builders:

| Piece | Current source | Turn A (page) | Turn B (delta) |
|---|---|---|---|
| TASK | `formatNextPageTaskPrompt` (2612) | keep (page-focused) | new `formatNextPageStateDeltaTaskPrompt` — "given this generated page, update world state" |
| Story context | `formatNextPageStoryContextPrompt` (2966) | keep (needed to write the page) | keep, reduced — the page text is already in hand |
| Narrative | `formatNextPageNarrativePrompt` (3033) | keep (flags/profile/hidden/future-notes/threads/ending steer prose) | **drop** narrative-style/embodied blocks; keep future-notes, threads, ending-plan (delta must update those) |
| Field instructions | `buildNextPageFieldInstructions` (885) | split → `buildStoryPageFieldInstructions` (page keys only) | split → `buildStateDeltaFieldInstructions` (delta keys only) |
| Review checklist | `buildNextPageReviewChecklist` (1160) | split → `buildStoryPageReviewChecklist` (prose/scene/choices/JSON) | split → `buildStateDeltaReviewChecklist` (state-integrity/continuity/JSON) |
| Output format example | `nextPageOutputFormat` (658) | split → `storyPageOutputFormat` | split → `stateDeltaOutputFormat` |
| Evaluator | `buildNextPageEvaluatorPrompt` (1259) | split → page evaluator | split → delta evaluator (rubric dimensions scoped to delta keys) |
| System prompt | `buildPresetSystemPrompt` (321) | keep `'next'` | new `buildPresetSystemPrompt('state-delta')` — writing style + `RULES_LANGUAGE_LOCALIZATION` + `RULES_ROUTE_MEMORY` + `RULES_STORY_CONSISTENCY` + `RULES_FUTURE_NOTES` + `RULES_PLANNED_CHARACTERS` + `RULES_CHARACTER` + `RULES_PLACE`. **Drop** `RULES_EMBODIED_SCENE_CONTINUITY`, page-text rules, `RULES_ACTIONS`, `RULES_SCENE_TYPES`, `RULES_ENDING_ARCHETYPES`, `RULES_STORY_MOMENTUMS` (page/staging concerns the delta doesn't author). |

**Turn B input contract:** Turn A's generated `StoryPage` is passed to Turn B as a document:

```ts
documents: [
  ...baseDocuments,
  { title: 'GENERATED PAGE (from previous AI turn)', snippet: JSON.stringify(storyPage) },
]
```

This mirrors `src/utils/ai-chat.ts:1590–1597` (evaluator feeding generated output as a document) — no new plumbing in `aiPrompt`.

### 2.3 Stage orchestration in the AI-chat layer

`aiPrompt`/`executePromptForJSON` stay single-shot. Add a thin stage runner in `src/utils/prompt.ts`:

```ts
export type GenerationStage = 'story_page' | 'state_delta';

export interface GenerationStageDefinition<T extends Record<string, unknown>> {
  schema: Record<keyof T, AIJsonProperty>;
  requiredFields: (keyof T)[];
  fallbackField: keyof T;
  buildUserPrompt: (ctx: StageContext) => string;      // task + story context (+ generated page for delta)
  fieldInstructions: string;
  reviewChecklist: string;
  jsonStructure: string;
  systemPrompt: string;
  documents: AIDocument[];
  cachedContentId: string;
  evaluatorPrompt: (ctx: StageContext) => string;
}

export async function runGenerationStage<T extends Record<string, unknown>>(
  stage: GenerationStageDefinition<T>,
  ctx: StageContext,
  onProgress?: ProgressCallback,
  onGenerationProgress?: (step: StoryGenerationStep) => Promise<void>,
): Promise<AIResponse<T>>;
```

`runGenerationStage` wraps `executePromptForJSON` with the stage's own schema/required-fields/system-prompt/documents and a **stage-scoped output budget** (Phase 2). The `BuildNextPagePromptParams`/`AIPromptForJsonParams` types in `src/types/prompt.ts` / `src/types/ai-chat.ts` gain the fields needed (stage, generated-page input, per-stage `evaluatorPrompt`). SSE `onProgress` emits `ai_generation_start`/`ai_generation_complete` per turn.

### 2.4 `generateNextPage` (single page) — 2-turn flow

```text
prepareNextPageGenerationSetup(params, 1)         // unchanged, computes shared context once
   │
   ▼
Turn A: runGenerationStage('story_page')          // schema = STORY_PAGE_SCHEMA_DEFINITION
   │  → StoryPage (validated against page schema)
   ▼
Turn B: runGenerationStage('state_delta', {       // input doc = Turn A's StoryPage
   generatedPage: storyPage })                    // schema = STATE_DELTA_SCHEMA_DEFINITION (+ branchNames)
   │  → StateDelta
   ▼
merge: const generatedStoryPage: StoryGeneration =
   { ...storyPage, ...stateDelta, calendarDate: storyPage.calendarDate ?? actionedPage.calendarDate }
   │
   ▼
validateGeneratedPage(generatedStoryPage, mode)   // master validation, unchanged
   → canon pass → resolvePageDelta → determineBranchIdForPage → persistPageWithState → embeds
```

Failure semantics: if Turn A fails, nothing is persisted (today's behavior). If Turn B fails but Turn A succeeded → write a `page_generation_tasks` row so the cron can re-run Turn B only (Part 2.6).

### 2.5 `generateNextPages` (multiverse) — parallel multi-turn

```text
prepareNextPageGenerationSetup(params, candidateCount)   // unchanged
   │
   ▼
Phase 1 (parallel): const storyPages = await Promise.all(
     alternatives.map(() => runGenerationStage('story_page')))
   // N StoryPage turns (N ≤ MAX_CANDIDATE_PAGE_PER_ACTION = 3)
   │
   ▼
Phase 2 (parallel): const deltas = await Promise.all(
     storyPages.map((page) => runGenerationStage('state_delta', { generatedPage: page })))
   │
   ▼
merge each alt → validate → [existing per-alt loop: canon → resolvePageDelta →
   determineBranchIdForPage → persistPageWithState → embeds]   // reuse lines 4818–4911
```

Partial-success behavior preserved: a failed alternative is skipped, only an all-failed batch throws (current line 4914). `usedBranchIds` collision guard and `determineBranchIdForPage`'s `ACTION_ALREADY_HAS_DESTINATION` idempotency are untouched. The `*candidateCount` token multiplication (`prompt.ts:4783`) is removed — each parallel request uses its own per-turn budget.

### 2.6 Idempotent StateDelta retry (partial persistence + cron)

**Problem this solves:** with the split, Turn A may succeed and Turn B fail. Today that throws and discards the whole candidate. We must retain the succeeded StoryPage and retry only the delta later — **without persisting a page that lacks its delta** (delta is required for state reconstruction; see `StateDelta` JSDoc, `src/types/story.ts:1185–1293`).

**Chosen approach — dedicated `page_generation_tasks` table** (recommended over columns-on-pages; see Part 5 for the alternative):

```ts
export const pageGenerationTasks = pgTable("page_generation_tasks", {
  id: id(),
  bookId: bookId("cascade"),
  actionedPageId: uuid("actioned_page_id"),   // parent page (persisted, so state is reconstructable)
  action: jsonb("action").$type<Action>(),    // exact action text/type/hint
  expectedPageNumber: integer("expected_page_number").notNull(),
  branchId: text("branch_id"),                // resolved branchId, if already determined
  fateIndex: integer("fate_index"),           // alternative slot (0-based) within the batch
  stage: text("stage").$type<'story_page' | 'state_delta'>().notNull().default('state_delta'),
  status: text("status").$type<'pending' | 'in_progress' | 'completed' | 'failed'>().notNull().default('pending'),
  storyPageJson: jsonb("story_page_json").$type<StoryPageGeneration>(), // cached Turn-A output
  deltaJson: jsonb("delta_json").$type<StateDeltaGeneration>(),
  attemptCount: integer("attempt_count").notNull().default(0),
  lastError: text("last_error"),
  isGeneratingStartedAt: timestamp("is_generating_started_at", { withTimezone: true }),
  createdAt, updatedAt,
}, (t) => [
  // Idempotency key: one delta-turn per (parent page, action, fate slot)
  unique("page_generation_tasks_action_fate_unique").on(t.actionedPageId, t.fateIndex),
  index("page_generation_tasks_pending_idx").on(t.status)
    .where(sql`${t.status} = 'pending' OR ${t.status} = 'failed'`),
]);
```

**Write points (in the refactored `generateNextPage(s)`):**
1. After Turn A succeeds and before Turn B: `upsert` row `{ stage: 'story_page', status: 'completed', storyPageJson }` (kept for observability/repair).
2. If Turn B fails: `update` row `{ stage: 'state_delta', status: 'failed', lastError }`. If Turn B succeeds: `update ... status: 'completed', deltaJson` (then the normal persist path writes the page; the row is purely a ledger).

**Retry flow (cron):**
- Query `status IN ('pending','failed')` rows (indexed), order by `bookId`/`fateIndex`.
- For each: reconstruct `advancedState` via the same deterministic path `prepareNextPageGenerationContext` uses — `getStoryStateWithBranch(bookId, actionedPageId)` + `advanceStoryState` (`src/utils/prompt.ts:4278–4285`) — then re-run only Turn B with the stored `storyPageJson` as input, merge, master-validate, canon-pass, `determineBranchIdForPage` (fresh-parent read preserves the `ACTION_ALREADY_HAS_DESTINATION` guard), `persistPageWithState`, mark `status: 'completed'`.
- Concurrency: set `isGeneratingStartedAt` on claim, `attemptCount++`, reuse `cleanupStuckGenerations`-style stale reset (`src/cron/retry-pending-generations.ts:349`).
- **Idempotency guarantees:** the unique `(actionedPageId, fateIndex)` key prevents double-processing; `determineBranchIdForPage` bails with `ACTION_ALREADY_HAS_DESTINATION` if a concurrent worker already persisted; `persistPageWithState`'s branch-conflict retry + `onConflictDoNothing` on `branches` (`src/services/book.ts:657–665`) keep it safe.

**Cron wiring:** extend `retry-pending-generations.ts` (after the existing candidate loop) or add a sibling `retry-pending-state-deltas.ts` sharing the locking/cleanup helpers. Since `state_delta` rows reference *not-yet-persisted* pages, this cron runs before the page exists — independent of `pages.pendingGenerationCount`.

---

## Part 3 — Phased Execution Plan

Each phase is independently shippable; Phase 0–3 are pure additions with zero behavior change, so they can land behind the existing pipeline before the orchestrator flips.

### Phase 0 — Schema split (no behavior change)

- **Step 0.1** — `src/schema/story.ts`: export `STORY_PAGE_SCHEMA_DEFINITION`, `STORY_PAGE_REQUIRED_FIELDS`, `STATE_DELTA_SCHEMA_DEFINITION`, `STATE_DELTA_REQUIRED_FIELDS`; refactor `STORY_GENERATION_SCHEMA_DEFINITION` (line 675) to compose from them so the two definitions can't drift (the exact class of bug `TODO-multi-turn-request.md` warns about).
- **Step 0.2** — `src/schema/story.ts`: add `CANDIDATE_PAGE_SCHEMA_DEFINITION` / `CANDIDATE_DELTA_SCHEMA_DEFINITION` (Part 2.1). `CANDIDATE_GENERATION_SCHEMA_DEFINITION` (line 690) is kept for the pre-flip path.
- **Step 0.3** — `src/types/story.ts`: confirm `StoryPageGeneration` / `StateDeltaGeneration` / `StoryGeneration` types need no change (they already split exactly at the right seam). Add `StoryPageGeneration & { branchNames?: string[] }` type alias if `branchNames` moves to Turn B.

### Phase 1 — Per-turn prompt builders

- **Step 1.1** — `src/utils/prompt.ts`: split `nextPageOutputFormat` (line 658) → `storyPageOutputFormat` + `stateDeltaOutputFormat` (mirror of `STORY_PAGE_*` / `STORY_STATE_*` keys). `multiNextPageOutputFormat` (line 863) becomes obsolete in the parallel path.
- **Step 1.2** — split `buildNextPageFieldInstructions` (line 885) → `buildStoryPageFieldInstructions` / `buildStateDeltaFieldInstructions`. The delta builder needs a new section describing how the *provided generated page text* drives updates (`traumaTagAdd`, `factUpdates`, `newCharacters`, `updatedCharacters`, `newPlaces`, `contextHistory`, `viableEnding`, `minutesPassed`, `branchNames`).
- **Step 1.3** — split `buildNextPageReviewChecklist` (line 1160) → page checklist (sections 1–5, 8, 9, 10) and delta checklist (state-integrity/continuity, thread/future-note/character/place integrity, JSON integrity). `buildNextPageEvaluatorPrompt` (line 1259) → page evaluator + delta evaluator (rubric dimensions re-scoped; the delta evaluator scores `newCharacters`/`newPlaces`/`contextHistory`/`viableEnding` etc., not prose staging).
- **Step 1.4** — add `formatNextPageStateDeltaTaskPrompt` (delta TASK) and `buildStateDeltaSystemPrompt` (Part 2.2 table). Keep `formatNextPageStoryContextPrompt`/`formatNextPageNarrativePrompt` but add a "skip narrative-prose blocks" variant used by Turn B.
- **Step 1.5** — `src/config/book-creation.ts`: add the `state-delta` preset entry to `PROMPT_SYSTEM_WRITING_STYLE` or define a dedicated `PROMPT_SYSTEM_STATE_DELTA` so `buildPresetSystemPrompt('state-delta', preset)` has a target.

### Phase 2 — Per-turn output-token budgets

- **Step 2.1** — `src/config/ai-chat.ts`: introduce per-turn budgets (halved from current 4000):

```ts
export const STORY_PAGE_MAX_OUTPUT_TOKEN: number = 2200;   // page text + scene meta + actions
export const STATE_DELTA_MAX_OUTPUT_TOKEN: number = 1800;  // characters/places/threads/facts/ending
export const STORY_PAGE_EVALUATION_OUTPUT_TOKEN: number = 1100;  // ≈ EVALUATION_SCORING_OUTPUT_TOKEN / 2
export const STATE_DELTA_EVALUATION_OUTPUT_TOKEN: number = 900;
```

`DEFAULT_MAX_OUTPUT_TOKEN` (line 3) stays 4000 for non-split callers (`pen.ts`, `canon-validation.ts`, book-creation). The stage runner overrides `config.maxOutputToken` per stage; the evaluator budget (`src/utils/ai-chat.ts:1585`) also becomes stage-scoped.
- **Step 2.2** — `src/utils/prompt.ts`: remove `maxOutputToken: DEFAULT_MAX_OUTPUT_TOKEN * candidateCount` (line 4783). Each parallel request now uses its own per-turn budget; total output per candidate ≈ 4000 (unchanged), just split.

### Phase 3 — Stage orchestration types

- **Step 3.1** — `src/types/prompt.ts` / `src/types/ai-chat.ts`: add `GenerationStage`, `GenerationStageDefinition<T>`, and thread `generatedPage?` (Turn-B input) through `BuildNextPagePromptParams`.
- **Step 3.2** — `src/utils/prompt.ts`: implement `runGenerationStage` (Part 2.3), which wraps `executePromptForJSON` (`src/utils/prompt.ts:4937`) with stage-scoped schema/system/documents/token-budget and the existing per-turn SSE hooks.

### Phase 4 — `generateNextPage` 2-turn refactor

- **Step 4.1** — extract `generateStoryPage(context)` / `generateStateDelta(context, storyPage)` helpers from the current single-call body (lines 4626–4650).
- **Step 4.2** — wire the 2-turn flow + merge + master `validateGeneratedPage` (Part 2.4). Add the `page_generation_tasks` write points (Phase 6) if Phase 6 has landed; otherwise a `console.warn` placeholder.

### Phase 5 — `generateNextPages` parallel multi-turn refactor

- **Step 5.1** — replace the `executePromptForJSON<CandidatePagesGeneration>` batch call (lines 4776–4799) with Phase-1 parallel StoryPage turns.
- **Step 5.2** — add Phase-2 parallel StateDelta turns.
- **Step 5.3** — merge each alt into `StoryGeneration`, keep the existing per-alt loop (canon → `resolvePageDelta` → branchId → persist → embeds, lines 4818–4911) and partial-success semantics (line 4914).

### Phase 6 — Partial-persistence tracking (DB)

- **Step 6.1** — add `pageGenerationTasks` table (Part 2.6) + migration (`bun db:generate` / `bun db:migrate`).
- **Step 6.2** — write/update task rows in the refactored generators (Turn-A success → `story_page completed`; Turn-B failure → `state_delta failed`; Turn-B success → `state_delta completed`).
- **Step 6.3** — expose `getPendingStateDeltaTasks()` + `claimStateDeltaTask(id)` (sets `isGeneratingStartedAt`, bumps `attemptCount`) in a new `src/services/page-generation-tasks.ts`.

### Phase 7 — Idempotent state-delta retry cron

- **Step 7.1** — add `retryPendingStateDeltas()` in `src/cron/retry-pending-generations.ts` (or a sibling cron file), reusing the module's lazy-import + distributed-lock + `cleanupStuckGenerations` idioms (lines 41–164, 349).
- **Step 7.2** — per-task: reconstruct `advancedState` → re-run Turn B with stored `storyPageJson` → merge → master validate → canon → branchId → persist → mark completed (Part 2.6).
- **Step 7.3** — package.json scripts: `dev:cron:retry-deltas` / `start:cron:retry-deltas` mirroring existing cron scripts.

### Phase 8 — Verification & feature flag

- **Step 8.1** — `.env.example` + `src/config/*`: `USE_MULTI_TURN_GENERATION=true|false`. `generateNextPage(s)` branch to the new pipeline only when true (default **false** on first ship).
- **Step 8.2** — quality gates: `bun run typecheck`, `bun run lint:fast`, `bun run lint:imports`.
- **Step 8.3** — manual verification: (a) single-page continuation (`interactive` mode, `candidateCount: 1`); (b) multiverse (`candidateCount: 3`, confirm parallel turns + branchIds distinct + `branches` display names from Turn B); (c) Gemini path — confirm no `isSchemaTooComplex` skip (`src/utils/ai-chat.ts:1722` logs); (d) forced delta failure → confirm cron retry persists the page without regenerating Turn A.
- **Step 8.4** — rollback: flip flag off; the pre-flip single-request path remains intact because all Phase 0–3 changes were additive.

---

## Part 4 — Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| **RPM/RPD consumption** (the ChatGPT doc's headline trade-off) | ~1→2 requests per candidate (×2 with evaluator); multiverse ×3 alternatives | Parallel phases keep wall-clock at 2 sequential layers; per-turn context specialization reduces input tokens; document the rate math in Part 5 before flipping default on |
| **Input-token duplication** (story context re-sent per turn) | Turn B resends story context + Turn A output | Context specialization: Turn B drops narrative-prose blocks (`formatNextPageNarrativePrompt` prose part), Turn A drops delta-heavy blocks; Gemini explicit cache (`cachedContentId`) already shares the static prefix across turns |
| **Schema divergence between page/delta definitions** | Drift → field-level bugs (the `newPlaces.knownCharacters` class of bug) | Step 0.1 composes `STORY_GENERATION_SCHEMA_DEFINITION` from the two halves — single source of truth |
| **Merged-object validation gaps** | Page and delta pass separately but merged object violates `StoryGeneration` | Keep master `STORY_GENERATION_SCHEMA_DEFINITION` + `validateGeneratedPage` on the merged object (unchanged) |
| **`branchNames` in the wrong turn** | Names that don't fit the diverged branch | Move to Turn B (delta) where the full divergence is known; `resolveBranchDisplayName` (`src/services/book.ts:492`) unchanged |
| **Cron retry races a live generation** | Duplicate page for same action | Unique `(actionedPageId, fateIndex)` key + `determineBranchIdForPage`'s `ACTION_ALREADY_HAS_DESTINATION` guard + `persistPageWithState` branch-conflict retry |
| **Delta retry produces a different delta than the original attempt** | Non-determinism across model sampling | Acceptable — the delta is a *consequence of the persisted page text* (Turn A output is stored and reused); the retry's input is identical to the failed attempt's |
| **Stuck task rows** | Rows never complete | `isGeneratingStartedAt` + `cleanupStuckGenerations` idiom (cron line 349) reused verbatim |
| **SSE progress semantics** | Frontend expects one `ai_generation` step | Emit per-turn `ai_generation_start/complete`; `storyGenerationSteps` (`src/types/book.ts:59`) needs no new step unless per-turn granularity is desired (Part 5 decision) |

---

## Part 5 — Decisions Needed Before Implementation

1. **Partial-persistence shape:** dedicated `page_generation_tasks` table (recommended — clean idempotency key, no page without a delta) **vs.** columns on `pages` (`stateDeltaPending`, `pendingStoryPageJson`) that require persisting a page *before* its delta (breaks the delta-chain reconstruction contract unless flagged).
2. **`branchNames` turn:** Turn B (recommended) vs. a 3rd micro-turn vs. Turn A.
3. **Token budgets:** accept `2200/1800` page/delta and `1100/900` evaluation splits, or tune to observed per-turn truncation in `finishReason === 'length'` (`src/types/ai-chat.ts:88`).
4. **Feature flag default:** flip `USE_MULTI_TURN_GENERATION` on only after the Phase 8 manual pass, or land it on for a staged rollout?
5. **SSE granularity:** keep single `ai_generation` step, or add `story_page`/`state_delta` sub-steps to `storyGenerationSteps`?
6. **Context specialization depth:** how aggressively should Turn B drop prose blocks? (Conservative first: keep `formatNextPageNarrativePrompt`'s flags/profile but drop the embodied-scene/style sections.)
7. **Cron placement:** extend `retry-pending-generations.ts` (one job, two phases) vs. a new `retry-pending-state-deltas.ts` (independent schedule).

---

*This document should be updated as the phases land and new patterns emerge. Quality gates and decision list are the contract for starting Phase 0.*