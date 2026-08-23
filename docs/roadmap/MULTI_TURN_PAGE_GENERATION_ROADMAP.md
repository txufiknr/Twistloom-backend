# Twistloom — Multi-Turn (Stage-Split) Page Generation Roadmap

**Date:** August 15, 2026 · **Last updated:** August 22, 2026 (implementation checkpoint 7 — second external review, both findings verified and fixed; field-instructions refactor also complete; Phase 6 is the only scheduled work remaining)
**Scope:** Split the single monolithic "page + state delta" AI request into **2 sequential structured generation turns** — `StoryPage` then `StateDelta` — with parallel per-alternative turns for the multiverse `generatedPages` flow, plus a Turn-A result checkpoint cache so a succeeded `StoryPage` never needs to be regenerated when only its `StateDelta` failed (no dedicated retry cron needed — see Part 2.6).

Every feasibility verdict below was verified against the actual source in `src/schema/story.ts`, `src/utils/prompt.ts`, `src/utils/ai-chat.ts`, `src/types/ai-chat.ts`, `src/types/prompt.ts`, `src/types/book.ts`, `src/config/ai-chat.ts`, `src/config/env.ts`, `src/services/book.ts`, `src/services/page-validation.ts`, `src/services/canon-validation.ts`, `src/utils/candidate-generation.ts`, `src/db/schema.ts`, `src/cron/retry-pending-generations.ts`, and `package.json` — the full file set the original draft cited is now in hand.

> **How to read this doc.** Part 0 = the design decision taken from `TODO-multi-turn-request.md` (and what we are deliberately *not* doing). **Part 0.5 = review verdict + corrections found while implementing.** Part 1 = what already exists in the code so proposals don't re-build machinery. Part 2 = the target architecture (schemas, prompts, orchestration, token budgets, retry) — updated in place where implementation diverged from the original draft. Part 3 = the phased, step-by-step execution plan, now annotated with per-step status. Part 4 = risks & mitigations. Part 5 = decisions needed — all resolved. **Part 5.5 = the checkpoint-1 open questions, all now resolved.** **Part 6 = implementation checkpoint log.**

---

## ✅ Implementation Status (at a glance)

| Status | Phase / Item | Effort | Impact (before → after) | Files changed |
|---|---|---|---|---|
| ✅ **DONE** | **Phase 0 — schema split** (page vs delta schema definitions + required fields) | small | One 30-key combined schema → an 11-key page schema + a 23/24-key delta schema, composed (not copied) from the same two `Record`s the combined schema already used | `story_schema.ts`, `story_types.ts` |
| ✅ **DONE** | **Phase 1 — per-turn prompt builders** (page vs delta task/field-instructions/review-checklist/output-format) | medium | Same giant user prompt → two specialized prompts, each verified byte-lossless against the original via automated diff during authoring; 2 previously-undocumented cross-turn contract gaps found and fixed (Part 0.5) | `prompt.ts` |
| ✅ **DONE** | **Phase 2 — per-turn output-token budgets** (asymmetric split, not a straight halving — see rationale in file) | tiny | `generateNextPages` `*candidateCount` multiplication removed in the new path (old path unchanged); per-turn budgets added | `ai-chat.config.ts` |
| ✅ **DONE** | **Evaluator redesign** (Part 5.5 Q2, checkpoint 2) | small | Per-turn evaluators (checkpoint 1) → 1 evaluation pass on the merged object, reusing the unchanged legacy evaluator prompt; `runEvaluationPass` extracted and exported from `aiPrompt` | `ai-chat.ts`, `prompt.ts` |
| ✅ **DONE** | **Phase 3 — stage orchestration types** in the AI-chat layer | small | `executePromptForJSON` stays single-shot; new `runGenerationStage` orchestrates each turn; `StageContext`/`GenerationStageDefinition<T>` placed in `types/prompt.ts` proper | `prompt.ts`, `types/prompt.ts` |
| ✅ **DONE** | **Phase 4 — `generateNextPage` 2-turn refactor** | medium | `generateNextPage` becomes: StoryPage → StateDelta → merge → 1 evaluation pass → master validate → persist (persist unchanged), flag-gated | `prompt.ts` |
| ✅ **DONE** | **Phase 5 — `generateNextPages` parallel multi-turn refactor** | medium | `generatedPages` batch request → `candidateCount` independent parallel (StoryPage → StateDelta) pipelines via `Promise.allSettled` → existing per-alt persist loop; includes the fate-divergence fix (Part 0.5) and a real resilience improvement over the legacy batch path (Part 2.5) | `prompt.ts` |
| ⏳ **TODO** | **Phase 6 — Turn-A result checkpoint cache (DB)** *(redesigned at checkpoint 2 — replaces the original Phase 6+7 pair; no dedicated cron needed, see Part 2.6 / Part 5.5 Q4)* | small–medium | New small `pageGenerationCheckpoints` table; a retried candidate skips Turn A if already cached — benefits both of the *existing* retry layers automatically. `TODO(Phase 6)` markers already placed at their exact insertion points in `generateStoryGenerationMultiTurn` | `schema.ts`, new `page-generation-checkpoints.ts`, migration |
| ✅ **RESOLVED (no build needed)** | ~~Phase 7 — idempotent state-delta retry cron~~ | — | Dropped — the existing `retry-pending-generations.ts` + `ensureCandidatesForPageWithStrategy` already guarantee eventual success on any generation failure; Phase 6 above is a pure cost optimization on top, not new retry infrastructure | *(none — `retry-pending-generations.ts` needs zero changes)* |
| 🔧 **PARTIAL** | **Phase 8 — verification & flag** | small | `USE_MULTI_TURN_GENERATION` flag added (`ai-chat.config.ts`, default `false`, confirmed to match `config/env.ts`'s actual convention); real quality gates confirmed from `package.json` (`bunx tsc --noEmit`, `bunx eslint .`); recommendation to default `true` in dev once Phase 5 lands (pre-launch, Part 5.5 Q5) — **Phase 5 has now landed; flipping the flag in dev is unblocked.** | `ai-chat.config.ts` |
| ✅ **DONE** | **Checkpoint 5 bug fixes** (external review, 4 confirmed bugs + 1 defensive fix + 1 typo) | small | Gemini/Mistral evaluator cache-slot corruption, malformed structured-object evaluator schema, calendarDate merge-order gap, SSE-callback parity, a schema-description typo — all fixed and verified (Part 4, Part 6 checkpoint 5 log) | `prompt.ts`, `types/prompt.ts`, `schema/story.ts` |
| ✅ **DONE** | **Checkpoint 6 refactor** (field-instructions extraction, generic types) | small | `buildNextPageFieldInstructionSections` moved to its own file; `FieldInstructionSection<T>` generic, `fields: (keyof T)[]` checked at compile time — all 31 sections verified byte-identical via round-trip diff | new `utils/field-instructions.ts`, `prompt.ts` |
| ✅ **DONE** | **Checkpoint 7 bug fixes** (second external review, 2 confirmed findings) | small–medium | Evaluator correction newline-stripping (prompt hardening + `sanitise()` fix + routed through the existing `parseAISafely` repair pipeline instead of a bare `JSON.parse`), duplicate/unlabeled output-format block in the evaluator system prompt — both fixed and verified (Part 6 checkpoint 7 log) | `ai-parser.ts`, `ai-chat.ts`, `prompt.ts` |
| 📋 **FUTURE (not scheduled)** | **Phase 9 — deterministic slug-ID reconciliation** | small–medium | Server-side backstop for the rare case the model doesn't follow the slug-ID handoff convention (Part 0.5 item 3) — additive robustness, not a fix for anything currently broken | *(sketch only — Part 3)* |
| 📋 **FUTURE (not scheduled)** | **Phase 10 — Turn B context pruning** | medium | Shrink Turn B's prompt further by trimming prose-heavy story context it doesn't need — already a deliberately-deferred decision (Part 5.5 decision 6), formalized here | *(sketch only — Part 3)* |
| 📋 **FUTURE (not recommended)** | **Phase 11 — alternative evaluation strategy** | small | Documented for completeness; not recommended — see Part 3 for why | *(sketch only — Part 3)* |

**Quality gates (post-change):** `bun run typecheck` · `bun run lint:fast` · `bun run lint:imports` — confirmed real (from `package.json`) but not runnable in this environment (no project checkout / `node_modules`); every edited file was instead verified with `esbuild` (syntax-valid TS) after each change, plus automated string-diff verification for every text-split (see Part 6).

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

## Part 0.5 — Review Verdict & Corrections Found While Implementing

**Verdict: the plan is sound and unusually well-grounded.** Every `file:line` citation in Parts 1–2 checked out exactly against the real source (schema field counts, function boundaries, the `isSchemaTooComplex` thresholds, the `AIPromptForJsonParams` shape) — this is not a plan that needs re-architecting, it needs the handful of gaps below closed before the sequencing/parallelism design is safe to build on. None of them change the target architecture in Parts 1–2; they're additions the original draft didn't reach.

**1. Gemini explicit-cache key collision (new — Part 4 risk table).** `resolveGeminiCachedContent` derives `cachedContentId` purely from `book.id + characters + places` (`buildBookMetaDocuments`, `book_services.ts:2192`) — independent of `systemPrompt`. The original draft's Part 4 row ("Gemini explicit cache already shares the static prefix across turns") reads this as a free win. It's actually a correctness hazard: Turn A and Turn B send *different* system prompts under the *same* `cachedContentId`, so whichever turn's cache entry is created first risks being silently reused by the other with the wrong system instructions baked in. **Fix implemented:** each turn suffixes the shared `cachedContentId` (`:story_page` / `:state_delta`) before calling `runGenerationStage`, so the two turns can never collide regardless of `getOrCreateGeminiCache`'s internal matching behavior (that function's source wasn't supplied, so the fix is defensive-by-construction rather than dependent on verifying its internals).

**2. Multiverse divergence breaks under naive parallelization (new — Part 4 risk table, Part 2.5 update).** The current single-shot multiverse path asks for all `candidateCount` alternatives in **one** completion specifically so the model can see everything it's writing and deliberately diverge each alternative (`formatNextPageTaskPrompt`'s "Multiple possible futures example"). Part 2.5's parallel design runs `candidateCount` **independent** StoryPage requests instead — each is blind to the other N−1. Without an explicit push, independently-sampled completions for the same action risk converging on similar continuations, silently defeating the reason multiverse mode offers alternatives at all. **Fix implemented:** `formatFateDivergenceDirective` (`prompt.ts`) injects a deterministic, zero-extra-cost rotation of narrative angles into each parallel call's task prompt (danger-is-real / misdirection / tonal-break / quiet-wrongness). Applies to `multiverse` and `interactive` (both offer multiple candidates); `novel` mode is always single-path and never needs it.

**3. Cross-turn ID handoff for brand-new characters/places (new — affects Phase 1 field instructions, already fixed).** In the combined single-shot schema, `charactersPresent`/`placeId` (page fields) can reference an ID defined in that *same response's* `newCharacters`/`newPlaces` (delta fields) — confirmed by the original field instructions: `"Every ID must match an existing known character... or a character introduced in newCharacters on this page"`. Splitting into two turns breaks this silently: Turn A has no `newCharacters` of its own to point to when a brand-new character or place first appears on the page. **Fix implemented:** a slug-ID handoff convention, gated behind an `isMultiTurn` flag so the legacy single-shot prompt is untouched. Turn A is instructed to invent a short lowercase-slug ID for a brand-new character/place the moment one appears (consistent with the existing `<new_character_id>`/`<new_place_id>` placeholder convention in `NEW_CHARACTER_SHAPE`/`NEW_PLACE_SHAPE`), and Turn B is instructed to detect any `charactersPresent`/`placeId` ID not present in the known-entity list and add a matching `newCharacters`/`newPlaces` entry using that **exact** ID. The new Turn B evaluator's rubric (§2, Continuity & ID Integrity) scores this directly.

**4. Part 2.2 system-prompt table had a placement error (corrected in place below).** The original draft listed `RULES_PLANNED_CHARACTERS` as part of the new `state-delta` **system** prompt. It's actually spliced into the shared **user** prompt today (`buildNextPagePrompt`'s `state.plannedCharacters?.length && RULES_PLANNED_CHARACTERS` line), and — since a planned character can plausibly appear in Turn A's prose even though `addPlannedCharacters` itself is a Turn B field — it belongs in **both** turns' user prompts, not one turn's system prompt. The table also omitted `RULES_CHARACTER_RECOGNITION` from the delta system prompt even though `recognitionLevel` is itself authored by `newCharacters`/`updatedCharacters` (delta fields). Both corrected in Part 2.2.

**5. Part 3 Step 1.3's checklist split was coarser than the actual field ownership (corrected in place below).** The draft grouped "sections 1–5, 8, 9, 10" wholesale into the page checklist. Section 1 (Spoiler & Mystery Control) mixes page-prose concerns with an ending-trajectory check that's actually about the `viableEnding` delta field. Implemented split pulls that piece out into a new delta-side "State Trajectory & Ending Progression" section instead of leaving it stranded in the page checklist where it doesn't validate anything Turn A authors.

**6. Naming simplification (not a bug, a scope cut).** The original draft proposed `CANDIDATE_PAGE_SCHEMA_DEFINITION`/`CANDIDATE_DELTA_SCHEMA_DEFINITION` as a separate array-wrapped pair for the multiverse path. In the parallel-per-alternative design (Part 2.5), each alternative's turn already sends exactly one page/delta per request — there's no array-wrapped "candidate" shape distinct from the single-page schemas. Implemented as direct reuse of `STORY_PAGE_SCHEMA_DEFINITION`/`STATE_DELTA_WITH_BRANCH_SCHEMA_DEFINITION` for both the single-page and multiverse call sites, dropping two names that would have been pure aliases.

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
- `retry-pending-generations.ts` cron: `retryPendingGenerations()` (line 41) scans `pages.pendingGenerationCount > 0` (DB-generated column, `src/db/schema.ts:97`), `processPageGeneration` (line 220) → `ensureCandidatesForPageWithStrategy({ strategy: 'cron' })`. Locking via `pages.isGeneratingStartedAt` (`src/db/schema.ts:109`) + `cleanupStuckGenerations` (cron line 349). Idempotency: `determineBranchIdForPage` throws `ACTION_ALREADY_HAS_DESTINATION` when a fresh parent read shows an action already at `MAX_CANDIDATE_PAGE_PER_ACTION` (`src/utils/prompt.ts:4378–4383`). **This mechanism, combined with `ensureCandidatesForPageWithStrategy`'s own 3× in-process backoff before a page ever reaches `pendingGenerationCount`, already guarantees eventual success on any `generateNextPages` failure — the original Part 2.6/Phase 7 draft proposed a second, separate retry system without drawing that conclusion from these same facts. Corrected at checkpoint 2: see Part 2.6.**
- `bookGenerations` table (`src/db/schema.ts:622`) + `updateBookGenerationStatus` (`src/services/book-creation.ts:645`) power the async book-creation progress (`storyGenerationSteps`, `src/types/book.ts:59`) — separate from page-level generation, but the same `isGeneratingStartedAt` locking idiom applies.

### 1.6 Token constants

`src/config/ai-chat.ts`: `DEFAULT_MAX_OUTPUT_TOKEN = 4000` (line 3), `EVALUATION_SCORING_OUTPUT_TOKEN = 2000` (line 4), `MAX_SCHEMA_LENGTH = 30_000` (line 6). `AI_CHAT_CONFIG_CREATIVE.maxOutputToken` = 4000 (line 66). The evaluator adds `EVALUATION_SCORING_OUTPUT_TOKEN` to `config.maxOutputToken` (`src/utils/ai-chat.ts:1585`).

---

## Part 2 — Target Architecture

### 2.1 Schema split (`src/schema/story.ts`) — ✅ IMPLEMENTED, as follows (differs slightly from the original draft — see Part 0.5 item 6)

**Additive, non-breaking exports — implemented in `story_schema.ts`:**

```ts
// Page turn — alias, not a copy, of the existing STORY_PAGE_GENERATION_SCHEMA Record.
export const STORY_PAGE_SCHEMA_DEFINITION: Record<keyof StoryPageGeneration, AIJsonProperty> = STORY_PAGE_GENERATION_SCHEMA;
export const STORY_PAGE_REQUIRED_FIELDS = ['text', 'actions', 'calendarDate'] satisfies (keyof StoryPageGeneration)[];

// Delta turn, without branchNames — alias of the existing STORY_STATE_GENERATION_SCHEMA Record.
export const STATE_DELTA_SCHEMA_DEFINITION: Record<keyof StateDeltaGeneration, AIJsonProperty> = STORY_STATE_GENERATION_SCHEMA;
export const STATE_DELTA_REQUIRED_FIELDS: (keyof StateDeltaGeneration)[] = [];

// Delta turn + branchNames — this is what actually gets sent for Turn B (both single-page and
// multiverse call sites). No separate array-wrapped "candidate" schema — see Part 0.5 item 6.
export const STATE_DELTA_WITH_BRANCH_SCHEMA_DEFINITION = {
  ...STATE_DELTA_SCHEMA_DEFINITION,
  branchNames: { type: 'array', items: { type: 'string' }, description: 'Suggest 3 creative, distinct names for this timeline. Evocative, spoiler-free.' },
} satisfies Record<keyof StateDeltaGenerationWithBranch, AIJsonProperty>;
export const STATE_DELTA_WITH_BRANCH_REQUIRED_FIELDS: (keyof StateDeltaGenerationWithBranch)[] = [];

// Kept for backward compatibility + as the server-side merge-validation target — composed from
// the two exports above (aliases of the same objects), so it structurally cannot drift from them.
export const STORY_GENERATION_SCHEMA_DEFINITION = {
  ...STORY_PAGE_SCHEMA_DEFINITION,
  ...STATE_DELTA_SCHEMA_DEFINITION,
  branchNames: { /* existing */ },
} satisfies Record<keyof StoryGeneration, AIJsonProperty>;
```

`StateDeltaGenerationWithBranch` (new, `story_types.ts`) = `StateDeltaGeneration & { branchNames?: string[] }` — a named type so both `story_schema.ts` and `prompt.ts` reference the same shape instead of repeating the inline intersection.

`STORY_GENERATION_REQUIRED_FIELDS` is reused as `STORY_PAGE_REQUIRED_FIELDS`; the merged object still requires `['text', 'actions', 'calendarDate']`.

> `branchNames` placement: **Turn B (StateDelta)**, as originally recommended. The alternative names describe the *whole* divergence, which only exists after the delta is known; the delta prompt already carries the generated page text as input (`GENERATED PAGE`, Part 2.2), so it can name the branch sensibly.

### 2.2 Per-turn prompts (user & system separation) — ✅ IMPLEMENTED, table corrected per Part 0.5 items 4–5

**Turn A — StoryPage.** Reuses the existing `buildPresetSystemPrompt('next', preset)` unchanged (it already carries the page-staging + action rules). User prompt = page-scoped slices of the current builders:

| Piece | Current source | Turn A (page) | Turn B (delta) |
|---|---|---|---|
| TASK | `formatNextPageTaskPrompt` | keep, + new optional `fateContext` param for the divergence directive (Part 0.5 item 2) | new `formatStateDeltaTaskPrompt` — "given this generated page, update world state" |
| Story context | `formatNextPageStoryContextPrompt` | keep unchanged (needed to write the page) | keep unchanged (conservative first cut — see Part 5 decision 6) |
| Narrative | `formatNextPageNarrativePrompt` | keep, full (flags/profile/hidden/future-notes/threads/ending steer prose) | new `includeProseStyle=false` param — **drops only** the "NARRATIVE STYLE & PROSE ATMOSPHERE" block (the one section with zero relevance to any delta field); keeps flags/profile/hidden/composure/route-memory/future-notes/threads/ending (all plausibly inform a delta field) |
| Field instructions | `buildNextPageFieldInstructions` | split → `buildStoryPageFieldInstructions` (page keys only, + slug-ID handoff instruction on `charactersPresent`/`placeId` — Part 0.5 item 3) | split → `buildStateDeltaFieldInstructions` (delta keys only, + matching slug-ID instruction on `newCharacters`/`newPlaces`) |
| Review checklist | `buildNextPageReviewChecklist` | split → `buildStoryPageReviewChecklist` (sections 1–5, 7–9 renumbered 1–9, + JSON) | split → `buildStateDeltaReviewChecklist` (new "State Trajectory & Ending Progression" + section 6 Thread Management renumbered + new "Continuity & State Integrity (Delta)" + JSON) — **corrected split, not the draft's literal "1–5,8,9,10 vs 6,7"; see Part 0.5 item 5** |
| Output format example | `nextPageOutputFormat` | split → `storyPageOutputFormat` | split → `stateDeltaOutputFormat` (includes `branchNames`) |
| Evaluator | `buildNextPageEvaluatorPrompt` | **superseded — see below** | **superseded — see below** |
| System prompt | `buildPresetSystemPrompt` | keep `'next'` unchanged | new `buildPresetSystemPrompt('state-delta', preset)` — writing style + `RULES_LANGUAGE_LOCALIZATION` + `RULES_ROUTE_MEMORY` + `RULES_STORY_CONSISTENCY` + `RULES_FUTURE_NOTES` + `RULES_CHARACTER` + `RULES_CHARACTER_RECOGNITION` + `RULES_PLACE`. **Drop** `RULES_EMBODIED_SCENE_CONTINUITY`, page-text rules, `RULES_ACTIONS`, `RULES_SCENE_TYPES`, `RULES_ENDING_ARCHETYPES`, `RULES_STORY_MOMENTUMS`, `RULES_DIFFICULTY_SCALING`. `RULES_PLANNED_CHARACTERS` **removed from this list** — it's a user-prompt splice today, not a system-prompt rule, and applies to both turns' user prompts (Part 0.5 item 4). `RULES_CHARACTER_RECOGNITION` **added** — `recognitionLevel` is itself a delta field (Part 0.5 item 4). |

**Turn B input contract — implemented via `buildStateDeltaPrompt`'s "GENERATED PAGE" section**, formatted by a new `formatGeneratedPageForDeltaPrompt(storyPage)` (page text + a compact scene-facts summary — presented the way a human editor would read it, not raw JSON) rather than a raw `JSON.stringify` document snippet as the original draft sketched. Functionally the same idea (mirrors the evaluator's existing "feed previous AI output as context" pattern) — no new plumbing in `aiPrompt` either way.

**Evaluator — revised design, resolved by Part 5.5 Q2 (checkpoint 2), context/cache handling fixed at checkpoints 4–5.** Per-turn evaluation (`buildStoryPageEvaluatorPrompt`/`buildStateDeltaEvaluatorPrompt`, built at checkpoint 1) is **removed**: it would double evaluator-call cost per candidate (up to 4 total calls vs. today's up-to-2) for a benefit that doesn't actually require two rubrics. Instead: **exactly one evaluation pass, after Turn A + Turn B are merged**, reusing `buildNextPageEvaluatorPrompt` completely unchanged (it already targets the full `StoryGeneration` shape — zero new prompt content needed). New `evaluateMergedStoryGeneration` in `prompt.ts` calls a newly-`export`ed `runEvaluationPass` (extracted, not rewritten, from `aiPrompt`'s own inline evaluation block in `ai-chat.ts`). Total calls per candidate: 2 generation (Turn A + Turn B) + 1 evaluation = 3, vs. today's up-to-2 — one more call than today, not two. `evaluateMergedStoryGeneration` threads `documents`/`config`/`bookId` through from the same `setup` Turn A/Turn B already used (a gap caught during the checkpoint-4 audit), so the evaluation call carries the same book-level character/place context the legacy evaluator always had. Its `cachedContentId` is a dedicated key derived from the actual content being evaluated (`createCacheKey([bookId, merged])`, the same utility `buildBookMetaDocuments` uses for the book-level base ID) rather than reusing Turn A's `:story_page` slot or passing no ID at all — see BUG-01 in Part 4's risk table for why both of those were considered and rejected first.

*Why the merged object's size isn't actually a concern here (corrected at checkpoint 2 — the original reasoning below was more hedged than the code actually requires):* `buildEvaluationSchemaDefinition` (`schema/story.ts:756`) defaults `useStringEvaluatorOutput` to `true` — not as a Gemini-specific complexity fallback, but as the schema's normal default. In that mode `output`'s JSON-schema entry is just `{ type: 'string' }` (`schema/story.ts:773–777`): the actual object being evaluated (T — here, the merged `StoryGeneration`) never appears in the *structural* schema sent to any provider's constrained decoder, regardless of its size — the model is asked to write an escaped JSON string, not to fill a nested schema shaped like `StoryGeneration`. The rest of the wrapper (`scoreBefore`/`scoreAfter`/`actionFlags`/`integrityFlags`) is fixed, modest, and identical whether T is a small split-turn schema or the full merged object — it never scales with T at all. So `isSchemaTooComplex` essentially never trips for the evaluation call's *schema* regardless of T's size. What does scale with T is *prompt length* (the rubric text plus the "EXPECTED JSON SCHEMA" prose description of T) — and that's the one dimension where reusing the legacy full-size `buildNextPageEvaluatorPrompt` does cost something back. But this is exactly the prompt-length situation that already exists and is already tolerated every time evaluation runs today, handled the same way it always has been: `assertPromptAllowed` skips a provider that can't fit it, the waterfall moves to the next one, and evaluation is explicitly best-effort throughout (`runEvaluationPass`'s try/catch/finally — any failure, at any stage, falls back to the un-evaluated merged result; see `evaluateMergedStoryGeneration`'s `evaluated ?? { ...baseResult, result: merged }`). Nothing about the split's core goal (generation calls never failing on schema complexity or prompt length) is put at risk by this — only the optional polish pass inherits a pre-existing, already-accepted characteristic of today's evaluator.

### 2.3 Stage orchestration in the AI-chat layer — ✅ IMPLEMENTED (checkpoint 3), simplified from the original sketch

`aiPrompt`/`executePromptForJSON` stayed single-shot, exactly as planned. `GenerationStage` (the 2-value union) lives in `types/ai-chat.ts` (added at checkpoint 1, alongside `GenerationStage`'s natural home next to the other AI-layer types). `StageContext`/`GenerationStageDefinition<T>` landed in `types/prompt.ts` — the gap from checkpoint 1 (that file wasn't supplied yet) is closed:

```ts
// types/prompt.ts
export type StageContext = BuildNextPagePromptParams & {
  generatedPage?: StoryPageGeneration;   // present only for Turn B
};

export type GenerationStageDefinition<T extends Record<string, unknown>> = {
  stage: GenerationStage;
  prompt: string;
  systemPrompt: string;
  fieldInstructions: string;
  reviewChecklist: string;
  jsonStructure: string;
  schema: Record<keyof T, AIJsonProperty>;
  requiredFields: (keyof T)[];
  fallbackField: keyof T;
  config: AIChatConfig;        // from determineAIConfig — dynamic, not a static preset
  maxOutputToken: number;
  documents: AIDocument[];
  cachedContentId?: string;
  context: string;
  bookId: string;
};
```

Simpler than the original sketch in two ways, both deliberate: **(1) no `evaluatorPrompt` field** — per-turn evaluation was removed at checkpoint 2 (Part 5.5 Q2), so there's nothing per-stage to carry; **(2) `buildUserPrompt`/`evaluatorPrompt` aren't closures taking a `ctx: StageContext`** — the actual Phase 1 builders (`buildStoryPagePrompt`/`buildStateDeltaPrompt`) already take their own params directly, so `runGenerationStage` just receives the already-built `prompt: string`, not a function to call. One caught-during-implementation bug worth noting here even though it surfaces in Phase 4 (Part 3): the original sketch's `config` field doesn't appear at all — I initially hardcoded `AI_CHAT_CONFIG_CREATIVE` in `runGenerationStage`, which would have silently discarded `determineAIConfig`'s per-page dynamic tuning (psychological-state-based temperature/sampling adjustments); caught during Phase 4 wiring and fixed by threading the real `config` through `GenerationStageDefinition` instead.

```ts
// prompt.ts
async function runGenerationStage<T extends Record<string, unknown>>(
  definition: GenerationStageDefinition<T>,
  onProgress?: ProgressCallback,
  onGenerationProgress?: (step: StoryGenerationStep) => Promise<void>,
): Promise<AIResponse<T>>
```

Deliberately thin — it just assembles the `AIPromptForJsonParams<T>` shape `executePromptForJSON` expects (matching `generateNextPage`'s existing single-shot call field-for-field) and suffixes `cachedContentId`/`context` by `stage` (Part 0.5 item 1's Gemini cache-collision fix). SSE `onProgress` emits `ai_generation_start`/`ai_generation_complete` per turn (Part 4's SSE risk row, confirmed resolved against the now-supplied `types/book.ts`).

### 2.4 `generateNextPage` (single page) — 2-turn flow — ✅ IMPLEMENTED (checkpoint 3), flag-gated

```text
prepareNextPageGenerationSetup(params, 1)         // unchanged, computes shared context once
   │
   ▼
Checkpoint lookup: skip Turn A if a cached StoryPage already exists for this action (Part 2.6)
   │
   ▼
Turn A: runGenerationStage('story_page')          // schema = STORY_PAGE_SCHEMA_DEFINITION
   │  → StoryPage (validated against page schema) → upsert checkpoint (Part 2.6)
   ▼
Turn B: runGenerationStage('state_delta', {       // input doc = Turn A's StoryPage
   generatedPage: storyPage })                    // schema = STATE_DELTA_WITH_BRANCH_SCHEMA_DEFINITION
   │  → StateDelta
   ▼
merge: const generatedStoryPage: StoryGeneration =
   { ...storyPage, ...stateDelta, calendarDate: storyPage.calendarDate ?? actionedPage.calendarDate }
   │
   ▼
evaluateMergedStoryGeneration(generatedStoryPage, ...)   // 1 evaluation pass, Part 2.2/5.5 Q2
   │
   ▼
validateGeneratedPage(generatedStoryPage, mode)   // master validation, unchanged
   → canon pass → resolvePageDelta → determineBranchIdForPage → persistPageWithState → embeds
   → delete checkpoint (Part 2.6)
```

Failure semantics: if Turn A fails, nothing is persisted (today's behavior) — same as today, no checkpoint to write yet. If Turn B fails but Turn A succeeded, the checkpoint written after Turn A survives the failure; the *existing* retry layers (immediate 3× backoff, then the unchanged `retry-pending-generations.ts` cron — Part 2.6) will pick the candidate back up and skip straight to Turn B next time, without a dedicated retry mechanism of its own.

### 2.5 `generateNextPages` (multiverse) — parallel multi-turn — ✅ IMPLEMENTED (checkpoint 3), simplified from the original two-phase sketch

**Simplified during implementation:** rather than "Phase 1: all N StoryPage turns in parallel, then Phase 2: all N StateDelta turns in parallel" (the original sketch below), each alternative runs its own **independent, internally-sequential** (StoryPage → StateDelta) pipeline via `generateStoryGenerationMultiTurn` (Part 2.4) — all `candidateCount` of them in parallel via `Promise.allSettled`. Wall-clock cost is the same either way (bounded by one Turn-A + Turn-B latency pair regardless of how the parallelism is sliced), but this reuses `generateStoryGenerationMultiTurn` completely unmodified instead of needing a second, separate batch-orchestration layer — one less thing to keep in sync.

```text
prepareNextPageGenerationSetup(params, candidateCount)   // unchanged
   │
   ▼
Promise.allSettled(
  Array.from({ length: candidateCount }, (_, i) =>
    generateStoryGenerationMultiTurn({ ..., fateContext: { fateIndex: i, fateCount: candidateCount } })))
   // N independent (StoryPage → StateDelta → merge → 1 evaluation) pipelines, in parallel
   │
   ▼
normalize fulfilled results to { result, response } pairs, log+skip rejected ones
   │
   ▼
[existing per-alt persist loop: checkGeneratedPage → canon → resolvePageDelta →
   determineBranchIdForPage → persistPageWithState → embeds]   // fully unchanged
```

**A genuine resilience improvement over the legacy combined-batch path, not just a neutral refactor:** today, one malformed AI response in the single combined multi-page request loses *every* alternative at once (a JSON-parse-level failure has no partial-success recourse before the persist loop even starts). With `Promise.allSettled` over N independent generations, one alternative's total generation failure — either turn — no longer takes the others down with it. Partial-success behavior in the *persist* loop is otherwise unchanged: a failed alternative is skipped, only an all-failed batch throws. `usedBranchIds` collision guard and `determineBranchIdForPage`'s `ACTION_ALREADY_HAS_DESTINATION` idempotency are untouched. The `*candidateCount` token multiplication is removed for the multi-turn path — each turn uses its own fixed per-turn budget (Phase 2) regardless of `candidateCount`.

**A real bug caught during this implementation, not present in the original sketch's design:** the shared `evaluateMergedStoryGeneration` step reuses `buildNextPageEvaluatorPrompt`, which branches its "EXPECTED JSON SCHEMA" text on `candidateCount > 1` (describing the array-wrapped `multiNextPageOutputFormat` shape for the legacy batch path). Passed through unchanged, every per-alternative evaluation call in a multi-candidate multi-turn request would have described the wrong shape — the evaluator's prose would say "an array of pages" while the actual schema enforced was a single `StoryGeneration`. Fixed by forcing `candidateCount: 1` for that one call only (not the shared `params` object other builders still read) — see the code comment on `evaluateMergedStoryGeneration` for the full explanation.

### 2.6 Turn-A result checkpoint cache (replaces the original "partial persistence + dedicated cron" design — see Part 5.5 Q4)

**Revised after reviewing `retry-pending-generations.ts` and `candidate-generation.ts`'s `ensureCandidatesForPageWithStrategy`, both supplied at checkpoint 2.** The original Part 2.6 draft (dedicated `page_generation_tasks` table + a new sibling cron) assumed a Turn-B failure was an unhandled resilience gap. It isn't: `ensureCandidatesForPageWithStrategy` already retries each action's candidate generation up to 3× with backoff (`retryWithBackoffOrNull`), and if that still fails, leaves `destinationPageIds` empty — which keeps `pages.pendingGenerationCount > 0`, which `retryPendingGenerations()` (the existing cron) already picks up and retries on its next scheduled run, indefinitely, until it succeeds. **A Turn-B failure was never going to lose a candidate — it just means the whole 2-turn attempt (including the Turn A that already succeeded) gets retried from scratch, twice over** (once by the immediate 3× backoff, again by the cron if that also fails).

That reframes what's actually needed: not a new tracking/retry system, but a **cache** that lets a retried attempt skip Turn A if a valid one was already produced — benefiting *both* existing retry layers automatically, since both ultimately call `generateCandidatePages` → `generateNextPages` (`candidate-generation.ts:498,517`). No new cron. No new retry loop. No changes to `retry-pending-generations.ts`'s core logic.

```ts
export const pageGenerationCheckpoints = pgTable("page_generation_checkpoints", {
  id: id(),
  bookId: bookId("cascade"),
  actionedPageId: uuid("actioned_page_id"),   // parent page this action belongs to
  actionText: text("action_text").notNull(),  // action identity within the parent page
  fateIndex: integer("fate_index").notNull().default(0), // alternative slot (0-based); 0 for generateNextPage
  storyPageJson: jsonb("story_page_json").$type<StoryPageGeneration>().notNull(),
  storyPageProvider: text("story_page_provider"),
  storyPageModel: text("story_page_model"),
  createdAt, updatedAt,
}, (t) => [
  unique("page_generation_checkpoints_action_fate_unique").on(t.actionedPageId, t.actionText, t.fateIndex),
]);
```

**Wiring (inside the refactored `generateNextPage`/`generateNextPages`, Phase 4/5):**
1. **Before Turn A:** look up a checkpoint for `(actionedPageId, actionText, fateIndex)`. If found, skip Turn A entirely and reuse `storyPageJson` — this is the whole optimization.
2. **After Turn A succeeds:** `upsert` the checkpoint (best-effort — a failed write is logged and generation proceeds anyway; it only costs the optimization on the *next* retry, not correctness now).
3. **After the merged page is successfully persisted:** delete the checkpoint — it's no longer needed once state is fully committed.

**Validity — no TTL needed for correctness.** `advancedState` is reconstructed deterministically from the immutable parent page + action (`prepareNextPageGenerationContext` / `getStoryStateWithBranch` + `advanceStoryState`), not from "current live state" that could drift between attempts — so a cached Turn A page stays valid regardless of how much time passed before a retry picks it up. The only thing a checkpoint can become is **orphaned**, not stale: if an action is eventually replaced by `ensureCandidatesForPageWithStrategy`'s fallback ("all actions invalid → replace with 1 continue action"), its checkpoint has no home. This is a storage-hygiene concern, not a correctness one — worth a periodic sweep (optional, low priority; can piggyback on `retry-pending-generations.ts`'s existing end-of-run cleanup calls as one more additive line, exactly like `cleanupGeneratingStartedAt`/`cleanupStuckGenerations` already do — or be deferred/run manually, since orphan volume should be low).

**Idempotency under concurrency:** the unique `(actionedPageId, actionText, fateIndex)` key means a checkpoint upsert from a losing race just overwrites with an equally-valid Turn A result (both are valid completions of the same deterministic input) — no conflict-guard logic needed beyond what `upsert`/`onConflictDoUpdate` already gives for free.

---

## Part 3 — Phased Execution Plan

Each phase is independently shippable; Phase 0–3 are pure additions with zero behavior change, so they can land behind the existing pipeline before the orchestrator flips.

### Phase 0 — Schema split (no behavior change) — ✅ DONE

- ✅ **Step 0.1** — `story_schema.ts`: exported `STORY_PAGE_SCHEMA_DEFINITION`, `STORY_PAGE_REQUIRED_FIELDS`, `STATE_DELTA_SCHEMA_DEFINITION`, `STATE_DELTA_REQUIRED_FIELDS`; refactored `STORY_GENERATION_SCHEMA_DEFINITION` to compose from them so the two definitions can't drift (the exact class of bug `TODO-multi-turn-request.md` warns about).
- ✅ **Step 0.2 (revised)** — added `STATE_DELTA_WITH_BRANCH_SCHEMA_DEFINITION` / `STATE_DELTA_WITH_BRANCH_REQUIRED_FIELDS` instead of the originally-proposed `CANDIDATE_PAGE_SCHEMA_DEFINITION`/`CANDIDATE_DELTA_SCHEMA_DEFINITION` pair (Part 0.5 item 6 — no separate array-wrapped shape needed in the parallel-per-alternative design). `CANDIDATE_GENERATION_SCHEMA_DEFINITION` kept unchanged for the pre-flip path.
- ✅ **Step 0.3** — `story_types.ts`: confirmed `StoryPageGeneration` / `StateDeltaGeneration` / `StoryGeneration` need no change. Added `StateDeltaGenerationWithBranch = StateDeltaGeneration & { branchNames?: string[] }` (the original draft's note here said "add to `StoryPageGeneration`", which was backwards — `branchNames` moves to Turn B/delta, not Turn A/page).

### Phase 1 — Per-turn prompt builders — ✅ DONE

- ✅ **Step 1.1** — split `nextPageOutputFormat` → `storyPageOutputFormat` + `stateDeltaOutputFormat`. Implemented via a bracket-depth-aware parse of the original template into 35 per-key chunks, partitioned 11/24 and diff-verified lossless before reassembly — not hand-retyped. `multiNextPageOutputFormat` kept for the legacy path.
- ✅ **Step 1.2** — split `buildNextPageFieldInstructions` → `buildStoryPageFieldInstructions` / `buildStateDeltaFieldInstructions`, both reading from one shared, computed-once `buildNextPageFieldInstructionSections` array (31 sections, split-verified byte-lossless against the original via automated diff) rather than literal copies — the legacy function still joins *all* sections, so it's provably byte-identical to pre-split output. Added the slug-ID handoff instructions (Part 0.5 item 3) to the `charactersPresent`/`placeId`/`newCharacters`/`newPlaces` sections, gated behind an `isMultiTurn` flag so the legacy prompt is untouched. **Extracted to its own `utils/field-instructions.ts` and made generic at checkpoint 6** — `FieldInstructionSection<T>`'s `fields: (keyof T)[]` (renamed from `field: string`) is checked against real `StoryGeneration` keys at compile time; see the checkpoint 6 log entry.
- ✅ **Step 1.3 (revised split)** — page checklist = original sections 1–5, 7–9 (renumbered 1–9) + JSON. Delta checklist = new "State Trajectory & Ending Progression" (distilled from section 1's ending-progression bullets) + section 6 Thread Management (renumbered) + new "Continuity & State Integrity (Delta)" (ID-validity/new-vs-updated/justified-by-the-page checks) + JSON. This is NOT the draft's literal "1–5,8,9,10 vs 6,7" split — see Part 0.5 item 5 for why. Evaluator: see "Evaluator — revised design" in Part 2.2 above — the per-turn split originally planned here (`buildStoryPageEvaluatorPrompt`/`buildStateDeltaEvaluatorPrompt`) was built at checkpoint 1 and then **removed at checkpoint 2** in favor of a single merged-object evaluation pass (Part 5.5 Q2).
- ✅ **Step 1.4** — added `formatStateDeltaTaskPrompt` (delta TASK, newly authored) and extended `buildPresetSystemPrompt` with a third `'state-delta'` branch (table in Part 2.2, corrected per Part 0.5 item 4) rather than a separate `buildStateDeltaSystemPrompt` function — smaller surface, same effect. `formatNextPageNarrativePrompt` gained an `includeProseStyle` param (default `true`, preserving every existing call site) instead of a separate "reduced" function.
- ⏸️ **Step 1.5 — not needed.** `buildPresetSystemPrompt`'s `writingStyle` lookup (`PROMPT_SYSTEM_WRITING_STYLE[preset]`) is shared across all three `type` branches already — no `book-creation.ts` changes were required to add the `'state-delta'` branch. (`book-creation.ts` wasn't supplied for this pass in any case.)

### Phase 2 — Per-turn output-token budgets — ✅ DONE

- ✅ **Step 2.1** — `ai-chat.config.ts`: added the four per-turn budgets as an intentionally **asymmetric** split (not a straight halving):

```ts
export const STORY_PAGE_MAX_OUTPUT_TOKEN: number = 2200;   // page text + scene meta + actions
export const STATE_DELTA_MAX_OUTPUT_TOKEN: number = 1800;  // characters/places/threads/facts/ending
export const STORY_PAGE_EVALUATION_OUTPUT_TOKEN: number = 1100;
export const STATE_DELTA_EVALUATION_OUTPUT_TOKEN: number = 900;
```

`DEFAULT_MAX_OUTPUT_TOKEN` stays 4000 for non-split callers. Full rationale (why 2200/1800 rather than 2000/2000) is documented inline in `ai-chat.config.ts` — page text rarely approaches half the old shared 4000 budget, while delta's largest fields (`contextHistory` + every new/updated array) are the ones that actually risked `finishReason === 'length'` under the old shared pool.
- ⏳ **Step 2.2 — not yet reached.** Removing `maxOutputToken: DEFAULT_MAX_OUTPUT_TOKEN * candidateCount` happens inside `generateNextPages`'s rewrite (Phase 5, not started).

### Phase 3 — Stage orchestration types — ✅ DONE

- ✅ **Step 3.1 (gap closed)** — `types/prompt.ts` is now supplied (checkpoint 2). `StageContext`/`GenerationStageDefinition<T>` are defined there properly, per the codebase's existing type-organization convention, closing the checkpoint-1 gap that had them planned as a local-to-`prompt.ts` fallback. `GenerationStage` stays in `types/ai-chat.ts` (added checkpoint 1).
- ✅ **Step 3.2** — `runGenerationStage` implemented in `prompt.ts`. One real bug caught and fixed during this step: initially hardcoded `AI_CHAT_CONFIG_CREATIVE` as the base config, which would have silently discarded `determineAIConfig`'s dynamic per-page tuning — fixed by threading the real `config` through `GenerationStageDefinition` instead of assuming a static preset. See Part 2.3.

### Phase 4 — `generateNextPage` 2-turn refactor — ✅ DONE

- ✅ **Step 4.1 (revised)** — rather than two standalone `generateStoryPage`/`generateStateDelta` helpers, implemented as one shared `generateStoryGenerationMultiTurn` (Part 2.4) — it's the exact same logic `generateNextPages` needs per-alternative (Phase 5), so sharing it outright avoids two copies that could drift instead of extracting two pieces that would need re-composing at each call site anyway.
- ✅ **Step 4.2** — 2-turn flow + merge + 1 evaluation pass (`evaluateMergedStoryGeneration`) + master `validateGeneratedPage`, flag-gated on `USE_MULTI_TURN_GENERATION` inside `generateNextPage` itself. `generateStoryGenerationMultiTurn` returns the identical `AIResponse<StoryGeneration>` shape the legacy `executePromptForJSON` call already returns, so every line of `generateNextPage` after the response is produced — validate, canon, `resolvePageDelta`, branchId, persist, embeds — needed **zero changes**, flag-gated or otherwise. Checkpoint-cache touch-points (Phase 6) are marked with `TODO(Phase 6)` comments at their exact insertion points but not yet wired — Phase 6 hasn't landed yet, so Turn A always runs fresh for now (never worse than today, just not yet optimized).

### Phase 5 — `generateNextPages` parallel multi-turn refactor — ✅ DONE

Simplified from the original two-phase sketch during implementation — see Part 2.5 for the reasoning (same wall-clock cost, reuses `generateStoryGenerationMultiTurn` unmodified, and gets a real resilience improvement over the combined-batch path for free via `Promise.allSettled`).

- ✅ **Step 5.1 (revised)** — replaced with `Promise.allSettled` over `candidateCount` independent `generateStoryGenerationMultiTurn` calls (each with its own `fateContext`), not a separate "parallel Turn A batch" step.
- ✅ **Step 5.2 (dropped — folded into 5.1)** — no separate StateDelta batch phase; each alternative's Turn B runs inside its own `generateStoryGenerationMultiTurn` call.
- ✅ **Step 5.3** — normalizes both the multi-turn path's per-alternative `{result, response}` pairs and the legacy path's shared-response pages into the same shape before the existing per-alt persist loop (canon → `resolvePageDelta` → branchId → persist → embeds), which needed **zero changes** beyond reading from the normalized array instead of `response.result.generatedPages` directly. One real bug caught here: `evaluateMergedStoryGeneration` needed a `candidateCount: 1` override for its internal `buildNextPageEvaluatorPrompt` call — see Part 2.5's writeup.

### Phase 6 — Turn-A result checkpoint cache (DB) — ⏳ TODO — replaces the original Phase 6+7 pair

**Phase 7 (the original "idempotent state-delta retry cron") is dropped as a separate phase** — folded into Phase 6, since the checkpoint-cache design (Part 2.6) needs no dedicated cron at all; both of the existing retry layers (`ensureCandidatesForPageWithStrategy`'s in-process 3× backoff, and `retryPendingGenerations()`'s scheduled sweep) already call through `generateNextPages` and benefit automatically once the cache check/write is inside it. `retry-pending-generations.ts` needs **zero changes** for correctness. See Part 5.5 Q4 for the discovery and full reasoning.

- **Step 6.1** — add `pageGenerationCheckpoints` table (Part 2.6) + migration (`bun db:generate` / `bun db:migrate`).
- **Step 6.2** — wire the 3 checkpoint touch-points into the refactored `generateNextPage(s)` (Phase 4/5): check-before-Turn-A, upsert-after-Turn-A, delete-after-persist.
- **Step 6.3** — expose `getPageGenerationCheckpoint(actionedPageId, actionText, fateIndex)` / `upsertPageGenerationCheckpoint(...)` / `deletePageGenerationCheckpoint(...)` in a new `src/services/page-generation-checkpoints.ts`.
- **Step 6.4 (optional, low priority)** — one additive line in `retry-pending-generations.ts`'s existing end-of-run cleanup (alongside its current `cleanupGeneratingStartedAt`/`cleanupStuckGenerations` calls) to sweep orphaned checkpoints — see Part 2.6's staleness note for why this is hygiene, not correctness. Deferrable indefinitely without risk.

### Phase 7 — *(dropped — see Phase 6 above)*

### Phase 8 — Verification & feature flag — 🔧 PARTIAL

- ✅ **Step 8.1** — `USE_MULTI_TURN_GENERATION` flag added to `ai-chat.config.ts` (reads `process.env.USE_MULTI_TURN_GENERATION === 'true'`, default `false`). **Resolved at checkpoint 2 (Q5):** since Twistloom is confirmed still pre-launch with no live traffic, the recommendation is to flip this to `true` in dev/staging as soon as Phase 5 lands, so the path gets real exercise before any production concern applies. `config/env.ts` is now supplied — confirmed it only exports plain `process.env`-backed constants with no shared helper/factory to route through (`IS_PRODUCTION`, `IS_DEVELOPMENT`, etc. are each their own one-line export), so reading `process.env.USE_MULTI_TURN_GENERATION` directly in `ai-chat.config.ts` (current implementation) already matches the codebase's actual convention — no change needed here after all. `generateNextPage(s)` branching on this flag happens in Phase 4/5 (not yet reached).
- ⏳ **Step 8.2** — quality gates unavailable in this environment (no project checkout / `node_modules`); substituted with `esbuild` syntax verification after every edit + automated string-diff verification for every text split, both described per-file in Part 6. `package.json` (now supplied) confirms `bun run typecheck` (`bunx tsc --noEmit`) and `bun run lint:fast` as the real gates — recommend running both once this lands in an actual checkout.
- ⏳ **Step 8.3 / 8.4** — apply once Phases 3–6 land.

### Phase 9 — Deterministic server-side reconciliation for the slug-ID handoff (future enhancement, not blocking)

**Origin:** an external review (Antigravity, checkpoint 5) proposed this as ISSUE-05/Open Question 2. Assessed as a genuinely good idea — not a bug fix, a robustness layer on top of something that already works.

**Current state, and why this is additive, not corrective:** the slug-ID handoff (Part 0.5 item 3) is a *prompt-level* convention — Turn A is instructed to invent a stable slug ID for a brand-new character/place, Turn B is instructed to reuse that exact ID in `newCharacters`/`newPlaces`. This already has two layers of defense: the field instructions state the contract explicitly (`buildStoryPageFieldInstructions`/`buildStateDeltaFieldInstructions`'s `isMultiTurn` sections), and the evaluator's rubric scores it directly (§2 Continuity & ID Integrity in the — now superseded — per-turn evaluator design; the current single merged-object evaluator, reusing `buildNextPageEvaluatorPrompt`, scores overall consistency across the merged object, which covers this too, just less surgically). What's missing is a *deterministic* backstop for when the model doesn't follow the convention — today, a mismatch means the character/place record never gets created, and a persisted page could reference an ID with no backing entity.

**Proposed design (sketch, not final — would need verification against the real `StoryState` shape before implementing):**

```ts
function reconcileUnresolvedSlugIds(merged: StoryGeneration, state: StoryState): StoryGeneration {
  const knownCharacterIds = new Set([...state.characters.map(c => c.characterId), ...(merged.newCharacters ?? []).map(c => c.characterId)]);
  const orphanedCharacterIds = merged.charactersPresent
    .map(c => c.characterId)
    .filter(id => !knownCharacterIds.has(id));

  const synthesizedCharacters = orphanedCharacterIds.map(id => ({
    characterId: id,
    knownName: 'Unknown', // or derive from page text — needs a design decision
    recognitionLevel: 'unrecognized' as const,
    // ...minimum-viable fields per NEW_CHARACTER_SHAPE
  }));

  // Same pattern for merged.placeId against state.places / merged.newPlaces.

  return synthesizedCharacters.length
    ? { ...merged, newCharacters: [...(merged.newCharacters ?? []), ...synthesizedCharacters] }
    : merged;
}
```

Call this right after merge, before `validateGeneratedPage`/canon/persist — a pure, deterministic, zero-AI-cost safety net, not a replacement for the prompt-level convention.

**Why deferred:** this needs real `StoryState.characters`/`StoryState.places` shapes (keyed how? by ID directly, or an array requiring a `.find()`?) verified against the actual type before the sketch above can become real code — a wrong assumption here would silently create malformed character/place stubs, which is worse than the rare unresolved-ID case it's meant to catch. Also needs a design decision on what a "minimum-viable synthesized character" should contain (placeholder name? Inferred from the page text somehow? Flagged specially so the UI can show it differently?) that's a product question, not just an engineering one.

**Effort:** small-medium. **Risk if deferred:** low — this only matters on the rare occasion the model doesn't follow an explicit, evaluator-scored instruction it's already given.

### Phase 10 — Turn B context pruning (future enhancement, not blocking)

**Origin:** raised independently by both this project's own Part 5.5 decision 6 (checkpoint 2, "conservative first cut... narrower trimming is a documented, deliberately-deferred follow-up") and the external review's ISSUE-07/Open Question 4 — the same conclusion reached twice, independently, which is a reasonable signal it's worth eventually doing.

**What it is:** `formatNextPageStoryContextPrompt` is currently reused byte-for-byte for both Turn A and Turn B (Part 2.2's table). Turn B doesn't need the full previous-pages prose the way Turn A does — it needs *facts, threads, and dates* for continuity judgment, not necessarily the narrated text of prior pages. A tighter Turn B-specific variant could drop or summarize the prose-heavy portions of story context, shrinking Turn B's prompt further than the current split already does.

**Why deferred (both times it's been considered):** the story-context builder is large and shared by other callers beyond just these two turns; forking it for a "reduced" Turn B variant risks the exact kind of drift this whole project has been trying to eliminate (see Part 0.5's discussion of the `newPlaces.knownCharacters` bug class) unless done carefully — likely via the same "shared array of sections, filtered by consumer" pattern `buildNextPageFieldInstructionSections` already established, rather than a hand-forked copy. That's a real, scoped piece of work, not a quick tweak.

**Effort:** medium. **Risk if deferred:** low — this is a token-cost optimization on an already-working, already-shrunk prompt, not a correctness gap.

### Phase 11 — Reconsidering the evaluation strategy (documented for your own call, not recommended)

**Origin:** the external review's Open Question 1 proposes evaluating Turn A's prose *before* Turn B runs, instead of the current single post-merge evaluation (Part 5.5 Q2). Recorded here for completeness, not as a recommendation — reversing this isn't something I'm doing unilaterally, for two reasons: (1) you explicitly asked for the post-merge design at checkpoint 2 ("what if I want 1x evaluator at the end... propose the best & cleanest approach"), and a prior explicit decision shouldn't be quietly reversed by a third-party review; (2) the review's stated justification for it — that Turn B's output is "already validated downstream by Zod schemas" — doesn't hold up; there's no Zod anywhere in this project's `package.json` dependencies, so that specific rationale is factually wrong, which weakens the case for revisiting this regardless of the idea's other merits.

**The idea on its own merits, for your own weighing:** evaluating Turn A alone, before Turn B runs, would mean Turn B always builds on an already-corrected page rather than a possibly-flawed one — arguably higher quality for the page text specifically. The trade-off is real too: it reintroduces a form of the original per-turn evaluation cost problem Q2 was designed to avoid (though only for one turn, not both — 1 extra call either way, same as today's post-merge design, just positioned differently), and it means Turn B's own structural correctness (the thing the post-merge evaluator's rubric — reused from `buildNextPageEvaluatorPrompt` — actually spends most of its dimensions on) gets no evaluation pass at all under this alternative, unless a second evaluator is added back for Turn B specifically, which starts to erode the exact simplification checkpoint 2 was trying to achieve.

**If you want this changed:** it's a small, contained change — evaluate right after Turn A (`storyPageResponse`) instead of after merge, threading the corrected page into `buildStateDeltaPrompt` instead of the raw one. Tell me and I'll implement it against the actual code rather than sketching it here.

---

## Part 4 — Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| **RPM/RPD consumption** (the ChatGPT doc's headline trade-off) | ~1→2 requests per candidate (×2 with evaluator); multiverse ×3 alternatives | Parallel phases keep wall-clock at 2 sequential layers; per-turn context specialization reduces input tokens; document the rate math in Part 5 before flipping default on |
| **Input-token duplication** (story context re-sent per turn) | Turn B resends story context + Turn A output | Context specialization: Turn B drops the narrative-style prose block (`includeProseStyle=false`); story context is reused unchanged for both turns as a conservative first cut (Part 5 decision 6) |
| **Schema divergence between page/delta definitions** | Drift → field-level bugs (the `newPlaces.knownCharacters` class of bug) | ✅ Step 0.1 composes `STORY_GENERATION_SCHEMA_DEFINITION` from the two halves — single source of truth. **Done.** |
| **Merged-object validation gaps** | Page and delta pass separately but merged object violates `StoryGeneration` | Keep master `STORY_GENERATION_SCHEMA_DEFINITION` + `validateGeneratedPage` on the merged object (unchanged) — applies once Phase 4 lands |
| **`branchNames` in the wrong turn** | Names that don't fit the diverged branch | ✅ Moved to Turn B (delta) where the full divergence is known; `resolveBranchDisplayName` unchanged. **Done** (`STATE_DELTA_WITH_BRANCH_SCHEMA_DEFINITION`). |
| **Gemini explicit-cache key collision across turns** *(found during implementation — Part 0.5 item 1, not in original draft)* | Turn B could silently reuse Turn A's cached system instructions (or vice versa), since `cachedContentId` is derived only from book/character/place data, independent of `systemPrompt` | ✅ Each turn suffixes the shared `cachedContentId` (`:story_page` / `:state_delta`) before calling the stage runner — safe by construction regardless of `getOrCreateGeminiCache`'s internal matching. **Fix designed; wiring lands with Phase 3's `runGenerationStage`.** |
| **Multiverse alternatives converge instead of diverging under parallelization** *(found during implementation — Part 0.5 item 2, not in original draft)* | Independent parallel StoryPage calls can't see each other, unlike the current single combined completion — alternatives could read as near-duplicates | ✅ `formatFateDivergenceDirective` — deterministic, zero-cost per-alternative narrative-angle rotation. **Done** (wired into `formatNextPageTaskPrompt`/`buildStoryPagePrompt`; actual parallel loop lands with Phase 5). |
| **Cross-turn ID handoff for brand-new characters/places** *(found during implementation — Part 0.5 item 3, not in original draft)* | Turn A may need to reference a character/place ID that doesn't exist yet (first appearance); Turn B — not Turn A — is the one that formally introduces it via `newCharacters`/`newPlaces`, so without a shared convention the IDs could mismatch | ✅ Slug-ID handoff convention: Turn A invents a stable slug ID, Turn B is instructed to reuse it exactly. **Done**, scored directly by the new delta evaluator's Continuity & ID Integrity dimension. |
| **Retried generation races a concurrent attempt** | Duplicate page for same action | Existing `determineBranchIdForPage`'s `ACTION_ALREADY_HAS_DESTINATION` guard + `persistPageWithState`'s branch-conflict retry (already relied on today, unchanged) + the checkpoint's unique `(actionedPageId, actionText, fateIndex)` key for the cache layer itself |
| **Checkpoint reused for a Turn A that's no longer valid** | Stale page persisted | Not applicable — `advancedState` is deterministically reconstructed from the immutable parent page + action, not live-drifting state (Part 2.6) — a checkpointed Turn A page has no staleness window, only an orphan risk (low priority, Phase 6 Step 6.4) |
| **Assumed a resilience gap that didn't exist** *(found reviewing the supplied `retry-pending-generations.ts`/`candidate-generation.ts` at checkpoint 2 — corrects the original Phase 6/7 draft)* | Would have built a redundant tracking/retry system alongside the one that already exists | ✅ Confirmed `ensureCandidatesForPageWithStrategy`'s 3× backoff + the existing cron already guarantee eventual success on any generation failure; redesigned Phase 6 as a pure cost-optimization cache with no new cron (Part 2.6, Part 5.5 Q4) |
| **`runGenerationStage` silently discarding `determineAIConfig`'s dynamic tuning** *(found during Phase 3/4 implementation, checkpoint 3)* | Every multi-turn generation call would have used a static creative preset instead of the psychological-state-tuned config every other call site (legacy and multi-turn alike) relies on — a real, if subtle, generation-quality regression, not a crash | ✅ Caught before Phase 4 wiring shipped — `config: AIChatConfig` threaded through `GenerationStageDefinition` from `determineAIConfig`'s actual output instead of assumed static (Part 2.3) |
| **Evaluator prose/schema mismatch for multi-candidate multi-turn requests** *(found during Phase 5 implementation, checkpoint 3)* | `buildNextPageEvaluatorPrompt` describes the array-wrapped batch shape whenever `candidateCount > 1` — reused unchanged for each alternative's post-merge evaluation, every multi-candidate multi-turn evaluation call would have told the model to expect/produce an array while actually enforcing a single-object schema | ✅ `evaluateMergedStoryGeneration` forces `candidateCount: 1` for its internal `buildNextPageEvaluatorPrompt` call only — the shared `params` object other builders read is untouched (Part 2.5) |
| **`esbuild`-only verification has a real blind spot for type errors** *(found via actual `bun check`/`tsc` output against the real project, checkpoint 4)* | 3 genuine `tsc` compile errors (a generic constraint mismatch, an object-spread type-narrowing failure, a cross-branch type unification failure) all passed `esbuild` cleanly at the checkpoint each was introduced, because `esbuild` strips types without checking them — syntax-valid stripped JS says nothing about type correctness | ✅ All 3 fixed and re-verified against isolated `tsc --strict` reproductions (checkpoint 4). Ongoing mitigation: every future checkpoint explicitly checks for this class of issue (missing type imports, generic constraint mismatches across related generic functions, spread type narrowing, cross-branch type unification) rather than treating a clean `esbuild` run as sufficient |
| **Evaluator silently missing book-level context on the merged-object path** *(found during the checkpoint-4 audit)* | `evaluateMergedStoryGeneration` passed only `{ modelSelection }` to `runEvaluationPass`, dropping the character/place context documents the legacy evaluator always had — a quiet quality regression, not a crash | ✅ `documents`/`config`/`bookId` threaded through from the same `setup` Turn A/Turn B already use (Part 2.2). The checkpoint-4 version of this fix *also* reused Turn A's `:story_page` cache slot for the evaluation call — that part was wrong; see BUG-01 below for why and how it was corrected at checkpoint 5 |
| **BUG-01 — Gemini/Mistral cache-slot corruption in the evaluator** *(external review, checkpoint 5, confirmed real)* | `runEvaluationPass` always appends a candidate-specific "GENERATED JSON" document before the cache-content hash is computed, so reusing Turn A's `:story_page` ID for evaluation (the checkpoint-4 fix) could never produce a matching hash — worse, it meant every parallel alternative's evaluation call would repeatedly overwrite the *shared* slot every alternative's Turn A legitimately depends on staying stable, thrashing the cross-candidate cache sharing Turn A was designed to get | ✅ `evaluateMergedStoryGeneration` now derives a dedicated `cachedContentId` from the actual content being evaluated (`createCacheKey([bookId, merged])`) instead of reusing Turn A's slot or passing no ID — unique per merged content, so it can't collide with Turn A's slot, still caches validly across this one evaluation call's own provider-waterfall retries. An intermediate `cachedContentId: undefined` fix was considered and rejected: `resolveGeminiCachedContent` correctly no-ops on a falsy ID, but `buildMistralPromptCacheKey` instead falls back to a *shared* generic key (`'twistloom:mistral:shared'`) used by unrelated callers (`pen.ts`, `canon-validation.ts`) — `undefined` would have traded one collision for a different one |
| **BUG-02 — evaluator schema silently malformed in structured-object mode** *(external review, checkpoint 5, confirmed real by direct inspection)* | `buildEvaluationSchemaDefinition` (`schema/story.ts`) builds `output`'s schema from `options.outputJsonStructure`/`options.outputJsonRequired` when `useStringEvaluatorOutput` is `false` — `evaluateMergedStoryGeneration` never supplied either, so any evaluator call in structured-object mode would send `properties: undefined`, which providers requiring `properties` on a `type: 'object'` schema reject outright | ✅ Now passes `STORY_GENERATION_SCHEMA_DEFINITION`/`STORY_GENERATION_REQUIRED_FIELDS` — exactly what the legacy single-shot flow already supplies for the equivalent call, and exactly correct here too since `merged` is always a full `StoryGeneration` regardless of path |
| **BUG-03 — SSE/DB progress callbacks not threaded through the multi-turn path** *(external review, checkpoint 5, assessed as likely false positive, fixed defensively anyway)* | `generateStoryGenerationMultiTurn` didn't accept or forward `onProgress`/`onGenerationProgress` | Directly verified `BuildNextPageParams` has never carried these fields, and the *legacy* branch's `executePromptForJSON` call never passed them either — for either path, at this entry point, there was nothing to "drop." Fixed anyway for parity: added to `BuildNextPageParams`, threaded through both `generateNextPage`/`generateNextPages` branches identically, since the fix is cheap and removes any doubt |
| **BUG-04 — calendarDate fallback applied too late in the multi-turn merge** *(external review, checkpoint 5, confirmed real)* | `generateStoryGenerationMultiTurn`'s merge didn't apply the `calendarDate ?? actionedPage.calendarDate` fallback the roadmap's own Part 2.4 diagram specified — `evaluateMergedStoryGeneration` could score a transiently-missing date, and a stray runtime `calendarDate` key on Turn B's parsed JSON (structurally impossible per the TYPE, not impossible at runtime if a provider doesn't strictly enforce `additionalProperties: false`) could silently overwrite Turn A's correct value | ✅ Fallback now applied immediately at merge time in `generateStoryGenerationMultiTurn`, matching the documented design |
| **ISSUE-06 — `closeThreads` schema description said "titles" instead of "IDs"** *(external review, checkpoint 5, confirmed real by direct inspection)* | Schema description disagreed with the field instructions text (which already correctly said "thread IDs") and with how the field is actually consumed | ✅ Fixed in `schema/story.ts` |
| **SSE progress semantics** | Frontend expects one `ai_generation` step | ✅ **Confirmed against the now-supplied `types/book.ts`:** `ai_generation`/`ai_evaluation` are separate existing steps — emit `ai_generation_start/complete` twice (once per turn) and `ai_evaluation_start/complete` once (for the new single post-merge pass, Part 5.5 Q2) — maps onto the existing vocabulary exactly, no new step needed, no guesswork required (Part 5 decision 5 fully resolved, not just deferred) |

---

## Part 5 — Decisions Needed Before Implementation

Resolved where implementation already required an answer (Phases 0–2); left open where the relevant phase hasn't been reached yet. Overridable — flag anything you'd rather have gone the other way and it gets revised before Phase 6/7 land.

1. **Partial-persistence shape:** ✅ **resolved — dedicated table, redesigned as a checkpoint cache, not a task ledger.** See Part 2.6 and Part 5.5 Q3/Q4 for the full story: the original "table vs. columns on `pages`" framing assumed a retry mechanism needed to be built from scratch; it doesn't (Q4's discovery), so the table that IS still needed (`pageGenerationCheckpoints`) is much smaller than first planned — no `status`/`attemptCount`/`lastError` columns, just the cached Turn A output.
2. **`branchNames` turn:** ✅ **resolved — Turn B.** Implemented (`STATE_DELTA_WITH_BRANCH_SCHEMA_DEFINITION`).
3. **Token budgets:** ✅ **resolved for v1 — asymmetric `2200/1800` and `1100/900`**, with the rationale (why not a straight halving) documented inline in `ai-chat.config.ts`. Genuinely tentative pending real `finishReason === 'length'` telemetry — revisit once the multi-turn path has real traffic.
4. **Feature flag default:** ✅ **resolved — `false`.** `USE_MULTI_TURN_GENERATION` defaults off; flipping it on is a deliberate, separate decision after Phase 8's manual pass, not something this implementation changes for you.
5. **SSE granularity:** ✅ **resolved for v1 — keep the single `ai_generation` step**, emitted twice (once per turn) rather than adding new `storyGenerationSteps` values, since that type lives in `types/book.ts` which wasn't supplied for this pass and touching it without seeing it would be a guess. Revisit once that file is available if per-turn UI granularity turns out to matter.
6. **Context specialization depth:** ✅ **resolved for v1 — conservative.** Turn B drops only the narrative-style prose block (`includeProseStyle=false`); story context (`formatNextPageStoryContextPrompt`) is reused unchanged for both turns rather than forked into a "reduced" variant, since most of what it carries (facts, threads, dates) plausibly informs at least one delta field and a fork adds real drift risk for modest savings. Narrower trimming is a documented, deliberately-deferred follow-up, not implemented here.
7. **Cron placement:** ✅ **resolved differently at checkpoint 2 — no new cron needed at all.** Now that `retry-pending-generations.ts` is supplied, review showed the "dedicated retry cron" premise was solving a problem that doesn't exist — see Part 5.5 Q4 for the full discovery. `retry-pending-generations.ts` needs zero changes; the checkpoint-cache design (Part 2.6) plugs into the existing retry layers instead.

---

## Part 5.5 — Open Questions (Checkpoint 1 → resolved at Checkpoint 2)

All five questions from checkpoint 1 are now resolved — either by your answer or by what the newly-supplied files showed. Kept here as a record rather than deleted, since the reasoning matters for anyone reading this later.

**Q1. Ship Phases 3–5 before Phase 6, or pull the persistence/cache work forward?**
✅ **Resolved — Phases 3–5 first**, per your "use your best recommendation." Even more clearly correct now that Q4's discovery landed: Phase 6 (redesigned as a checkpoint cache, no longer a resilience prerequisite) is purely a cost optimization on top of retry infrastructure that already exists and already guarantees eventual success.

**Q2. Evaluator: independently per turn, or something cleaner?**
✅ **Resolved — your proposal, implemented.** One evaluation pass on the merged object, not one per turn. Full design in Part 2.2's "Evaluator — revised design"; implemented this checkpoint (`evaluateMergedStoryGeneration` in `prompt.ts`, `runEvaluationPass` newly exported from `ai-chat.ts`). This is better than my original per-turn default would have been — fewer calls, less new rubric content, reuses fully-tested existing logic. **Correction from you, verified against `schema/story.ts`:** my original write-up over-hedged the schema-size trade-off — `buildEvaluationSchemaDefinition` defaults to string-mode output, so the merged object's size never reaches the constrained decoder as a structural schema regardless of provider; see Part 2.2 for the corrected reasoning.

**Q3. Partial-persistence shape: dedicated table vs. columns on `pages`?**
✅ **Resolved — dedicated table, but redesigned.** Still a separate table (not columns on `pages`), but reframed by Q4's discovery from a task/status ledger into a much smaller **checkpoint cache** (Part 2.6) — no `status`/`attemptCount`/`lastError`/`isGeneratingStartedAt` columns needed, since there's no independent retry loop to drive; just the cached Turn A output keyed by `(actionedPageId, actionText, fateIndex)`.

**Q4. How are your crons actually invoked?**
✅ **Resolved — and the answer changed the design, not just filled a gap.** With `retry-pending-generations.ts` in hand: it drives retries via `pages.pendingGenerationCount`, invoked through `ensureCandidatesForPageWithStrategy` → `generateCandidatePages` → `generateNextPages`, with its *own* 3×-backoff retry layer already sitting in front of the cron (`candidate-generation.ts`'s `retryWithBackoffOrNull`). Neither layer needed to be studied to guess an invocation contract for a new file — **the finding is that no new cron is needed at all.** A Turn-B failure was never an unhandled case; it just wasted a Turn-A's worth of cost on every retry. Phase 6 (Part 2.6) now exists to eliminate that waste, not to add resilience that was missing. This is the single biggest design change from checkpoint 1 — see Part 2.6 and the revised Phase 6 in Part 3.

**Q5. Pre-launch or live traffic?**
✅ **Resolved — pre-launch, no traffic, "that's why major breaking changes is now."** Recommendation adopted as stated: default `USE_MULTI_TURN_GENERATION=true` in dev as soon as Phase 5 lands, so the path gets real exercise well before any production concern applies. No staged-rollout caution needed — noted in Phase 8.

### Files — resolved

All six newly-supplied files were put to use (`retry-pending-generations.ts`, `canon-validation.ts`, `book_types.ts`, `package.json`, `page-validation.ts`, `env_config.ts`, `prompt_types.ts` — seven, plus the ones already in hand):
- `retry-pending-generations.ts` → drove the Q4 discovery above; confirmed **zero changes needed** to this file.
- `package.json` → confirmed `bun`, confirmed `bunx tsc --noEmit` / `bunx eslint .` as the real gates, confirmed no test runner script exists (nothing lost by not having one to run).
- `prompt_types.ts` (= `types/prompt.ts`) → **Phase 3 Step 3.1's gap is now closed.** `BuildNextPageParams`/`BuildNextPagePromptParams`/`GenerateBookCreationPromptParams` are fully visible; `StageContext`/`GenerationStageDefinition<T>` can now be added here properly instead of defined locally in `prompt.ts` — will land with Phase 3 this checkpoint or next.
- `env_config.ts` (= `config/env.ts`) → confirmed there's no shared env-helper pattern to route through (every constant there is its own flat `process.env`-backed export) — `USE_MULTI_TURN_GENERATION`'s current implementation in `ai-chat.config.ts` already matches this convention; no change needed.
- `book_types.ts` (= `types/book.ts`) → confirmed `ai_generation`/`ai_evaluation` as separate existing SSE steps, fully resolving Part 5 decision 5 (no longer just "deferred," genuinely settled).
- `page-validation.ts`, `canon-validation.ts` → confirm the exact signatures Phase 4/5 will call (`validateGeneratedPage`/`checkGeneratedPage` take a merged-shape `{text, actions}`; `runCanonValidationPass` takes the full `StoryGeneration`) — both operate on the **merged** object only, consistent with the roadmap's existing design; no fail-fast-on-Turn-A-alone optimization implemented (still a valid future enhancement, still not needed now).

Nothing outstanding — Phase 3 can proceed with full file coverage.

---

## Part 6 — Implementation Checkpoint Log

This section is the running record of what's actually landed, kept current at each checkpoint (see the Implementation Status table at the top for the phase-level summary).

**Checkpoint 1 (August 16, 2026) — Phases 0–2 complete, Phase 3 next.**

*Files touched so far:* `story_types.ts`, `story_schema.ts`, `ai-chat_config.ts` (`ai-chat.config.ts`), `ai-chat_types.ts`, `prompt.ts`.
*Files reviewed but not modified (confirmed zero changes needed):* `ai-chat.ts` — schema/evaluator scoping in `executePromptForJSON`/`aiPrompt` is entirely caller-driven, so the split is fully contained to the files above. `candidate-generation.ts` — calls `generateNextPages` with an unchanged signature, so it's unaffected by the internal refactor.
*Files cited in the original draft but not supplied for this pass, so not touched:* `types/prompt.ts`, `types/book.ts`, `config/book-creation.ts`, `config/env.ts`, `cron/retry-pending-generations.ts`. Each has a specific workaround noted at its point of use above (Phase 3 Step 3.1, Part 5 decision 5, Phase 1 Step 1.5, Phase 8 Step 8.1, Phase 7 Step 7.1 respectively) rather than being silently assumed.

*Verification method:* every edited file was checked with `esbuild` (syntax-valid TypeScript) immediately after each change — not deferred to the end. Every text SPLIT (field instructions, review checklist, output-format JSON templates) was additionally verified losslessly: the original block was parsed into ordered chunks (blank-line boundaries for prose, bracket-depth tracking for the JSON-shaped templates), reassembled, and diffed byte-for-byte against the original before being partitioned — not hand-retyped and eyeballed. The legacy single-shot functions (`buildNextPageFieldInstructions`, `buildNextPageReviewChecklist`, `nextPageOutputFormat`, `buildNextPageEvaluatorPrompt`) are all still present, unchanged, and are what `USE_MULTI_TURN_GENERATION=false` continues to use.

*New this checkpoint (beyond the original draft — see Part 0.5 for full detail):* Gemini cache-key suffixing, the fate-divergence directive, and the character/place slug-ID handoff convention.

**Checkpoint 2 (August 17, 2026) — Q2 implemented, Phase 6/7 redesigned, all 5 checkpoint-1 open questions resolved. Phase 3 next.**

*New files supplied and reviewed:* `retry-pending-generations.ts`, `canon-validation.ts`, `book_types.ts`, `package.json`, `page-validation.ts`, `env_config.ts`, `prompt_types.ts` — the full file set the original draft cited is now in hand. See Part 5.5 for what each one resolved.

*Files touched this checkpoint:* `ai-chat.ts` (one change: extracted `runEvaluationPass`, exported it — pure extraction, verified byte-identical inline behavior via the same diff-before-replace method as every Phase-1 text split; also fixed a stale doc-comment on `isSchemaTooComplex` found in passing — said ">15KB" where the code has used `MAX_SCHEMA_LENGTH`/30KB since before this project started), `prompt.ts` (removed the checkpoint-1 per-turn evaluators, added `evaluateMergedStoryGeneration`).

*Design changes from checkpoint 1 (both driven by newly-supplied files, not preference):*
1. **Evaluator (Q2):** per-turn evaluation → one evaluation pass on the merged object. See Part 2.2.
2. **Phase 6/7 (Q4):** discovered `retry-pending-generations.ts` + `ensureCandidatesForPageWithStrategy` already guarantee eventual success on any generation failure (3× in-process backoff, then indefinite cron retry via `pendingGenerationCount`). The originally-planned dedicated task-ledger table + new retry cron was solving a problem that doesn't exist — replaced with a much smaller Turn-A checkpoint *cache* that both existing retry layers benefit from automatically, with no new cron. See Part 2.6.

*Decisions closed:* all 5 Part 5.5 questions — Phases 3–5 prioritized over Phase 6 (Q1), merged-object evaluator (Q2), dedicated checkpoint table confirmed (Q3), no new cron needed (Q4), dev flag defaults to `true` once Phase 5 lands given pre-launch status (Q5).

**Next checkpoint:** Phase 3 (`runGenerationStage`, `StageContext` — now placed in `types/prompt.ts` proper) → Phase 4 (`generateNextPage` 2-turn rewrite) → Phase 5 (`generateNextPages` parallel rewrite).

**Checkpoint 3 (August 18, 2026) — Phases 3, 4, and 5 complete. The split pipeline is fully wired end to end, flag-gated behind `USE_MULTI_TURN_GENERATION` (still `false` by default).**

*Files touched this checkpoint:* `types/prompt.ts` (`StageContext`/`GenerationStageDefinition<T>` added), `prompt.ts` (`runGenerationStage`, `generateStoryGenerationMultiTurn`, `generateNextPage` and `generateNextPages` both flag-gated).

*What's now real, not just designed:* both `generateNextPage` and `generateNextPages` will actually route through the 2-turn/parallel-multi-turn pipeline the moment the flag flips — this is no longer prompt-building machinery sitting unused. The legacy single-shot path is untouched and remains the default; every downstream step (validate, canon, `resolvePageDelta`, branchId, persist, embeds) is shared byte-for-byte between both paths, since both branches now produce the identical `AIResponse<StoryGeneration>` shape before that point.

*Two more real bugs caught during this checkpoint (on top of the 3 from checkpoint 1 and the reasoning correction from checkpoint 2 — six total across the project so far):*
1. `runGenerationStage` initially hardcoded a static config instead of threading through `determineAIConfig`'s dynamic per-page tuning — would have quietly degraded generation quality for every multi-turn call, no crash, so likely to have gone unnoticed without this file-level review. Fixed before it reached Phase 4.
2. `evaluateMergedStoryGeneration`, reused across all `candidateCount` alternatives in the parallel path, would have told the evaluator model to expect the array-wrapped batch shape (via `buildNextPageEvaluatorPrompt`'s existing `candidateCount > 1` branch) while actually enforcing a single-object schema — prose and schema disagreeing in a way that could plausibly have pushed corrections to wrap themselves incorrectly. Fixed with a scoped `candidateCount: 1` override that doesn't affect any other reader of the shared params object.

Both are documented in Part 4's risk table and at their exact code locations.

*Remaining work:* Phase 6 (checkpoint cache) is the only phase left, and it's genuinely optional — everything shipped this checkpoint is already strictly better than today's single-shot behavior with the flag on, Phase 6 or not. `TODO(Phase 6)` comments mark its two insertion points inside `generateStoryGenerationMultiTurn` precisely.

**Next checkpoint:** Phase 6 (`pageGenerationCheckpoints` table + service + the two wiring points) — the last item on the roadmap.

---

**Checkpoint 4 (August 19, 2026) — Real `bun check`/`tsc` output from the actual project surfaced 3 real compile errors + 8 lint warnings across Phases 0–5; a follow-up full re-audit of Phases 1–5 found one more functional gap. All fixed and verified. No new phase started — Phase 6 remains the only open item.**

**Why this checkpoint matters more than the bug count suggests:** every prior checkpoint's "syntax check" was `esbuild`, which strips TypeScript types without checking them — it cannot catch a wrong generic constraint, a type-narrowing spread, or a missing type import, because none of those affect whether the *stripped* JavaScript is syntactically valid. All 6 issues below are exactly that class of bug: every one of them passed `esbuild` cleanly at the checkpoint it was introduced. This is a real gap in the verification method used throughout this project, not a one-off — see the new risk-table row below.

**The 3 real `tsc` errors (all fixed, each verified against an isolated minimal reproduction compiled with actual `tsc --strict` before touching the real file):**

1. **`ai-chat.ts` — `runEvaluationPass<T>`'s generic constraint was narrower than its caller's.** Declared `<T extends Record<string, unknown>>`, but `aiPrompt`'s own `T extends Record<string, unknown> | string` can legitimately be `string`, and `aiPrompt` calls `runEvaluationPass<T>` internally with that same `T` unchanged. Widened to match `aiPrompt`'s constraint exactly; verified the internal `buildEvaluationSchemaDefinition<T>` call (which *does* need the narrower constraint) is unaffected, since it's called without an explicit type argument and its own parameter doesn't reference `T` — its inference is independent.
2. **`prompt.ts` — `evaluateMergedStoryGeneration`'s `baseResult` spread.** `carrierResult: AIResponse<unknown>` has `.result?: unknown`; spreading it directly into a variable typed `AIResponse<string>` fails even though `.output` is overridden right after — TypeScript checks the whole object literal against the annotation, not just the properties read later. Fixed by destructuring `.result` out before spreading (`const { result: _carrierResult, ...carrierMeta } = carrierResult`).
3. **`prompt.ts` — `generatedAlternatives`'s declared type didn't fit the legacy branch.** Declared `{ result: StoryGeneration; response: AIResponse<StoryGeneration> }[]`, but the legacy path's shared `response` is `AIResponse<CandidatePagesGeneration>` (one combined response for the whole batch, not per-alternative) — not structurally assignable to `AIResponse<StoryGeneration>`. Fixed by typing the `response` field as `AIResponseProvider` instead (`Pick<AIResponse<unknown>, 'model' | 'provider' | 'evalModel' | 'evalProvider' | 'scoreBefore' | 'scoreAfter'>`) — the exact type `persistPageWithState`'s `aiResponseProvider` parameter actually consumes, and the only type both branches can satisfy, since none of `AIResponseProvider`'s picked fields depend on the generic parameter.

**The 8 lint warnings (all genuinely dead code, all removed):** `StateDeltaGenerationWithBranch` (unused in `types/prompt.ts` even before `StageContext` was removed — it was only ever referenced in a JSDoc comment, never in real type position); `logEvaluationResult`/`evaluatorFallbackLimit` (destructured at the top of `aiPrompt` for the old inline evaluation block — orphaned once that block became a call to `runEvaluationPass`, which does its own independent destructuring from the same `options`); `STORY_PAGE_EVALUATION_OUTPUT_TOKEN`/`STATE_DELTA_EVALUATION_OUTPUT_TOKEN` (built at checkpoint 1 for per-turn evaluation, orphaned when checkpoint 2's Q2 redesign removed per-turn evaluation entirely — removed from `ai-chat.config.ts`, not just un-imported, since nothing anywhere uses them anymore); `StateDeltaGeneration`, `GenerationStage`, `StageContext` (imported in `prompt.ts` speculatively during earlier checkpoints, never actually referenced in code — only `StateDeltaGenerationWithBranch`/`GenerationStageDefinition` were ever used).

**One more functional gap found during the broader Phase 1–5 re-audit you asked for (not a compile error — this would have run without crashing, just worse than intended):** `evaluateMergedStoryGeneration` was passing only `{ modelSelection: AI_CHAT_MODELS_EVALUATION }` to `runEvaluationPass`, silently dropping the book-level context documents (characters/places) and the Gemini cache benefit that the legacy single-shot evaluator always had — a quiet quality/cost regression, not a crash, so the kind of thing that's easy to miss without deliberately re-checking "does this call carry everything the equivalent legacy call carried." Fixed by threading `documents`/`cachedContentId`/`config`/`bookId` through from the same `setup` Turn A/Turn B already use. While fixing this, also caught and fixed a cosmetic double-suffix bug: `runEvaluationPass` appends `-evaluation` to its `context` parameter internally, but the call site was *also* pre-appending `:evaluation` before passing it in, producing `...evaluation-evaluation` in logs.

**Also directly re-confirmed, per your original question this checkpoint:** yes, `evaluateMergedStoryGeneration`'s `candidateCount: 1` override (Part 2.5, fixed at checkpoint 3) does correctly handle the parallel multiverse case — verified still in place and working as designed before starting the broader audit.

**Files touched this checkpoint:** `ai-chat.ts` (constraint widening, dead-var cleanup), `prompt.ts` (all 3 type fixes, the documents/cache/context fixes, import cleanup), `types/prompt.ts` (`StageContext` fully removed, dead import cleanup), `ai-chat.config.ts` (dead per-turn evaluation budgets removed).

**Methodology change going forward:** the risk table below now carries this as a standing item — every future checkpoint's code changes get an explicit "does esbuild's blind spot apply here" pass (missing type imports, generic constraint mismatches between related generic functions, object-spread type narrowing, cross-branch type unification), not just an esbuild run, since esbuild alone has now been shown to miss real compile errors three separate times in one file.

**Next checkpoint:** Phase 6 (`pageGenerationCheckpoints` table + service + the two wiring points) — still the only open item; nothing in this checkpoint changed Phase 6's design (Part 2.6).

---

**Checkpoint 5 (August 20, 2026) — External review (Antigravity) of the Phase 5 checkpoint assessed item-by-item; 4 confirmed real bugs fixed, 1 likely-false-positive fixed defensively anyway, 1 schema-description typo fixed, 3 items formalized as deferred Phase 9–11 enhancements, 1 fix refined further after a follow-up question caught a gap in the first version. Phase 6 next.**

**Assessment discipline:** every claim was checked against the actual code before being accepted — not taken at face value, and not dismissed without evidence either. Two claims (BUG-01, BUG-02) were confirmed by direct source inspection before any fix was written. One claim (BUG-03) was checked against `BuildNextPageParams` and the legacy branch directly, found to not describe an actual regression, and fixed anyway since the cost of doing so was low. One recommendation (Question 1, evaluation strategy) was rejected — its stated justification claimed Zod validation exists downstream; `package.json` has no Zod dependency at all, so that reasoning doesn't hold, and reversing an explicit prior user decision (Q2, checkpoint 2) isn't something done on an unverified third-party claim regardless.

**Confirmed real, fixed:**

1. **BUG-01 (Gemini/Mistral cache-slot corruption)** — see Part 4's risk table. Refined twice in this checkpoint: first fix passed `cachedContentId: undefined`; a follow-up question ("how does explicit caching work without it?") prompted checking `resolveGeminiCachedContent`'s exact short-circuit behavior directly, which surfaced that `buildMistralPromptCacheKey` does NOT no-op the same way Gemini's path does — it falls back to a shared generic key used by unrelated callers. Final fix derives a dedicated content-based key via `createCacheKey([bookId, merged])`, avoiding both problems and preserving genuine within-call retry caching.
2. **BUG-02 (evaluator schema malformed in structured-object mode)** — confirmed by reading `buildEvaluationSchemaDefinition` directly; fixed by supplying `outputJsonStructure`/`outputJsonRequired`.
3. **BUG-04 (calendarDate merge timing)** — confirmed against the type split (`calendarDate` genuinely isn't in `StateDeltaGeneration`) and against the roadmap's own Part 2.4 diagram, which specified this and was never actually implemented; fixed at the merge site in `generateStoryGenerationMultiTurn`.
4. **ISSUE-06 (schema description typo)** — confirmed by direct inspection; one-line fix in `schema/story.ts`.

**Likely false positive, fixed anyway for parity:**

5. **BUG-03 (SSE callbacks)** — `BuildNextPageParams` never carried `onProgress`/`onGenerationProgress` for either path; nothing was "dropped." Added properly to `BuildNextPageParams` and threaded through both branches of both `generateNextPage` and `generateNextPages` regardless, since the fix is cheap and removes any doubt about it.

**Deferred, formalized as new roadmap phases (Part 3):** Phase 9 (deterministic server-side reconciliation for unresolved slug IDs — ISSUE-05), Phase 10 (Turn B context pruning — ISSUE-07, the same conclusion this project's own Part 5.5 decision 6 already reached independently), Phase 11 (evaluation-strategy alternative — Question 1, documented for the user's own call, not recommended given the Zod inaccuracy in its justification and the fact that it would reverse an explicit prior decision).

**Files touched this checkpoint:** `prompt.ts` (all 4 confirmed-bug fixes, the BUG-03 parity fix, the cache-key refinement), `types/prompt.ts` (`onProgress`/`onGenerationProgress` added to `BuildNextPageParams`), `schema/story.ts` (ISSUE-06 typo).

**Next checkpoint:** Phase 6 (`pageGenerationCheckpoints` table + service + the two wiring points) — still the only phase left; Phases 9–11 are documented future enhancements, not scheduled work.

---

**Checkpoint 6 (August 21, 2026) — `buildNextPageFieldInstructionSections` extracted to its own file and made generic, at the user's request. Phase 6 next.**

**What changed:** the ~300-line field-instructions block (type + 4 functions) moved out of `prompt.ts` into a new `utils/field-instructions.ts`. `FieldInstructionSection` is now `FieldInstructionSection<T>`, with `fields: (keyof T)[]` (renamed from the old singular `field: string`) instantiated as `FieldInstructionSection<StoryGeneration>` — every one of the 31 sections' field names is now checked against real `StoryGeneration` keys at compile time. The 4 sections that cover two schema keys under one prose block (`traumaTagAdd`/`traumaTagRemove`, `futureNoteAdd`/`futureNoteRemove`, `newCharacters`/`updatedCharacters`, `newPlaces`/`updatedPlaces`) now express that as `fields: ['traumaTagAdd', 'traumaTagRemove']` etc. instead of a compound string label — a real typo in any of these 35 field names (11 page + 24 delta, across the 31 sections) is now a build error instead of a silent documentation drift.

**Verification:** the array-literal content itself (all 31 entries' prose) was checked byte-for-byte identical to the pre-refactor version via an automated round-trip diff (`fields: [...]` converted back to the old `field: '...'` form and compared against the original — exact match, 23,090 bytes). `prompt.ts`'s own imports were swept for now-orphaned entries the extraction left behind — 8 identifiers (`characterImportances`, `characterStatuses`, `canonicalPlaceTypes`, `MAX_CHARACTERS`, `MAX_PLACES`, `MAX_TRAUMA_TAGS`, `MAX_ACTION_CHOICES_FINALE`, `MAX_WORDS_SUMMARIZED_CONTEXT`) were only ever used by the extracted code and are removed from `prompt.ts`'s imports entirely (not just left unused); everything else the new file also needs (`factTypes`, `sceneRoleValues`, `accessibilityValues`, `MAX_ACTION_CHOICES`, `MAX_FUTURE_NOTES`, `MAX_INVENTORY_ITEM`, `ACTION_TEXT_LENGTH`, `FACT_KEY_FORMAT`, `KEY_EVENT_LENGTH`, `MIN_ACTION_CHOICES`, `PLACE_CONTEXT_LENGTH`, `VIABLE_ENDING_LENGTH`, `formatOneOf`, `getStoryStateInfo`) is still genuinely used elsewhere in `prompt.ts` too, so those imports stay in both files independently.

**Files touched this checkpoint:** new `utils/field-instructions.ts`; `prompt.ts` (block removed, import added, 8 orphaned imports cleaned up).

**Next checkpoint:** Phase 6 (`pageGenerationCheckpoints` table + service + the two wiring points) — still the only scheduled phase left.

---

**Checkpoint 7 (August 22, 2026) — Second external review (newline-stripping in evaluator corrections + duplicate output-format block). Both findings verified against actual code before any fix; both real, both fixed. Phase 6 next.**

**Finding 1 — newline stripping in evaluator corrections.** Root cause (per the review, plausible and not independently falsifiable from source alone): the model itself sometimes "cleans up" formatting while re-encoding a corrected object as an escaped JSON string in string-mode. Confirmed real, fixable contributing factors, verified by direct inspection:

- `ai-parser.ts`'s `sanitise()` — confirmed by reading the function directly: its control-character strip (`\u0000-\u001F`) included `\t`/`\n`/`\r` (all fall in that range), and its whitespace-collapse (`\s+` → `' '`) would fold any run containing a newline into a single space. If a provider ever emitted a raw newline byte instead of a `\n` escape, every paragraph break was silently deleted before the JSON parser saw it. **Fixed**: control-char strip now excludes `\t`/`\n`/`\r`; whitespace-collapse now targets horizontal whitespace only (`[^\S\r\n]+`). Verified safe for `extractJsonCandidate` (the sole downstream consumer) by direct inspection — it already uses `[\s\S]*?`/`indexOf`/`lastIndexOf`, none of which assume collapsed or single-line input. Verified correct behavior with a runtime test (paragraph breaks and `\t`/`\r\n` preserved; control bytes and horizontal whitespace runs still cleaned).
- `runEvaluationPass`'s string-mode branch — confirmed by reading the function directly: `correctedOutput = raw ? JSON.parse(raw) as T : undefined` inside a bare `try/catch` meant ANY minor escaping slip in the model's re-encoded JSON threw, silently discarding the entire correction (falling back to the pre-correction — i.e., un-corrected — text) with no repair attempt. **Fixed, and better than what was proposed**: rather than adding a new bespoke tolerant-parse helper, this now routes through `parseAISafely` — the same multi-stage repair pipeline (sanitise → extract → jsonrepair → isdk-repair → heuristic fixes) every other structured-output call in this codebase already uses, and the identical fix already applied once before to `aiPrompt`'s own Gemini string-mode fallback for the same class of problem (a prior session's memory record surfaced this precedent directly, which is what prompted using the existing pipeline instead of building a parallel one). Instantiated as `parseAISafely<Record<string, unknown>>` rather than `parseAISafely<T>`, since `T` here can be `string` (inherited from `aiPrompt`'s own wider constraint) which `parseAISafely`'s stricter constraint would reject — verified this specific pattern compiles clean with an isolated `tsc --strict` reproduction before touching the real file. A local `try/catch` was kept around the call (matching the original code's defensive style) even though `parseAISafely` is designed not to throw, so an unexpected failure still gets this branch's specific warning instead of falling through to the outer catch's more generic one.
- Prompt hardening — added an explicit "preserve verbatim, `\n` means a real line break, never reflow" instruction to `buildEvaluatorOuputFormatBlurb`'s string-mode text and to both `buildNextPageEvaluatorPrompt`'s and `buildFirstBookEvaluatorPrompt`'s STEP 3 CORRECT blocks (book creation's evaluator has the identical bare-JSON.parse pattern and the identical missing instruction — fixed for consistency even though it's outside the multi-turn refactor's direct scope, since it's the same shared root cause).
- One additional gap found while implementing this: `evaluateMergedStoryGeneration` (checkpoint 5's BUG-02 fix) supplied `outputJsonStructure`/`outputJsonRequired` but never `outputJsonFallbackField`, which the new `parseAISafely`-based repair path reads. Added (`'text'`, matching the legacy flow's equivalent call).

**Finding 2 — duplicate/unlabeled output-format block in the evaluator's system prompt.** Confirmed by reading `runEvaluationPass`'s `evaluationOptions` construction and `aiPrompt`'s `shouldAppendOutputFormat` logic directly: the `systemPrompt` argument passed into `runEvaluationPass` already has the output-format text appended exactly once (from the generation call that produced the content being evaluated); `options.outputFormat` surviving the `...options` spread into `evaluationOptions` meant the inner `aiPrompt` call would append a second, unlabeled copy on top, since `aiPrompt` has no way to know the system prompt it received already carries one. **Fixed**: `outputFormat` is now stripped from `options` before `evaluationOptions` is built, so it can't propagate to the inner call. Also added a heading (`"EXPECTED OUTPUT JSON FORMAT (the exact shape the response must match):"`) to the block `aiPrompt` appends, so on the (now singular) occasion it does appear, it reads as a labeled JSON-shape reference rather than another unlabeled `---`-separated block of instructions. **Confirmed not applicable to `evaluateMergedStoryGeneration`**: it calls `runEvaluationPass` directly, never through `executePromptForJSON` (the only place `outputFormat` is ever set), so this call's `outputFormat` was already always `undefined` — verified directly rather than taken on the review's word, since a wrong assumption here would have meant "fixing" something that wasn't actually broken for this path.

**Files touched this checkpoint:** `ai-parser.ts` (`sanitise()`), `ai-chat.ts` (`runEvaluationPass`'s string-mode parse + `outputFormat` stripping, `aiPrompt`'s output-format labeling), `prompt.ts` (`buildEvaluatorOuputFormatBlurb`, both STEP 3 CORRECT blocks, `evaluateMergedStoryGeneration`'s `outputJsonFallbackField`).

**Next checkpoint:** Phase 6 (`pageGenerationCheckpoints` table + service + the two wiring points) — still the only scheduled phase left; two independent external reviews across checkpoints 5 and 7 have now each turned up real, fixed issues, none of which changed Phase 6's design.

---

*This document is updated at each implementation checkpoint. Quality gates and decision list are the contract for starting Phase 0 — Phases 0–5 are now closed against that contract, verified against real `bun check`/`tsc` output (checkpoint 4) and two independent external reviews (checkpoints 5 and 7); Phase 6 is the only scheduled phase left open. Phases 9–11 are documented future enhancements, not scheduled work.*