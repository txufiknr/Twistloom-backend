# Twistloom — Multi-Turn (Stage-Split) Page Generation Roadmap

**Date:** August 15, 2026 · **Last updated:** August 16, 2026 (implementation checkpoint 1 — Phases 0–1 complete)
**Scope:** Split the single monolithic "page + state delta" AI request into **2 sequential structured generation turns** — `StoryPage` then `StateDelta` — with parallel per-alternative turns for the multiverse `generatedPages` flow, plus idempotent partial-persistence + cron retry so a succeeded `StoryPage` never needs to be regenerated when only its `StateDelta` failed.

Every feasibility verdict below was verified against the actual source in `src/schema/story.ts`, `src/utils/prompt.ts`, `src/utils/ai-chat.ts`, `src/types/ai-chat.ts`, `src/config/ai-chat.ts`, `src/services/book.ts`, `src/utils/candidate-generation.ts`, `src/db/schema.ts`, and `src/cron/retry-pending-generations.ts` (the last one was cited by file:line in the original draft but was **not actually supplied** for this pass — see Part 6).

> **How to read this doc.** Part 0 = the design decision taken from `TODO-multi-turn-request.md` (and what we are deliberately *not* doing). **Part 0.5 = review verdict + corrections found while implementing (new).** Part 1 = what already exists in the code so proposals don't re-build machinery. Part 2 = the target architecture (schemas, prompts, orchestration, token budgets, retry) — updated in place where implementation diverged from the original draft. Part 3 = the phased, step-by-step execution plan, now annotated with per-step status. Part 4 = risks & mitigations, extended with 3 risks found during implementation. Part 5 = decisions needed — resolved where implementation required an answer, left open where not yet reached. **Part 6 = implementation checkpoint log (new).**

---

## ✅ Implementation Status (at a glance)

| Status | Phase / Item | Effort | Impact (before → after) | Files changed |
|---|---|---|---|---|
| ✅ **DONE** | **Phase 0 — schema split** (page vs delta schema definitions + required fields) | small | One 30-key combined schema → an 11-key page schema + a 23/24-key delta schema, composed (not copied) from the same two `Record`s the combined schema already used | `story_schema.ts`, `story_types.ts` |
| ✅ **DONE** | **Phase 1 — per-turn prompt builders** (page vs delta task/field-instructions/review-checklist/output-format/evaluator) | medium | Same giant user prompt → two specialized prompts, each verified byte-lossless against the original via automated diff during authoring; 2 previously-undocumented cross-turn contract gaps found and fixed (Part 0.5) | `prompt.ts` |
| ✅ **DONE** | **Phase 2 — per-turn output-token budgets** (asymmetric split, not a straight halving — see rationale in file) | tiny | `generateNextPages` `*candidateCount` multiplication removed in the new path (old path unchanged); per-turn budgets added | `ai-chat.config.ts` |
| 🔧 **NEXT** | **Phase 3 — stage orchestration types** in the AI-chat layer | small | `executePromptForJSON` stays single-shot; new `runGenerationStage` orchestrates turn A → turn B, threads turn-A output into turn-B `documents` | `prompt.ts` (types/prompt.ts wasn't supplied — see Part 6) |
| ⏳ **TODO** | **Phase 4 — `generateNextPage` 2-turn refactor** | medium | `generateNextPage` becomes: StoryPage → StateDelta → merge → master validate → persist (persist unchanged) | `prompt.ts` |
| ⏳ **TODO** | **Phase 5 — `generateNextPages` parallel multi-turn refactor** | medium | `generatedPages` batch request → N parallel StoryPage turns → N parallel StateDelta turns → merge each → existing per-alt persist loop; includes the new fate-divergence fix (Part 0.5) | `prompt.ts` |
| ⏳ **TODO** | **Phase 6 — partial-persistence tracking (DB)** | medium | New `page_generation_tasks` table so a succeeded StoryPage survives a failed StateDelta; rows are idempotency keys | `schema.ts`, new `page-generation-tasks.ts`, migration |
| ⏳ **TODO** | **Phase 7 — idempotent state-delta retry cron** | medium | New standalone cron (the sibling file wasn't supplied, so this can't be a drop-in extension of it — see Part 6) | new `retry-pending-state-deltas.ts` |
| 🔧 **PARTIAL** | **Phase 8 — verification & flag** | small | `USE_MULTI_TURN_GENERATION` flag added (`ai-chat.config.ts`, default `false`); typecheck/lint/manual-test steps still apply once Phases 3–5 land | `ai-chat.config.ts` |

**Quality gates (post-change):** `bun run typecheck` · `bun run lint:fast` · `bun run lint:imports` — not runnable in this environment (no project/`node_modules`); every edited file was instead verified with `esbuild` (syntax-valid TS) after each change, plus automated string-diff verification for every text-split (see Part 6).

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
- `retry-pending-generations.ts` cron: `retryPendingGenerations()` (line 41) scans `pages.pendingGenerationCount > 0` (DB-generated column, `src/db/schema.ts:97`), `processPageGeneration` (line 220) → `ensureCandidatesForPageWithStrategy({ strategy: 'cron' })`. Locking via `pages.isGeneratingStartedAt` (`src/db/schema.ts:109`) + `cleanupStuckGenerations` (cron line 349). Idempotency: `determineBranchIdForPage` throws `ACTION_ALREADY_HAS_DESTINATION` when a fresh parent read shows an action already at `MAX_CANDIDATE_PAGE_PER_ACTION` (`src/utils/prompt.ts:4378–4383`).
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
| Evaluator | `buildNextPageEvaluatorPrompt` | split → `buildStoryPageEvaluatorPrompt` (same 6-dimension prose rubric, verbatim — it already scored only page-authored fields) | split → `buildStateDeltaEvaluatorPrompt` — **entirely new 5-dimension rubric** (grounding, continuity/ID integrity, thread/ending management, completeness, format discipline); the original rubric had no dimension that scored structural delta correctness, so this isn't an extraction, it's new content |
| System prompt | `buildPresetSystemPrompt` | keep `'next'` unchanged | new `buildPresetSystemPrompt('state-delta', preset)` — writing style + `RULES_LANGUAGE_LOCALIZATION` + `RULES_ROUTE_MEMORY` + `RULES_STORY_CONSISTENCY` + `RULES_FUTURE_NOTES` + `RULES_CHARACTER` + `RULES_CHARACTER_RECOGNITION` + `RULES_PLACE`. **Drop** `RULES_EMBODIED_SCENE_CONTINUITY`, page-text rules, `RULES_ACTIONS`, `RULES_SCENE_TYPES`, `RULES_ENDING_ARCHETYPES`, `RULES_STORY_MOMENTUMS`, `RULES_DIFFICULTY_SCALING`. `RULES_PLANNED_CHARACTERS` **removed from this list** — it's a user-prompt splice today, not a system-prompt rule, and applies to both turns' user prompts (Part 0.5 item 4). `RULES_CHARACTER_RECOGNITION` **added** — `recognitionLevel` is itself a delta field (Part 0.5 item 4). |

**Turn B input contract — implemented via `buildStateDeltaPrompt`'s "GENERATED PAGE" section**, formatted by a new `formatGeneratedPageForDeltaPrompt(storyPage)` (page text + a compact scene-facts summary — presented the way a human editor would read it, not raw JSON) rather than a raw `JSON.stringify` document snippet as the original draft sketched. Functionally the same idea (mirrors the evaluator's existing "feed previous AI output as context" pattern) — no new plumbing in `aiPrompt` either way.

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

### Phase 0 — Schema split (no behavior change) — ✅ DONE

- ✅ **Step 0.1** — `story_schema.ts`: exported `STORY_PAGE_SCHEMA_DEFINITION`, `STORY_PAGE_REQUIRED_FIELDS`, `STATE_DELTA_SCHEMA_DEFINITION`, `STATE_DELTA_REQUIRED_FIELDS`; refactored `STORY_GENERATION_SCHEMA_DEFINITION` to compose from them so the two definitions can't drift (the exact class of bug `TODO-multi-turn-request.md` warns about).
- ✅ **Step 0.2 (revised)** — added `STATE_DELTA_WITH_BRANCH_SCHEMA_DEFINITION` / `STATE_DELTA_WITH_BRANCH_REQUIRED_FIELDS` instead of the originally-proposed `CANDIDATE_PAGE_SCHEMA_DEFINITION`/`CANDIDATE_DELTA_SCHEMA_DEFINITION` pair (Part 0.5 item 6 — no separate array-wrapped shape needed in the parallel-per-alternative design). `CANDIDATE_GENERATION_SCHEMA_DEFINITION` kept unchanged for the pre-flip path.
- ✅ **Step 0.3** — `story_types.ts`: confirmed `StoryPageGeneration` / `StateDeltaGeneration` / `StoryGeneration` need no change. Added `StateDeltaGenerationWithBranch = StateDeltaGeneration & { branchNames?: string[] }` (the original draft's note here said "add to `StoryPageGeneration`", which was backwards — `branchNames` moves to Turn B/delta, not Turn A/page).

### Phase 1 — Per-turn prompt builders — ✅ DONE

- ✅ **Step 1.1** — split `nextPageOutputFormat` → `storyPageOutputFormat` + `stateDeltaOutputFormat`. Implemented via a bracket-depth-aware parse of the original template into 35 per-key chunks, partitioned 11/24 and diff-verified lossless before reassembly — not hand-retyped. `multiNextPageOutputFormat` kept for the legacy path.
- ✅ **Step 1.2** — split `buildNextPageFieldInstructions` → `buildStoryPageFieldInstructions` / `buildStateDeltaFieldInstructions`, both reading from one shared, computed-once `buildNextPageFieldInstructionSections` array (31 sections, split-verified byte-lossless against the original via automated diff) rather than literal copies — the legacy function still joins *all* sections, so it's provably byte-identical to pre-split output. Added the slug-ID handoff instructions (Part 0.5 item 3) to the `charactersPresent`/`placeId`/`newCharacters`/`newPlaces` sections, gated behind an `isMultiTurn` flag so the legacy prompt is untouched.
- ✅ **Step 1.3 (revised split)** — page checklist = original sections 1–5, 7–9 (renumbered 1–9) + JSON. Delta checklist = new "State Trajectory & Ending Progression" (distilled from section 1's ending-progression bullets) + section 6 Thread Management (renumbered) + new "Continuity & State Integrity (Delta)" (ID-validity/new-vs-updated/justified-by-the-page checks) + JSON. This is NOT the draft's literal "1–5,8,9,10 vs 6,7" split — see Part 0.5 item 5 for why. `buildNextPageEvaluatorPrompt` → `buildStoryPageEvaluatorPrompt` (rubric kept verbatim, re-pointed at split schema/prompt pieces) + `buildStateDeltaEvaluatorPrompt` (new 5-dimension rubric — grounding/continuity/threads/completeness/format).
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

### Phase 3 — Stage orchestration types — 🔧 NEXT

- 🔧 **Step 3.1 (revised location)** — `types/prompt.ts` was **not supplied** for this pass (`BuildNextPageParams`/`BuildNextPagePromptParams` are imported from it but its content is unseen), so `GenerationStageDefinition<T>` and the concrete `StageContext` type will be defined **locally in `prompt.ts`** instead (e.g. `type StageContext = BuildNextPagePromptParams & { generatedPage?: StoryPageGeneration }`) rather than editing a file that hasn't been reviewed. `GenerationStage` itself (the two-value union) — the one piece generic enough to belong in the AI-chat layer proper — is already added to `ai-chat_types.ts` (Phase 0.5 side effect, done early since it's a 3-line addition with no dependencies). Recommend relocating `StageContext`/`GenerationStageDefinition` into `types/prompt.ts` once that file is available, for consistency with the codebase's existing type-organization convention.
- ⏳ **Step 3.2** — not yet implemented. `runGenerationStage` is the next unit of work.

### Phase 4 — `generateNextPage` 2-turn refactor — ⏳ TODO (next after Phase 3)

- **Step 4.1** — extract `generateStoryPage(context)` / `generateStateDelta(context, storyPage)` helpers from the current single-call body.
- **Step 4.2** — wire the 2-turn flow + merge + master `validateGeneratedPage` (Part 2.4). Add the `page_generation_tasks` write points (Phase 6) if Phase 6 has landed by then; otherwise a `console.warn` placeholder.

### Phase 5 — `generateNextPages` parallel multi-turn refactor — ⏳ TODO

Building blocks are ready (`buildStoryPagePrompt`/`buildStateDeltaPrompt`/`buildStoryPageEvaluatorPrompt` already accept a `fateContext` for the divergence fix — Part 0.5 item 2), but the orchestration loop itself hasn't been written yet.

- **Step 5.1** — replace the `executePromptForJSON<CandidatePagesGeneration>` batch call with Phase-1 parallel StoryPage turns (each with its own `fateContext`).
- **Step 5.2** — add Phase-2 parallel StateDelta turns.
- **Step 5.3** — merge each alt into `StoryGeneration`, keep the existing per-alt loop (canon → `resolvePageDelta` → branchId → persist → embeds) and partial-success semantics.

### Phase 6 — Partial-persistence tracking (DB) — ⏳ TODO

- **Step 6.1** — add `pageGenerationTasks` table (Part 2.6) + migration (`bun db:generate` / `bun db:migrate`).
- **Step 6.2** — write/update task rows in the refactored generators (Turn-A success → `story_page completed`; Turn-B failure → `state_delta failed`; Turn-B success → `state_delta completed`).
- **Step 6.3** — expose `getPendingStateDeltaTasks()` + `claimStateDeltaTask(id)` (sets `isGeneratingStartedAt`, bumps `attemptCount`) in a new `src/services/page-generation-tasks.ts`.

### Phase 7 — Idempotent state-delta retry cron — ⏳ TODO

- **Step 7.1 (revised)** — `src/cron/retry-pending-generations.ts` was **not supplied** for this pass, so extending it isn't possible as a verified drop-in edit. Will instead deliver a **new, standalone** `retry-pending-state-deltas.ts`, keeping the locking pattern (claim via `isGeneratingStartedAt`, stale-reset) inferred from `schema.ts`'s `pages` table columns and `book_services.ts`'s patterns — both of which *were* supplied — rather than assuming the sibling cron's internal structure. Flagged clearly as newly authored, not a verified extension, when delivered.
- **Step 7.2** — per-task: reconstruct `advancedState` → re-run Turn B with stored `storyPageJson` → merge → master validate → canon → branchId → persist → mark completed (Part 2.6).
- **Step 7.3** — package.json scripts: `dev:cron:retry-deltas` / `start:cron:retry-deltas` mirroring existing cron scripts (naming inferred, not verified against an actual `package.json`).

### Phase 8 — Verification & feature flag — 🔧 PARTIAL

- ✅ **Step 8.1** — `USE_MULTI_TURN_GENERATION` flag added to `ai-chat.config.ts` (reads `process.env.USE_MULTI_TURN_GENERATION === 'true'`, default `false`). Note: reads `process.env` directly rather than through a shared env-config helper, since `config/env.ts` (which houses `IS_PRODUCTION`) wasn't supplied — worth moving there for consistency once that file is in hand. `generateNextPage(s)` branching on this flag happens in Phase 4/5 (not yet reached).
- ⏳ **Step 8.2** — quality gates unavailable in this environment (no project checkout / `node_modules`); substituted with `esbuild` syntax verification after every edit + automated string-diff verification for every text split, both described per-file in Part 6.
- ⏳ **Step 8.3 / 8.4** — apply once Phases 3–7 land.

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
| **Multiverse alternatives converge instead of diverging under parallelization** *(found during implementation — Part 0.5 item 2, not in original draft)* | Independent parallel StoryPage calls can't see each other, unlike the current single combined completion — alternatives could read as near-duplicates | ✅ `formatFateDivergenceDirective` — deterministic, zero-cost per-alternative narrative-angle rotation. **Done** (wired into `formatNextPageTaskPrompt`/`buildStoryPagePrompt`/`buildStoryPageEvaluatorPrompt`; actual parallel loop lands with Phase 5). |
| **Cross-turn ID handoff for brand-new characters/places** *(found during implementation — Part 0.5 item 3, not in original draft)* | Turn A may need to reference a character/place ID that doesn't exist yet (first appearance); Turn B — not Turn A — is the one that formally introduces it via `newCharacters`/`newPlaces`, so without a shared convention the IDs could mismatch | ✅ Slug-ID handoff convention: Turn A invents a stable slug ID, Turn B is instructed to reuse it exactly. **Done**, scored directly by the new delta evaluator's Continuity & ID Integrity dimension. |
| **Cron retry races a live generation** | Duplicate page for same action | Unique `(actionedPageId, fateIndex)` key + `determineBranchIdForPage`'s `ACTION_ALREADY_HAS_DESTINATION` guard + `persistPageWithState` branch-conflict retry — applies once Phase 6/7 land |
| **Delta retry produces a different delta than the original attempt** | Non-determinism across model sampling | Acceptable — the delta is a *consequence of the persisted page text* (Turn A output is stored and reused); the retry's input is identical to the failed attempt's |
| **Stuck task rows** | Rows never complete | `isGeneratingStartedAt` + stale-reset idiom, inferred from `schema.ts`'s existing `pages.isGeneratingStartedAt` pattern (the actual cron's `cleanupStuckGenerations` wasn't available to copy verbatim — see Phase 7 Step 7.1) |
| **SSE progress semantics** | Frontend expects one `ai_generation` step | Emit per-turn `ai_generation_start/complete`; no new `storyGenerationSteps` value added — see Part 5 decision 5 (resolved: keep single step for v1) |

---

## Part 5 — Decisions Needed Before Implementation

Resolved where implementation already required an answer (Phases 0–2); left open where the relevant phase hasn't been reached yet. Overridable — flag anything you'd rather have gone the other way and it gets revised before Phase 6/7 land.

1. **Partial-persistence shape:** ⏳ **still open** — dedicated `page_generation_tasks` table (recommended — clean idempotency key, no page without a delta) **vs.** columns on `pages` (`stateDeltaPending`, `pendingStoryPageJson`) that require persisting a page *before* its delta (breaks the delta-chain reconstruction contract unless flagged). Default going in: the dedicated table, unless you say otherwise before Phase 6.
2. **`branchNames` turn:** ✅ **resolved — Turn B.** Implemented (`STATE_DELTA_WITH_BRANCH_SCHEMA_DEFINITION`).
3. **Token budgets:** ✅ **resolved for v1 — asymmetric `2200/1800` and `1100/900`**, with the rationale (why not a straight halving) documented inline in `ai-chat.config.ts`. Genuinely tentative pending real `finishReason === 'length'` telemetry — revisit once the multi-turn path has real traffic.
4. **Feature flag default:** ✅ **resolved — `false`.** `USE_MULTI_TURN_GENERATION` defaults off; flipping it on is a deliberate, separate decision after Phase 8's manual pass, not something this implementation changes for you.
5. **SSE granularity:** ✅ **resolved for v1 — keep the single `ai_generation` step**, emitted twice (once per turn) rather than adding new `storyGenerationSteps` values, since that type lives in `types/book.ts` which wasn't supplied for this pass and touching it without seeing it would be a guess. Revisit once that file is available if per-turn UI granularity turns out to matter.
6. **Context specialization depth:** ✅ **resolved for v1 — conservative.** Turn B drops only the narrative-style prose block (`includeProseStyle=false`); story context (`formatNextPageStoryContextPrompt`) is reused unchanged for both turns rather than forked into a "reduced" variant, since most of what it carries (facts, threads, dates) plausibly informs at least one delta field and a fork adds real drift risk for modest savings. Narrower trimming is a documented, deliberately-deferred follow-up, not implemented here.
7. **Cron placement:** ✅ **resolved by necessity, not preference — new standalone `retry-pending-state-deltas.ts`.** `retry-pending-generations.ts` wasn't supplied for this pass, so "extend it" isn't something that can be delivered as a verified drop-in; a new file is the only option that doesn't involve guessing at a file's contents. Worth reconsidering (merge into the existing cron) once that file is available for review.

---

## Part 6 — Implementation Checkpoint Log

This section is the running record of what's actually landed, kept current at each checkpoint (see the Implementation Status table at the top for the phase-level summary).

**Checkpoint 1 (August 16, 2026) — Phases 0–2 complete, Phase 3 next.**

*Files touched so far:* `story_types.ts`, `story_schema.ts`, `ai-chat_config.ts` (`ai-chat.config.ts`), `ai-chat_types.ts`, `prompt.ts`.
*Files reviewed but not modified (confirmed zero changes needed):* `ai-chat.ts` — schema/evaluator scoping in `executePromptForJSON`/`aiPrompt` is entirely caller-driven, so the split is fully contained to the files above. `candidate-generation.ts` — calls `generateNextPages` with an unchanged signature, so it's unaffected by the internal refactor.
*Files cited in the original draft but not supplied for this pass, so not touched:* `types/prompt.ts`, `types/book.ts`, `config/book-creation.ts`, `config/env.ts`, `cron/retry-pending-generations.ts`. Each has a specific workaround noted at its point of use above (Phase 3 Step 3.1, Part 5 decision 5, Phase 1 Step 1.5, Phase 8 Step 8.1, Phase 7 Step 7.1 respectively) rather than being silently assumed.

*Verification method:* every edited file was checked with `esbuild` (syntax-valid TypeScript) immediately after each change — not deferred to the end. Every text SPLIT (field instructions, review checklist, output-format JSON templates) was additionally verified losslessly: the original block was parsed into ordered chunks (blank-line boundaries for prose, bracket-depth tracking for the JSON-shaped templates), reassembled, and diffed byte-for-byte against the original before being partitioned — not hand-retyped and eyeballed. The legacy single-shot functions (`buildNextPageFieldInstructions`, `buildNextPageReviewChecklist`, `nextPageOutputFormat`, `buildNextPageEvaluatorPrompt`) are all still present, unchanged, and are what `USE_MULTI_TURN_GENERATION=false` continues to use.

*New this checkpoint (beyond the original draft — see Part 0.5 for full detail):* Gemini cache-key suffixing, the fate-divergence directive, and the character/place slug-ID handoff convention.

**Next checkpoint:** Phase 3 (`runGenerationStage`, `StageContext`) → Phase 4 (`generateNextPage` 2-turn rewrite) → Phase 5 (`generateNextPages` parallel rewrite), each delivered as complete drop-in files with this log updated per checkpoint.

---

*This document is updated at each implementation checkpoint. Quality gates and decision list are the contract for starting Phase 0 — Phases 0–2 are now closed against that contract; Phase 3 opens the next one.*