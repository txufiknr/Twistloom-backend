# Twistloom — Diffusion-LLM & Token-Saving Execution Roadmap (Code-Grounded)

**Date:** August 13, 2026
**Scope:** Merges two prior fact-check docs — `AI_DIFFUSION_LLM_ROADMAP.md` (Inception Labs Mercury, DeepInfra, HF Inference, diffusion-for-fiction trade-offs) and `AI_TOKEN_SAVING_ROADMAP.md` (Wexa, Helicone/Portkey, Gemini explicit-cache economics, exact-match page cache) — into a single, **code-grounded execution plan**. Every feasibility verdict below was verified against the actual source in `src/utils/ai-chat.ts`, `src/utils/ai-chat-stream.ts`, `src/utils/ai-parser.ts`, `src/utils/gemini.ts`, `src/utils/ai-limiters.ts`, `src/utils/ai-cost.ts`, `src/utils/ai-clients.ts`, `src/config/ai-clients.ts`, `src/services/book.ts`, `src/utils/candidate-generation.ts`, and `src/utils/prompt.ts`.

> **How to read this doc.** Part 0 = the honest feasibility assessment. Part 1 = what already exists in your code (so proposals don't re-build existing machinery). Parts 2–4 = the ordered, step-by-step plan with `file:line` references and concrete patch snippets. Part 5 = everything that is *not* feasible / *paid* / *not recommended*, with pros & cons. Part 6 = decisions I need from you before starting.

---

## ✅ Implementation Status (at a glance)

| Status | Item | Effort | Impact (before → after) | Files changed |
|---|---|---|---|---|
| ✅ **DONE** | **Step 1 — Mistral `prompt_cache_key`** (90%-off cache hits) | ~8 lines | **Before:** Mistral requests carried no cache key → every call billed full input price, no cache-hit discount. **After:** `promptCacheKey` derived from the *same `cachedContentId`* as Gemini's explicit cache → repeated prefixes (same book system-prompt + docs) are served at Mistral's discounted cache-hit rate, busting in lockstep with characters/places changes | `src/utils/ai-chat.ts`, `src/utils/ai-chat-stream.ts` |
| ✅ **DONE** | **Step 2 — Per-book usage attribution** (bookId-tagged `context`) | 2 lines + 1 script | **Before:** `usage` contexts were static `'story-page-candidate'`/`'story-page-candidates'` → per-book cache economics & provider repair-rate unanswerable. **After:** contexts carry `:b-{bookId}` → every page-generation row is attributable to a book, enabling the Step-2b economics report | `src/utils/prompt.ts`, package.json |
| ✅ **DONE** | **Step 2b — Cache-economics dev report** | 1 script + 1 npm script | **Before:** no way to see "is explicit caching paying for this book?" **After:** `bun run dev:usage-cache-report` aggregates last-7-days `usage` per book/provider/model with cache-hit ratio + est. USD, flagging low-hit (opt-out) candidates | `src/cron/usage-cache-report.ts`, package.json |
| ✅ **DONE** | **Step 3 — Schema-adherence counters** in `parseAISafely` | ~45 lines | **Before:** repair-pipeline outcomes were logged but not tallied → "diffusion has better JSON adherence" was untestable. **After:** `getParseAdherenceStats()` exposes per-provider `total/clean/repaired/repairRate`; `resetParseAdherenceStats()` enables clean harness runs | `src/utils/ai-parser.ts` |
| ⏩ **DEFERRED** | **Step 7 — Gemini Interactions dispatch** | — | **Verified 2026-08:** explicit caching + `top_p`/`top_k` unsupported → no dispatch work. Keep `generateContent`; re-verify when Google ships both | — |
| ✅ **DONE** | **Steps 4+5 — adherence harness + Inception provider wiring** | medium | **Harness (Step 4):** `tests/test-diffusion-adherence.ts` — Tier A parse-adherence per provider (`repairRate` via `getParseAdherenceStats()`) + Tier B continuity probe; current-provider baseline not yet recorded (operator run pending). **Provider (Step 5):** `inception` wired across all 8 layers with **confirmed** baseURL `https://api.inceptionlabs.ai/v1` + slug `mercury-coder-small`; sits in new `AI_CHAT_MODELS_DIFFUSION`, **inert** in the waterfall | 8 files + `tests/test-diffusion-adherence.ts` + `.env.example` |
| ⏳ **BLOCKED (needs operator)** | Step 6 — run the trial against Inception, make the call | medium | `INCEPTION_API_KEY` → `.env`, then `bun tests/test-diffusion-adherence.ts` + manual Tier B on a scratch book; then promote into `AI_CHAT_MODELS_WRITING` or keep for IDEA/THEME | — |

**Quality gates:** `bun run typecheck` ✅ · `bun run lint:fast` ✅ · `bun run lint:imports` ✅ (post-change)

---

## Part 0 — Feasibility Assessment (the short version)

| # | Proposal (from either source doc) | Verdict grounded on code | Effort | Blocks on |
|---|---|---|---|---|
| A | **Mistral `prompt_cache_key`** for 90%-off cache hits | ✅ **DONE (Step 1).** SDK's public field is `promptCacheKey` (serialised to wire `prompt_cache_key`), derived from `cachedContentId` | ~8 lines | nothing |
| B | **Schema-adherence measurement** (diffusion doc's Phase 0 test) | ✅ **DONE (Step 3).** `getParseAdherenceStats()`/`resetParseAdherenceStats()` in ai-parser.ts tally clean vs repaired per provider | ~45 lines | nothing |
| C | **Per-book Gemini cache economics** (storage fee vs read savings) | ✅ **DONE (Steps 2 + 2b).** `usage.context` now tagged `story-page-candidate:b-{bookId}`; `dev:usage-cache-report` script computes per-book cache-hit ratios | 2 lines + 1 script | decision (Q5) |
| D | **Gemini explicit-cache TTL / per-book opt-out** (80% of a problem, 20% of the work) | ✅ **Feasible now.** `GEMINI_CACHE_TTL_SECONDS` is a hardcoded 3600 (gemini.ts:61); `getOrCreateGeminiCache` gets a null fast-path change | ~15 lines | none (decision on default) |
| E | **Wire the Gemini Interactions API dispatch** (already fully implemented, parked) | ⏩ **Defer — confirmed blocker, not a doc-gap.** `geminiPromptViaInteractions` + `geminiStreamGeneratorViaInteractions` exist and are exported but not dispatched (ai-chat.ts:596, ai-chat-stream.ts:652). **Both limiting conditions are now confirmed in Google's current docs (verified 2026-08):** (1) *explicit caching is not supported* — the exact `cachedContentId` → `getOrCreateGeminiCache` mechanism Twistloom relies on for per-book static-prefix cost savings has no Interactions equivalent (only stateful `previous_interaction_id` implicit caching, incompatible with single-shot serverless generation); (2) *granular sampling is unavailable* — the current docs' `generation_config` mentions `temperature` generically, but `top_p`/`top_k` (used by `AI_CHAT_CONFIG_CREATIVE`, temp 0.78/topP 0.92/topK 50, src/config/ai-chat.ts:58–69) are not documented, so prose-variety control is only partially expressible. Hold; re-verify when Google ships both | ~10 lines | Google ships explicit caching + top_p/top_k on Interactions |
| F | **Add Inception Mercury as a 20th provider** | ✅ **DONE (Step 5, 2026-08-13).** `inception` wired across all 8 files into `AI_CHAT_MODELS_DIFFUSION` (inert). base URL + `mercury-coder-small` slug confirmed from Inception's platform docs | medium | trial verdict (Step 6) |
| G | **Run the diffusion trial (adherence + continuity) on that provider** | ⏳ **Harness ready (Step 4) + F wired; blocked** on an `INCEPTION_API_KEY` + a scratch book. Record remaining/current-provider baselines first | medium | operator (Step 6) |
| H | **DeepInfra as paid fallback rung** | ⚠️ **Feasible technically, breaks the waterfall's "all-free" design.** Same OpenAI-compatible slot-in, but it's a conscious paid-reliability decision, not a free addition | small (code) | decision (budget) |
| I | **Exact-match page cache** `hash(bookId+state+choice+model)` (from token doc Part 4) | ❌ **Largely redundant in your architecture.** `generateCandidatePage` already pre-generates + *reuses* existing destination pages, and `determineBranchIdForPage` enforces `ACTION_ALREADY_HAS_DESTINATION` idempotency (prompt.ts:4377, candidate-generation.ts:484–548). Within a book, pages are never regenerated for an existing action. **A cross-book exact-match cache is near-useless** because each book has its own branching state | build | — (rejected unless a shared-book mode appears) |
| J | **Helicone / Portkey gateways for caching** | ❌ **Rejected.** Solves a problem (I) that doesn't exist in this architecture; adds a request-path dependency + free-tier ceilings (10K req/mo each). Only their *observability* story is interesting → folded into Future/To-Consider (Cloudflare AI Gateway) | — | —
| K | **HF Inference API as a fallback** | ❌ **Rejected.** Corrected free tier is $0.10/mo credit (not "100K req/mo" as claimed) + cold starts; integration cost not worth it | — | —
| L | **DiffusionGemma / self-hosted diffusion** | ❌ **Rejected.** Download-and-run, needs your own GPU (H100-class / ~18GB VRAM); no API. Orthogonal to a serverless Vercel platform | — | —
| M | **Wexa** | ❌ **Rejected.** Wrong product category (AI-coworker platform, not a prompt-token SDK) | — | —
| N | **Graph-RAG memory compression (LlamaIndex/pgvector)** | ⏸ **Defer until a real pain point.** You already pass structured JSON state (not prose recaps); pgvector already exists for semantic memory | exploratory | traffic evidence |
| O | **NVIDIA structured output via `extra_body.nvext`** | ⏸ **Not available on hosted API** (confirmed in code comments, ai-chat.ts:1022–1036). Only possible on self-hosted NIM → Future | — | —

**Bottom line:** everything that is *free*, *zero-risk*, and *high-confidence* is in Phase 0 (steps 1–3). The genuinely new capability (diffusion provider) is one mechanical provider-add (Phase 1) + a measurement harness that exists to settle the only real open question.

---

## Part 1 — What the Codebase Already Has (so we don't re-build it)

- **Uniform OpenAI-compatible provider factory.** `createOpenAICompatiblePrompt` (ai-chat.ts:200) and `createOpenAICompatibleStreamGenerator` (ai-chat-stream.ts:391) exist precisely so a new OpenAI-compatible provider is a ~1-line call, not a copy-paste. `openrouter` + `cloudflare` are the two live examples.
- **Provider waterfall** (`aiPrompt`, ai-chat.ts:1126) with per-provider prompt-length gate (`AI_MAX_PROMPT_LENGTH`), daily budget gate (`canUseAIToday`), per-model retry/backoff, model fallback, provider fallback, and one `switch` that maps provider → prompt fn (ai-chat.ts:1220–1229). Streaming has the same switch (ai-chat-stream.ts:206–215).
- **Structured output everywhere.** `response_format: json_schema` (OpenAI-compat), Gemini via `convertToGeminiSchema`, plus `isSchemaTooComplex` pre-gating for Gemini (ai-chat.ts:1214, 1398). **This is exactly what makes the diffusion doc's "schema adherence" a *measurable* claim** — see Step 3.
- **Gemini explicit-cache infrastructure** (gemini.ts): L1 map + L2 Redis entry store, per-book reverse index, orphan cleanup, `GEMINI_CACHE_TTL_SECONDS = 3600`, `GEMINI_CACHE_MIN_CHARS = 8000` guard. Callers pass `cachedContentId` + auto-create (ai-chat.ts:327, ai-chat-stream.ts:487).
- **9-stage JSON repair pipeline** (src/utils/ai-parser.ts) + `ai-token-repair.ts` — the existing instrumentation point for adherence stats.
- **Token/cost telemetry**: `usage` table (per-day aggregate: requests, input/output/total/cached tokens, duration, context), `incrementDailyUsageCount`, `ai-cost.ts` (USD estimators + `checkDailyCostSpike`), `prompt-telemetry.ts` (TTFT + cache-hit-rate logging).
- **Per-action candidate pre-generation + reuse** (`generateCandidatePage`), with idempotency via `determineBranchIdForPage`'s `ACTION_ALREADY_HAS_DESTINATION` (prompt.ts:4377, candidate-generation.ts:484–548). This is why the "exact-match page cache" is redundant (see I above).
- **`geminiPromptViaInteractions` / `geminiStreamGeneratorViaInteractions`** fully implemented + exported, deliberately un-wired. Verified 2026-08 against current Google docs: **explicit caching is not supported** on Interactions (confirms the ai-chat.ts:296–299 comment), so the `cachedContentId` per-book prefix-cache path stays on `generateContent`. `temperature` is mentioned generically in the current `generation_config` docs; `top_p`/`top_k` are not — so granular sample control remains a `generateContent`-only feature.

---

## Part 2 — Phase 0: Free, zero-risk, do this first

Everything here is safe to ship with no behavior change to users and no new vendor.

### Step 1 — Enable Mistral prompt caching (`prompt_cache_key`)

**Goal:** unlock Mistral's cache-hit discount (90%-off cached input tokens per the token-savings doc) on the Mistral-rung calls that already flow through `mistralPrompt` / `mistralStreamGenerator`.

**Verified against installed SDK:** `@mistralai/mistralai@2.2.5` exposes `promptCacheKey?: string | null` on both `ChatCompletionRequest` and `ChatCompletionStreamRequest` (camelCase public property, serialised to the wire field `prompt_cache_key` — see `chatcompletionrequest.js`'s `promptCacheKey: "prompt_cache_key"` mapping).

**Change 1a — `src/utils/ai-chat.ts` → `mistralPrompt`** (request body at lines 912–938). Derive the key from the **same `cachedContentId`** `buildBookMetaDocuments` computes (book.ts:2160) — it is already threaded through `opts` (`AIPromptOptions.cachedContentId`), but `mistralPrompt` currently doesn't destructure it. This is exactly the Gemini pattern (gemini.ts:229) and is *better* than a constant: whenever characters/places change and `cachedContentId` changes, the Mistral key changes in lockstep with the prefix content, so the cache-bust semantics are identical to the Gemini cache.

> ✅ **DONE (2026-08-13).** This change is implemented — see the top status table.

```diff
-      const { config = AI_CHAT_CONFIG_DEFAULT, context, outputAsJson, outputJsonStructure, outputJsonRequired } = opts;
+      const { config = AI_CHAT_CONFIG_DEFAULT, context, outputAsJson, outputJsonStructure, outputJsonRequired, cachedContentId } = opts;
       const { maxOutputToken, temperature, topP, stopSequences, frequencyPenalty, seed } = config;
       const systemPromptWithDocuments = formatSystemPromptWithDocuments('mistral', opts);

       return await getMistralClient().chat.complete({
         model,
         messages: [
           { role: 'system', content: systemPromptWithDocuments },
           { role: 'user', content: prompt },
         ],
         maxTokens: getMaxOutputToken('mistral', model, maxOutputToken),
         temperature,
         topP,
         stop: stopSequences,
         frequencyPenalty,
         randomSeed: seed,
         stream: false,
+        // Cache key mirrors Gemini's cachedContentId so the Mistral prefix
+        // cache and the Gemini explicit cache bust on the same content change
+        // (characters/places). Fall back to a shared key for callers that
+        // don't pass cachedContentId (pen.ts, canon-validation.ts, etc.).
+        promptCacheKey: cachedContentId
+          ? `twistloom:mistral:${cachedContentId}`
+          : 'twistloom:mistral:shared',
         responseFormat: outputAsJson ? (outputJsonStructure ? {
```

**Change 1b — `src/utils/ai-chat-stream.ts` → `mistralStreamGenerator`** (request body at lines 827–853). Same addition after `stream: true` (line 839), and add `cachedContentId` to the destructure at line 822 (`const { signal, config, …, cachedContentId } = options;`).

```diff
         maxTokens: getMaxOutputToken('mistral', model, maxOutputToken),
         temperature,
         topP,
         stop: stopSequences,
         frequencyPenalty,
         randomSeed: seed,
         stream: true,
+        promptCacheKey: cachedContentId
+          ? `twistloom:mistral:${cachedContentId}`
+          : 'twistloom:mistral:shared',
         responseFormat: outputAsJson ? (outputJsonStructure ? {
```

**Why `cachedContentId` and not a constant:** Mistral caches the *prefix* (system prompt + docs). `cachedContentId` is already the content fingerprint for that exact prefix (book.id + characters + plannedCharacters + places, book.ts:2160–2165) — the same signal that drives Gemini's explicit cache. Using it means:
- same content ↔ same key (cache hits fire),
- content changed ↔ key changed (no stale/served-from-wrong-prefix hits), a self-invalidating key with zero bookkeeping,
- identical lifecycle to `getOrCreateGeminiCache`, so there's exactly one "when does the prefix change" truth in the codebase.

The static `'shared'` fallback exists only because not every `aiPrompt` caller passes `cachedContentId` (e.g. `pen.ts:477`, `canon-validation.ts:404`, custom-action validation in `books.ts:5616`); those are one-shot calls where cache value is low anyway.

**Verify** (before productionising): (1) Mistral only discounts cache hits for prefixes they actually cached — check the returned `usage.prompt_tokens_details.cached_tokens` field for non-zero values after shipping; (2) confirm the discount figure against mistral.ai/pricing in the same pass (the 90% claim comes from the source doc, not from Mistral's site); (3) confirm the `promptCacheKey`-prefixed/namespaced key doesn't collide with plain `cachedContentId` use elsewhere — the `twistloom:mistral:` prefix guarantees that.

**Sign-off:** `bun run typecheck` ✅; lint+imports ✅. Real validation requires one live request and reading usage — do it in Step 4's harness or `bun run dev:usage-cache-report`.

### Step 2 — Per-book cache & schema observability via the `usage` context

**Goal:** make the two questions in `TOKEN_SAVING_ROADMAP` Part 3 answerable — "is Gemini explicit caching paying for this book?" and "which providers need the repair pipeline?" — without any DB migration yet.

The `usage` table stores a `context` string (schema.ts:758–768). Today the page-generation contexts are static strings `'story-page-candidate'` / `'story-page-candidates'` (prompt.ts:4636, 4784), so nothing is attributable to a book. **Zero-migration fix: tag the context with the bookId.**

**Change 2a — `src/utils/prompt.ts`.**
- Line 4636 (`generateNextPage` path), change:
  `context: 'story-page-candidate',` → `` context: `story-page-candidate:b-${book.id}`, `` (book is in scope in both functions)
- Line 4784 (`generateNextPages` path):
  `context: 'story-page-candidates',` → `` context: `story-page-candidates:b-${book.id}`, ``

> ✅ **DONE (2026-08-13).** Both context strings are tagged; the script is `src/cron/usage-cache-report.ts` wired as `dev:usage-cache-report`.

This flows straight through `aiPrompt` → `promptWithFallback` → `incrementDailyUsageCount(provider, options.context ?? 'ai-prompt', …)` (ai-chat.ts:122) and the stream path (ai-chat-stream.ts:339). The `context` column then gives you, per bookId:
- request counts and `cached_tokens` ratios → Gemini cache storage-vs-savings answer
- which provider/model generated (already there: `provider`, `model` columns)

> ⚠️ **Caveat:** Gemini's **implicit** (automatic) caching and your **explicit** caching for the same content are mutually exclusive as a source of savings — the token doc explicitly flags this. After tagging, run both a book that hits `getOrCreateGeminiCache` and one that doesn't and compare the `cached_tokens`/`input_tokens` ratio before deciding per-book policy in Phase 2.

**Change 2b — cache-economic report.** Add a small dev command under `package.json` scripts (see Part 4, "Cheap, self-contained build #2") rather than a serverless route. Query:

```sql
SELECT context, provider, model, requests, total_tokens, cached_tokens
FROM "usage"
WHERE context LIKE 'story-page-candidate:%' AND date >= CURRENT_DATE - 7
ORDER BY total_tokens DESC;
```

Interpretation rule (from TOKEN_SAVING_ROADMAP Part 3): a gemini row whose `cached_tokens / total_tokens` ratio is low *and* whose request count is low is a candidate for explicit-cache opt-out (Step 5c) — the $1.00/1M/hr Flash storage fee eats the day even when nothing reads the cache.

**Sign-off:** `bun run db:test` (connection) + the SQL above run in Drizzle Studio (`bun db:studio`), or `bun run dev:usage-cache-report` which runs the equivalent aggregation.

> ✅ **DONE (2026-08-13).** The report script exists; live traffic + `dev:usage-cache-report` is the remaining verification.

### Step 3 — Schema-adherence counters in `parseAISafely` (the diffusion doc's Phase-0 instrument)

**Goal:** turn "diffusion has better JSON adherence" from a hypothesis into a measured, per-provider number — without building anything new. The 9-stage pipeline already logs which stage succeeds (ai-parser.ts:337, 350, 371, 397, …). We just tally it, keyed by provider, and export a getter.

**Change 3 — `src/utils/ai-parser.ts`.**
Add counters near the `walkerCache` (line 153):

```diff
 const walkerCache = new Map<string, Promise<SchemaWalker>>();

+/**
+ * Schema-adherence counters keyed by `logContext` (format: `<provider>-<context>`).
+ * "clean"  = parsed by stages 1–2 (no repair needed).
+ * "repaired" = any stage ≥3, or stage 8/9 fallback, was required.
+ * Used by the adherence harness (Step 4) to compare providers head-to-head.
+ */
+const parseAdherenceCounters = new Map<string, { clean: number; repaired: number }>();
+
+function recordParseOutcome(logContext: string, clean: boolean): void {
+  const key = logContext.split('-')[0] ?? 'unknown'; // provider prefix
+  const entry = parseAdherenceCounters.get(key) ?? { clean: 0, repaired: 0 };
+  if (clean) entry.clean++; else entry.repaired++;
+  parseAdherenceCounters.set(key, entry);
+}
+
+/** Returns per-provider adherence stats: total, clean, repaired, repairRate (0–1). */
+export function getParseAdherenceStats(): Record<string, { total: number; clean: number; repaired: number; repairRate: number }> {
+  const out: Record<string, { total: number; clean: number; repaired: number; repairRate: number }> = {};
+  for (const [key, v] of parseAdherenceCounters) {
+    const total = v.clean + v.repaired;
+    out[key] = { ...v, total, repairRate: total ? v.repaired / total : 0 };
+  }
+  return out;
+}
+
+/** Resets adherence counters (used at the start of each harness run). */
+export function resetParseAdherenceStats(): void {
+  parseAdherenceCounters.clear();
+}
```

Then tag the return sites inside `runParsePipeline` (ai-parser.ts:323) and the outer fallbacks:

- before `return sanitized;` (line 338) → `recordParseOutcome(logContext, true);`
- before `return native;` (line 352) → `recordParseOutcome(logContext, true);`
- before `return parsed;` at Stage 3 (line 372), Stage 4 (line 398), + the later stages and Stage 8/9 fallbacks (parseAISafely lines 294, 308) → `recordParseOutcome(logContext, false);`

No prod behavior changes. **Sign-off:** `bun run typecheck` ✅; counts appear in dev logs/Harness output.

> ✅ **DONE (2026-08-13).** `getParseAdherenceStats()` / `resetParseAdherenceStats()` / `recordParseOutcome()` implemented and wired into Stages 1–9.

**Why this exact design:** `aiPrompt` already passes `logContext = \`${provider}-${context}\`` (ai-chat.ts:1347), so the provider is recoverable with a string split, no new plumbing. This single counter gives you the diffusion doc's *exact* requested metric: "how often does a provider's output route through the repair pipeline."

---

## Part 3 — Phase 1: Measure, then add the new provider

Do not skip Step 4. It is the only thing that turns Step 5 from a guess into a decision.

### Step 4 — Adherence + continuity trial harness (provider-agnostic, runs today)

Create a **temporary** test file under `tests/` (per AGENTS.md: isolated, descriptive name, deleted after use). Two difficulty tiers:

> ✅ **DONE (2026-08-13).** `tests/test-diffusion-adherence.ts`. Tier A runs N (`DIFFUSION_RUNS`, default 30) `aiPrompt<StoryGeneration>` calls per provider/model, feeds each raw output through `parseAISafely` (counter bucket = provider via `logContext`), and prints `console.table(getParseAdherenceStats())`. A lightweight Tier B probe checks the continuation still mentions the fixed characters/location; the full DB-backed multi-page Tier B stays manual as scoped. Baseline for current providers is **not yet recorded** — run it once with working keys before Step 6. `tests/` is in ESLint's global ignores (same as the other harnesses), so it needs no config. Kept until the Step-6 verdict, then deleted per AGENTS.md.

**Tier A — Schema adherence (isolated calls).** Reuses the real generation schema & a realistic prompt, but does **not** touch the DB. Direct `aiPrompt`:

```typescript
// tests/test-diffusion-adherence.ts  (DELETE after the trial)
import { aiPrompt, createAIOptionsWithSchema } from '../src/utils/ai-chat.js';
import { STORY_GENERATION_SCHEMA_DEFINITION, STORY_GENERATION_REQUIRED_FIELDS } from '../src/schema/story.js';
import { resetParseAdherenceStats, getParseAdherenceStats } from '../src/utils/ai-parser.js';
import type { StoryGeneration } from '../src/types/book.js';

// 1. realistic prompt mimicking prepareNextPageGenerationSetup's output —
//    embed a small StoryState JSON + "continue the story" instruction.
// 2. iterate providers: ['gemini', 'groq', 'cerebras', 'openrouter' /* later: 'inception' */]
// 3. per provider run N (e.g. 30) aiPrompt<StoryGeneration>(prompt, {
//      ...createAIOptionsWithSchema<StoryGeneration>({
//        schema: STORY_GENERATION_SCHEMA_DEFINITION,
//        requiredFields: STORY_GENERATION_REQUIRED_FIELDS,
//        fallbackField: 'text',
//        baseOptions: { modelSelection: { [provider]: [model] }, context: 'adherence-trial' , config: AI_CHAT_CONFIG_CREATIVE },
      // }),
//    });
// 4. resetParseAdherenceStats() between providers; print getParseAdherenceStats() after each.
```

**Tier B — Multi-page continuity.** The strongest cheap proxy is `generateNextPages` with `candidateCount >= 3`: the multiverse batch forces the model to keep the *same* parent state consistent across multiple alternative fates **inside a single call** (`CANDIDATE_GENERATION_SCHEMA_DEFINITION`). Feed it a real book + state read from the DB (use a scratch/dev book to avoid polluting prod data), then validate each fate with the existing `checkGeneratedPage` / `runCanonValidationPass` and diff the fates' state-delta fields. This directly tests the axis the diffusion doc predicts is weak (continuity across a generated block) without needing N sequential HTTP round-trips.

**Acceptance criteria to record** (per provider):
- `repairRate` from Tier A (lower is better; diffusion's hypothesized edge).
- Tier B pass rate + how many fates survive `checkGeneratedPage` untouched.
- `finishReason` distribution, TTFT (already logged by `prompt-telemetry.ts`), and average `durationMs`.

**Run order:** baseline **all current providers first** (this alone is valuable — you likely don't know today's real repair rate per provider), then re-run for Inception after Step 5/6. Command: `bun tests/test-diffusion-adherence.ts` (PowerShell: `cd "D:\Projects\Twistloom\Twistloom-backend"; bun tests/test-diffusion-adherence.ts`).

### Step 5 — Add Inception Labs Mercury as a provider (mechanical, env-gated)

The switch from `openrouter`/`cloudflare` — ~8 files, all following existing patterns. **Do the trial first, then promote the model within the waterfall** (the diffusion doc's own recommendation: unproven rungs start at the bottom).

> ✅ **CONFIRMED (2026-08-13)** from Inception Labs' own platform docs (`inceptionlabs.ai/platform`): (1) OpenAI-compatible base URL = **`https://api.inceptionlabs.ai/v1`**; (2) callable Mercury model slug = **`mercury-coder-small`** (docs also list `mercury-coder-large`, `mercury-architect`, `mercury-mini`). Both are wired below — no placeholder remains.

**5a — `src/types/ai-chat.ts`** — extend the provider union (lines 11–51):

```diff
   | 'llm7';
+  // @see https://docs.inceptionlabs.ai (OpenAI-compatible diffusion LLM — free
+  // tier: 10M tokens on signup per AI_DIFFUSION_LLM_ROADMAP Part 1)
+  | 'inception'
```

**5b — `src/utils/ai-clients.ts`**
- `AI_PROVIDER_API_KEYS` (lines 20–39): add `inception: 'INCEPTION_API_KEY',`
- New singleton (after `getCloudflareClient`, line 112), reusing the `openai` SDK like the OpenRouter client (line 94):

```diff
+export function getInceptionClient(): OpenAI {
+  if (inceptionClient) return inceptionClient;
+  inceptionClient = new OpenAI({
+    apiKey: requireEnv('INCEPTION_API_KEY'),
+    // TODO: confirm exact base URL from Inception's OpenAI-compat docs.
+    baseURL: 'https://api.inceptionlabs.ai/v1',
+  });
+  return inceptionClient;
+}
```
(declare `let inceptionClient: OpenAI | null = null;` with the other singletons, line 17.) Optionally add `getInceptionClient()` to `warmAIProviders()` (line 124) — or intentionally leave it out until the trial passes.

**5c — `src/config/ai-clients.ts`**
- `AI_RATE_LIMITS` (end of record, after `llm7` line 235):
  `inception: { rpm: 60, rpd: 1_000 }, // ⚠️ PLACEHOLDER — confirm Inception's real free-tier ceilings. 10M free tokens on signup (per source doc); token-budget may be the real gate.`
- `AI_MAX_PROMPT_LENGTH` (end of record, line 342): `inception: 60_000, // ⚠️ conservative placeholder (~15K tokens) until confirmed`
- `AI_STREAM_DEFAULT_MODEL` (end of record, line 411): `inception: 'mercury-2', // ⚠️ confirm exact model slug`
- **Model placement — new, separate selection** (recommended first step so prod waterfall is untouched):

```ts
/**
 * Diffusion-LLM experimental rung. DELIBERATELY not in AI_CHAT_MODELS_WRITING:
 * wire nothing until the Part 1 trial in Step 4 passes. See
 * AI_DIFFUSION_LLM_ROADMAP Part 4 — unproven quality starts at the bottom.
 */
export const AI_CHAT_MODELS_DIFFUSION: AIModelSelection = {
  inception: [
    'mercury-2', // ⚠️ confirm slug; also verify streak-mode/streaming behaves OpenAI-schema-compatibly
  ],
};
```
*Later*, if it passes the trial, either copy `inception` into `AI_CHAT_MODELS_WRITING` **at the bottom** (below `cohere`, above the "last resort" batch) or, if continuity fails, keep it only for IDEA/THEME-style single-shot calls (see Part 5, "what stays useful").

**5d — `src/utils/ai-limiters.ts`**
- `AI_RATE_LIMITS_WITH_BUFFER` (lines 25–44): add `inception: getRateLimitConfig('inception'),`
- Singleton getter after `getCloudflareLimiter` (line 207): `getInceptionLimiter()`
- `getRateLimiter` switch (line 232): add `case 'inception': return getInceptionLimiter();`

**5e — `src/utils/ai-chat.ts`**
- Import (line 2): add `getInceptionClient` to the `ai-clients.js` import.
- Factory (next to line 286):
  `export const inceptionPrompt = createOpenAICompatiblePrompt('inception', getInceptionClient);`
- `aiPrompt` switch (lines 1220–1229): add `case 'inception': result = await inceptionPrompt(prompt, opts); break;` (with the same `// ✅ JSON schema` comment style).

**5f — `src/utils/ai-chat-stream.ts`**
- Factory (next to line 458):
  `const inceptionStreamGenerator = createOpenAICompatibleStreamGenerator('inception', getInceptionClient, AI_STREAM_DEFAULT_MODEL.inception);`
- `aiStreamSSE` switch (lines 206–215): add `case 'inception': gen = inceptionStreamGenerator(prompt, opts); break;`

**5g — `src/utils/ai-cost.ts`**
- `AI_COST_PER_MILLION_PREVIEW` (end of record, line 66): `inception: { input: 0, output: 0 }, // free tier — source doc's 10M-token allowance; placeholder $0 until a paid tier is confirmed`
- (Optional) `AI_MODEL_COST_OVERRIDES`: add `{ match: 'mercury', input: 0, output: 0 }` so the cost spike checker doesn't misattribute later.

**5h — `.env.local` / env docs**: add `INCEPTION_API_KEY`.

**Sign-off:** `bun run typecheck`, `bun run lint:fast`. Because the provider is *not* in `AI_CHAT_MODELS_WRITING`, no production request will ever touch it until `executePromptForJSON` (or a caller) explicitly passes `modelSelection: AI_CHAT_MODELS_DIFFUSION`.

> ✅ **DONE (2026-08-13).** All 8 files wired exactly as specified — the union, `getInceptionClient` (confirmed base URL), config maps (`rpm 60` placeholder / `120_000` chars / `mercury-coder-small`), the limiter, `inceptionPrompt`, `inceptionStreamGenerator`, cost entries (provider-scoped `mercury-coder-small` $0 override + provider default), and `.env.example`. Added the dedicated `AI_CHAT_MODELS_DIFFUSION` selection as recommended (not merged into `AI_CHAT_MODELS_WRITING`). Sign-off: `bun run check` ✅ (lint + `lint:imports` + typecheck). The Step-4 harness lives at `tests/test-diffusion-adherence.ts` — `tests/` is already in ESLint's global ignores, so no lint config change was needed for it.

### Step 6 — Run the trial against Inception and make the call

> ⏳ **BLOCKED (waiting on operator).** Harness + wiring are in place; the only missing piece is a live `INCEPTION_API_KEY` and a scratch book for the manual Tier B. Running it:
> ```powershell
> cd "D:\Projects\Twistloom\Twistloom-backend"
> # 1. add INCEPTION_API_KEY=... to .env.local (see .env.example)
> bun tests/test-diffusion-adherence.ts              # Tier A — defaults to all of AI_CHAT_MODELS_DIFFUSION
> bun tests/test-diffusion-adherence.ts inception    # or pin just Inception
> ```

1. Run `tests/test-diffusion-adherence.ts` Tier A (default `modelSelection = AI_CHAT_MODELS_DIFFUSION`), plus the manual DB-backed Tier B on a scratch book routed via `AI_CHAT_MODELS_DIFFUSION`.
2. Compare `repairRate` and continuity pass-rate to the Step-4 baseline (record current-provider baselines first — see Step 4).
3. **If continuity holds** → promote `inception` into `AI_CHAT_MODELS_WRITING` (bottom rung) and add the cost override. If it **breaks down** (the likely outcome per AI_DIFFUSION_LLM_ROADMAP Part 2) → keep Mercury only for single-shot IDEA/THEME flume calls (`AI_CHAT_MODELS_IDEA`/`THEME`), where no prior state exists for continuity to lose.
4. After the verdict: delete `tests/test-diffusion-adherence.ts` per AGENTS.md.

### Step 7 — Keep the Gemini Interactions path **parked** (verified 2026-08)

The code is done; the decision is effectively made by Google's current docs (see Q3). Re-verified today:

- **Explicit caching — confirmed NOT available on Interactions.** The overview page states the API "does not currently support explicit caching" and points back to `generateContent` for it. This is the load-bearing feature for Twistloom: `cachedContentId` (hash of bookId + characters + places, book.ts:2160) → `getOrCreateGeminiCache` (gemini.ts:229) → cached prefix served at the discounted rate for every page generation in a book. The only Interactions caching is *stateful* implicit caching via `previous_interaction_id`, which requires a conversational flow Twistloom's single-shot serverless model doesn't have. So `geminiPrompt` (ai-chat.ts:596) must keep its `cachedContentId` branch on `generateContent`.
- **Sampling — partially confirmed.** Current `generation_config` docs mention `temperature` generically, but `top_p`/`top_k` are absent, and `AI_CHAT_CONFIG_CREATIVE` relies on all three (temp 0.78 / topP 0.92 / topK 50, src/config/ai-chat.ts:58–69). Even if `temperature` maps, prose-variety control is only partially expressible.

**Recommendation: hold.** Keep the dispatch on `generateContent` exactly as it is today. Preserve the parked implementations for the day Google ships both capabilities. If you still want the switch ready, gate it behind an env flag so nothing can silently ship:

```diff
export async function geminiPrompt(
  prompt: string,
  options?: Partial<PromptWithFallbackOptions>
): Promise<AIResponse<string> | null> {
+  if (process.env.ENABLE_GEMINI_INTERACTIONS === '1' && !options.cachedContentId) {
+    return geminiPromptViaInteractions(prompt, options);   // explicit caching requires generateContent
+  }
  return geminiPromptViaGenerateContent(prompt, options);
}
```

(same shape in `geminiStreamGenerator`, ai-chat-stream.ts:652, still keeping the `cachedContentId` branch on `generateContent`). Re-verify against the live Limitations page before flipping the flag on in prod.

---

## Part 4 — Phase 2: Optimise with the numbers you now have

Only once Steps 2–3 are producing data:

### Cheap, self-contained builds
1. **Gemini explicit-cache opt-out / TTL control** (`src/utils/gemini.ts`):
   - Replace the hardcoded `GEMINI_CACHE_TTL_SECONDS` (line 61) with `process.env.GEMINI_CACHE_TTL_SECONDS ?? 3600`.
   - Add a fast-path opt-out respected by `getOrCreateGeminiCache` (signature line 228) so low-traffic books fall back to Gemini's free implicit caching:

```diff
 export async function getOrCreateGeminiCache(
   cachedContentId: string,
   model: string,
   systemInstruction: string,
   semiStaticContext: string,
   bookId?: string,
+  skipExplicitCache?: boolean,
 ): Promise<string | null> {
+  // Low-traffic books skip the paid storage-metered explicit cache and rely on
+  // Gemini's free implicit caching instead (TOKEN_SAVING_ROADMAP Part 3 (b)).
+  if (skipExplicitCache) return null;
   const prefixContent = systemInstruction + semiStaticContext;
```
   Then thread `skipExplicitCache` from `meta` (e.g. `meta.bookId` + a per-book opt-out persisted in `advancedOptions` or a lookup) through the two call sites (ai-chat.ts:327, ai-chat-stream.ts:487).
2. **Durable per-book cost report** — a small `src/cron/` or dev script that runs the Step-2b SQL weekly, joins against `ai-cost.ts`, and logs per-book Gemini cache-economics (request count, cache-read ratio, estimated storage-vs-read balance). Add a `dev:cron:ai-costs` npm script mirroring the existing cron pattern.

### Correctness/robustness passes (no new features)
3. **Prompt-order audit** — confirm in `formatSystemPromptWithDocuments` (ai-chat.ts:1547) that static (PROMPT_SYSTEM + schema `outputFormat` appended at ai-chat.ts:1171) precedes documents precedes dynamic user text. This is already true by construction; the audit is a regression guard so automatic prefix caching (Groq/DeepSeek, Step 1's Mistral key) keeps firing.
4. **`ai-cost.ts` tier audit** after Inception/any promoted models — the `AI_MODEL_COST_OVERRIDES` substring matcher silently falls through to provider defaults; ensure every new model you promote gets an explicit override (the same bug class already found & fixed for gpt-oss-safeguard and glm-4.7-flash).

---

## Part 5 — Rejected or Future / To-Consider (pros & cons)

### Rejected now (feasibility/architecture, not budget)

**1. HF Inference API fallback**
- *Why rejected:* corrected free tier is **$0.10/month credit** with a hard stop (it is *not* "100K free requests/month"), plus documented 30s+ cold starts.
- Pros: huge model catalog, backup capacity when quotas exhaust.
- Cons: tiny free budget, latency on primary generation, integration cost for near-zero marginal utility. Skip even for background tasks.

**2. DiffusionGemma / any self-hosted diffusion model**
- *Why rejected:* download-and-run, needs your own inference hardware (H100-class or ~18GB VRAM quantized). No API. Google's own release notes say output quality is below standard Gemma 4 — a worse product *and* a new infrastructure category.
- Pros: speed leadership, diffusion-differentiator on your hardest schema, no per-token cost.
- Cons: GPU infra you don't run, ops burden, quality regression, completely orthogonal to a serverless/Vercel platform. Revisit only if Twistloom ever owns/rents inference hardware.

**3. Wexa**
- *Why rejected:* wrong product category — an AI-coworker/process-automation platform (Gmail/Slack/Salesforce/Jira context graphs), not a prompt-token-compression SDK you could call inside a generation pipeline. The "200K→2.6K tokens" Graph-RAG benchmark is unverified publicly.

**4. Helicone / Portkey gateways *for caching***
- *Why rejected:* their pitch (cache Reader B's page identical to Reader A's) is an **exact-match** cache, and your architecture already solves it deterministically via persisted pages + `ACTION_ALREADY_HAS_DESTINATION` reuse (Part 1). You'd add a request-path dependency and a 10K req/mo free ceiling to solve a problem you already don't have.
- Cons (if you were to adopt anyway): proxy latency hop on every call, per-request logging costs at scale, opaque free-tier limits (Helicone is 10K not 100K).

**5. NVIDIA `extra_body.nvext.guided_json` structured output**
- *Why rejected:* your code hits `integrate.api.nvidia.com`, the hosted OpenAI-compatible endpoint, which strips vendor extensions — confirmed in the commented-out block in `nvidiaPrompt` (ai-chat.ts:1022–1036). Only possible on a self-hosted NIM container → see future item 6.

**6. DeepInfra as a paid fallback rung** — ⚠️ *feasible but a business decision, not a code task*
- Why held: the waterfall's core design principle is "every rung is free until scale." DeepInfra is effectively pay-as-you-go (one-time $1 trial credit, then paid). Adding it is "we're now paying for reliability," which the prior doc explicitly says deserves a deliberate call, not a drop-in add.
- Pros: huge GPU fleet (B200s), wide catalog, same one-line factory integration as Inception/others; a genuine safety net when the 10 free tiers exhaust for the day.
- Cons: ongoing paid spend, becomes the "always-on" crutch that masks free-tier budget exhaustion, same OpenAI-schema dependency caveats as any new compat provider.
- **Decision input needed (Q6):** threshold for spending (e.g. only above X failures/day), which models, monthly cap.

### Future / To-Consider (with the trigger)

**1. Cloudflare AI Gateway as an observability proxy**
- Pros: you're already a Cloudflare customer (Workers AI rung), caching/rate-limit/analytics on the free plan with no documented ceiling, OpenAI/Anthropic-compatible universal endpoints → base-URL swap adoption, one dashboard across providers.
- Cons: unverified native integration for your niche newer providers (ModelScope, SiliconFlow, Chutes, Aion Labs, LLM7) — verify coverage against your actual 19-provider list before assuming whole-waterfall support; another layer in the request path.
- Trigger: real cross-provider observability pain or a second paid provider.

**2. Inception promotion or single-shot reuse**
- Pros: 10M free tokens cost nothing to spend; if continuity *does* survive the trial, a genuinely-fast schema-strong rung; if it doesn't, still useful for theme/blurb/character-say single-shot tasks (no prior state to lose).
- Cons: zero fiction-quality benchmark exists (Mercury 2's public benchmarks are math/science/coding); "Karpathy said diffusion has unique psychology" is a real quote about a *coding* model, not creative writing — don't treat it as evidence.

**3. Gemini Interactions API active routing (parked — verified 2026-08)**
- Pros: GA since June 2026, where Google routes new features first; already implemented in your codebase.
- Cons: **explicit caching not supported** on Interactions (only stateful implicit caching) — this is the load-bearing `cachedContentId` per-book prefix-cache mechanism, which has no equivalent; `temperature` mentioned generically in `generation_config` but `top_p`/`top_k` absent, so prose-variety control for fiction is only partially expressible.
- Trigger: Google ships explicit caching and top_p/top_k on Interactions (see Step 7).

**4. Graph-RAG-style character/plot memory compression (LlamaIndex or hand-rolled over pgvector)**
- Pros: the legitimate version of Wexa's pitch, buildable on infra you already run (pgvector is live for semantic memory); big input-token savings if recap prompts balloon.
- Cons: real engineering effort for a problem you may not have — you pass structured JSON state, not prose recaps; risk of adding a nondeterministic retrieval layer to a continuity-critical pipeline.
- Trigger: measured recap-prompt growth past what flat JSON flags keep lean (the Step-2 observability data will tell you).

**5. Self-hosted NVIDIA NIM or other self-hosted stack**
- Pros: `guided_json` structured output works (fixes the Part 5-rejected 5), full batch/cache control, flat cost.
- Cons: GPU infra + ops; same architecture change as DiffusionGemma. Trigger: scalability bible-grade traffic, not now.

**6. per-book `bookId` column on `usage` (proper analytics)**
- Pros: clean, queryable attribute instead of string-prefix parsing; enables durable per-book cache/cost dashboards.
- Cons: requires a Drizzle migration (`bun db:generate` + `bun db:migrate`) and a backfill; the context-tagging in Step 2 gives 95% of the value immediately.
- Trigger: Step 2 tagging proves the per-book economics question is worth answering on an ongoing basis.

---

## Part 6 — Open Questions / Decisions Needed

These gate Phase-1/Phase-2 scope. Phase 0 (Steps 1–3) requires none of them.

| # | Question | Options | Recommendation |
|---|---|---|---|
| Q1 | **Inception surface**: new isolated selection (`AI_CHAT_MODELS_DIFFUSION`, un-wired) or straight into `AI_CHAT_MODELS_WRITING` bottom rung? | (a) experimental selection, (b) direct-wire low rung, (c) skip | **(a)** — matches the observed-quality-first ordering rule already used for the 9 new providers |
| Q2 | **Env-gate the Inception provider** behind a flag, or fully live after the trial? | (a) `INCEPTION_ENABLED` flag honored in `aiPrompt`, (b) live immediately on promote | **(a)** — lets you A/B in prod traffic without a redeploy |
| Q3 | **Gemini Interactions**: wait, wire-behind-flag (default off), or empirically test first? | (a) test-first on your key, then flag, (b) flag default-off now + test later, (c) hold | **(c) hold — decided by docs, verified 2026-08.** Explicit caching not supported (load-bearing for Twistloom) + top_p/top_k absent → nothing to empirically test that would change the outcome |
| Q4 | **Mistral `prompt_cache_key` value**: constant `'twistloom:v1:…'` or derived from `cachedContentId` (the same fingerprint Gemini's cache key rotates on)? | (a) constant, (b) derived from `cachedContentId`, (c) derived from provider-config hash | **(b)** — key rotates in lockstep with the prefix content (characters/places), mirroring the Gemini cache lifecycle; self-invalidating, zero bookkeeping |
| Q5 | **Per-book usage attribution**: encode bookId in the `context` string (zero migration, Step 2) now, and defer the `bookId` column/NN migration? | (a) context-encode now, column later, (b) schema migration now | **(a)** — the migration can wait for evidence the metric is useful; note: attributes change if you ever change the context string format |
| Q6 | **DeepInfra paid safety net** — do you want it at all, and under what trigger? | (a) never, (b) only when all free tiers fail for ≥N consecutive requests in a day, (c) always-on last rung | **(b)** if any — it preserves the free-first waterfall while giving a real backstop; needs a spend cap agreed up front |
| Q7 | **Where does the Step-4 trial run?** | (a) local dev machine, (b) staged/deploy-preview book, (c) admin-only route | **(a)** — Tier B touches `generateNextPages` (writes pages); run against a scratch book in an isolated env, not prod traffic |

---

## Suggested Execution Order (with verification per step)

| Status | Step | What | Verify |
|---|---|---|---|
| ✅ | 1 | **DONE** — Mistral `promptCacheKey` (2 patches, derived from `cachedContentId`) | `bun run typecheck` ✅ passed; live check: `cached_tokens > 0` on first Mistral-rung call |
| ✅ | 2 | **DONE** — bookId-tagged usage context (`:b-{bookId}`) + `dev:usage-cache-report` script | `bun run typecheck` ✅ passed; live check: report returns per-book rows |
| ✅ | 3 | **DONE** — parseAISafely adherence counters (`getParseAdherenceStats`) | `bun run typecheck` ✅ passed; live check: counters increment after any generation |
| 🔷 | 4 | **DONE (harness) —** adherence/continuity harness in `tests/`; baseline for current providers **not yet recorded** (operator run) | ✅ harness built; 🔷 `bun tests/test-diffusion-adherence.ts` to record the baseline; uses Step-3 counters + confirms Step-1 `cached_tokens` live |
| ✅ | 5 | **DONE —** Inception provider wiring (8 files, env-gated) | `bun run check` ✅ passed; inert in `AI_CHAT_MODELS_DIFFUSION`, nothing in `AI_CHAT_MODELS_WRITING` |
| ⏳ | 6 | **BLOCKED (needs operator)** — Inception trial → promote / single-shot-only decision | `INCEPTION_API_KEY` → `.env`, then `bun tests/test-diffusion-adherence.ts` (re-run w/ inception)
| ⏩ | 7 | **DEFERRED** — Interactions dispatch (explicit caching + top_p/top_k unsupported, verified 2026-08); no activation work | re-verify Limitations page; nothing to ship |

Cleanup rule (AGENTS.md): delete `tests/test-diffusion-adherence.ts` when the trial is done and recorded (or promote it into `src/scripts/` if you want it repeatable).

---

## 🎯 Conclusion — Token-Saving Impact (implemented vs projected)

> **Honesty note.** Every number below is an **estimate / illustrative**, not a measured invoice line — live savings depend on your real traffic mix (how many page generations hit a given book's cache in a storage-hour) and on Mistral's actual discount for your models, which must be re-verified against mistral.ai/pricing (the "90%" figure originates from the source doc, not Mistral's site). Steps 2b and 3 were built precisely so these estimates become *measured* numbers once live traffic flows.

### A. What the completed steps (1–5) already deliver

| Lever | Mechanism | Approximate impact |
|---|---|---|
| **Mistral `promptCacheKey` (Step 1, DONE)** | Repeated page-gen calls share a static prefix (system prompt + book documents) keyed by the same `cachedContentId` Gemini uses | Cached input tokens billed at **~10% of list price** (i.e. **~90% off**). Realistic page-gen mix (≈75% of input tokens are cacheable prefix, high repeat-hit rate for an active book): **~50–60% reduction in Mistral input-token cost**. Caveat: Mistral is one rung of the 19-provider waterfall, so whole-pipeline impact scales with Mistral's traffic share |
| **Per-book `usage` attribution (Step 2, DONE)** | `context` now carries `:b-{bookId}` → cache economics queryable per book | **0% direct savings — unlocks the rest.** Without it the Gemini storage-vs-read question (below) was literally unanswerable |
| **Cache-economics report (Step 2b, DONE)** | `bun run dev:usage-cache-report` flags low-hit books | Feeds the Phase-2 per-book opt-out: for low-traffic books, explicit caching currently costs **~88% more** than not caching (50K-context, 15 reads/day example from TOKEN_SAVING_ROADMAP Part 3) — opting those books out reclaims **~47%** of their Gemini cost (1 − 1/1.88) |
| **Adherence counters (Step 3, DONE)** | `getParseAdherenceStats()` tallies clean vs repaired per provider | **0% direct savings — the trial's measuring stick.** Repair/fallback wastes output tokens and triggers cross-provider retries; Step 3 turns that waste into a number so Step 4–6 can prove (or disprove) "diffusion has better adherence" instead of assuming it |
| **Adherence harness (Step 4, DONE)** | `tests/test-diffusion-adherence.ts` runs N `aiPrompt` calls per provider through the real 9-stage pipeline + a continuity probe | **0% direct savings — operationalizes the trial.** Once the operator records the baseline, current providers' real repair rates stop being speculation; until then the diffusion "advantage" is unproven |
| **Inception Mercury wired (Step 5, DONE)** | `inception` in `AI_CHAT_MODELS_DIFFUSION` — the 8-layer slot-in is done and env-gated, **inert** in the waterfall | **0% until Step 6** — adds a potential **$0** writing rung (10M free tokens/mo) with zero cost while parked |

### B. Projected impact of the remaining steps

| Step | What it targets | Projected impact |
|---|---|---|
| 6 (only non-parked item left) | Inception Mercury trial → promote / single-shot-only decision | If continuity survives: adds a **$0** writing rung with genuine cost ceiling; if it breaks (likely per the diffusion doc): keep it for single-shot IDEA/THEME calls. Either way the Step-3/4 numbers make it a decision, not a guess |
| (parked) | Gemini Interactions dispatch | **No impact available** — explicit caching + top_p/top_k unsupported, verified 2026-08 |

### C. Realistic expectation for the whole effort

- **Completed so far:** the only *direct* cost lever shipped is **Step 1 (Mistral)** — realistically **tens of % off Mistral's input cost** on active books, *not* a whole-pipeline number, because Mistral is one provider among 19. Steps 2/2b/3/4/5 added the instrumentation and the trial machinery (per-book economics, adherence stats, the diffusion harness, the inert `$0` rung) but no further direct savings on their own.
- **Biggest unquantified prize still on the table:** Gemini's explicit-cache economics. Step 2/2b now give you the per-book data to (a) keep caching for hot books (high hit-rate = the 90%-off cache read wins) and (b) opt cold books out (reclaim ~47%). This is Phase 2 / row D, and it is now *decidable* instead of speculative.
- **The measurement infrastructure (Steps 2b + 3 + Step 4 harness) is the compounding asset** — every future provider (Inception) and every cache-policy decision gets verified against real numbers instead of the source-doc's optimistic percentages.

**Bottom line:** ~50–60% off Mistral input tokens today (Step 1), and the tools to find another ~47%-on-cold-books Gemini lever (Step 2/2b) and to settle the diffusion question honestly (Steps 3 + 4 harness + Step 5 wiring). The single remaining item — Step 6, the Inception trial — is itself a decision *enabled by* that instrumentation and only needs a live `INCEPTION_API_KEY` + a scratch book to resolve.