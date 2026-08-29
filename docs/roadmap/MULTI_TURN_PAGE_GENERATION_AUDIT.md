# Multi-Turn (Stage-Split) Page Generation — Implementation Audit

**Date:** 2026-08-29 · **Auditor:** codebase review & static analysis  
**Scope:** Verify the implementation described in `MULTI_TURN_PAGE_GENERATION_ROADMAP.md` (status: all phases 0–8 DONE) against the *actual* source code, and surface bugs, inefficiencies, regressions, and decisions needing human review.  
**Files reviewed in depth:** `src/utils/prompt.ts`, `src/utils/ai-chat.ts`, `src/config/ai-chat.ts`, `src/types/prompt.ts`, `src/utils/field-instructions.ts`, `src/utils/candidate-generation.ts`, `src/services/page-generation-checkpoints.ts`, `src/services/book.ts`, `src/db/schema.ts`, `src/schema/story.ts`.

---

## 1. Verdict: Is it complete and correct?

**Completeness — YES.** Every checkpoint deliverable from the roadmap (Phases 0 through 8) is present and fully wired:

- **Schema split** (`STORY_PAGE_SCHEMA_DEFINITION`, `STATE_DELTA_WITH_BRANCH_SCHEMA_DEFINITION`, `STORY_GENERATION_SCHEMA_DEFINITION`) — composed structurally without duplicated key definitions (`src/schema/story.ts`). ✅
- **Per-turn prompt builders** (`buildStoryPagePrompt`, `buildStateDeltaPrompt`, split field instructions in `src/utils/field-instructions.ts`, split review checklists, split output formats) — present and cleanly partitioned. ✅
- **Asymmetric per-turn token budgets** (`STORY_PAGE_MAX_OUTPUT_TOKEN = 2200`, `STATE_DELTA_MAX_OUTPUT_TOKEN = 1800`) — configured in `src/config/ai-chat.ts:33-35`, eliminating token multiplier explosion in parallel multi-turn calls. ✅
- **Single post-merge evaluation pass** reusing `buildNextPageEvaluatorPrompt` via extracted `runEvaluationPass` — present and correct in `src/utils/prompt.ts:1767` and `src/utils/ai-chat.ts:1680`. ✅
- **Stage Orchestration** (`runGenerationStage` + `GenerationStageDefinition<T>`) — present in `src/utils/prompt.ts:5103` and `src/types/prompt.ts:115`. ✅
- **2-Turn single-page & parallel multiverse orchestrators** (`generateStoryGenerationMultiTurn`, `generateNextPage`, `generateNextPages`) — present and flag-gated on `USE_MULTI_TURN_GENERATION`. ✅
- **Turn-A checkpoint cache** — all 3 touch-points wired: check-before (`prompt.ts:5171`), upsert-after (`prompt.ts:5206`), delete-after-persist (`prompt.ts:5456` and `:5710`). ✅
- **Gemini cache-collision isolation** (`:story_page` / `:state_delta`) — present (`prompt.ts:5123`). ✅
- **Fate-divergence directives** for parallel multiverse generation — present (`prompt.ts:3078`). ✅
- **Slug-ID cross-turn handoff** (`buildStoryPageFieldInstructions` $\to$ `buildStateDeltaFieldInstructions`) — present (`field-instructions.ts:70, 99, 198, 228`). ✅

**Correctness — HIGH, with one primary resilience gap (F1) and several edge-case optimization items (F2–F6).** The happy path is sound, types match 1:1, and the design's core thesis (independent structured stages + deterministic merge) is honored. The findings below address *resilience under retry*, *evaluator defensive merging*, *top-up slot alignment*, and *efficiency at scale*.

> **Note on Feature Flag:** `USE_MULTI_TURN_GENERATION` defaults to `false` (`src/config/ai-chat.ts:60`) as a safe rollback gate. All findings below apply once the flag is enabled (Phase 8). The legacy single-shot path remains untouched and operational.

---

## 2. Detailed Findings

### ◻️ F1 — HIGH: Checkpoint cache can freeze a weak/defective Turn A and cause infinite retry poisoning

**Location:** `generateStoryGenerationMultiTurn` upsert at `prompt.ts:5206` (no validation gate); lookup at `prompt.ts:5171`.

**Problem:** The checkpoint upserts `storyPageResponse.result` **unconditionally** after any Turn A that produced a parseable JSON result:
```ts
await upsertPageGenerationCheckpoint({ ... storyPageJson: storyPage, ... });
```
`storyPage` here is whatever `runGenerationStage<StoryPageGeneration>` returned. `executePromptForJSON` guarantees it is *schema-valid* (required keys present, parseable), but **not necessarily semantically healthy** — `text` could be empty/garbled, `actions` could be near-empty, or IDs could be malformed. The legacy path had no cache, so a fluky-but-schema-valid page was simply retried from scratch and usually self-healed.

With the cache, a weak Turn A is frozen: on the next retry (immediate 3× backoff *or* the `retry-pending-generations` cron), `getPageGenerationCheckpoint` returns a **hit**, so Turn A is skipped and the same weak `storyPage` is reused. The merged object then fails `validateGeneratedPage` (`prompt.ts:5387`) or `checkGeneratedPage` (`prompt.ts:5634`), the page is never persisted, the checkpoint is **never deleted** (deletion only happens on success), so the cycle repeats indefinitely for that `(actionedPageId, actionText, fateIndex)` until the action is replaced by a fallback action or the row is manually pruned.

**Recommendation:** Gate the upsert on a lightweight sanity check of the page turn (e.g. reuse `checkGeneratedPage(storyPage, ...)` or assert non-empty `text` and well-formed `actions`). If the page turn fails the check, skip the upsert and let the retry regenerate Turn A fresh. *(See Open Question Q1).*

---

### ✅ F2 — LOW: Checkpoint fate-slot misalignment during candidate top-up (narrow edge)

**Location:** `candidate-generation.ts:506-519` and `prompt.ts:5506`.

**Problem (corrected premise):** The checkpoint cache keys on `(actionedPageId, actionText, fateIndex)`, where `fateIndex` is a *per-call* generation-order index (`0..candidateCount-1` within a single `generateNextPages` invocation) — **not** a stable "slot identity" that persists across the original batch and a later top-up. The original draft claimed a top-up of one missing alternative (`existing.length === 1` → `needed = 1`) routes through `generateNextPage` (fateIndex 0) and misses a surviving checkpoint at `fateIndex: 1`. That mechanism is **inaccurate**:

- `candidate-generation.ts:509` computes `needed = Math.min(limit - existing.length, modeLimit)`. For `multiverse` (`limit = 3`), `existing.length === 1` → `needed = 2`, **not 1**. So the top-up calls `generateNextPages({ candidateCount: 2 })`, which does **not** hit the `prompt.ts:5506` fast-path to `generateNextPage`.
- With `candidateCount: 2`, the top-up generates fateIndex **0 and 1**. In the *common* partial-failure case (original fate 0 persisted → cp0 deleted; original fate 1 Turn-B-failed → cp1 survives), the top-up's **second** fate checks `getPageGenerationCheckpoint(..., 1)` and **does reuse** the surviving Turn A. So the cache benefit is preserved, not lost.

**What is genuinely real (narrow edge):** because `fateIndex` is only per-call order, the top-up's indices don't reliably map to the original batch's failed slots. The one scenario where a surviving checkpoint is genuinely orphaned:

- Original 3-fate batch: fates 0 and 1 persisted (cp0, cp1 deleted); fate 2's Turn B failed (cp2 survives, page not persisted).
- `existing.length === 2` → `needed = 1` → `generateNextPages({ candidateCount: 1 })` → `generateNextPage` → fateIndex 0 → `getPageGenerationCheckpoint(..., 0)` = `null` (deleted). The surviving `cp2` row is never consulted and remains orphaned until cleanup.

This is a cost/efficiency edge only — `determineBranchIdForPage` caps destinations at `MAX_CANDIDATE_PAGE_PER_ACTION`, so no duplicate/over-limit page is created; generation always succeeds.

**Recommendation:** Treat the checkpoint `fateIndex` as call-scoped, not slot-stable. Either (a) accept orphan rows as harmless and let the periodic sweep (Q6) reclaim them, or (b) investigate a stable fate-slot identity if top-up cache reuse matters at scale. *(See Open Question Q7).*

**Status: ✅ FIXED (2026-08-29).** The concrete wrong-slot deletion bug is resolved: `generateNextPages` now carries the true `fateIndex` through `generatedAlternatives` and deletes via `realFateIndex = fateIndex ?? index` (`prompt.ts:5635`, `:5719`), so when parallel alternatives are skipped after partial failure the correct checkpoint slot is deleted and no orphan/wrong-slot delete occurs. The narrow top-up edge (this finding's "what is genuinely real") remains accepted as-is per Q7 Option A.

---

### ◻️ F3 — MEDIUM: Evaluator partial JSON re-encoding risk on merged state

**Location:** `prompt.ts:1881` in `evaluateMergedStoryGeneration`.

**Problem:** In `evaluateMergedStoryGeneration`:
```ts
const evaluated = await runEvaluationPass<StoryGeneration>(baseResult, evaluatorPrompt, ...);
return evaluated ?? { ...baseResult, result: merged };
```
When `runEvaluationPass` succeeds in string-mode evaluation (`useStringEvaluatorOutput: true`), `parseAISafely` parses the evaluator's output string as `correctedOutput`.
If a smaller or fallback evaluator model only outputs the subset of fields it corrected (e.g., `{ "text": "...", "mood": "..." }`) rather than re-serializing all 35 keys, `evaluated.result` replaces `merged`.
Downstream in `generateNextPage`, `generatedStoryPage = { ...response.result, ... }` uses `response.result` directly, which could lose unmentioned Turn B delta keys (`contextHistory`, `newCharacters`, `futureNoteAdd`, `inventory`, etc.).

**Recommendation:** Add a defensive merge backstop in `evaluateMergedStoryGeneration`:
```ts
if (evaluated?.result) {
  return {
    ...evaluated,
    result: {
      ...merged,
      ...evaluated.result,
      calendarDate: evaluated.result.calendarDate ?? merged.calendarDate,
    },
  };
}
return { ...baseResult, result: merged };
```
*(See Open Question Q8).*

---

### ⏩ F4 — MEDIUM: Cached Turn A context drift against live vector memory

**Location:** `prompt.ts:5171` lookup; `prepareNextPageGenerationSetup` (`prompt.ts:4975`).

**Problem:** The roadmap (Part 2.6) states that `advancedState` is deterministic from parent page + action. However, Turn A's prompt also embeds three **pgvector semantic-recall blocks** (`relevantPastEventsBlock`, `relevantFutureNoteKeys`, `clueRecallBlocks`) retrieved at setup time that depend on the live vector store. If sibling pages/fates were generated and embedded in the interim, reusing an earlier Turn A checkpoint means Turn A was written against *older* recall context while Turn B sees *fresh* context.

**Impact:** Minor narrative nuance (recall blocks are advisory hints, not hard constraints).

**Recommendation:** Either accept and document as acceptable advisory drift, or incorporate a short hash of the semantic recall keys into the checkpoint query. *(See Open Question Q2).*

---

### ◻️ F5 — MEDIUM: Redundant prompt recomputation per turn × per fate

**Location:** `buildStoryPagePrompt` (`prompt.ts:1174`) and `buildStateDeltaPrompt` (`prompt.ts:1218`).

**Problem:** For `candidateCount = 3`, `generateStoryGenerationMultiTurn` re-invokes the full prompt builders independently for both turns across all 3 parallel branches (`3 fates × 2 turns = 6` builds of `formatNextPageStoryContextPrompt` + `formatNextPageNarrativePrompt` + field instructions). The base context strings are identical across fates.

**Impact:** Unnecessary CPU and GC allocation on high-concurrency generation paths.

**Recommendation:** Page-scoped memoization of the shared context strings within `prepareNextPageGenerationSetup`.

---

### ◻️ F6 — LOW: Error context & code loss in `Promise.allSettled` batch failures

**Location:** `prompt.ts:5570-5581` in `generateNextPages`.

**Problem:** When all parallel alternatives fail in `generateNextPages`:
```ts
if (generatedAlternatives.length === 0) {
  throw new Error(`All ${candidateCount} alternatives failed to generate for ${generationContext}`);
}
```
The specific error causes (e.g. rate limits, authentication failures, `PAGE_DELETED`, `ACTION_ALREADY_HAS_DESTINATION`) are logged to `console.error` but stripped from the thrown error. The outer caller (`candidate-generation.ts`) receives a generic `Error` without error codes, impeding smart retry decisions.

**Recommendation:** Attach the first rejection's `cause` or rethrow the structured error.

---

### ◻️ F7 — LOW: Page provider/model attribution lost on checkpoint hit

**Location:** `prompt.ts:5174-5215`.

**Problem:** On a cache hit, `storyPage` comes from the DB row. The merged response takes Turn B's response as the carrier, attributing the entire page's `aiProvider`/`aiModel` to Turn B's provider. If Turn A prose was written by Gemini and Turn B delta by Mistral, the page metadata reflects only Mistral.

**Recommendation:** Read `storyPageProvider`/`storyPageModel` from the checkpoint row and include them in the merged metadata.

---

### ⏩ F8 — LOW: Redundant `calendarDate` fallback applied twice

**Location:** Merge at `prompt.ts:5257-5261`, and downstream at `prompt.ts:5390-5393` and `prompt.ts:5639-5642`.

**Problem:** The merged object already applies `calendarDate: storyPage.calendarDate ?? actionedPage.calendarDate`. The downstream functions re-apply the exact same fallback.

**Impact:** Completely harmless (idempotent), just redundant.

---

### ◻️ F9 — LOW: SSE event multiplexing in parallel multiverse generation

**Location:** `prompt.ts:5195`, `prompt.ts:5235`, `ai-chat.ts:1439`.

**Problem:** In parallel multiverse generation (`candidateCount: 3`), each stage and evaluation emits `ai_generation_start` and `complete`, firing up to 6 start/complete events concurrently into `onProgress`.

**Recommendation:** Pass `stage` (`story_page` vs `state_delta`) and `fateIndex` in the SSE payload for smoother client progress tracking.

---

### ◻️ F10 — HYGIENE: Stale `.bak.ts` files inside `src/`

**Location:** `src/schema/story.bak.ts`, `src/types/ai-chat.bak.ts`, `src/types/story.bak.ts`, `src/utils/ai-chat-stream.bak.ts`, `src/utils/ai-chat.bak.ts`, `src/utils/prompt.bak.ts`.

**Problem:** Dead backup files from previous refactorings clutter `src/` and may get checked by `tsc` or confuse developers.

**Recommendation:** Delete all `.bak.ts` files. *(See Open Question Q4).*

---

### ◻️ F11 — INFO: Feature flag evaluation & rollout state

**Location:** `src/config/ai-chat.ts:60` (`USE_MULTI_TURN_GENERATION = process.env.USE_MULTI_TURN_GENERATION === 'true'`).

**Problem:** Evaluated once at module load. Dynamic testing without process restarts is not supported.

**Recommendation:** Centralize into `src/config/env.ts` and support dynamic dev toggling. *(See Open Question Q3).*

---

### ⏩ F12 — INFO: `outputJsonStructure` in `evaluateMergedStoryGeneration`

**Location:** `prompt.ts:1861-1862` $\to$ `runEvaluationPass` (`ai-chat.ts:1725-1749`).

**Clarification:** `STORY_GENERATION_SCHEMA_DEFINITION` passed to `runEvaluationPass` is used to re-parse the corrected string output in `parseAISafely`, while the AI provider wrapper receives `buildEvaluationSchemaDefinition`. The behavior is correct.

---

## 3. Explicit Regression Check vs. Legacy Single-Shot Path

| Aspect | Legacy Single-Shot | Multi-Turn (Flag On) | Verdict |
|---|---|---|---|
| **Request count / candidate** | 1 combined request (`*candidateCount` tokens) | 2 turns × N fates + 1 eval/fate | RPM higher; token output bound per turn |
| **Multiverse failure isolation** | One bad JSON aborts all alternatives | `Promise.allSettled` isolates failures per fate | **Significant Improvement** |
| **Turn A failure** | Entire generation fails | Nothing persisted (no checkpoint) | Neutral |
| **Turn B failure** | Entire generation fails | Checkpoint survives $\to$ retry skips Turn A | **Cost Improvement** (subject to F1 fix) |
| **Schema complexity** | 35 top-level keys in one request | 11 keys (Turn A), 24 keys (Turn B) | **Major Decoder Reliability Win** |
| **Prompt token length** | Monolithic prompt | Stripped prose rules on Turn B | **Token Reduction** |
| **Final validation** | `validateGeneratedPage` + `checkGeneratedPage` | Identical | Neutral |
| **Persist / branchId / embeds** | Unchanged | Unchanged | Neutral |
| **Weak-output self-healing** | Regenerates from scratch on retry | Cached Turn A could pin unless gated | **Regression (F1)** $\to$ Solved by Q1 gate |

---

## 4. Improvement Suggestions

1. ◻️ **Gate Checkpoint Upsert (Immediate):** Gate `upsertPageGenerationCheckpoint` on `checkGeneratedPage` (F1).
2. ◻️ **Defensive Merge on Evaluation (Immediate):** Merge `{ ...merged, ...evaluated.result }` in `evaluateMergedStoryGeneration` (F3).
3. ✅ **Top-Up Checkpoint Alignment (Optional):** Investigate stable fate-slot identity if top-up cache reuse matters; otherwise rely on the orphan sweep (F2/Q6).
4. ◻️ **Context Memoization (Near-term):** Memoize shared story context string generation per setup instance (F5).
5. ◻️ **Delete `.bak.ts` Files (Immediate Hygiene):** Clean up dead backup files from `src/` (F10).
6. ◻️ **Periodic Orphan Sweeper (Phase 6.4):** Sweep checkpoints older than 7 days during routine DB cron maintenance.
7. ◻️ **Phase 10 Context Pruning (Future Optimization):** Trim legacy page history blocks from Turn B prompt.

---

## 5. Open questions needing your decision

### ◻️ Q1 — Should the checkpoint upsert be gated on a page-turn validation?
The cache can pin a weak-but-schema-valid Turn A (F1), turning a transient weak output into a persistent retry loop for that action.

- **Option A (Recommended):** Gate the upsert on `checkGeneratedPage(storyPage, undefined, ctx)` (or assert non-empty `text` and well-formed `actions`). If it fails, skip the upsert and let the retry regenerate Turn A fresh.  
  *Rationale:* Minimal code, reuses existing validator, preserves all cost savings on the valid path while preventing poisoning.
- **Option B:** Add a retry/attempt counter to the checkpoint (only trust cached Turn A if attempt count $< N$).  
  *Rationale:* More complex schema and state tracking for the same outcome.
- **Option C:** Leave as-is; rely on `retry-pending-generations` eventually replacing the action with a fallback action.  
  *Rationale:* Causes unnecessary AI token spend and delayed recovery.

---

### ◻️ Q2 — Should the cache key incorporate the semantic-recall context signature?
Cached Turn A may have been written against slightly different pgvector recall results than the current attempt (F4).

- **Option A (Recommended):** Leave as-is and document the caveat.  
  *Rationale:* Semantic recall blocks are advisory narrative hints, not hard constraints. The slight context variance across retries is harmless and not worth key hashing complexity.
- **Option B:** Include a short hash of `relevantPastEventsBlock + relevantFutureNoteKeys + clueRecallBlocks` in the checkpoint key so a stale-context Turn A is not reused.  
  *Rationale:* Strictly purist, but causes cache misses whenever vector memory updates.
- **Option C:** Add a short TTL (e.g. 1 hour) to the checkpoint table.  
  *Rationale:* Introduces TTL management without addressing the underlying semantic determinism.

---

### ◻️ Q3 — Rollout: when and how to flip `USE_MULTI_TURN_GENERATION` to default `true`?
Currently `false` (F11). The pipeline is code-complete.

- **Option A (Recommended):** Apply fixes for F1 (validation gate) and F3 (defensive merge), then flip default to `true` in **development/staging**. Monitor telemetry across all 3 modes (`novel`, `interactive`, `multiverse`), then promote to production.  
  *Rationale:* Follows standard safe rollout procedure with verified telemetry.
- **Option B:** Keep `false` by default; enable via environment variables per deployment environment.  
  *Rationale:* Conservative, but delays full end-to-end multi-turn testing.
- **Option C:** Flip `true` immediately in production.  
  *Rationale:* High risk before applying F1 and F3 safeguards.

---

### ◻️ Q4 — Delete the stale `src/**/*.bak.ts` files?
(F10.) These can confuse developers and bloat type-checking.

- **Option A (Recommended):** Delete all six `.bak.ts` files now.  
  *Rationale:* Clean codebase hygiene; all live modules are verified in git history.
- **Option B:** Keep them and add `**/*.bak.ts` to `tsconfig.json` `exclude`.  
  *Rationale:* Unnecessary clutter.

---

### ◻️ Q5 — Should we do Turn B context pruning (Phase 10) now or defer?
Turn B currently receives the full story context prompt even though prose rules were stripped.

- **Option A (Recommended):** Defer to Phase 10 as planned.  
  *Rationale:* The current token budget (`1800`) and prompt length comfortably fit within all provider context limits. Focus first on landing Phase 8 rollout.
- **Option B:** Implement a targeted prune now — strip `PREVIOUS PAGES` and `CURRENT SITUATION` from Turn B since it already has `GENERATED PAGE`.  
  *Rationale:* Saves ~300–500 input tokens per Turn B immediately.

---

### ◻️ Q6 — Checkpoint cleanup & retention strategy
Beyond F1's validation gate, how should stale/orphaned checkpoints be cleaned?

- **Option A (Recommended):** Keep CASCADE deletion on `pages`/`books` and add a lightweight sweep of checkpoints older than 7 days inside `retryPendingGenerations`. No TTL index needed.  
  *Rationale:* Zero database schema overhead; handles abandoned branches naturally.
- **Option B:** Add a strict 24-hour TTL column and delete via PostgreSQL TTL extension.  
  *Rationale:* Requires extra database configuration.
- **Option C:** Rely entirely on foreign key CASCADE deletes on page/book deletion.  
  *Rationale:* Leaves rows behind if an action is abandoned without deleting the parent page.

---

### ✅ Q7 — Should checkpoint `fateIndex` be made slot-stable across top-up?
F2 shows `fateIndex` is per-call order, so a surviving checkpoint from the original batch is only *coincidentally* reused during a top-up (and can be orphaned in the `existing.length === limit-1` edge). 

- **Option A (Recommended):** Accept the current call-scoped `fateIndex` and rely on the periodic orphan sweep (Q6) to reclaim any unused checkpoint rows. Document that the cache benefit applies primarily to *retries of the same call* (where fateIndex is identical), not to cross-call top-ups.  
  *Rationale:* Simplest; top-up volume is low and the cost of an occasional re-run Turn A is negligible vs. the complexity of a stable slot-identity scheme.
- **Option B:** Introduce a stable fate-slot identity (e.g. persist the action's destination slot index and pass it as `fateIndex` on top-up) so the top-up regenerates exactly the missing slot and reuses its checkpoint.  
  *Rationale:* Maximizes cache reuse, but requires threading a slot index through `generateCandidatePages` → `generateNextPages` → `generateStoryGenerationMultiTurn`, and only aligns when the missing slot equals the regenerated index — not guaranteed in arbitrary partial-failure patterns, so the implementation must map *per missing slot*, not assume `fateIndex = existing.length`.

---

### ◻️ Q8 — Evaluator defensive merge backstop
To prevent fallback evaluators from dropping Turn B delta keys if they only output corrected text fields (F3).

- **Option A (Recommended):** Apply defensive merge `{ ...merged, ...evaluated.result, calendarDate: evaluated.result.calendarDate ?? merged.calendarDate }` in `evaluateMergedStoryGeneration`.  
  *Rationale:* 100% guarantees state integrity against malformed or partial LLM evaluator output.
- **Option B:** Require the evaluator output to contain all required fields or discard evaluation completely.  
  *Rationale:* Discards useful text polish if minor delta fields were omitted.

---

## 6. Summary

The multi-turn page generation implementation is **architecturally sound, complete, and aligns with the roadmap**. The core sequential flow (`Turn A` $\to$ `Turn B` $\to$ `Deterministic Merge` $\to$ `Single Evaluator Pass`) effectively resolves the schema complexity bottleneck and provider token overflow.

Addressing the two immediate safeguards:
1. **F1 (Validation gate on checkpoint upsert — Q1/Option A)**
2. **F3 (Defensive merge on evaluation — Q8/Option A)**

along with deleting the stale `.bak.ts` files (Q4/Option A), makes the pipeline fully ready for staging enablement and production rollout.
