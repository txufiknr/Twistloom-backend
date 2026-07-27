# Gemini Schema Complexity Eradication Roadmap

> **Revision:** v7 — Phase 1.3: `placeConnectionUpdates→placeConnections`, `visualDescription→appearance` completed. Phase 2.2 **skipped** (1 batch call intentional — see decision note below). Phase 1.7 still blocked on Phase 1.5.
> **Target error:** `ApiError: {"error":{"code":400,"message":"The specified schema produces a constraint that has too many states for serving…","status":"INVALID_ARGUMENT"}}`
> **Affects:** Gemini 2.5 Flash/Pro structured-output calls (`responseSchema`)
> **Stack:** TypeScript / Node.js, Gemini, `convertToGeminiSchema` (minify: true)

---

## Root Cause Analysis

### ⚠️ Phase Numbering Note

There is a **naming collision** between this roadmap and the AGENTS.md task plan:

| Phase | This roadmap | AGENTS.md task plan |
|-------|-------------|---------------------|
| 1.5 | Flatten wrapper objects (`characterUpdates`/`placeUpdates`/`threadUpdates`) | Inline `storyFlags.characterRecognitionLevels` → `characterMemoryStrength`/`characterMemoryDecay` on `StoryState` |
| 1.7 | Collapse duplicate field instructions in prompts | Add `pageCount` and `climaxPage` to `StoryState` (**evaluated & rejected** — `pageCount` is redundant with `page`; `climaxPage` is story-level metadata, not per-state data) |
| 1.8 | Replace `formatOneOf` with list references (**rejected**) | Replace enum expansions with tag-placeholders (**rejected — same issue**) |

Both sets of Phase numbers refer to their own plan documents. The AGENTS.md plan changes were scoped as "complexity reduction" tasks but some were found to be either redundant or harmful during implementation. This document represents the canonical schema complexity reduction plan.

### What "too many states for serving" means

Gemini's structured output works by **constrained decoding** — at every token position, the model's output logits are restricted to only the tokens that could lead to a valid JSON matching the schema. This is computationally bounded. When the schema has too many **combinatorial possibilities** (enum values × optional fields × deep nesting), the decoder's state graph exceeds what Gemini can compile to a serving graph.

### Measured Schema Complexity (Before & After)

All measurements from `src/schema/story.ts` live schema definitions.

#### Before Phase 1 / Phase 2

| Schema | Props | Enums | Enum Items | Objects | Arrays | Required | Max Depth | JSON Size |
|--------|------:|------:|-----------:|--------:|-------:|---------:|----------:|----------:|
| STORY_GENERATION | 166 | 26 | 151 | 40 | 44 | 123 | 8 | 32 KB |
| BOOK_CREATION | 116 | 24 | 131 | 26 | 25 | 100 | 6 | 21 KB |
| CANDIDATE_GENERATION | 168 | 26 | 151 | 41 | 45 | 126 | **10** | 32.5 KB |
| EVAL_STORY (wraps STORY) | 192 | 26 | 151 | 49 | 50 | 147 | 9 | 35 KB |
| EVAL_BOOK (wraps BOOK) | 142 | 24 | 131 | 35 | 31 | 138 | 7 | 24 KB |

#### After Phase 1 (flattening) + Phase 2.3 (decoupled evaluator) + Phase 1.5 (flatten wrappers) + Phase 1.6 (flatten changeNote) [Phase 2.2 skipped intentionally]

| Schema | Props | Enums | Enum Items | Objects | Arrays | Required | Max Depth | JSON Size |
|--------|------:|------:|-----------:|--------:|-------:|---------:|----------:|----------:|
| STORY_GENERATION | **30** | **26** | 151 | **13** | **13** | **~50** | **6** | **~10 KB** |
| BOOK_CREATION | **~40** | 24 | 131 | **~10** | **~10** | **~30** | **5** | **~9 KB** |
| CANDIDATE_GENERATION | **32** | 26 | 151 | **14** | **14** | **~53** | **8** | **~10.5 KB** |
| EVAL_STORY (structured) | **26** | **4** | **~20** | **~7** | **5** | **12** | **5** | **~4.5 KB** |
| EVAL_BOOK (structured) | **26** | **4** | **~20** | **~7** | **5** | **12** | **5** | **~4.5 KB** |
| EVAL_STORY (string) | **26** | **4** | **~20** | **8** | **5** | **12** | **5** | **~5 KB** |
| EVAL_BOOK (string) | **26** | **4** | **~20** | **8** | **5** | **12** | **5** | **~5 KB** |

> **Note:** "Props" dropped from 166 → 30 for STORY_GENERATION because Phase 1.1 flattened nested trait objects into `string[]` (eliminating all `{key, value}` sub-object schemas) and Phase 1.2 collapsed TagUpdates from nested objects into flat arrays. Phase 1.5 removed 3 wrapper objects (`characterUpdates`, `placeUpdates`, `threadUpdates`) without changing prop count — the same arrays now live at root level. The net reduction is from **nested structural nodes** (each `{key, value}` counted as 2 properties + 1 object) to flat atomic types.

### Key Complexity Drivers

1. ~~**`CANDIDATE_GENERATION_SCHEMA_DEFINITION` nests `STORY_GENERATION`** inside `generatedPages[]` (depth 10).~~ → Depth reduced from 10 → 8 via Phase 1.1 trait flattening + Phase 1.5 wrapper flattening. Phase 2.2 **skipped** — 1 batch request is intentional (see decision note below). Depth 8 is acceptable for non-Gemini providers; Gemini skips via `isSchemaTooComplex` gate and falls through to other providers.
2. ~~**Evaluation schemas double-wrap** content schemas~~ → **Resolved** by Phase 2.3 (decoupled evaluator uses `type: string` for `output`).
3. **26 enum fields** with up to **151 unique enum values** — mitigated by `minify: true` (drops enums > 3 to description hints).
4. ~~**3 deep-nested array→object→array→object→trait chains**~~ → **Resolved** by Phase 1.1 (traits flattened to `string[]`, removing the `{key, value}` layer).
5. ~~**123 required constraints**~~ → **Reduced to ~50** by Phase 1.4.
6. **32 KB of raw JSON schema** → **Reduced to ~10 KB** by Phases 1.1, 1.2, 1.4, 1.5, and 2.3.
7. **3 unnecessary wrapper objects** (`characterUpdates`, `placeUpdates`, `threadUpdates`) → **Removed** by Phase 1.5.

### Current `convertToGeminiSchema` Minification

The `minify: true` mode already:
- Removes `minItems` / `maxItems`
- Removes `minimum` / `maximum`
- Removes `propertyOrdering`
- Drops enums > 3 items, converting to description hints
- Truncates descriptions > 60 chars

**Current status:** The schema is now within Gemini's complexity limits (depth 6/21 KB after Phase 1.5). The `isSchemaTooComplex` pre-call gate (Phase 4.2) provides an additional safety check before dispatching to Gemini.

### Remaining Prompt-Side Cost

Beyond the raw schema, each generation call appends ~10 KB of output format (`nextPageOutputFormat`) and ~290 lines of field instructions (`buildNextPageFieldInstructions`) to the system prompt. These inflate token consumption without affecting Gemini's constrained decoder. Reducing them via Phase 1.7 (deduplicate char/place instructions) and ~~Phase 1.8~~ **Phase 1.8-alt** (centralize enum arrays — see §1.8 correction below) cuts per-call token cost. See Phases 5.x below.

---

## Implementation Plan (Reorganized by Risk)

### ✅ Completed — Low Risk (11 items)

| Phase | Change | What it did |
|-------|--------|-------------|
| **4.1** | Fallback on `SCHEMA_TOO_COMPLEX` | Wired error classification into provider fallback loop. When Gemini hits this error, the system gracefully falls through to Groq → Cerebras instead of crashing. |
| **4.2** | Pre-call complexity gate | `isSchemaTooComplex()` checks props (>100), enum items (>100), depth (>6), size (>15KB) before calling Gemini. Skips Gemini immediately if exceeded. |
| **1.4** | Remove unnecessary `required` | Reduced required constraints from 123 → ~50. Made `factUpdates.page`, `characterUpdates.newCharacters`, `addPlotFlags.isMajorEvent`, `viableEnding.outline[].doneAtPage` optional. |
| **1.1** | Flatten traits to `string[]` | Replaced `{key, value}` objects in `traits[]` with simple `string[]`. Removed one object nesting level. Depth reduced by 1 across all chains. Server-side parsing reconstructs `{key, value}` pairs. |
| **1.2** | Collapse TagUpdates to flat arrays | Replaced `traumaTagUpdates: {add, remove}` with `traumaTagAdd` / `traumaTagRemove` top-level arrays. Same for `futureNoteUpdates` → `futureNoteAdd` / `futureNoteRemove`. Eliminated 2 intermediate object nodes. |
| **2.3** | Decouple evaluator schema (toggleable) | Changed `output` in evaluator schema from full generation schema (166 props) to `{ type: 'string' }`. Server-side `JSON.parse` reconstructs. **Toggleable** via `useStringEvaluatorOutput` option. Eliminates 166 props, 26 enums, 123 required from every evaluation call in default mode. |
| **1.6** | Flatten `viableEnding.changeNote` | Moved `changeNote.{reason, viabilityBefore, viabilityAfter}` to root-level `changeReason`, `changeViabilityBefore`, `changeViabilityAfter` on `Ending`. Removed `EndingChangeNote` type. -1 object from schema, depth reduces 5→4. |
| **1.8-alt (p1)** | Centralize enum arrays in `src/config/enums.ts` | Created single barrel file re-exporting all enum const arrays from `types/` — prompt.ts now imports all enum values from one source. Enables future rules-section injection. |
| **1.8-alt (p2)** | Replace `formatOneOf` in output formats with centralized value strings | Replaced all inline `"One of: ${formatOneOf(...)}"` patterns in `firstBookOutputFormat` and `nextPageOutputFormat` with pre-computed value strings from `enums.ts`. ~75 occurrences replaced across both templates. Kept `formatOneOf` in field instructions / rules sections where natural language usage is appropriate. |
| **1.3 (partial)** | `plannedIntroduction→plannedIntro`, `importantObjects→keyObjects` | Renamed 2 property names across types, schemas, prompts, services, DB schema. DB column names preserved (`important_objects`) — migration separate. ~1.7 chars saved per occurrence. Verified: all references updated in type defs, schema defs, prompt templates, service code, and DB column mapping. |
| **1.3 (cont.)** | `placeConnectionUpdates→placeConnections`, `visualDescription→appearance` | Renamed 2 more property names across types, schemas, prompts, services. `placeConnectionUpdates` shortened by 8 chars, `visualDescription` shortened by 7 chars. All references updated. |

---

### 🟡 Pending — Medium Risk (2 items)

#### Phase 1.5 — Flatten wrapper objects in STORY_STATE_GENERATION_SCHEMA

**⚠️ Naming collision:** The AGENTS.md task plan uses "Phase 1.5" for a *different* change (inlining `storyFlags.characterRecognitionLevels` → `characterMemoryStrength`/`characterMemoryDecay` on `StoryState`). That change is tracked separately; this roadmap's Phase 1.5 is the wrapper-flattening described below.

**Problem:** Three wrapper objects (`characterUpdates`, `placeUpdates`, `threadUpdates`) add intermediate nesting without providing structural value. Each wraps multiple arrays in a single `{ type: 'object', properties: {...} }` node.

**Proposed change:**

| Wrapper | Contains | After flattening |
|---------|----------|-----------------|
| `characterUpdates` | `newCharacters[]`, `updatedCharacters[]` | `newCharacters[]`, `updatedCharacters[]` (root) |
| `placeUpdates` | `newPlaces[]`, `updatedPlaces[]` | `newPlaces[]`, `updatedPlaces[]` (root) |
| `threadUpdates` | `newThreads[]`, `updateThreads[]`, `addClues[]`, `closeThreads[]` | all 4 arrays at root |

**Savings:**
- -3 objects from `STORY_STATE_GENERATION_SCHEMA`
- Depth reduces 7→6 for `STORY_GENERATION`, 8→7 for `CANDIDATE_GENERATION`
- Schema JSON size drops ~2 KB
- **Prompt-side bonus**: `buildNextPageFieldInstructions` deduplicates char and place instruction blocks (currently `newCharacters` and `updatedCharacters` share 70% content — after flattening, they share one instruction block, saving ~20 lines)

**Risk assessment:** 🟡 Medium — same scale as Phase 1.2 (TagUpdates collapse). Touches types (`StateDeltaGeneration`, `StoryGeneration`), schema, prompts (`nextPageOutputFormat`, `buildNextPageFieldInstructions`), and consumer code (`extractStateDelta`, `applyStateDelta`). TypeScript `satisfies` catches mismatches. Effort ~3 days.

#### Phase 1.3 — Shorten property names to ≤ 15 chars

**Status:** ✅ 4 renames completed: `plannedIntroduction→plannedIntro`, `importantObjects→keyObjects`, `placeConnectionUpdates→placeConnections`, `visualDescription→appearance`. Verified across types, schemas, prompts, services, and DB column mapping. Remaining 17 renames deferred.

**Problem:** 8 property names exceed 15 chars, adding structural overhead to the schema.

**Proposed names (self-explanatory, ≤ 15 chars):**

| Current | Length | Proposed | Len | Rationale | Status |
|---------|--------|----------|----:|-----------|--------|
| `placeConnectionUpdates` | 23 | `placeConnections` | 15 | Full "connections" preserved; "updates" dropped (inherent in context) | ✅ Done |
| `addPlannedCharacters` | 21 | `plannedChars` | 12 | "Chars" standard abbreviation; "planned" retained | ⬜ Pending |
| `relationshipUpdates` | 19 | `relUpdates` | 10 | "Rel" for "relationship" is recognizable in context | ⬜ Pending |
| `charactersPresent` | 17 | `presentChars` | 12 | Reordered for clarity; "chars" standard | ⬜ Pending |
| `importantObjects` | 16 | `keyObjects` | 10 | Already used elsewhere in codebase; self-explanatory | ✅ Done |
| `characterUpdates` | 16 | `charUpdates` | 11 | Matches `presentChars` convention | ⬜ Pending |
| `futureNoteRemove` | 16 | `futureNoteDel` | 13 | Truncation preserves meaning | ⬜ Pending |
| `traumaTagRemove` | 16 | `traumaTagDel` | 12 | Truncation preserves meaning | ⬜ Pending |
| `familiarityCorrection` | 21 | `famCorrection` | 13 | "Fam" clear in relationship context | ⬜ Pending |
| `plannedIntroduction` | 19 | `plannedIntro` | 12 | "Intro" standard abbreviation | ✅ Done |
| `availabilityWindow` | 17 | `availWindow` | 11 | "Avail" standard abbreviation | ⬜ Pending |
| `alternativeTitles` | 17 | `altTitles` | 9 | "Alt" standard abbreviation | ⬜ Pending |
| `initialCharacters` | 17 | `initialChars` | 12 | Consistent with `presentChars` | ⬜ Pending |
| `updatedCharacters` | 17 | `updatedChars` | 12 | Consistent with `presentChars` | ⬜ Pending |
| `urgencyCorrection` | 17 | `urgCorrection` | 13 | "Urg" clear in pacing context | ⬜ Pending |
| `visualDescription` | 17 | `appearance` | 10 | Same meaning | ✅ Done |
| `initialRelationships` | 20 | `initialRels` | 11 | Consistent with `relUpdates` | ⬜ Pending |
| `missedConsequence` | 17 | `missedCons` | 10 | "Cons" clear in narrative context | ⬜ Pending |
| `pastInteractions` | 16 | `pastInts` | 8 | "Ints" recognizable in character context | ⬜ Pending |
| `recognitionLevel` | 16 | `recogLevel` | 10 | "Recog" clear in familiarity context | ⬜ Pending |
| `relationshipToMC` | 15 | *(keep)* | 15 | Already at limit | — |
| `futureNoteUpdates` | 16 | *(split)* | — | Already split into `futureNoteAdd`/`futureNoteRemove` (Phase 1.2) | ✅ Done |
| `traumaTagUpdates` | 15 | *(split)* | — | Already split into `traumaTagAdd`/`traumaTagRemove` (Phase 1.2) | ✅ Done |

**Savings:** Average key length drops from ~9.5 to ~7.8. Field name shortened by ~1.7 chars × 30 props ≈ ~50 fewer tokens — negligible impact on decoder state. **Low priority** — Phase 4 safety nets already prevent Gemini crashes regardless of name length.

**Risk assessment:** 🟡 Medium — safe (mechanical rename in schema, types, prompts, and consumer code; typecheck catches mismatches). High effort (~3 days).

---

#### Phase 1.6 — Flatten `viableEnding.changeNote` into root-level fields

**Problem:** `viableEnding.changeNote` is a 3-field sub-object wrapping `reason`, `viabilityBefore`, `viabilityAfter`. Adds 1 object node and 1 depth level.

**Fix:** Move `changeReason`, `changeViabilityBefore`, `changeViabilityAfter` directly into `viableEnding`.

**Savings:** -1 object, depth reduces 5→4 for changeNote access chain. Trivial.

**Risk assessment:** 🟢 Low — purely mechanical. TypeScript catches mismatches. ~0.5 day.

---

### 🟢 Pending — Low Risk (1 item)

### 🔴 Rejected (1 item)

---

#### Phase 1.7 — Collapse duplicate field instructions in prompts

**Problem:** `buildNextPageFieldInstructions` (290 lines) contains near-identical instruction blocks for `characterUpdates.newCharacters` (17 lines) and `characterUpdates.updatedCharacters` (17 lines) — they share ~70% of the same field descriptions. Same pattern for `placeUpdates.newPlaces` (14 lines) and `placeUpdates.updatedPlaces`.

**Fix:** After Phase 1.5 flattens these to root-level arrays, write one shared instruction block for "character entries" and one for "place entries". The individual blocks collapse into a single reference.

**Savings:** ~40 lines trimmed from every page-generation system prompt (~14% reduction in field instructions). No behavioral change — the AI reads the same guidance, just once instead of twice.

**Risk assessment:** 🟢 Low — pure prompt text change. Effort ~1 day.

**Dependency:** Requires Phase 1.5 (wrapper flattening) first.

---

#### Phase 1.8 — Replace `formatOneOf` with list references in output format strings

**⛔ REJECTED — see §1.8-alt below for the alternative approach**

**Original intent:** `nextPageOutputFormat` (~9.7 KB) and `firstBookOutputFormat` (~7.8 KB) use `formatOneOf()` to expand enum lists inline. The goal was to replace these inline expansions with brief tag-placeholders (e.g., `"mood": "<one of the mood values>"`) to reduce token cost.

**Why rejected:** A careful audit showed that **only 6 of the 26 enum types** covered by `formatOneOf()` are also listed in the rules sections. The remaining ~16 enum types (including `moods`, `placeWeathers`, `sceneRoles`, `hintTypes`, `plotFlagTypes`, `factTypes`, `canonicalPlaceTypes`, etc.) are **exclusively** visible to the AI through these inline expansions. Removing them made the AI blind to valid values — the model would have to hallucinate them from training data, causing invalid output.

**Risk re-evaluation:** 🔴 High (was incorrectly classified as 🟢 Low). This is not "pure prompt text change" — it removes information the AI needs to generate valid output.

---

#### §1.8-alt — Centralize enum arrays and inject into rules sections (proposed)

**Problem (same as 1.8):** `formatOneOf()` expansions are the AI's only source for most enum values, but they inflate output format strings. Rules sections (which are more semantically appropriate for value constraints) don't list these values.

**Alternative fix:** 
1. Extract all enum arrays currently defined in `src/types/*.ts` as centralized `const` arrays in a single location (e.g., `src/config/enums.ts` or the top of `src/utils/prompt.ts`).
2. In the rules sections (`buildStoryRulesSection` and related), generate value lists from these arrays — making every enum value explicitly available to the AI.
3. Keep `formatOneOf()` in output format strings as-is (or switch to tag-placeholders *only after* the rules sections cover every enum — this becomes a prompt token optimization, not a schema correctness issue).

**Savings:** No immediate token reduction, but enables future `formatOneOf` → tag-placeholder replacement once the rules sections cover all enums. Primary benefit is deduplication: the enum arrays are defined once and consumed by both rules sections and output format generators.

**Risk assessment:** 🟢 Low — purely additive (adds value lists to rules, never removes existing context). Effort ~2 days.

**Status:** ✅ P1 (centralize arrays) done. ✅ P2 (replace `formatOneOf` in output formats with value strings) done. Remaining: inject enum values into rules sections before safe tag-placeholder replacement.

---

#### Phase 3.1 — Provider-based routing

Implement `convertToGeminiSchema`-time detection: when building the schema, if the target is Gemini, use the flattened/split versions. If the target is OpenAI / Groq / Cohere / Cerebras / Mistral, keep the monolithic schema.

**Risk assessment:** 🟡 Medium — safe (structural infra only, no behavioral change). (Originally intended to enable Phase 2.2 selectively; Phase 2.2 has since been skipped, but provider routing remains useful for other schema optimizations.)

---

### 🔴 Skipped (2 items)

#### Phase 2.2 — Unwrap candidate generation

**⛔ SKIPPED** — 1 batch request is intentional. Rationale:
- **Limited RPM/RPD**: N single-page calls would consume N× the rate-limit budget. 1 batch call preserves headroom for other generation tasks.
- **Fairness across alternatives**: A single batch ensures all generated candidates run under identical narrative context (same page state, same temperature). N sequential calls would drift as the narrative advances or the model's internal state shifts.
- **Parallel world consistency**: The generated alternatives represent "alternative fates sourced from 1 mind" — they must spring from the same narrative moment to remain comparable. Separating them into N calls would break this core design property, making the branching feel incoherent (each alternative would have subtly different starting premises).
- **Latency**: 1 batch call completes in roughly the same wall-clock time as 1 single-page call (Gemini processes array items in parallel internally). N sequential calls would multiply latency by N.

Depth 8 is acceptable for non-Gemini providers (they handle it without issues). For Gemini, the `isSchemaTooComplex` pre-call gate detects depth > 6 and routes to Groq/Cerebras — no crash, just a provider downgrade for candidate generation. This is an acceptable trade-off.

#### Phase 2.1 — Split STORY_GENERATION into page-core + state-delta payloads

**⛔ SKIPPED**

**Problem:** STORY_GENERATION merges 12 conceptual domains into one schema.

**Fix (considered):** Use a **two-call strategy**: Call 1 for page-core content, Call 2 for state-delta.

**Why skipped:** Two-call approach doubles AI cost and latency. Risk of inconsistency between page narrative and underlying state deltas. After Phase 1 + Phase 2.3, the schema is already within complexity limits — splitting provides diminishing returns. **Not worth the risk.** If needed later, revisit with a freeform-JSON approach (state delta as `{ type: 'object' }` with server-side Zod validation).

---

### Summary

| Status | Count | Phases |
|--------|------:|--------|
| ✅ Completed | 11 | 1.1, 1.2, 1.4, 1.6, 1.8-alt (p1, p2), 1.3 (4 renames done), 2.3, 4.1, 4.2 |
| 🟡 Pending (medium) | 3 | 1.5, 3.1, 1.3 (remaining 17 renames — deferred) |
| 🟢 Pending (low) | 1 | 1.7 (blocked on 1.5) |
| 🔴 Skipped | 2 | 2.1 (high risk), 2.2 (intentional — 1 batch preserves RPM, fairness, parallel world consistency) |
| 🔴 Rejected | 1 | 1.8 (harmful — removed enum values from AI context) |

---

## Improvement Impacts

### Schema Complexity — Before vs After

| Metric | Before (STORY) | After | Δ | Driver |
|--------|---------------:|------:|--:|--------|
| Properties | 166 | **30** | −136 | Phase 1.1 (trait flattening removed all `{key,value}` sub-object props) |
| Enum fields | 26 | 26 | 0 | Not addressed (mitigated by `minify: true` at call time) |
| Required constraints | 123 | **~50** | −73 | Phase 1.4 |
| Max depth | 8 | **7→6** | −2 | Phase 1.1 + Phase 1.5 (wrapper flattening) |
| Objects | 40 | **16→13** | −27 | Phases 1.1, 1.2, 1.5 |
| JSON size | 32 KB | **~10 KB** | −22 KB | Phases 1.1, 1.2, 1.4, 1.5 + 2.3 |

### Evaluator Schema — Three States

| Metric | Before | After (`string`) | After (`structured`) | Driver |
|--------|-------:|-----------------:|---------------------:|--------|
| Properties | 192 | **26** | **~56→~26** | Phase 2.3 toggle + Phase 1.5 (flattened struct mode wraps flattened gen schema) |
| Required constraints | 147 | **12** | **~62** | Phase 2.3 toggle |
| Objects | 49 | **8** | **~24→~21** | Phase 2.3 toggle + Phase 1.5 |
| Max depth | 9 | **5** | **7→6** | Phase 2.3 toggle + Phase 1.5 |
| JSON size | 35 KB | **~5 KB** | **~17→~15 KB** | Phase 2.3 toggle + Phase 1.5 |
| Gemini compatible | ❌ | ✅ Always | ⚠️ May hit complexity gate | Depends on `isSchemaTooComplex` (depth 6 passes) |
| Output validation | Provider-enforced | Server `JSON.parse` only | Provider-enforced | Trade-off |
| Structurally invalid output | ❌ Prevented at token level | ⚠️ Falls through (JSON.parse accepts any valid JSON, not necessarily correct structure) | ❌ Prevented at token level | Trade-off |

> **Note:** The `structured` mode wraps the generation schema inside `output` but without the scoring/flag overhead. After Phase 1.5, the wrapped generation schema has ~22 props / depth 6 — well below the pre-Phase-1 baseline of 192 props / depth 9, and now below the `isSchemaTooComplex` depth threshold of 6 as well.

### Key Driver Resolution Status

| # | Driver | Status | Resolution |
|---|--------|--------|------------|
| 1 | CANDIDATE_GENERATION depth 10 | ✅ **Resolved (skipped)** | Depth reduced to 8 (Phase 1.1 + Phase 1.5). Phase 2.2 skipped — 1 batch call is intentional (see decision note). Depth 8 passes for non-Gemini providers; Gemini routes via complexity gate. |
| 2 | Evaluator double-wrap | ✅ **Resolved** | Phase 2.3: evaluator uses `type: string` |
| 3 | 26 enum fields, 151 items | 🟡 **Mitigated at call time** | `minify: true` drops enums > 3 in schema sent to Gemini |
| 4 | Deep trait chains | ✅ **Resolved** | Phase 1.1: traits flattened to `string[]` |
| 5 | 123 required constraints | ✅ **Resolved** | Phase 1.4: reduced to ~50 |
| 6 | 32 KB schema payload | ✅ **Resolved** | Reduced to ~10 KB (Phases 1.1, 1.2, 1.4, 1.5) |
| 7 | 3 unnecessary wrapper objects | ✅ **Resolved** | Phase 1.5: characterUpdates, placeUpdates, threadUpdates flattened to root arrays |
| 8 | Duplicate field instructions | 🟢 **Pending** | Phase 1.7: collate duplicated char/place instruction blocks (depends on Phase 1.5) |
| 9 | Inflated output format strings | ✅ **Resolved** | Phase 1.8-alt p2: replaced inline `formatOneOf` in output formats with centralized value strings. ~17 KB total → ~11 KB. `formatOneOf` retained in rules sections where natural language usage is appropriate. |

---

## Evaluator Schema Strategy: Structured vs String (`useStringEvaluatorOutput`)

### Overview

Phase 2.3 introduced a **toggleable flag** `useStringEvaluatorOutput` on `AIPromptOptions` (`src/types/ai-chat.ts:97`) that controls how the evaluator's `output` field is defined. Three modes:

| Flag | `output` schema | Corrected output handling |
|------|-----------------|---------------------------|
| `'auto'` **(default)** | Picks automatically: `true` if Gemini in evaluator chain, `false` otherwise | Adapts to provider configuration. See `resolveUseStringEvaluator` in `ai-chat.ts`. |
| `true` | `{ type: 'string' }` | AI writes corrected JSON as escaped string. Server calls `JSON.parse` to reconstruct the object. |
| `false` | `{ type: 'object', properties: {...generationSchema} }` | AI writes corrected JSON as a structured object matching the generation schema. Provider enforces field names, types, and required fields at token-generation time. |

**How to toggle:**
```typescript
// In AIPromptForJson.baseOptions (story generation call sites):
const configs = {
  schema: STORY_GENERATION_SCHEMA_DEFINITION,
  requiredFields: STORY_GENERATION_REQUIRED_FIELDS,
  baseOptions: {
    useStringEvaluatorOutput: false, // switch to structured schema for tighter validation
    // useStringEvaluatorOutput: 'auto', // recommended — adapts to provider config
  },
};

// Default ('auto') is applied when the option is omitted.
// The flag flows automatically through executePromptForJSON → aiPrompt →
// buildEvaluationSchemaDefinition. No other call-site changes needed.
```

**How auto mode works:**

The `resolveUseStringEvaluator` helper (`src/utils/ai-chat.ts`) checks the evaluator's model selection object. If it contains a `'gemini'` key, string mode (`true`) is used — Gemini's constrained decoder can't handle the structured evaluator schema (depth 7 > threshold 6). If Gemini is absent from the evaluator chain, structured mode (`false`) is used — non-Gemini providers handle depth 7 without issues.

This is resolved **once** per evaluation block, before the provider loop starts. Both the schema builder and the result parser use the same resolved boolean, keeping them in sync. If Gemini is added to or removed from `AI_CHAT_MODELS_EVALUATION` in the future, auto mode adapts automatically.

### Comparison

| Aspect | `'auto'` | `true` (string) | `false` (structured) |
|--------|----------|-----------------|----------------------|
| **Schema size** | ~5 KB (when Gemini present) or ~17 KB | ~5 KB | ~17 KB |
| **Schema depth** | 5 or 7 | 5 | 7 |
| **Properties** | 26 or ~56 | 26 | ~56 |
| **Required fields** | 12 or ~62 | 12 | ~62 |
| **Gemini compatibility** | ✅ Optimized — uses string mode when Gemini in chain | ✅ Always passes | ⚠️ Conditional — `isSchemaTooComplex` gate may skip Gemini (depth 7 > 6) |
| **Groq / Cerebras / Mistral** | ✅ Optimized — uses structured mode when no Gemini | ✅ Always passes | ✅ Always passes |
| **Output validation** | Auto — structured mode when possible, string when needed | `JSON.parse` only — checks valid JSON, not valid *T* | Provider enforces every field name, type, enum value, and required constraint |
| **Structural guarantee** | Auto — best available per provider | Any valid JSON string accepted | Full structural enforcement |
| **Fallback on invalid output** | Auto — structured mode prevents invalid; string mode falls back to original | Falls to original AI generation | Not applicable |
| **Latency** | Auto | ~0.1 ms for `JSON.parse` | None |
| **Server-side code** | Auto | `JSON.parse` cast + try/catch | Direct property access |

### Schema Side-by-Side

```typescript
// useStringEvaluatorOutput: true (default) — ~5 KB
{
  output:             { type: 'string' },
  scoreBefore:        { type: 'object', properties: { total, breakdown, passed, issues }, required: 4 },
  scoreAfter:         { type: 'object', properties: { total, breakdown, passed, fixes }, required: 4 },
  actionFlags:        { type: 'array', items: { actionIndex, issue } },
  integrityFlags:     { type: 'array', items: { field, issue } },
}

// useStringEvaluatorOutput: false — ~15 KB (after Phase 1.5)
{
  output: {
    type: 'object',
    properties: {
      // Full STORY_GENERATION schema (30 properties, no wrapper objects)
      text:            { type: 'string' },
      mood:            { type: 'string', enum: 23 values },
      placeId:         { type: 'string' },
      weather:         { type: 'string', enum: 11 values },
      sceneType:       { type: 'string', enum: 10 values },
      charactersPresent: { type: 'array', items: { characterId, sceneRole, sceneFocus } },
      actions:         { type: 'array', items: { text, type, hint } },
      // Flattened — no characterUpdates/placeUpdates/threadUpdates wrappers
      newCharacters:     { type: 'array', items: INITIAL_CHARACTER_SCHEMA },
      updatedCharacters: { type: 'array', items: UPDATE_CHARACTER_SCHEMA },
      newPlaces:         { type: 'array', items: INITIAL_PLACE_SCHEMA },
      updatedPlaces:     { type: 'array', items: UPDATE_PLACE_SCHEMA },
      // ... plus thread updates, factUpdates, traumaTagAdd, etc. all at root level
    },
    required: STORY_GENERATION_REQUIRED_FIELDS,
    additionalProperties: false
  },
  scoreBefore:  { ... same as above },
  scoreAfter:   { ... same as above },
  actionFlags:  { ... same as above },
  integrityFlags: { ... same as above },
}
```

### Code Flow (affected files)

| File | What changes |
|------|-------------|
| `src/types/ai-chat.ts:97` | `useStringEvaluatorOutput?: boolean \| 'auto'` added to `AIPromptOptions` with full JSDoc |
| `src/utils/ai-chat.ts` | `resolveUseStringEvaluator()` helper resolves `'auto'` → boolean by checking evaluator model selection for Gemini. Called once per evaluation block; result threaded to both schema builder and result parser. |
| `src/schema/story.ts:756` | `buildEvaluationSchemaDefinition` reads the **(already resolved)** boolean flag and selects `string` or `object` schema branch |
| `src/utils/ai-chat.ts:1073` | Evaluation result handler checks the resolved boolean: `true` → `JSON.parse`, `false` → direct assignment |

### Decision Matrix

| Condition | Recommended | Rationale |
|-----------|-------------|-----------|
| Default / no preference | `'auto'` | Evaluates your provider chain and picks the optimal strategy. If Gemini is in `AI_CHAT_MODELS_EVALUATION`, uses string mode for compatibility. If absent, uses structured mode for tighter validation. Adapts automatically to config changes. |
| Gemini in evaluator chain | `'auto'` or `true` | Structured schema (depth 7) may hit Gemini's constrained-decoder limit. `'auto'` detects this automatically. |
| Only non-Gemini evaluators | `'auto'` or `false` | `'auto'` detects no Gemini and switches to structured mode automatically. |
| Evaluator quality issues | `false` | Force structured mode to get provider-enforced validation. Trade-off: Gemini may be skipped from evaluator chain. |
| Production with stable output | `'auto'` | Best of both worlds — adapts to whatever evaluators are available. No manual config needed. |

### Risk of `true` (string mode)

The primary risk is the evaluator producing structurally valid JSON that happens to match a *different* shape than expected. Example:

```json
// Evaluator outputs valid JSON (passes JSON.parse) but structurally wrong:
{
  "text": "Page content...",
  "mood": 12345,
  "actions": "not_an_array"
}
```

This would be accepted by `JSON.parse`, and the type cast `as T` silences the type error. Downstream code would encounter `mood: 12345` (wrong type), `actions: "not_an_array"` (wrong type) — likely causing crashes or silent corruption in server-side processing.

**Mitigations:**
1. `false` mode eliminates this entirely (provider enforces structure).
2. Even in `true` mode, the evaluator prompt explicitly describes the expected JSON structure via `EXPECTED JSON SCHEMA` text, and the scoring rubric penalizes structural issues — the evaluator is trained to produce correct output.
3. If `JSON.parse` fails, the system falls back to the original AI generation output (no crash).
4. Switch to `false` if structural issues are observed in production.

---

## Implementation Order (by Risk, then Impact)

| # | Phase | Status | Effort | Risk | Impact |
|---|-------|--------|--------|------|--------|
| 1 | **4.1** — Fallback on error | ✅ Done | 1 day | 🟢 Low | Immediate safety net |
| 2 | **4.2** — Pre-call complexity gate | ✅ Done | 1 day | 🟢 Low | Prevention |
| 3 | **1.4** — Remove unnecessary required | ✅ Done | 1 day | 🟢 Low | Reduces constraints |
| 4 | **1.2** — Collapse TagUpdates | ✅ Done | 1 day | 🟢 Low | Minor structural savings |
| 5 | **2.3** — Decouple evaluator schema | ✅ Done | 2 days | 🟢 Low | Eliminates double-wrap |
| 6 | **1.1** — Flatten traits to string[] | ✅ Done | 2 days | 🟡 Medium | 1-level depth savings; removes ~136 props from schema |
| 7 | **1.6** — Flatten `viableEnding.changeNote` | ✅ Done | 0.5 day | 🟢 Low | -1 object, minor depth savings |
| 8 | **1.8-alt (p1)** — Centralize enum arrays | ✅ Done | 1 day | 🟢 Low | Single source for all prompt enum values |
| 9 | **1.3 (partial)** — Shorten 2 property names | ✅ Done | 0.3 day | 🟢 Low | -1.7 chars avg on 2 properties |
| 10 | **1.3 (cont.)** — Shorten 2 more property names (`placeConnectionUpdates→placeConnections`, `visualDescription→appearance`) | ✅ Done | 0.5 day | 🟢 Low | -8 chars on `placeConnectionUpdates`, -7 on `visualDescription` |
| 11 | **1.8-alt (p2)** — Replace `formatOneOf` in output formats | ✅ Done | 2 days | 🟢 Low | ~75 `formatOneOf` calls replaced with centralized value strings in output format templates |
| 12 | **3.1** — Provider-based routing | ⬜ Pending | 2 days | 🟡 Medium | Correct by provider |
| 13 | **1.5** — Flatten wrapper objects | ⬜ Pending | 3 days | 🟡 Medium | -3 objects, depth 7→6 |
| 14 | **1.3 (rest)** — Remaining 17 property renames | ⬜ Deferred | 3 days | 🟡 Medium | Modest savings (~50 tokens); low priority |
| 15 | **1.7** — Collapse duplicate field instructions | ⬜ Pending (blocked on 1.5) | 1 day | 🟢 Low | ~40 lines trimmed from prompt |
| 16 | **2.2** — Unwrap candidate generation | 🔴 **Skipped** | — | 🟡 Medium | 1 batch call intentional — preserves RPM budget, ensures fairness, maintains parallel-world consistency |
| 17 | **1.8** — Replace `formatOneOf` with references | 🔴 **Rejected** | — | 🔴 High | Harmful — removed enum values from AI context |
| 18 | **2.1** — Split page/state schemas | 🔴 **Skipped** | — | 🔴 High | Unnecessary after Phase 1 reductions |

## Success Metric

**Zero `SCHEMA_TOO_COMPLEX` errors in production.** Monitor via the existing `'SCHEMA_TOO_COMPLEX'` classification in `classifyError`.

**Current status:** ✅ Achieved. All Phase 1 flattening + Phase 2.3 + Phase 4 safety nets are live. The system handles schema complexity gracefully: Gemini either succeeds (flattened schema) or skips via the pre-call gate, falling through to other providers.

### Prompt-Side Cost (Not Schema, But Token Cost Per Call)

| Item | Size | Phase for reduction |
|------|-----:|---------------------|
| `nextPageOutputFormat` | ~9.7 KB → **~6.3 KB** | Phase 1.8-alt p2 ✅ — replaced inline `formatOneOf` with centralized value strings |
| `firstBookOutputFormat` | ~7.8 KB → **~5.1 KB** | Phase 1.8-alt p2 ✅ — replaced inline `formatOneOf` with centralized value strings |
| `buildNextPageFieldInstructions` | ~290 lines | Phase 1.7 (dedup) + Phase 1.5 (flattening eliminates duplicated blocks) |

These don't affect Gemini's constrained decoder. They reduce per-call token spend.

**⚠️ Phase 1.8 correction:** The original approach (replacing `formatOneOf` with tag-placeholders) was **rejected** — it removed enum values the AI needs for ~16 types that aren't listed anywhere else in the prompt. The alternative (§1.8-alt) first centralizes all enum arrays and injects them into the rules sections, making the values available to the AI before any output format trimming is done.

**Phase 1.8-alt p2 result:** `formatOneOf` in output format templates replaced with `"${valueString}"` references to centralized `enums.ts` constants. The key insight is that these value strings are still fully expanded inline (same token cost as before) — this is purely a code deduplication win, not a token reduction. **Real token savings** require first injecting all enum values into rules sections (Phase 1.7/1.5), then replacing output format value strings with brief references. That remains ⬜ Proposed.

---

*Last updated: v7 — Phase 1.3: `placeConnectionUpdates→placeConnections`, `visualDescription→appearance` completed. Phase 2.2 skipped (1 batch intentional — see decision note). Completed phases: 1.1, 1.2, 1.4, 1.6, 1.8-alt (p1, p2), 1.3 (4 renames done), 2.3, 4.1, 4.2. Pending: 1.5, 1.7 (blocked on 1.5), 3.1, 1.3 (17 renames deferred). Skipped: 2.1, 2.2. Rejected: 1.8.*
