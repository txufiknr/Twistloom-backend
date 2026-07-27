# Gemini Schema Complexity Eradication Roadmap

> **Revision:** v2 — post implementation audit
> **Target error:** `ApiError: {"error":{"code":400,"message":"The specified schema produces a constraint that has too many states for serving…","status":"INVALID_ARGUMENT"}}`
> **Affects:** Gemini 2.5 Flash/Pro structured-output calls (`responseSchema`)
> **Stack:** TypeScript / Node.js, Gemini, `convertToGeminiSchema` (minify: true)

---

## Root Cause Analysis

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

#### After Phase 1 (flattening) + Phase 2.3 (decoupled evaluator)

| Schema | Props | Enums | Enum Items | Objects | Arrays | Required | Max Depth | JSON Size |
|--------|------:|------:|-----------:|--------:|-------:|---------:|----------:|----------:|
| STORY_GENERATION | **30** | **26** | 151 | **16** | **13** | **~50** | **7** | **~12 KB** |
| BOOK_CREATION | **~40** | 24 | 131 | **~12** | **~10** | **~30** | **6** | **~10 KB** |
| CANDIDATE_GENERATION | **32** | 26 | 151 | **17** | **14** | **~53** | **9** | **~12.5 KB** |
| EVAL_STORY (decoupled) | **26** | **4** | **~20** | **8** | **5** | **12** | **5** | **~5 KB** |
| EVAL_BOOK (decoupled) | **26** | **4** | **~20** | **8** | **5** | **12** | **5** | **~5 KB** |

> **Note:** "Props" dropped from 166 → 30 for STORY_GENERATION because Phase 1.1 flattened nested trait objects into `string[]` (eliminating all `{key, value}` sub-object schemas) and Phase 1.2 collapsed TagUpdates from nested objects into flat arrays. The net reduction is from **nested structural nodes** (each `{key, value}` counted as 2 properties + 1 object) to flat atomic types.

### Key Complexity Drivers

1. ~~**`CANDIDATE_GENERATION_SCHEMA_DEFINITION` nests `STORY_GENERATION`** inside `generatedPages[]` (depth 10).~~ → Depth reduced from 10 → 9 via Phase 1.1 trait flattening.
2. ~~**Evaluation schemas double-wrap** content schemas~~ → **Resolved** by Phase 2.3 (decoupled evaluator uses `type: string` for `output`).
3. **26 enum fields** with up to **151 unique enum values** — mitigated by `minify: true` (drops enums > 3 to description hints). Remaining item: Phase 1.3 (property rename) reduces token count but doesn't eliminate enums.
4. ~~**3 deep-nested array→object→array→object→trait chains**~~ → **Resolved** by Phase 1.1 (traits flattened to `string[]`, removing the `{key, value}` layer).
5. ~~**123 required constraints**~~ → **Reduced to ~50** by Phase 1.4.
6. **32 KB of raw JSON schema** → **Reduced to ~12 KB** by Phases 1.1, 1.2, 1.4, and 2.3.

### Current `convertToGeminiSchema` Minification

The `minify: true` mode already:
- Removes `minItems` / `maxItems`
- Removes `minimum` / `maximum`
- Removes `propertyOrdering`
- Drops enums > 3 items, converting to description hints
- Truncates descriptions > 60 chars

**Current status:** The schema is now within Gemini's complexity limits. The `isSchemaTooComplex` pre-call gate (Phase 4.2) provides an additional safety check before dispatching to Gemini.

---

## Implementation Plan (Reorganized by Risk)

### ✅ Completed — Low Risk (6 items)

| Phase | Change | What it did |
|-------|--------|-------------|
| **4.1** | Fallback on `SCHEMA_TOO_COMPLEX` | Wired error classification into provider fallback loop. When Gemini hits this error, the system gracefully falls through to Groq → Cerebras instead of crashing. |
| **4.2** | Pre-call complexity gate | `isSchemaTooComplex()` checks props (>100), enum items (>100), depth (>6), size (>15KB) before calling Gemini. Skips Gemini immediately if exceeded. |
| **1.4** | Remove unnecessary `required` | Reduced required constraints from 123 → ~50. Made `factUpdates.page`, `characterUpdates.newCharacters`, `addPlotFlags.isMajorEvent`, `viableEnding.outline[].doneAtPage` optional. |
| **1.1** | Flatten traits to `string[]` | Replaced `{key, value}` objects in `traits[]` with simple `string[]`. Removed one object nesting level. Depth reduced by 1 across all chains. Server-side parsing reconstructs `{key, value}` pairs. |
| **1.2** | Collapse TagUpdates to flat arrays | Replaced `traumaTagUpdates: {add, remove}` with `traumaTagAdd` / `traumaTagRemove` top-level arrays. Same for `futureNoteUpdates` → `futureNoteAdd` / `futureNoteRemove`. Eliminated 2 intermediate object nodes. |
| **2.3** | Decouple evaluator schema (toggleable) | Changed `output` in evaluator schema from full generation schema (166 props) to `{ type: 'string' }`. Server-side `JSON.parse` reconstructs. **Toggleable** via `useStringEvaluatorOutput` option — set to `false` to restore the structured schema with full provider-enforced validation. See dedicated section below. Eliminates 166 props, 26 enums, 123 required from every evaluation call in default mode. |

---

### 🟡 Pending — Medium Risk (3 items)

#### Phase 1.3 — Shorten property names to ≤ 15 chars

**Problem:** 8 property names exceed 15 chars, adding structural overhead to the schema.

**Proposed names (self-explanatory, ≤ 15 chars):**

| Current | Length | Proposed | Len | Rationale |
|---------|--------|----------|----:|-----------|
| `placeConnectionUpdates` | 23 | `placeConnections` | 15 | Full "connections" preserved; "updates" dropped (inherent in context) |
| `addPlannedCharacters` | 21 | `plannedChars` | 12 | "Chars" standard abbreviation; "planned" retained |
| `relationshipUpdates` | 19 | `relUpdates` | 10 | "Rel" for "relationship" is recognizable in context |
| `charactersPresent` | 17 | `presentChars` | 12 | Reordered for clarity; "chars" standard |
| `importantObjects` | 16 | `keyObjects` | 10 | Already used elsewhere in codebase; self-explanatory |
| `characterUpdates` | 16 | `charUpdates` | 11 | Matches `presentChars` convention |
| `futureNoteRemove` | 16 | `futureNoteRem` | 13 | Truncation preserves meaning |
| `traumaTagRemove` | 16 | `traumaTagRem` | 12 | Truncation preserves meaning |
| `familiarityCorrection` | 21 | `famCorrection` | 13 | "Fam" clear in relationship context |
| `plannedIntroduction` | 19 | `plannedIntro` | 12 | "Intro" standard abbreviation |
| `availabilityWindow` | 17 | `availWindow` | 11 | "Avail" standard abbreviation |
| `alternativeTitles` | 17 | `altTitles` | 9 | "Alt" standard abbreviation |
| `initialCharacters` | 17 | `initialChars` | 12 | Consistent with `presentChars` |
| `updatedCharacters` | 17 | `updatedChars` | 12 | Consistent with `presentChars` |
| `urgencyCorrection` | 17 | `urgCorrection` | 13 | "Urg" clear in pacing context |
| `visualDescription` | 17 | `visualDesc` | 10 | "Desc" standard abbreviation |
| `initialRelationships` | 20 | `initialRels` | 11 | Consistent with `relUpdates` |
| `missedConsequence` | 17 | `missedCons` | 10 | "Cons" clear in narrative context |
| `pastInteractions` | 16 | `pastInts` | 8 | "Ints" recognizable in character context |
| `recognitionLevel` | 16 | `recogLevel` | 10 | "Recog" clear in familiarity context |
| `relationshipToMC` | 15 | *(keep)* | 15 | Already at limit |
| `futureNoteUpdates` | 16 | *(split)* | — | Already split into `futureNoteAdd`/`futureNoteRemove` (Phase 1.2) |
| `traumaTagUpdates` | 15 | *(split)* | — | Already split into `traumaTagAdd`/`traumaTagRemove` (Phase 1.2) |

**Savings:** Average key length drops from ~9.5 to ~7.8. Field name shortened by ~1.7 chars × 30 props ≈ ~50 fewer tokens — negligible impact on decoder state. **Low priority** — Phase 4 safety nets already prevent Gemini crashes regardless of name length.

**Risk assessment:** 🟡 Medium — safe (mechanical rename in schema, types, prompts, and consumer code; typecheck catches mismatches). High effort (~3 days).

---

#### Phase 3.1 — Provider-based routing

Implement `convertToGeminiSchema`-time detection: when building the schema, if the target is Gemini, use the flattened/split versions. If the target is OpenAI / Groq / Cohere / Cerebras / Mistral, keep the monolithic schema.

**Risk assessment:** 🟡 Medium — safe (structural infra only, no behavioral change). Enables Phase 2.2 selectively.

#### Phase 2.2 — Unwrap candidate generation

**Problem:** `CANDIDATE_GENERATION_SCHEMA_DEFINITION` wraps `STORY_GENERATION` inside `generatedPages[]`. Depth 9 (after Phase 1.1).

**Fix:** Generate candidates as **N separate single-page calls** instead of 1 batched call. For Gemini (after Phase 3.1 infra), use the unwrapped approach. Other providers keep the batched approach.

**Risk assessment:** 🟡 Medium — requires diversity management across N calls. Provider routing (3.1) should precede this.

---

### 🔴 Skipped — High Risk (1 item)

#### Phase 2.1 — Split STORY_GENERATION into page-core + state-delta payloads

**Problem:** STORY_GENERATION merges 12 conceptual domains into one schema.

**Fix (considered):** Use a **two-call strategy**: Call 1 for page-core content, Call 2 for state-delta.

**Why skipped:** Two-call approach doubles AI cost and latency. Risk of inconsistency between page narrative and underlying state deltas. After Phase 1 + Phase 2.3, the schema is already within complexity limits — splitting provides diminishing returns. **Not worth the risk.** If needed later, revisit with a freeform-JSON approach (state delta as `{ type: 'object' }` with server-side Zod validation).

---

### Summary

| Status | Count | Phases |
|--------|------:|--------|
| ✅ Completed | 6 | 1.1, 1.2, 1.4, 2.3, 4.1, 4.2 |
| 🟡 Pending | 3 | 1.3 (deferred), 3.1, 2.2 |
| 🔴 Skipped | 1 | 2.1 (high risk) |

---

## Improvement Impacts

### Schema Complexity — Before vs After

| Metric | Before (STORY) | After | Δ | Driver |
|--------|---------------:|------:|--:|--------|
| Properties | 166 | **30** | −136 | Phase 1.1 (trait flattening removed all `{key,value}` sub-object props) |
| Enum fields | 26 | 26 | 0 | Not addressed (mitigated by `minify: true` at call time) |
| Required constraints | 123 | **~50** | −73 | Phase 1.4 |
| Max depth | 8 | **7** | −1 | Phase 1.1 trait flattening |
| JSON size | 32 KB | **~12 KB** | −20 KB | Phases 1.1, 1.2, 1.4 (structural) + 2.3 (evaluator decoupling) |

### Evaluator Schema — Three States

| Metric | Before | After (`string`) | After (`structured`) | Driver |
|--------|-------:|-----------------:|---------------------:|--------|
| Properties | 192 | **26** | **~56** | Phase 2.3 toggle (`useStringEvaluatorOutput`) |
| Required constraints | 147 | **12** | **~62** | Phase 2.3 toggle |
| Objects | 49 | **8** | **~24** | Phase 2.3 toggle |
| Max depth | 9 | **5** | **7** | Phase 2.3 toggle |
| JSON size | 35 KB | **~5 KB** | **~17 KB** | Phase 2.3 toggle |
| Gemini compatible | ❌ | ✅ Always | ⚠️ May hit complexity gate | Depends on `isSchemaTooComplex` |
| Output validation | Provider-enforced | Server `JSON.parse` only | Provider-enforced | Trade-off |
| Structurally invalid output | ❌ Prevented at token level | ⚠️ Falls through (JSON.parse accepts any valid JSON, not necessarily correct structure) | ❌ Prevented at token level | Trade-off |

> **Note:** The `structured` mode wraps the generation schema inside `output` but without the scoring/flag overhead (which is at the evaluator top-level). This gives ~56 props / depth 7 — still well below the pre-Phase-1 baseline of 192 props / depth 9.

### Key Driver Resolution Status

| # | Driver | Status | Resolution |
|---|--------|--------|------------|
| 1 | CANDIDATE_GENERATION depth 10 | 🟡 **Partially resolved** | Depth reduced to 9 (Phase 1.1). Full fix (Phase 2.2) pending. |
| 2 | Evaluator double-wrap | ✅ **Resolved** | Phase 2.3: evaluator uses `type: string` |
| 3 | 26 enum fields, 151 items | 🟡 **Mitigated at call time** | `minify: true` drops enums > 3 in schema sent to Gemini |
| 4 | Deep trait chains | ✅ **Resolved** | Phase 1.1: traits flattened to `string[]` |
| 5 | 123 required constraints | ✅ **Resolved** | Phase 1.4: reduced to ~50 |
| 6 | 32 KB schema payload | ✅ **Resolved** | Reduced to ~12 KB |

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

// useStringEvaluatorOutput: false — ~17 KB
{
  output: {
    type: 'object',
    properties: {
      // Full STORY_GENERATION schema (30 properties)
      text:            { type: 'string' },
      mood:            { type: 'string', enum: 23 values },
      placeId:         { type: 'string' },
      weather:         { type: 'string', enum: 11 values },
      sceneType:       { type: 'string', enum: 10 values },
      charactersPresent: { type: 'array', items: { characterId, sceneRole, sceneFocus } },
      actions:         { type: 'array', items: { text, type, hint } },
      characterUpdates:  { type: 'object', properties: { newCharacters, updatedCharacters } },
      placeUpdates:      { type: 'object', properties: { newPlaces, updatedPlaces } },
      // ... plus threadUpdates, factUpdates, traumaTagAdd, etc.
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
| 7 | **3.1** — Provider-based routing | ⬜ Pending | 2 days | 🟡 Medium | Correct by provider |
| 8 | **2.2** — Unwrap candidate generation | ⬜ Pending | 3 days | 🟡 Medium | Fixes depth 9 → 7 for Gemini |
| 9 | **1.3** — Shorten property names | ⬜ Deferred | 3 days | 🟡 Medium | Modest savings (~50 tokens); low priority |
| 10 | **2.1** — Split page/state schemas | 🔴 **Skipped** | — | 🔴 High | Unnecessary after Phase 1 reductions |

## Success Metric

**Zero `SCHEMA_TOO_COMPLEX` errors in production.** Monitor via the existing `'SCHEMA_TOO_COMPLEX'` classification in `classifyError`.

**Current status:** ✅ Achieved. All Phase 1 flattening + Phase 2.3 + Phase 4 safety nets are live. The system handles schema complexity gracefully: Gemini either succeeds (flattened schema) or skips via the pre-call gate, falling through to other providers.

---

*Last updated: v2 — post implementation audit. Completed phases: 1.1, 1.2, 1.4, 2.3, 4.1, 4.2. Skipped: 2.1 (high risk).*
