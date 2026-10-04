# JSON Schema Key Compression Adoption Roadmap

> **Status:** Parked / Superseded (No-Go for Production Wire)  
> **Date:** 2026-10-03  
> **Owner:** Twistloom Backend  

---

## Architecture Decision Record (ADR): Wire Key Compression No-Go

> [!IMPORTANT]
> **Decision: DO NOT implement wire-level JSON schema key compression (`jsonschema-key-compression` or hand-authored dictionaries) for production LLM generation.**
>
> **Core Rationale:**
> 1. **Premise Verified as Inapplicable for Prompts:** Story state reaches LLMs as formatted Markdown/prose text (`formatCharactersForPrompt`, `formatPlacesForPrompt`, `formatFutureNotes`, etc.), **never as JSON keys**. Compressing JSON keys yields 0 prompt token reduction on world state context.
> 2. **Decoder Complexity Ineffectively Targeted by Key Compression (and Live Path Remains Single-Shot):** Multi-turn generation is currently dormant/disabled (`USE_MULTI_TURN_GENERATION = false` at `src/config/ai-chat.ts:17`). The active production path is single-shot `STORY_GENERATION_SCHEMA_DEFINITION` (37.9 KB, 303 props, 334 enum items, depth 6), which trips 3 of 4 `isSchemaTooComplex()` thresholds (`src/utils/ai-chat.ts:2021`). Even in multi-turn mode, Turn B (`STATE_DELTA_WITH_BRANCH_SCHEMA_DEFINITION`, 32.9 KB, 271 props, 252 enum items) also trips 3 thresholds (only Turn A passes at 4.9 KB, 32 props). Wire key compression does **not** solve constrained decoder state compilation because Google's state graph is bounded by combinatorial property cardinality, enum fan-out, and recursive nesting depth (e.g. depth 8 in candidate generation) — which key string abbreviation does not reduce. The real architectural path forward is structural flattening/renames (`GEMINI_SCHEMA_COMPLEXITY_ROADMAP.md` Phase 1.3) and provider fallback gating (`isSchemaTooComplex()`), not wire key compression.
> 3. **Model Adherence & Reasoning Regression Risk:** LLMs are pre-trained on semantic English keys (`actions`, `sceneRole`, `minutesPassed`). Forcing opaque single-letter keys (`|a`, `|b`) degrades model reasoning and adherence, while requiring complex synchronization between the prompt echo, descriptions, and post-generation decompression. Compounding this, `convertToGeminiSchema` minification drops descriptions over 60 characters (`src/utils/gemini.ts:530`), rendering opaque fields uninterpretable to the model.
> 4. **Database Compression Ruled Out:** Ruled out due to alphabetical alias drift (adding an earlier property shifts all aliases, corrupting historical persisted rows), lack of physical savings due to PostgreSQL TOAST/JSONB decomposition, and destruction of SQL `->>` queryability.
> 5. **Diagnostic Utility (Offline Concept):** Step 2 (`scripts/bench-key-compression.ts`) was evaluated as an uncommitted offline research concept (never created in the repository). All wire-up steps (Steps 4–7) are permanently rejected.
 
---
 
## 1. Summary Table
 
| # | Item | Priority | Status |
|---|------|----------|--------|
| 1 | Codebase examination & premise verification (prompt / Gemini / DB surfaces) | `P0` | ✅ Completed |
| 2 | Baseline benchmark harness for schema representations (`scripts/bench-key-compression.ts`) | `P3` | ⏩ Skipped (Uncommitted concept) |
| 3 | Prompt-surface token attribution audit | `P3` | ⏩ Skipped (Prose verified) |
| 4 | Key-compression module (stable hand-authored dictionary) | `P1` | ❌ Rejected / Parked |
| 5 | Gemini-boundary wire-up behind feature flag | `P1` | ❌ Rejected / Parked |
| 6 | Output-format echo & description preservation in compressed mode | `P1` | ❌ Rejected / Parked |
| 7 | Quality/adherence A/B evaluation and go/no-go | `P1` | ❌ Rejected / Parked |
| 8 | DB storage adoption (compression of `stateDelta` / `storyStates`) | `P2` | ⏩ Skipped |
| 9 | Offline IndexedDB codec (future client-side persistence) | `P2` | ⏩ Skipped |
| 10 | Doc sync with `GEMINI_SCHEMA_COMPLEXITY_ROADMAP.md` (§1.3 renames) | `P2` | ✅ Completed |

---

## 2. Problem Statement

### Current State

Three separate surfaces were examined against the premise in `TODO-jsonschema-key-compression.md` (adopt `jsonschema-key-compression` to cut prompt tokens, relieve Gemini "too many states for serving" errors, and shrink DB storage):

1. **Prompt surface — story state is rendered as prose, not JSON.** State sections reaching the model are produced by text formatters: `formatCharactersForPrompt` (`src/utils/characters.ts:437`), `formatPlacesForPrompt` (`src/utils/places.ts:336`), `formatFutureNotes` (`src/utils/prompt.ts:2473`), `formatActiveThreads` (`src/utils/prompt.ts:2909`), `formatCurrentFacts` (`src/utils/prompt.ts:4298`), `formatHiddenState` (`src/utils/prompt.ts:4355`), plus `buildBookMetaDocuments` (`src/services/book.ts:2654`). None of these emit `StoryState` / `StateDelta` property names. The only JSON keys that reach the prompt are the **output-contract templates** appended to the system prompt — `firstBookOutputFormat` (`src/utils/prompt.ts:563`), `nextPageOutputFormat` (`src/utils/prompt.ts:737`), `storyPageOutputFormat` (`src/utils/prompt.ts:965`), `stateDeltaOutputFormat` (`src/utils/prompt.ts:1003`) — attached as `EXPECTED OUTPUT JSON FORMAT` by `shouldAppendOutputFormat` (`src/utils/ai-chat.ts:1586-1594`), plus the ~280-line field-instructions block prepended in `executePromptForJSON` (`src/utils/prompt.ts:6124-6168`).

2. **Gemini surface — constrained decoder complexity is driven by structure, not key string lengths.** Definitions live in `src/schema/story.ts` (`STORY_PAGE_SCHEMA_DEFINITION:759`, `STATE_DELTA_SCHEMA_DEFINITION:763`, `STATE_DELTA_WITH_BRANCH_SCHEMA_DEFINITION:781`, `STORY_GENERATION_SCHEMA_DEFINITION:806`, `CANDIDATE_GENERATION_SCHEMA_DEFINITION:821`). The live production path is single-shot generation (`USE_MULTI_TURN_GENERATION = false` at `src/config/ai-chat.ts:17`). Running the empirical `isSchemaTooComplex()` check (`src/utils/ai-chat.ts:2021` with `MAX_SCHEMA_LENGTH = 30_000` at `src/config/ai-chat.ts:6`):
   - `STORY_GENERATION_SCHEMA_DEFINITION` (live single-shot): **37.0 KB (37,915 chars), 303 total props, 334 enum items, depth 6** → trips 3 thresholds (`props > 100`, `enumItems > 100`, `size > 30_000`).
   - `STATE_DELTA_WITH_BRANCH_SCHEMA_DEFINITION` (Turn B): **32.2 KB (32,947 chars), 271 total props, 252 enum items, depth 6** → also trips 3 thresholds (`props > 100`, `enumItems > 100`, `size > 30_000`).
   - `CANDIDATE_GENERATION_SCHEMA_DEFINITION` (multiverse single-shot): **37.4 KB (38,260 chars), 305 total props, 334 enum items, depth 8** → trips all 4 thresholds (including `maxDepth > 6`).
   - `STORY_PAGE_SCHEMA_DEFINITION` (Turn A): **4.9 KB (4,969 chars), 32 total props (14 root), 82 enum items, depth 4** → passes all thresholds.
   Because Gemini's decoder compiler explodes on combinatorial state fan-out (props × enums × depth), shortening key strings does not alter the state graph. Multi-turn splitting only resolves Turn A; Turn B and legacy single-shot remain complex until structural flattening occurs.

3. **DB surface — opaque text bytes vs physical JSONB bytes.** `pages.stateDelta` is `jsonb("delta")` (`src/db/schema.ts:99`), `pageGenerationCheckpoints.storyPageJson` is `jsonb` (`src/db/schema.ts:216`), and `storyStates` carries **17 JSONB columns** (`src/db/schema.ts:281-303`, noting `traumaTags` is a `text[]` array). Branch traversal already stores incremental deltas instead of full state (`src/utils/branch-traversal.ts:730`), and JSONB is TOAST-compressed with pglz/lz4.

### Pain Points & Findings

1. **The headline premise is false:** shortening JSON keys cannot reduce state-section prompt tokens, because no JSON keys of story state exist in those sections. Expected prompt-side savings are confined to the output-format echo and field instructions — saving at most a trivial fraction of tokens.
2. **Gemini 'too many states for serving' is not solved by key compression:** Both the active single-shot schema (37.9 KB, 303 props) and Turn B (32.9 KB, 271 props) trip `isSchemaTooComplex()`. Key compression does not reduce structural depth, enum fan-out, or property cardinality, which are the true drivers of Google's constrained decoder state compilation. Relying on key compression to fix decoder crashes is technically ineffective.
3. **Severe model adherence degradation:** LLMs are pre-trained on semantic key names. Forcing single-letter opaque aliases destroys semantic association, forcing complete reliance on descriptions. In addition, `convertToGeminiSchema` minification drops descriptions over 60 characters (`src/utils/gemini.ts:530-541`), compounding the risk of empty or malformed fields.
4. **Alphabetical alias drift corrupts persisted storage:** `jsonschema-key-compression` assigns aliases by sorting schema keys alphabetically. Adding a new property alphabetically shifts existing aliases, making previously stored JSONB data unreadable.

### Goal

Formally document the evaluation of JSON Schema Key Compression, reject wire-level and storage-level adoption, and direct architectural focus toward clean property renames in `GEMINI_SCHEMA_COMPLEXITY_ROADMAP.md` §1.3.

---

## 3. Intended Design & Alternatives

### Design Alternatives

#### Alternative A: Global adoption (schema + prompts + DB)
- **Status:** ❌ Rejected
- **Rationale:** Premise fails for prose state prompts; library assigns aliases in alphabetical order, breaking historical database rows; breaks SQL `->>` queries, Drizzle `$type<>` contracts, and debugging.

#### Alternative B: Gemini-boundary adapter only
- **Status:** ❌ Rejected / Parked
- **Rationale:** Adds unnecessary translation seams, risk of parse/repair failures, and generation quality degradation. Since key compression does not reduce property cardinality or nesting depth, it adds technical debt without solving constrained decoder state complexity.

#### Alternative C: Diagnostic Benchmark Harness (Step 2)
- **Status:** ⏩ Skipped (Uncommitted concept)
- **Rationale:** An offline research script (`scripts/bench-key-compression.ts`) was discussed to measure raw token counts, but was never checked into the repository because the prompt premise (prose formatters) already proved zero state prompt savings.

---

## 4. Feasibility & Risk Analysis

| Dimension | Assessment |
|-----------|------------|
| **Effort** | 5–7 days for full wire implementation (wasted effort without structural simplification) |
| **Risk** | **High** — model adherence regressions, hallucinated or dropped optional fields due to loss of semantic keys and 60-char description truncation |
| **Value** | **Near Zero** — key compression does not reduce decoder state space for single-shot (303 props) or Turn B (271 props), nor can it fix depth 8 in candidate generation |
| **Recommendation** | **No-Go** — park the initiative and do not deploy to production |

---

## 5. Implementation Status of Steps

### Step 1: Codebase examination & premise verification — ✅ Completed
- Verified that story state reaches prompts as prose formatters, not JSON keys.
- Confirmed that single-shot (303 props) and Turn B (271 props) schemas trip complexity thresholds due to property/enum cardinality, which key compression cannot mitigate.
- Confirmed that DB compression causes alias drift and breaks SQL JSONB queries.

### Step 2: Diagnostic benchmark harness — ⏩ Skipped (Uncommitted concept)
- **File:** `scripts/bench-key-compression.ts` (Never created)
- Evaluated as an optional diagnostic concept; skipped since the prose prompt formatters already proved zero token savings on story state.

### Steps 3–7: Wire-up, Echo Regeneration & A/B Evaluation — ❌ Rejected / Parked
- Production wire compression is formally parked. No runtime shims or feature flags (`GEMINI_SCHEMA_KEY_COMPRESSION`) will be added to the hot generation path.

### Steps 8–9: DB Storage & Offline IndexedDB — ⏩ Skipped
- Skipped per ADR rationale.

### Step 10: Doc sync with `GEMINI_SCHEMA_COMPLEXITY_ROADMAP.md` — ✅ Completed
- Cross-referenced this roadmap in §1.3 of `GEMINI_SCHEMA_COMPLEXITY_ROADMAP.md`.
- Reaffirmed that clean, semantic property renames (e.g. `placeConnectionUpdates` → `placeConnections`) remain the preferred optimization because they preserve model comprehension without obfuscating keys.

---

## 6. Completion Status

Legend: ✅ Implemented & verified · ❌ Rejected / Parked · ⏩ Deferred / Skipped · ⬜ Future work

### Completed
- ✅ Step 1 — Codebase examination across prompt, Gemini, and DB surfaces; premise disproved.
- ✅ Step 10 — Cross-reference documented in `GEMINI_SCHEMA_COMPLEXITY_ROADMAP.md` §1.3.

### Parked / Rejected (No-Go)
- ❌ Step 4 — Compression module (`src/utils/gemini-schema-compress.ts`).
- ❌ Step 5 — Gemini-boundary wire-up.
- ❌ Step 6 — Output-format echo & description preservation.
- ❌ Step 7 — Quality/adherence A/B evaluation.

### Skipped / Uncommitted
- ⏩ Step 2 — Diagnostic benchmark script (uncommitted concept, never checked in).
- ⏩ Step 3 — Prompt-surface token attribution audit.
- ⏩ Step 8 — DB storage adoption.
- ⏩ Step 9 — Offline IndexedDB codec.
