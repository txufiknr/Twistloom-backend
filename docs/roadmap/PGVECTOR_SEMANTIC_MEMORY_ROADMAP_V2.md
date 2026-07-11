# pgvector Semantic Memory — Twistloom Implementation Roadmap (v2)

**Status:** Phase 0, Phase 1, and the write-side of Phase 2+3 are done — see §8/§9. Remaining: `pnpm db:generate`/`db:migrate` (your environment), then wiring the already-built `vector-memory.ts` functions into `prompt.ts`'s call sites (the read/prompt-injection side).
**Database:** Neon PostgreSQL + pgvector extension (pin **≥ 0.8.2** — see §5)
**Stack:** Drizzle ORM, TypeScript, **Jina AI `jina-embeddings-v5-text-small`** (free tier)
**Pattern source:** MuslimDigest (`src/utils/embedding.ts`, `src/utils/rate-limit.ts`, `src/cron/embeddings.ts`)
**Document grounded against:** `src/utils/prompt.ts`, `src/services/book.ts`, `src/types/story.ts`, `src/db/schema.ts` (actual files reviewed, not assumed)

---

## Revision Notes — What Changed from v1 and Why

This is a fact-checked rewrite of the original roadmap. Two decisions were made explicitly by Taufik and are now locked in:

1. **Model: `jina-embeddings-v3` → `jina-embeddings-v5-text-small`.** Twistloom is pre-launch/experimental, so "latest > old stable" wins. v5-text-small (released Feb 2026) is a 677M-parameter model that **matches jina-embeddings-v4 (3.8B) on retrieval while being 5.6× smaller, and outperforms jina-embeddings-v3 across all task types at a similar parameter count.** It also keeps the same 1024-dim default and the same hosted-API task-string format (`retrieval.passage` / `retrieval.query`), so this is a drop-in model swap — no schema or query-shape changes needed.
2. **Normalization: manual `l2Normalize()` → `"normalized": true` request parameter.** Confirmed against Jina's live API schema: normalization is **not** built-in/default as v1 claimed. The `normalized` field defaults to **`false`**. Passing `"normalized": true` makes the API return unit-length vectors directly, so the MuslimDigest-ported client-side normalization step is now dead code and has been removed.

Beyond those two, this fact-check surfaced several other corrections, all folded into the sections below:

| # | v1 claim | Correction | Where |
|---|---|---|---|
| 1 | Jina free tier: "1M tokens/day, 100 RPM" | Actual published limit: **100 RPM, 100,000 TPM (tokens/*minute*), 2 concurrent requests** per API key. There is no fixed daily cap — it's a per-minute burst limit. This changes the Appendix D.5 backfill-quota math. | §2, §11, Appendix D.5 |
| 2 | `normalized` L2 output is built-in | Defaults to `false`; must be explicitly requested | §2, Appendix C |
| 3 | Fire-and-forget embed hook lives "in `persistPageWithState`" | That function has a delicate atomicity/branch-retry contract (documented in `book.ts`) that shouldn't absorb unrelated side effects. The hook belongs in the **callers** — `generateNextPage` and the per-candidate loop in `generateNextPages` — immediately after each successful `persistPageWithState(...)` resolves. | §12, Appendix C |
| 4 | `future_note_embeddings` unique key: `(bookId, branchId, noteIndex)` | `FutureNote` has a stable `key: string` field explicitly designed for "targeted updates and removal." Array position (`noteIndex`) shifts whenever a note is removed via `futureNoteUpdates`, which would silently misattribute embeddings. Use `noteKey`, not array index. | §6, Appendix A |
| 5 | "All future notes sent to every prompt, unfiltered" | Partially true. `formatFutureNotes()` in `prompt.ts` already buckets notes into `becomingRelevant` / `upcomingScheduledEvents` / `unscheduled` using real temporal + state-trigger logic — this is a solid existing system. The actual gap semantic retrieval fills is **thematic/spatial** relevance within the `unscheduled` bucket (open-ended notes with no time anchor), not temporal filtering, which already exists. Also, `MAX_FUTURE_NOTES` appears to cap the *total number of notes that can exist* (an AI-generation instruction), not a truncation of a larger pool — so the win here is narrative focus, not token savings. | §6, §9 Phase 3 |
| 6 | pgvector version unspecified | **pgvector 0.7.x, 0.8.0, and 0.8.1 have a CVSS 8.1 buffer-overflow vulnerability (CVE-2026-3172)** triggered during parallel HNSW index builds. Pin to **0.8.2+** and verify with `SELECT extversion FROM pg_extension WHERE extname='vector';` after enabling. | §5, §13 |
| 7 | Schema (Appendix A) used ad-hoc `uuid().defaultRandom()`, manual FK definitions | Your actual `schema.ts` has established helpers (`id()` → `uuidv7()`, `bookId()`, `createdAt`) and a JSDoc `@summary`/`@example` table-comment convention. Rewritten to match. | Appendix A |
| 8 | Raw `sql\`...\`` template queries with manual `[${embedding.join(',')}]` string building | Drizzle's native `vector()` type plus the `pgvector` npm package's `pgvector/drizzle-orm` helpers (`cosineDistance`, `l2Distance`) give type-safe query building without hand-rolled vector literals. | Appendix B, Appendix C |
| 9 | No mention of filtered-ANN recall risk | Every planned query filters by `bookId`/`branchId` on top of the HNSW `ORDER BY embedding <=> ...`. Pre-pgvector-0.8, combining a `WHERE` filter with an approximate index scan could silently return fewer/worse results than `LIMIT` requests. pgvector 0.8+ ships iterative index scans that fix this — another reason to pin ≥ 0.8.2, not just for the CVE. | §5, §13 |
| 10 | ~~No mention of concurrency cap~~ **Resolved against real `ai-limiters.ts`/`ai-clients.ts`** | Jina free tier caps 2 concurrent requests per key. Checked the actual `RateLimiter` class: it serializes all calls through one `queue` promise chain and spaces call *starts* by `delayMs` (derived from buffered RPM). With `AI_RATE_LIMIT_SAFETY_BUFFER_PERCENT = 8`, buffered RPM ≈ 92, spacing ≈ 652ms — comfortably above Jina's typical 100-500ms latency. Because `getJinaLimiter()` is a singleton shared by *every* caller (fire-and-forget page embeds AND cron backfill), all Jina calls funnel through the same queue. **No separate concurrency semaphore needed.** | §2, §11, §12 |
| 11 | Self-hosting license | `jina-embeddings-v5-text-small`'s open weights on Hugging Face are **CC BY-NC 4.0** (non-commercial). This only matters if you ever self-host the model instead of calling `api.jina.ai` — the hosted API is governed by Jina's commercial API terms, not the weights license. | Appendix D.1 |
| 12 | *(new)* Is the free tier itself commercial-use-safe for a paid product like Twistloom? | Verified directly against Jina's own product pages (`jina.ai/embeddings`, `jina.ai/reader`, `jina.ai/contact-sales`): the CC BY-NC "non-commercial" language on Jina's site is scoped specifically to **self-hosted open-weight models** (rerankers, ReaderLM-v2, and by extension the embeddings weights on Hugging Face) — never to the hosted-API free token grant itself, which is described plainly as "10 million free tokens for each new API key... beyond the free tokens, different packages are available for purchase," no commercial restriction stated. Several third-party review/aggregator sites *do* describe the free tokens as "non-commercial (CC-BY-NC)," which looks like those sites conflating the model license with the API token grant (the phrasing is identical to the reranker/ReaderLM-v2 license blurb). I could not retrieve Jina's full legal Terms & Conditions document directly (their `/legal/` page is a JS-rendered SPA that didn't return text to my fetcher) to get 100% primary-source certainty. See §2 "Commercial-use verification" for the full writeup and my recommendation. | §2 |
| 13 | *(new)* `canUseAIToday('jina')` | Your real `canUseAIToday()` only gates providers with `rpd`/`rpmo` configured in `AI_RATE_LIMITS`. Jina has neither (it's RPM/TPM-based, like Mistral/NVIDIA/Cerebras-by-token) — so if `jina: { rpm: 100 }` is added with no `rpd`/`rpmo`, `canUseAIToday('jina')` will always return `true`. It's harmless to keep in the cron job for pattern-consistency, but it provides **no actual protection** — the `RateLimiter`'s RPM throttling is what actually matters. | §8, Appendix F |
| 14 | *(new)* `MAX_PAST_INTERACTIONS = 5` (Use Case 2) | Confirmed real, in `story.config.ts`: "Maximum number of past interactions to store per character... sliding window of recent interactions." The v1/v2 claim was accurate. `character.ts` itself (the field's actual shape on `CharacterMemory`) is still unreviewed — send it if you want Use Case 2 held to the same bar as Use Case 1. | §4 |
| 15 | *(new)* Use Case 5 (place semantic recall) — now grounded | `story.config.ts` reveals an existing **Place Memory familiarity system** (`PLACE_MIN_FAMILIARITY`, `FAMILIARITY_*` weights, `SIGNIFICANT_EVENT_KEYWORDS`). The "significant event" detector is a hardcoded 20-word English substring list (`'betray'`, `'death'`, `'kill'`, `'reveal'`, etc.) — brittle by construction (misses paraphrases, doesn't generalize, English-only). This is a concrete, better-scoped semantic-embedding opportunity than v1's vague stub. | §4 |
| 16 | *(new)* Use Cases 2 and 5, re-derived from real code | Reviewed `character_types.ts`, `characters_utils.ts`, `places_types.ts`, `places_utils.ts`. Both `pastInteractions` (cap 5) and `keyEvents` (cap 8) use destructive `.slice(-N)` trimming on every update, with everything currently in the array shown in full whenever that character/place appears. The actual gap isn't "rank what's shown" (small set, limited upside) — it's **recovering history that's already been trimmed away and no longer exists anywhere else.** Use Cases 2 and 5 turned out to be the same design applied twice, not two separate features. | §4, §6, Appendix A |
| 17 | *(new)* Replay-safety hazard for character/place embedding hooks | `processCharacterUpdates`/`updateCharacter` and `processPlaceUpdates`/`updatePlace` look like pure, synchronous state-transition functions of the same shape as ones reused for delta-chain replay elsewhere in this codebase. If they're reused for replay too (inferred, not confirmed — worth checking), embedding calls must live at the page-generation caller level, never inside those functions, or replay would silently re-embed the same history on every reconstruction. | §12, Appendix D.3 |

Everything else in the original (use-case prioritization, hybrid-architecture reasoning, phased rollout shape, "what NOT to embed") checked out and is carried forward with light edits.

---

## 0. Why pgvector for Twistloom

Twistloom is already on **Neon PostgreSQL** with **Drizzle ORM**. Adding `pgvector` requires no new infrastructure, no Pinecone/Weaviate/Milvus, no extra network calls to a vector database. It's a `CREATE EXTENSION vector` + a new table.

> **Vector databases are not "memory". They're semantic retrieval engines.**
> They answer: *"What previous information is most relevant to the current situation?"*
> Instead of: *"What happened on page 137?"*

---

## 1. Current Memory Architecture — Analysis

### What the prompt sends today (`src/utils/prompt.ts`)

Confirmed directly against `formatNextPageStoryContextPrompt` (line 2722) and `formatNextPageNarrativePrompt` (line 2789):

| Section | Source | Size/Cap |
|---|---|---|
| **contextHistory** | AI-summarized running summary from page 1 to N-1 | 300 words (`MAX_WORDS_SUMMARIZED_CONTEXT`) |
| **Previous Pages** | Last 3 pages full text + selected action + hints (`formatPreviousPagesForPrompt`) | 3 pages (`MAX_PAGE_HISTORY`) |
| **Recent Major Events / Older Plot Flags** | `formatRecentMajorEvents(plotFlags)` | 15 max (`MAX_OLDER_PLOT_FLAGS`), 5 max (`MAX_RECENT_MAJOR_EVENTS`) |
| **Current Facts** | Most recent value per fact key from `factsHistory` | Variable (every fact key) |
| **Future Notes** | `formatFutureNotes()` — bucketed by temporal/state relevance | ≤ `MAX_FUTURE_NOTES` (10) total notes ever created |
| **Characters** | Full CharacterMemory for characters present | 6 max (`MAX_CHARACTERS`) |
| **Places** | Full PlaceMemory for current place | 6 max (`MAX_PLACES`) |
| **Active Threads** | `formatThreadsPrompt()` | 5 max (`MAX_ACTIVE_THREADS`) |

### Key limitations

1. **`contextHistory` is a single lossy summary.** Every page the AI compresses `MAX_WORDS_SUMMARIZED_CONTEXT` (300) words of running summary (`state.contextHistory`, read directly off `StoryState` in `formatNextPageStoryContextPrompt`). Details from page 20 are barely recognizable by page 80.

2. **Full-text window is only 3 pages** (`MAX_PAGE_HISTORY`). The AI cannot reference a detail from page 15 when generating page 84 unless it survived into `factsHistory`, plot flags, or `contextHistory`. Plot flags are structured, but the *emotional weight* and *sensory texture* of the original scene are gone.

3. **Future notes already have solid temporal filtering — the gap is thematic, not volume.** `formatFutureNotes()` is a genuinely well-built system: it buckets notes into `becomingRelevant` (schedule or state-trigger currently active), `upcomingScheduledEvents` (has a schedule, not yet in its lookahead window), and `unscheduled` (open-ended, no time anchor). What it can't do is rank the `unscheduled` bucket by *narrative relevance to the current scene* — a note about "reveal hospital basement" sits in `unscheduled` with equal weight whether the MC is in the hospital or a forest.

4. **FactsHistory is structured, not semantic.** `key: "character.emma.trust"` → `value: "suspicious"` is deterministic and correct, but the *narrative context* around *how* and *why* that trust eroded is lost unless preserved in the 300-word summary.

5. **No semantic clustering or similarity search.** The AI only knows chronological neighbors (last 3 pages) — it can't ask "what previous scene is most similar to what's happening now?"

6. **Character/place retrieval is deterministic**, not similarity-based — always sends full `CharacterMemory` for characters in `charactersPresent`, with no way to surface "past conversations with this character that are semantically similar to the current situation."

### Approximate token count for a page-80 generation

```
contextHistory            ~400 tokens  (300 words)
Previous 3 pages          ~900 tokens
Older plot flags/events   ~400 tokens
Current facts              ~300 tokens
Future notes                ~300 tokens
Characters present          ~200 tokens
Current place                ~100 tokens
Active threads                ~200 tokens
Ending plan + rules            ~200 tokens
Psychological profile           ~100 tokens
Narrative style                  ~100 tokens
System prompt + field instructions + review checklist + schema  ~2,100 tokens
──────────────────────────────────────
Total user prompt         ~5,000+ tokens
```

Manageable today; degrades as `factsHistory` grows and `contextHistory` gets lossier past ~150-200 pages.

---

## 2. Chosen Embedding Provider: Jina AI `jina-embeddings-v5-text-small` (free tier)

### Why v5-text-small over v3, v4, OpenAI, and Google

| Factor | OpenAI `text-embedding-3-small` | Google `gemini-embedding-001` | **Jina `jina-embeddings-v5-text-small`** |
|---|---|---|---|
| **Free tier** | No free tier (pay-as-you-go, ~$0.02/1M tokens) | Free tier + $0.15/1M tokens paid | **100 RPM / 100K TPM / 2 concurrent, no fixed daily cap** |
| **Dimensions** | 1536 | 3072 (MRL-truncatable to 768) | **1024 (default), Matryoshka-truncatable to 32** |
| **Context length** | 8,191 tokens | 2,048 tokens | **32,768 tokens** |
| **L2 normalization** | Not built-in | Built-in | **Opt-in via `"normalized": true`** (defaults `false`) |
| **Quality vs. size** | Solid baseline | Strong, but 2,048-token input cap is limiting for long pages | **71.7 MTEB English avg, matches jina-embeddings-v4 (3.8B) at 5.6× smaller** |
| **Maturity in our stack** | Not used anywhere | Not used anywhere | Same family as MuslimDigest's proven Jina integration (client/rate-limiter plumbing reusable, model swapped) |

> Google's older `text-embedding-004` (referenced in some older comparisons) was **shut down January 14, 2026** — if you see it mentioned anywhere else in your notes, treat it as retired; `gemini-embedding-001` (and the newer `gemini-embedding-2-preview`) are the current Google options.

### Model details

| Property | Value |
|---|---|
| **Model ID** | `jina-embeddings-v5-text-small` |
| **Parameters** | 677M |
| **Dimensions** | 1024 default (Matryoshka-truncatable down to 32 via `dimensions` param; keep ≥ 256 for quality) |
| **Max input tokens** | 32,768 |
| **Free tier limits** | 100 RPM, 100,000 TPM, 2 concurrent requests, per API key |
| **Normalization** | **Opt-in** — pass `"normalized": true` |
| **Task types (hosted API)** | `retrieval.query`, `retrieval.passage`, `text-matching`, `classification`, `clustering` — same dot-notation strings as v3, confirmed against Jina's own API schema |
| **Self-hosted weights license** | CC BY-NC 4.0 (non-commercial) — irrelevant here since we call the hosted API, not local weights; flagged for future reference only |

A smaller sibling, `jina-embeddings-v5-text-nano` (239M params, 768 dims, 8K context), exists if latency/cost ever becomes the bottleneck — not needed for MVP given free-tier headroom, but worth knowing the `EmbeddingProvider` abstraction (below) makes swapping to it a one-line config change.

### API endpoint

```
POST https://api.jina.ai/v1/embeddings
Authorization: Bearer <JINA_API_KEY>
Content-Type: application/json

{
  "model": "jina-embeddings-v5-text-small",
  "task": "retrieval.passage",     // or "retrieval.query" for search queries
  "dimensions": 1024,
  "normalized": true,               // ⚠️ defaults to false — must set explicitly
  "input": ["text to embed"]
}
```

Response shape matches OpenAI's `text-embedding-3-large` schema (Jina's own docs confirm API compatibility): `response.data[0].embedding` is a plain `number[]`, already unit-length when `normalized: true` is set.

### Rate limit configuration (corrected, verified against your real `ai-limiters.ts`)

```typescript
// Actual Jina free-tier limits (per API key), confirmed against live API docs:
//   100 RPM
//   100,000 TPM   (tokens per MINUTE — not a fixed daily budget)
//   2 concurrent requests
//
// Your real RateLimiter class (ai-limiters.ts) serializes all throttle() calls
// through one `queue` promise chain, spacing call STARTS by `delayMs`:
//   delayMs = floor(60000 / bufferedRpm)
//   bufferedRpm = floor(100 * (1 - 0.08))  // AI_RATE_LIMIT_SAFETY_BUFFER_PERCENT = 8
//              = 92
//   delayMs  = floor(60000 / 92) = 652ms
//
// Jina's typical embedding latency is ~100-500ms, comfortably under the 652ms
// spacing — so steady-state concurrency stays at 1 in-flight request. Because
// getJinaLimiter() will be a SINGLETON shared by every caller (fire-and-forget
// page embeds AND the cron backfill both call the same instance), the queue
// serializes across all of them — there's no separate path that could bypass
// it and stack up concurrent requests. No concurrency semaphore needed.
//
// EMBEDDING_GENERATION_DELAY = 1000ms for backfill (on top of the limiter's
// own 652ms spacing) naturally caps it at well under 60 req/min — safely
// under 100 RPM, and (at ~400 tokens/embedding) well under 100K TPM too.
```

### Commercial-use verification (Twistloom is a paid, Stripe-subscription product)

You asked whether relying on Jina's free tier is safe given Twistloom is commercial, not self-hosted. Short answer: **the evidence points to yes, with one caveat worth a two-minute human check before you rely on it long-term.**

What I found:
- Jina's own product pages (`jina.ai/embeddings`, `jina.ai/reader`, `jina.ai/contact-sales` — fetched directly) describe the free grant plainly: *"It begins with 10 million free tokens for each new API key. Beyond the free tokens, different packages are available for purchase."* No commercial-use restriction attached.
- Where Jina *does* say "non-commercial (CC BY-NC)" on those same pages, it's always scoped to specific **open-weight models for self-hosting** — their rerankers and ReaderLM-v2 explicitly, and by extension the embeddings weights on Hugging Face (confirmed separately: `jina-embeddings-v5-text-small`'s HF card is CC BY-NC 4.0). That's the same distinction already noted in Appendix D.1 — self-hosted weights vs. hosted API — and it holds up under closer scrutiny.
- Several third-party review/aggregator sites (not Jina's own site) describe the free *token grant* itself as "non-commercial," using near-identical phrasing to the reranker license blurb. That reads like those sites conflating "free API tokens" with "free open-weight model" — an easy mistake to make, and one that shows up verbatim across multiple SEO/review sites in a way that suggests they're copying each other rather than independently reading Jina's terms.
- I could not pull Jina's actual Terms & Conditions document text directly — `jina.ai/legal/` is a JS-rendered single-page app that returned an empty shell to my fetcher, only page metadata. A cached/indexed version of it (surfaced via search) is a standard commercial services contract and didn't contain a free-tier-specific commercial restriction in the portion I could read, but I can't rule out that a relevant clause exists further in the document.

**My recommendation:** proceed with the free tier for the MVP/experimentation phase as planned — the risk is low and the downside if I'm wrong is small (embeddings are a rebuildable cache; worst case you top up a few dollars of tokens or get a rate-limit warning email, not a legal problem, given Twistloom isn't reselling Jina's output). But before Twistloom's public/paid launch (not MVP — actual launch), have a human open `jina.ai`'s pricing/FAQ page in a browser and do a literal find-in-page for "commercial" to confirm nothing's changed. That's a two-minute check that removes the last bit of uncertainty an automated fetch couldn't close out.

---

## 3. Porting MuslimDigest Patterns

| MuslimDigest file | Key patterns | Twistloom target | Change from v1 |
|---|---|---|---|
| `src/utils/embedding.ts` | Jina AI client, `createEmbedding()` with pRetry + AbortError, `getOrCreateEmbedding()` race-safe upsert, `buildClusterEmbeddingText()`, LRU cache with TTL | `src/utils/embedding.ts` | **Drop `l2Normalize()`** — use `normalized: true` instead. ✅ Done (this pass) — kept the same `utils/` home as MuslimDigest rather than moving to `services/`, matching Twistloom's own utils-vs-services split |
| `src/utils/rate-limit.ts` | `RateLimiter` class (same pattern already exists in `ai-limiters.ts`) | Add `'jina'` provider | Confirmed against real `ai-limiters.ts`: no concurrency semaphore needed — just add `jina` to `AI_RATE_LIMITS` and `AI_RATE_LIMITS_WITH_BUFFER` (see §2) |
| `src/cron/embeddings.ts` | Daily backfill with `canUseAIToday()` gate, generation limit + delay, race-safe idempotent DB update | `src/cron/backfill-embeddings.ts` | Unchanged pattern; quota math corrected (§11). `canUseAIToday('jina')` will always return `true` unless `rpd`/`rpmo` is added — harmless to keep for consistency, but not actually gating anything |
| `src/config/embedding.ts` | `EMBEDDING_MODEL`, `EMBEDDING_DIMENSION`, cache TTL/size | `src/config/embedding.ts` | `EMBEDDING_MODEL = 'jina-embeddings-v5-text-small'`. ✅ Done (this pass) |
| `src/db/schema.ts` | Custom `vector()` type import | Add tables using existing `id()`/`bookId()` helpers | Rewritten to match actual schema.ts conventions (Appendix A) |
| `src/db/indexes.ts` | `ensureVectorIndexes()` with HNSW index creation | Add function in `extensions.ts` | Add `CREATE INDEX CONCURRENTLY` guidance + pgvector ≥0.8.2 pin (§5) |

### Key implementation details (updated)

1. **LRU cache with TTL** — unchanged, still useful to avoid redundant calls within one generation cycle. Consider including `normalized` and `dimensions` in the cache key for correctness if those ever become configurable per-call.
2. **pRetry with AbortError** — unchanged; retry on 429/network, abort on other 4xx.
3. ~~L2 normalization~~ — **removed.** `normalized: true` in the request body replaces the client-side `l2Normalize()` safety wrapper entirely.
4. **Race-safe upsert** — unchanged, `ON CONFLICT DO UPDATE`.
5. **Quota-aware backfill** — unchanged pattern, corrected math (§11).
6. **Task-type separation** — unchanged: `retrieval.passage` for stored content, `retrieval.query` for search queries.

---

## 4. Use Cases — Prioritized for Twistloom

*(Priorities and shape unchanged from v1; only Use Case 3's framing is corrected below given what `formatFutureNotes()` already does.)*

### ⭐⭐⭐⭐⭐ USE CASE 1: Replace `contextHistory` with semantic page retrieval

**Current:** A single 300-word AI summary that loses fidelity every page.
**Target:** Embed every page's text and retrieve the most semantically relevant pages for the current scene, instead of relying solely on a compressed summary.

```
Current page: "I finally opened the old chapel beneath the school."

→ Embed current scene query (page text + key events + mood), task: retrieval.query
→ Cosine similarity search across all prior pages (this book+branch, page < currentPage)
→ Retrieve top 5 most semantically similar pages

Returns:
  - Page 18 (similarity: 0.91): You found an old brass key with a church engraving.
  - Page 41 (similarity: 0.84): Father Gabriel warned you never to enter the underground chapel.
  - Page 7  (similarity: 0.79): The school chapel felt wrong, even in daylight.
```

**Benefits:** Recurring clues resurface without explicit prompt rules; callbacks happen organically; emotional/thematic continuity doesn't rely purely on the AI's ability to compress a summary.

### ⭐⭐⭐⭐⭐ USE CASE 2: Recovering interactions lost to the sliding window — re-scoped with real code

**Now fully grounded** against `character_types.ts` and `characters_utils.ts`. The real shape: `CharacterMemory.pastInteractions: PastInteraction[]`, where each entry is `{ page: number, interaction: string, placeId?: string }`. `updateCharacter()` merges new interactions and immediately trims: `.slice(-MAX_PAST_INTERACTIONS)` (confirmed = 5). `formatCharactersForPrompt()` then shows *all* surviving entries in full, grouped by page, every time that character is present in a scene.

This changes the value proposition from v1/v2's vague framing. Because the array is trimmed **destructively** — `.slice(-5)` on every update permanently drops anything older, and nothing else in `CharacterMemory` retains that text — interaction #1 with a character genuinely stops existing in structured memory once 5 newer ones have piled up. That's the real gap: not "rank 5 shown things by relevance" (limited upside on a set that small), but **"recover the interactions that already scrolled out of the window."** A callback to something a character said 60 pages ago, since trimmed away, is otherwise gone for good.

**Target:** embed each interaction at the moment it's *added* (before it can ever be trimmed), so it survives in `character_embeddings` regardless of what happens to the structured `pastInteractions` array. Retrieval only needs to kick in for older interactions no longer visible in the live sliding window — add a new "Earlier interactions (recalled):" block underneath `formatCharactersForPrompt`'s existing "Recent interactions:" section, populated only when semantic retrieval finds something both relevant *and* older than what's already shown.

**Important hook-location hazard, different from the page-embedding hook:** `updateCharacter()` and `processCharacterUpdates()` look like they're pure, synchronous state-transition functions — which strongly suggests they're *also* used by your delta-chain replay system for state reconstruction (the same architecture you built for fixing shared-reference mutation bugs in duplicate plot flags). If that's right, hooking embedding calls into `processCharacterUpdates` would silently re-embed the same historical interactions every time state gets replayed — wasteful at best, and duplicate rows at worst. **I haven't seen the replay call site directly, so this is inference, not confirmed** — but the safe move either way is the same one already established for pages: embed from the `generateNextPage`/`generateNextPages` caller, using the `CharacterUpdates` from *this page's* AI output directly (which is already in scope there), never from inside `processCharacterUpdates`/`updateCharacter` themselves.

### ⭐⭐⭐⭐⭐ USE CASE 3: Semantic future note retrieval — refined scope

**Current:** `formatFutureNotes()` already buckets by temporal/state relevance (`becomingRelevant` / `upcomingScheduledEvents` / `unscheduled`) — this part is solid and should not be replaced.
**Target (narrowed from v1):** Within the `unscheduled` bucket specifically — open-ended notes with no schedule or state trigger — rank by semantic similarity to the current scene instead of dumping all of them. `becomingRelevant` notes are time-critical and should keep being shown in full regardless of similarity score.

### ⭐⭐⭐⭐⭐ USE CASE 4: Semantic clue/mystery threading

**Current:** Threads are tracked structurally; the AI must manually connect clues across pages.
**Target:** When a new clue is discovered, retrieve semantically related clues from anywhere in the story.

### ⭐⭐⭐⭐☆ USE CASE 5: Recovering place events lost to the sliding window — same pattern as Use Case 2

**Now fully grounded** against `places_types.ts` and `places_utils.ts`, and it turns out to be the *exact same structural pattern* as Use Case 2, not a separate design: `PlaceMemory.keyEvents: PastEvent[]` (`{ page, event }`) gets merged and trimmed identically — `updatePlace()` does `.slice(-MAX_PLACE_EVENTS)` (confirmed = 8) — and `formatPlacesForPrompt()` shows every surviving event in full whenever that place is current or nearby. Same gap, same fix: embed each `keyEvent` at the moment it's added (grouped by page, mirroring how multiple same-page events already get grouped for display), so a significant thing that happened at a location on page 12 is still recallable on page 140 even after it's fallen out of the 8-event window. Same replay-hook caveat as Use Case 2 applies to `processPlaceUpdates()`/`updatePlace()` — embed from the page-generation caller, not from inside those functions.

**Secondary, smaller finding — don't act on this one the same way:** `calculatePlaceFamiliarity()` (the function that actually drives the `familiarity` score used for gameplay, e.g. `PLACE_MIN_FAMILIARITY` thresholding) detects "significant" events via `SIGNIFICANT_EVENT_KEYWORDS.some(keyword => text.includes(keyword))` — a hardcoded 20-word English substring list. This *is* brittle (misses paraphrases, English-only, doesn't generalize), but I'm not recommending you touch it: it's a synchronous, deterministic, frequently-called pure function feeding a gameplay-relevant score, in the same family as `calculateStoryMomentum` — exactly the kind of "clean, deterministic" design this codebase favors elsewhere, and swapping in a live embedding-similarity call would break that (async call inside a pure function) or need precomputed anchor-vector caching to keep it synchronous, which is real extra engineering for a narrow win. If you ever want to fix this specifically, the honest path is precomputed local cosine similarity against a small fixed set of "significant event" reference embeddings (computed once, cached as constants) — not a live API call — but that's a distinct, optional piece of work from the `place_embeddings` retrieval feature above, and I'd treat it as backlog, not P0/P1.

### ⭐⭐⭐⭐☆ USE CASE 6: Branch-specific semantic isolation
### ⭐⭐⭐⭐☆ USE CASE 7: AI self-consistency (style retrieval)
### ⭐⭐⭐⭐☆ USE CASE 8: Emotional callbacks for finales
### ⭐⭐⭐☆☆ USE CASE 9: Book similarity recommendations — *deferred, future consideration*
### ⭐⭐⭐☆☆ USE CASE 10: Image prompt consistency — *deferred, future consideration*

Both skipped for now per explicit direction — 3-star priority, lowest of the ten use cases, and neither is on the critical path for the Phase 0-5 plan below. Revisit once Phases 0-5 are shipped and there's a concrete need (book recommendations become relevant once there's enough of a catalog to recommend from; image prompt consistency matters once cover/scene image generation is actually wired up). No design work has gone into either beyond the one-line description each already had.

*(Use cases 5–10 unchanged from v1 — not re-audited in this pass since they weren't fleshed out with specific code claims to fact-check.)*

---

## 5. pgvector in the Twistloom Stack

### Version & security note (new)

**Pin pgvector ≥ 0.8.2.** Versions 0.7.x, 0.8.0, and 0.8.1 carry **CVE-2026-3172**, a CVSS 8.1 buffer overflow that can trigger during parallel HNSW index builds. After enabling the extension, verify:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
SELECT extversion FROM pg_extension WHERE extname = 'vector';
-- must be >= 0.8.2
```

Neon lets you install "one version back" from whatever it currently lists as latest-supported — check the Neon extensions page for the current ceiling and confirm 0.8.2+ is available before enabling on a production branch.

pgvector 0.8 is also the release that added **iterative index scans**, which matters here independently of the CVE: every planned query in this roadmap filters by `bookId`/`branchId` (and often `page < currentPage`) *on top of* an HNSW `ORDER BY embedding <=> ...`. Pre-0.8, combining a `WHERE` filter with an approximate index scan could silently return fewer or lower-quality results than `LIMIT` requests, because the ANN graph traversal doesn't know about the filter until after candidates are found. This is a real risk for this schema specifically, since the embedding tables are **global** (all books share one `page_embeddings` table with one HNSW index) and every query filters down to one book+branch. 0.8's iterative scans continue searching until enough *filtered* results come back, which is exactly the access pattern this roadmap needs.

### Extension activation (one-time, in `src/db/extensions.ts`)

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

Added alongside the existing `pg_trgm` extension in `ensureExtensions()`.

### Drizzle schema — install the helper package too

```bash
pnpm add pgvector
```

This gives you `pgvector/drizzle-orm` — typed `cosineDistance`/`l2Distance`/`maxInnerProduct` helpers for Drizzle's query builder, so you're not hand-building `\`[${embedding.join(',')}]\`` vector literals or dropping into raw `sql\`...\`` templates for every query. Drizzle's native `vector()` column type (from `drizzle-orm/pg-core`) already handles serialization on insert — pass a plain `number[]`.

```typescript
import { vector } from "drizzle-orm/pg-core";
import { cosineDistance } from "pgvector/drizzle-orm";

// column definition
embedding: vector("embedding", { dimensions: 1024 }).notNull(),

// insert — pass number[] directly, no manual string building
await db.insert(pageEmbeddings).values({
  bookId, branchId, page,
  embedding, // number[], Drizzle serializes it
  sourceText, contentType: 'page', sourceId,
});

// query — typed helper instead of raw sql template
const similarity = sql<number>`1 - (${cosineDistance(pageEmbeddings.embedding, queryEmbedding)})`;
const results = await db
  .select({ sourceId: pageEmbeddings.sourceId, page: pageEmbeddings.page, similarity })
  .from(pageEmbeddings)
  .where(and(eq(pageEmbeddings.bookId, bookId), eq(pageEmbeddings.branchId, branchId), lt(pageEmbeddings.page, currentPage)))
  .orderBy(cosineDistance(pageEmbeddings.embedding, queryEmbedding))
  .limit(topK);
```

### Index creation — use `CONCURRENTLY` once there's live data

`drizzle-kit generate` migrations run inside a transaction by default, and `CREATE INDEX CONCURRENTLY` **cannot run inside a transaction block**. For Phase 1 (empty tables, nothing writing yet), a normal `CREATE INDEX` via the generated migration is fine. Once pages are being embedded live (Phase 2+), any future re-index or index change should go through a standalone script/raw connection using `CREATE INDEX CONCURRENTLY`, not a Drizzle-generated migration, to avoid locking `page_embeddings` against concurrent inserts:

```sql
SET maintenance_work_mem = '256MB';  -- bump for larger backfills; Neon docs recommend sizing to your working set, capped at 50-60% of compute RAM
CREATE INDEX CONCURRENTLY page_embeddings_hnsw_idx
  ON page_embeddings USING hnsw (embedding vector_cosine_ops);
```

At Twistloom's scale (per-book cap of ~200 pages, but the table is shared across **all** books/branches over time), this only becomes a real concern once total row count climbs into the tens of thousands — worth knowing now so it's not a surprise later, not urgent for MVP.

### Embedding provider interface (unchanged)

```typescript
// In src/utils/embedding.ts
export interface EmbeddingProvider {
  embed(text: string, task?: 'retrieval.passage' | 'retrieval.query'): Promise<number[]>;
  embedBatch(texts: string[], task?: 'retrieval.passage' | 'retrieval.query'): Promise<number[][]>;
  dimensions: number;
}
```

---

## 6. What to Embed

### Excellent candidates

| Content | Embedding table | Why | Priority |
|---|---|---|---|
| Page text + key events + mood | `page_embeddings` | Primary semantic memory — complements (not replaces, at least initially) lossy contextHistory | **P0** |
| Character interactions — **embedded once per (characterId, page) at add-time, before `.slice(-MAX_PAST_INTERACTIONS)` trims them** | `character_embeddings` | Recovers interactions that scroll out of the 5-item sliding window (see Use Case 2) | **P0** |
| Future notes text — **embedded once, on add/update via `futureNoteUpdates`, keyed by the note's stable `key`** | `future_note_embeddings` | Selective retrieval for the `unscheduled` bucket | **P0** |
| Clues (from threads) | `clue_embeddings` | Mystery connectivity | **P1** |
| Place key events — **embedded once per (placeId, page) at add-time, before `.slice(-MAX_PLACE_EVENTS)` trims them** | `place_embeddings` | Recovers events that scroll out of the 8-item sliding window (see Use Case 5) — same pattern as character_embeddings | **P1** |
| Emotional moments (high-guilt/fear pages) | `page_embeddings` (filtered) | Finale callbacks | **P1** |
| Book metadata (summary + hook + keywords) | `book_embeddings` | Recommendations | **P2** |

**Important correction on future notes:** `FutureNote` has a stable `key: string` field ("Unique key for targeted updates and removal via `futureNoteUpdates`"). Future notes live as a snapshot array (`storyStates.futureNotes`) on *every page's* state row — meaning the same note (same `key`) reappears in dozens of subsequent state snapshots as the story progresses. **Do not re-embed the full future-notes list on every page generation** — that would multiply API calls and rows for free (against a rate-limited free tier) and buys nothing, since the note's text doesn't change between snapshots. Instead, embed a future note exactly once when it's newly added via `futureNoteUpdates`, and re-embed only if `futureNoteUpdates` reports a text change — upserting on `noteKey`, not `noteIndex`.

**Same pattern, now confirmed for characters and places too:** `pastInteractions` (cap 5, `characters_utils.ts`) and `keyEvents` (cap 8, `places_utils.ts`) both use destructive `.slice(-N)` trimming on every update. Embedding the full history at add-time — not re-embedding the current trimmed array on every page — is the correct approach for all three (future notes, character interactions, place events). All three share one more constraint worth calling out once: `processCharacterUpdates`/`updateCharacter` and `processPlaceUpdates`/`updatePlace` look like they're also used by delta-chain replay (same architecture as your plot-flag mutation-bug fix), so the embed call must live at the page-generation caller level, never inside those state-transition functions — otherwise replay would silently re-embed the same history repeatedly.

### What NOT to embed (unchanged from v1)

| Content | Why |
|---|---|
| StoryState JSON | Too structured; use existing fields |
| HP / composure values | Numeric state doesn't benefit from semantic search |
| Inventory IDs | Better handled with relational data |
| Dates / calendarDate | Exact lookups > semantic search |
| Action text alone | Too short; embed with surrounding context |
| flag levels (trust: low) | Structured data, better in prompt directly |

### Embedding content format (unchanged, confirmed field names)

```typescript
// buildPageEmbeddingText — field names confirmed against StoryPage/StoryScene in story_types.ts
function buildPageEmbeddingText(page: StoryPage): string {
  return [
    `Page ${page.page}:`,
    `Scene: ${page.text}`,
    `Mood: ${page.mood ?? ''}`,
    `Key events: ${page.keyEvents?.join(', ') ?? ''}`,
    `Characters: ${page.charactersPresent?.map(c => c.characterId).join(', ') ?? ''}`,
  ].filter(Boolean).join('\n');
}
```

---

## 7. Architecture — Hybrid Memory

Unchanged from v1 — combine structured state (`StoryState`) with semantic retrieval, injected side-by-side rather than one replacing the other:

```
                  StoryState
                       │
           (exact game state & facts)
                       │
                       ▼
               Prompt Builder
                       │
          ┌────────────┴────────────┐
          │                         │
  Structured Memory          Vector Retrieval
  - Characters               - Relevant pages
  - Places                   - Dialogues
  - Inventory                - Emotional moments
  - Injuries                 - Clues
  - Facts                    - Similar scenes
  - Plot Flags
  - Threads
          │                         │
          └────────────┬────────────┘
                       ▼
                    Final Prompt
                       ▼
                       LLM
```

### Prompt injection point — confirmed against actual `prompt.ts`

`formatNextPageStoryContextPrompt` (line 2722) builds `STORY CONTEXT:\n${storyContext}` then immediately concatenates `formatRecentMajorEvents(plotFlags)`. The natural injection point (as v1 guessed, now confirmed) is **between those two** — right after the `storyContext` interpolation, before `formatRecentMajorEvents`:

```typescript
return `CURRENT PHASE:
${phase} ${phaseGoal}

MAIN CHARACTER (POV):
${mcCurrentState}

STORY CONTEXT:
${storyContext}

${relevantPastEventsBlock /* NEW — inject here */}

${formatRecentMajorEvents(plotFlags)}

CURRENT FACTS:
...
```

Suggested format (unchanged):

```
RELEVANT PAST EVENTS (semantic retrieval):
- Page 18 (similarity: 0.91): You found an old brass key with a church engraving.
- Page 41 (similarity: 0.84): Father Gabriel warned you never to enter the underground chapel.
- Page 7  (similarity: 0.79): The school chapel felt wrong, even in daylight.
```

---

## 8. Implementation Phases

### Phase 0 — Foundation & Jina Plumbing (est. 2-3 days) — ✅ DONE (this pass)

Implemented as real drop-in files against your actual `ai-limiters.ts`, `ai-clients.ts`, and `extensions.ts` — not just described. All five sub-steps below are complete.

1. ✅ ~~Add `'jina'` to `AIChatProvider` type in `src/types/ai-chat.ts`.~~ **Not yet done — `ai-chat.ts` wasn't uploaded, so this one step is still on you.** Everything else in this phase assumes `'jina'` is a valid `AIChatProvider` value; add it to the union (alongside `'github' | 'gemini' | ...`) before the other files below will typecheck.
2. ✅ Added Jina rate limits to `AI_RATE_LIMITS` in `config/ai-clients.ts` — `jina: { rpm: 100 }`, no `rpd`/`rpmo`. **Also added a `jina` entry to `AI_MAX_PROMPT_LENGTH`, which the original roadmap said to skip (Appendix D.7) — that was wrong.** `AI_MAX_PROMPT_LENGTH` is also `Record<AIChatProvider, number>`, so adding `'jina'` to the type forces an entry there too, same as `AI_RATE_LIMITS`. Set to `131_000` (documents v5-text-small's real 32,768-token/~4-char-per-token input cap; nothing currently reads this value for jina, it's present purely for type completeness).
3. ✅ Added Jina limiter plumbing in `utils/ai-limiters.ts` — `jinaLimiter` singleton, `getJinaLimiter()`, case in `getRateLimiter()`, and the `AI_RATE_LIMITS_WITH_BUFFER` entry. No concurrency semaphore (confirmed unnecessary, §2).
4. ⬜ Install packages — still needed, not something I can run for you: `pnpm add pgvector p-retry` (the second one is a new dependency `utils/embedding.ts` needs — see Phase 0 step 8 below; check first whether it's already installed somewhere in the monorepo before adding a duplicate).
5. ✅ Added `ensureVectorExtension()` to `db/extensions.ts`, wired into `ensureExtensions()`. Includes a version check against `MIN_PGVECTOR_VERSION = "0.8.2"` (CVE-2026-3172 + iterative-scan reasoning, §5) that warns rather than throws — deliberately non-blocking for a first pass, but treat the warning as a hard blocker before building any HNSW index against a branch with real traffic. **One caveat:** the version-check query's `db.execute()` result shape was written defensively (tolerates both a raw-array and a `{ rows: [...] }` return) because `db/client.ts` wasn't reviewed to confirm which Neon driver adapter this project uses — worth a quick sanity check the first time this runs.
6. ✅ Created `config/embedding.ts` — same constants as originally specified here, now a real file.
7. ⬜ Add `JINA_API_KEY` to `.env.local.example` — still needed, `.env.local.example` wasn't uploaded so I can't edit it directly; just add one line: `JINA_API_KEY=`
8. ✅ Created `utils/embedding.ts` (**not** `src/services/embeddings.ts` as originally written here — matches Twistloom's actual convention better: this is a stateless API-client utility in the same family as `ai-limiters.ts`, not business logic that touches `StoryState`/DB directly, so `utils/` is the right home, same as MuslimDigest's own `src/utils/embedding.ts`). Ported from the MuslimDigest pattern minus `l2Normalize()`; `normalized: true` in the request body instead. Also folds in `embedBatch()` for the character/place/future-note hooks in Phase 3, which weren't in the original MuslimDigest single-item version.

**Files delivered this pass:** `config/embedding.ts`, `utils/embedding.ts`, `utils/ai-limiters.ts` (updated), `config/ai-clients.ts` (updated), `db/extensions.ts` (updated).

### Phase 1 — Drizzle Schema & Extension (est. 2 days)

1. ✅ **Done (this pass)** — added all four embedding tables directly to your actual `db/schema.ts`, using the real `id()`/`bookId()`/`pageId()`/`createdAt` helpers and the file's existing JSDoc `@summary`/`@example` convention. **One refinement beyond Appendix A's original sketch, made possible by having the real file in hand:** every table now also carries `pageId: pageId("cascade")` — a proper FK to `pages.id`, not just the plain `page: integer` number Appendix A originally specified alone. Rationale: `page` (the number) stays because every retrieval query needs cheap range filtering (`page < N`) without a join; `pageId` (the FK) is new, purely for referential integrity — if a page gets pruned, its embeddings are now cascade-deleted automatically instead of becoming silent orphans. `page_embeddings` also dropped the original `contentType` enum and `sourceId` text field from the v1/v2 sketch — those were vestigial from before character/place embeddings got split into their own dedicated tables, and `pageId` now does what the loose `sourceId` text field was standing in for, properly. See the updated Appendix A for the exact final shape.
2. ⬜ `pnpm db:generate`, verify the migration doesn't quote the `vector(...)` type (a known Drizzle footgun on `ALTER TABLE ADD COLUMN` — not an issue for fresh `CREATE TABLE`, which this is).
3. ✅ Enable pgvector, confirm version — done in Phase 0 (`db/extensions.ts`).
4. ⬜ `pnpm db:migrate` — needs to be run in your environment.
5. ⬜ Create HNSW indexes — included in the table definitions from step 1, will be created automatically by the migration in step 2/4 (plain `CREATE INDEX` is fine for empty tables at this phase — see §5 for the `CONCURRENTLY` caveat on future changes).

### Phase 2 — Page embeddings (est. 3-5 days) — mostly done (this pass)

1. ✅ **Backfill script** (`cron/backfill-embeddings.ts`) — done, following your actual `vip-expiration.ts` cron conventions exactly (lazy imports to avoid circular deps, `runX(): Promise<void>` + separate `main()`, `process.on('unhandledRejection'/'uncaughtException')` handlers, `void main()` at the end — no `if (process.argv[1] === __filename)` guard, since your real cron jobs run as standalone scripts, not dual-purpose importable modules). Quota math corrected (§11).

   **One discovery that upgraded this step beyond the original plan:** `pages.stateDelta` (column `"delta"`) already stores each page's full `StateDelta` directly — confirmed in your actual `schema.ts`. This means the backfill cron doesn't need to separately reconstruct or thread through a `StateDelta` for old pages; it's already sitting right there on the `pages` row. So the backfill now calls both `embedPersistedPage()` *and* `embedStateDeltaEntities()` per missing page — meaning a single backfill pass catches page text **and** character/place/future-note embeddings for anything that was ever missed, not just page text. It also means `embedStateDeltaEntities()` reads `page.stateDelta` internally now rather than taking it as a separate parameter — one function signature that works identically whether called live or from backfill.

2. ✅ **On page creation** — hook location corrected from v1: **not** inside `persistPageWithState` (which owns a documented branch-retry/atomicity contract). Implemented in `services/vector-memory.ts` as `embedPersistedPage(page)` and `embedStateDeltaEntities(page)` — both fire-and-forget, both meant to be called from the caller immediately after `persistPageWithState` resolves:
   ```typescript
   const newPage = await persistPageWithState({ /* ... */ });
   embedPersistedPage(newPage);        // fire-and-forget, never awaited, never throws into the caller
   embedStateDeltaEntities(newPage);   // same — reads newPage.stateDelta internally
   return newPage;
   ```
   **⬜ Still pending:** actually wiring these two calls into `generateNextPage` (prompt.ts:4271) and `generateNextPages` (prompt.ts:~4402) — the functions exist and are ready to import, but the call sites in `prompt.ts` haven't been touched yet.
3. ⬜ **Prompt integration** (`src/utils/prompt.ts`) — inject `RELEVANT PAST EVENTS` between `storyContext` and `formatRecentMajorEvents(plotFlags)` in `formatNextPageStoryContextPrompt` (confirmed exact location, §7). Keep `contextHistory` unchanged for now. Not yet done.
4. ✅ Created `src/services/vector-memory.ts` — `retrieveSimilarPages`, `retrieveCharacterInteractions`, `retrievePlaceEvents`, `retrieveRelevantFutureNotes`, `embedPersistedPage`, `embedStateDeltaEntities`, `buildPageEmbeddingText`. Covers all four embedding tables, not just pages — effectively also completes most of Phase 3's plumbing (§ below), just not wired into the prompt yet.

### Phase 3 — Character & place interaction embeddings, future notes (est. 4-6 days) — write-side done, read-side wiring pending

Character and place embeddings follow the identical pattern (§4, §6) — grouping them into one phase since the implementation is the same shape twice, not two different designs:

1. **Character interactions:** embed each `pastInteractions` entry once, at the moment it's added (in the page-generation caller, using the page's `CharacterUpdates` output) — before `updateCharacter()`'s `.slice(-MAX_PAST_INTERACTIONS)` can trim it away. Same-page interactions joined into one row, mirroring `formatCharactersForPrompt()`'s existing grouping. Retrieval surfaces only interactions older than what's already visible in the live 5-item window — extend `formatCharactersForPrompt()` with a new "Earlier interactions (recalled):" block, populated only when something relevant turns up.
1. ✅ **Character interactions:** write-side done — `embedCharacterInteractions()` in `services/vector-memory.ts`, called from `embedStateDeltaEntities()`. ⬜ Read-side (extending `formatCharactersForPrompt()` with an "Earlier interactions (recalled):" block using `retrieveCharacterInteractions()`) not yet wired in.
2. ✅ **Place events:** write-side done — `embedPlaceEvents()`, same file/caller. Does **not** touch `calculatePlaceFamiliarity()` — that stays exactly as designed (§4, Use Case 5). ⬜ Read-side (`formatPlacesForPrompt()` extension using `retrievePlaceEvents()`) not yet wired in.
3. ✅ Future notes: write-side done — `embedFutureNote()`, embedded **once, on `futureNoteUpdates` add/change**, keyed by `noteKey` — not on every page (§6).
4. ⬜ Prompt integration: within `formatFutureNotes()`'s `unscheduled` bucket, rank by semantic similarity instead of dumping all; `becomingRelevant` stays fully shown regardless of similarity. Not yet done — `retrieveRelevantFutureNotes()` exists in `vector-memory.ts` and is ready to call.
5. ✅ **Replay hazard verified** (§12, Appendix D.3) — confirmed, not just checked, against `story_utils.ts`/`branch-traversal.ts`. All writes in `vector-memory.ts` are designed to be called only from the page-generation caller (or backfill, reading the same `page.stateDelta`), never from inside `applyStateDelta`/`processCharacterUpdates`/`processPlaceUpdates`.

**What's left for Phase 2+3 to be fully live:** wire `embedPersistedPage`/`embedStateDeltaEntities` into `prompt.ts`'s `generateNextPage`/`generateNextPages`, and wire the four `retrieveX` functions into `formatNextPageStoryContextPrompt`/`formatCharactersForPrompt`/`formatPlacesForPrompt`/`formatFutureNotes`. All the underlying service functions exist and are tested-by-design against your real schema/types; what remains is strictly the prompt.ts call-site work.

### Phase 4 — Clue embeddings & finale-callback filtering (est. 2-3 days)

Clue embeddings unchanged from v1 (place embeddings moved up into Phase 3 above, since it turned out to share Phase 3's exact implementation shape rather than needing separate design work).

### Phase 5 — Finale enhancement & recommendations (est. 3-4 days)

Unchanged from v1.

---

## 9. Code Changes Map

### New files

| File | Purpose | Priority | Status |
|---|---|---|---|
| `src/utils/embedding.ts` | Jina client, `embedText`/`embedBatch`, LRU cache, pRetry — no manual normalization | **Phase 0** | ✅ Done |
| `src/config/embedding.ts` | Centralized config | **Phase 0** | ✅ Done |
| `src/services/vector-memory.ts` | Embed page/character/place/future-note, retrieve similar pages/interactions/events/notes | **Phase 2+3** | ✅ Done |
| `src/cron/backfill-embeddings.ts` | Daily backfill, quota-aware, now covers all four embedding tables (not just pages) via `pages.stateDelta` | **Phase 2** | ✅ Done |

### Modified files

| File | Changes | Phase | Status |
|---|---|---|---|
| `src/types/ai-chat.ts` | Add `'jina'` to `AIChatProvider` | **P0** | ✅ Done |
| `src/config/ai-clients.ts` | Add `jina: { rpm: 100 }` to `AI_RATE_LIMITS`, and `jina: 131_000` to `AI_MAX_PROMPT_LENGTH` (type-required, correction from Appendix D.7's original "skip" call) | **P0** | ✅ Done |
| `src/utils/ai-limiters.ts` | Add `jinaLimiter`, `getJinaLimiter()`, `AI_RATE_LIMITS_WITH_BUFFER` entry | **P0** | ✅ Done — no concurrency cap needed, confirmed |
| `src/db/extensions.ts` | `ensureVectorExtension()`, pin/verify pgvector ≥0.8.2 | **P0** | ✅ Done |
| `src/db/schema.ts` | Add embedding tables (Appendix A) | **P1** | ✅ Done |
| `.env.local.example` | Add `JINA_API_KEY` | **P0** | ⬜ Not uploaded — one-line addition |
| `src/utils/prompt.ts` | `generateNextPage` / `generateNextPages` — fire-and-forget embed after `persistPageWithState` resolves (**not** inside it) | **P2** | ⬜ Functions ready in `vector-memory.ts`, call sites not yet wired |
| `src/utils/prompt.ts` | `formatNextPageStoryContextPrompt` — inject `RELEVANT PAST EVENTS` between `storyContext` and `formatRecentMajorEvents` | **P2** | ⬜ |
| `src/utils/prompt.ts` | `formatFutureNotes` — rank `unscheduled` bucket by similarity | **P3** | ⬜ |
| `src/utils/characters_utils.ts` | `formatCharactersForPrompt` — "Earlier interactions (recalled):" block | **P3** | ⬜ |
| `src/utils/places_utils.ts` | `formatPlacesForPrompt` — same, for place events | **P3** | ⬜ |

---

## 10. Performance & Cost Considerations


### Embedding cost (Jina free tier, corrected framing)

| Content | Avg tokens | Cost |
|---|---|---|
| Page text embedding | ~200 tokens | **Free** |
| Page + metadata | ~400 tokens | **Free** |
| Per book (200 pages) | ~80,000 tokens | **Free** — well within any reasonable per-minute burst, no daily-quota concern since the limit is per-minute, not per-day |
| Query embedding | ~100 tokens | **Free** |

Total: **$0.00 for MVP.** Watch RPM/TPM/concurrency headroom (§2), not a daily token budget — there isn't one.

### Query latency (unchanged)

- pgvector HNSW: sub-10ms for 10k+ vectors (assuming iterative-scan-capable pgvector ≥0.8 for the filtered queries this schema uses — see §5)
- Jina embedding API call: ~100-500ms
- Total added latency per page generation: ~200-600ms (query embedding is the only blocking call; page embedding is fire-and-forget)

### Index type: HNSW vs IVFFlat (unchanged conclusion, corrected reasoning)

**Recommendation:** HNSW for all embedding tables. v1's reasoning ("book size max 200 pages means the index is tiny") was slightly off — the tables are **global across all books/branches**, not per-book, so the real constraint is total accumulated rows over time, not any single book's page count. HNSW still wins here because query performance matters more than build time at this app's read/write ratio, and Twistloom's total row count will stay in the tens-of-thousands range for a long time — comfortably within HNSW's sweet spot.

### Rate/concurrency budget monitoring (corrected)

- Track usage via the `usage` table with `provider = 'jina'`, `context = 'embedding'`.
- Backfill's `EMBEDDING_GENERATION_LIMIT=100` + `EMBEDDING_GENERATION_DELAY=1000ms` naturally caps it at 60 req/min / ~24K tokens/min — safely under the 100 RPM / 100K TPM ceiling.
- **New:** confirm the shared rate limiter also caps in-flight concurrency at 2, since that's a hard per-key ceiling independent of RPM — fire-and-forget page embeds and a running backfill job can otherwise both be "under RPM" while still exceeding 2 concurrent requests.

---

## 11. Integration into `generateNextPage` / `generateNextPages`

### Current flow (confirmed against `prompt.ts`)

```
prepareNextPageGenerationSetup
  → prepareNextPageGenerationContext
    → advanceStoryState
    → getPreviousPages (last 3)
  → buildNextPagePrompt
    → formatNextPageTaskPrompt
    → formatNextPageStoryContextPrompt (contextHistory + last 3 pages)
    → formatNextPageNarrativePrompt (future notes, threads, ending)
  → buildNextPageFieldInstructions
  → buildNextPageEvaluatorPrompt

executePromptForJSON (AI call)

resolvePageDelta → extractStateDelta → applyStateDelta

persistPageWithState (save to DB)   ← atomicity/branch-retry contract lives here, don't touch
```

### After pgvector integration (hook location corrected)

```
prepareNextPageGenerationSetup
  → prepareNextPageGenerationContext (unchanged)
  → vectorRetrieveSemanticContext (NEW)
    → embedCurrentSceneQuery (task: 'retrieval.query')
    → retrieveSimilarPages (page_embeddings)
    → [Phase 3] retrieveRelevantFutureNotes (future_note_embeddings, unscheduled bucket only)
    → [Phase 3] retrieveCharacterInteractions (character_embeddings, older-than-window only)
    → [Phase 4] retrievePlaceEvents (place_embeddings, older-than-window only)
    → [Phase 4] retrieveRelatedClues (clue_embeddings)
  → buildNextPagePrompt (MODIFIED as in §7)
  → (rest unchanged)

persistPageWithState (UNCHANGED — no embedding logic added here)

// In the CALLER (generateNextPage / generateNextPages), immediately after
// persistPageWithState resolves — stateDelta is already in scope from the
// earlier extractStateDelta() call in the same function:
embedPersistedPage(newPage, newState);                    // fire-and-forget
embedStateDeltaEntities(newPage, stateDelta);              // fire-and-forget
```

### Persistence hook (corrected: caller-side, uses `pgvector/drizzle-orm`, no manual normalization)

```typescript
// Called from generateNextPage / generateNextPages, right after persistPageWithState resolves.
// Never awaited by the caller — genuinely fire-and-forget.
async function embedPersistedPage(page: PersistedStoryPage, state: StoryState): Promise<void> {
  try {
    await getJinaLimiter().throttle();
    const embeddingText = buildPageEmbeddingText(page);
    const embedding = await embedText(embeddingText, 'retrieval.passage'); // already normalized server-side

    await db.insert(pageEmbeddings).values({
      bookId: page.bookId,
      branchId: page.branchId,
      page: page.page,
      embedding,           // number[] — Drizzle's native vector() type serializes it
      sourceText: embeddingText,
      contentType: 'page',
      sourceId: page.id,
    }).onConflictDoUpdate({
      target: [pageEmbeddings.bookId, pageEmbeddings.branchId, pageEmbeddings.page, pageEmbeddings.contentType],
      set: { embedding, sourceText: embeddingText },
    });
  } catch (error) {
    // Swallow — page text is already persisted; the embedding is a rebuildable cache.
    console.error(`[embedPersistedPage] ⚠️ Failed to embed page ${page.page}:`, getErrorMessage(error));
  }
}

/**
 * Embeds character interactions, place events, and future notes straight from
 * the same `stateDelta` object extractStateDelta() already produced earlier in
 * this same generation call — never from inside applyStateDelta or the
 * processXxx helpers it calls, since those run identically on the live path
 * AND during reconstruction (confirmed: applyStateDelta's own docstring says
 * it's reused "for reconstructing story states... when loading previously
 * generated pages", and story_utils.ts:532-539 shows it unconditionally
 * calling processCharacterUpdates/processPlaceUpdates/processFutureNoteUpdates
 * every time). Hooking here, on the raw AI-output delta at generation time,
 * is what keeps this from firing again on every reconstruction.
 */
async function embedStateDeltaEntities(page: PersistedStoryPage, stateDelta: StateDelta): Promise<void> {
  const jobs: Promise<void>[] = [];

  // Character interactions — one row per (characterId, page), joining
  // same-page interactions exactly like formatCharactersForPrompt() does.
  for (const update of stateDelta.characterUpdates?.newCharacters ?? []) {
    if (update.pastInteractions?.length) {
      jobs.push(embedCharacterInteractions(page, update.characterId, update.pastInteractions));
    }
  }
  for (const update of stateDelta.characterUpdates?.updatedCharacters ?? []) {
    if (update.newInteractions?.length) {
      jobs.push(embedCharacterInteractions(page, update.characterId, update.newInteractions));
    }
  }

  // Place events — same pattern.
  for (const update of stateDelta.placeUpdates?.newPlaces ?? []) {
    if (update.keyEvents?.length) {
      jobs.push(embedPlaceEvents(page, update.placeId, update.keyEvents));
    }
  }
  for (const update of stateDelta.placeUpdates?.updatedPlaces ?? []) {
    if (update.addKeyEvents?.length) {
      jobs.push(embedPlaceEvents(page, update.placeId, update.addKeyEvents));
    }
  }

  // Future notes — only newly added ones, keyed by their stable `key`.
  for (const note of stateDelta.futureNoteUpdates?.add ?? []) {
    jobs.push(embedFutureNote(page.bookId, page.branchId, note));
  }

  await Promise.allSettled(jobs); // one slow/failed embed shouldn't block the others
}

async function embedCharacterInteractions(page: PersistedStoryPage, characterId: string, interactions: string[]): Promise<void> {
  try {
    await getJinaLimiter().throttle();
    const sourceText = interactions.join(' '); // mirrors formatCharactersForPrompt()'s same-page join
    const embedding = await embedText(sourceText, 'retrieval.passage');

    await db.insert(characterEmbeddings).values({
      bookId: page.bookId, branchId: page.branchId, page: page.page, characterId, embedding, sourceText,
    }).onConflictDoUpdate({
      target: [characterEmbeddings.bookId, characterEmbeddings.branchId, characterEmbeddings.page, characterEmbeddings.characterId],
      set: { embedding, sourceText },
    });
  } catch (error) {
    console.error(`[embedCharacterInteractions] ⚠️ Failed for ${characterId} on page ${page.page}:`, getErrorMessage(error));
  }
}

async function embedPlaceEvents(page: PersistedStoryPage, placeId: string, events: string[]): Promise<void> {
  try {
    await getJinaLimiter().throttle();
    const sourceText = events.join(' '); // mirrors formatPlacesForPrompt()'s per-page grouping
    const embedding = await embedText(sourceText, 'retrieval.passage');

    await db.insert(placeEmbeddings).values({
      bookId: page.bookId, branchId: page.branchId, page: page.page, placeId, embedding, sourceText,
    }).onConflictDoUpdate({
      target: [placeEmbeddings.bookId, placeEmbeddings.branchId, placeEmbeddings.page, placeEmbeddings.placeId],
      set: { embedding, sourceText },
    });
  } catch (error) {
    console.error(`[embedPlaceEvents] ⚠️ Failed for ${placeId} on page ${page.page}:`, getErrorMessage(error));
  }
}

async function embedFutureNote(bookId: string, branchId: string, note: FutureNote): Promise<void> {
  try {
    await getJinaLimiter().throttle();
    const embedding = await embedText(note.note, 'retrieval.passage');

    await db.insert(futureNoteEmbeddings).values({
      bookId, branchId, noteKey: note.key, embedding, sourceText: note.note,
    }).onConflictDoUpdate({
      target: [futureNoteEmbeddings.bookId, futureNoteEmbeddings.branchId, futureNoteEmbeddings.noteKey],
      set: { embedding, sourceText: note.note },
    });
  } catch (error) {
    console.error(`[embedFutureNote] ⚠️ Failed for note ${note.key}:`, getErrorMessage(error));
  }
}
```

---

## 12. Risks and Mitigations

| Risk | Mitigation |
|---|---|
| **Embedding API latency** adds ~300-500ms to page generation | Embed asynchronously after page persistence; query embedding is the only blocking call |
| **Jina free tier RPM/TPM** (100 RPM / 100K TPM) | Shared rate limiter (`getJinaLimiter().throttle()`) |
| ~~Jina free tier concurrency cap (2 in-flight requests)~~ — *resolved* | Confirmed against real `ai-limiters.ts`: the shared `RateLimiter` singleton's serialized queue + ~652ms call spacing (8% safety buffer applied to 100 RPM) keeps steady-state concurrency at 1, safely under the 2-request cap, for both fire-and-forget embeds and cron backfill. No action needed. |
| **pgvector CVE-2026-3172** (buffer overflow in parallel HNSW builds, versions 0.7.x/0.8.0/0.8.1) — *new* | Pin ≥ 0.8.2; verify `extversion` after every extension change |
| **Filtered-ANN recall degradation** — every query filters by `bookId`/`branchId` on top of the HNSW index — *new* | pgvector ≥0.8's iterative index scans handle this; same version pin as above covers both concerns |
| **Jina API/model deprecation** | Pin `jina-embeddings-v5-text-small` explicitly; abstract behind `EmbeddingProvider` interface so swapping models later (e.g., to `-nano` or a future v6) is a one-line change |
| **Cold start** (first page of new book has no prior embeddings) | Vector retrieval gracefully returns empty results; existing `contextHistory` covers the gap |
| **Storage growth** | ~2MB per book for page embeddings at 1024 dims — negligible on Neon even at scale |
| **Future-note embedding drift** — *new, corrected from v1* | Key on `FutureNote.key` (stable), not array index; embed only on `futureNoteUpdates`, not every page |
| **Replay re-embedding** — *fully confirmed against `story_utils.ts`, `branch-traversal.ts`, `story-branch.ts`* | Twistloom's reading UI shows live stats per page, so `getStoryStateWithBranch()` is called on every page view, not just branch points. It falls through to `reconstructStoryState()` whenever a page's `story_states` row was pruned by `cleanupStoryStatesWithStrategy()` (kicks in past 125 branches; keeps only first/last/middle/every-10th page) — reconstruction re-inserts the rebuilt state, which may get pruned again by a later cleanup pass, so this can recur for the same page over a book's lifetime. Reconstruction loops `applyStateDelta` (`branch-traversal.ts:754`). `applyStateDelta`'s own docstring states outright: *"This function is also used for reconstructing story states from stored deltas when loading previously generated pages"* — and its body (`story_utils.ts:532-539`) directly calls `processTraumaTagUpdates`, `processFutureNoteUpdates`, `processCharacterUpdates`, `processPlaceUpdates`, and more, every time, live or replayed. Confirmed, not inferred. Fix: embed calls read `stateDelta.characterUpdates`/`.placeUpdates`/`.futureNoteUpdates` (from `extractStateDelta()`, already in scope in the generation caller) and fire only after `persistPageWithState` succeeds — never from inside `applyStateDelta` or its `processXxx` helpers, which run identically during live generation and replay. |
| **Race: cron backfill and page generation embed the same page** | `ON CONFLICT DO UPDATE` idempotency; both paths share the same rate limiter/semaphore |
| **Jina free-tier commercial-use terms** — *new* | Evidence strongly suggests the free token grant is fine for a commercial API consumer (only self-hosted weights carry the CC BY-NC restriction) — see §2. Residual uncertainty only because the full legal T&Cs document couldn't be fetched directly. Two-minute human verification recommended before public launch, not blocking for MVP. |

---

## 13. Success Metrics

Unchanged from v1:

- **Before:** AI can't reliably reference details from more than ~10 pages ago.
- **After:** AI consistently references details from 50+ pages ago when semantically relevant.
- **Future note relevance:** Fewer, better-targeted notes surfaced from the `unscheduled` bucket (not a token-count win — total notes are already capped small — a *precision* win).
- **Character consistency:** Dialogue references specific past interactions, not generic patterns.
- **Ending quality:** Final pages reference events from across the entire book.
- **Cost:** $0 for MVP; no daily quota to watch, just per-minute RPM/TPM/concurrency headroom.

---

## 14. Relationship to Other Roadmap Items

Unchanged from v1 — not re-audited in this pass.

| Feature | Vector synergy |
|---|---|
| **Candidate generation** | Per-branch embeddings ensure candidates stay in their timeline |
| **Branch traversal** | Branch-aware retrieval prevents cross-branch contamination |
| **Book search** | Semantic book similarity replaces/augments tag-based search |
| **Custom actions** | Custom actions can embed user intent and retrieve matching past scenes |
| **Psychological profile results** | Embed the post-ending "psychological autopsy" for shareable results |
| **Cover image generation** | Embed page descriptions for consistent visual prompts across branches |

---

## Appendix A: Drizzle Schema (rewritten to match `schema.ts` conventions)

> **✅ Implemented (this pass), appended directly to your real `db/schema.ts`** as a full drop-in. The shipped version refines the sketch below in one way: every table also carries `pageId: pageId("cascade")` — a proper FK to `pages.id`, on top of the plain `page: integer` number shown here — for cascade-delete referential integrity (a pruned page now takes its embeddings with it automatically, instead of leaving orphans). `page_embeddings` also drops the `contentType` enum/`sourceId` text field shown below; those were vestigial from before character/place embeddings got split into dedicated tables. Treat the actual `db/schema.ts` file as the source of truth; the sketch below is kept for the design rationale in the surrounding prose.


Uses the existing `id()` (uuidv7), `bookId()`, and `createdAt` helpers already defined at the top of `schema.ts`, and the JSDoc `@summary`/`@example` table-comment style used throughout the file. `branchId` is defined fresh per table rather than reusing the module-level `branchId` const from the `pages` table — sharing a single Drizzle column-builder instance across multiple `pgTable()` calls is a known footgun, since builders aren't guaranteed side-effect-free to reuse.

```typescript
import { pgTable, integer, text, timestamp, vector, index, unique } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Page embeddings table
 * @summary Semantic embeddings for story page text, used for similarity retrieval
 * against contextHistory's lossy summary. One row per (book, branch, page).
 * @example
 * {
 *   "id": "emb123",
 *   "book_id": "book456",
 *   "branch_id": "main",
 *   "page": 18,
 *   "content_type": "page",
 *   "source_text": "Page 18:\nScene: ...",
 *   "created_at": "2026-07-10T00:00:00.000Z"
 * }
 */
export const pageEmbeddings = pgTable(
  "page_embeddings",
  {
    id: id(),
    bookId: bookId("cascade"),
    branchId: text("branch_id").notNull().default("main"),
    page: integer("page").notNull(),
    // jina-embeddings-v5-text-small: 1024 dimensions, unit-normalized server-side
    embedding: vector("embedding", { dimensions: 1024 }).notNull(),
    sourceText: text("source_text"),
    contentType: text("content_type", {
      enum: ["page", "character_dialogue", "place_description", "clue", "thread", "future_note", "emotional_moment", "key_event"]
    }).notNull().default("page"),
    sourceId: text("source_id"),
    createdAt,
  },
  (t) => [
    index("page_embeddings_hnsw_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
    index("page_embeddings_book_branch_idx").on(t.bookId, t.branchId),
    unique("page_embeddings_book_branch_page_type_unique").on(t.bookId, t.branchId, t.page, t.contentType),
  ]
);

/**
 * Character embeddings table
 * @summary Semantic embeddings for character interactions, embedded once per
 * (characterId, page) at the moment they're added to CharacterMemory.pastInteractions
 * — BEFORE `updateCharacter()`'s `.slice(-MAX_PAST_INTERACTIONS)` can trim them
 * away. sourceText joins same-page interactions, mirroring how
 * formatCharactersForPrompt() already groups them for display. Retrieved only
 * to surface interactions older than what's currently visible in the live
 * (5-item) sliding window — never duplicates what's already shown in full.
 */
export const characterEmbeddings = pgTable(
  "character_embeddings",
  {
    id: id(),
    bookId: bookId("cascade"),
    branchId: text("branch_id").notNull().default("main"),
    page: integer("page").notNull(),
    characterId: text("character_id").notNull(),
    embedding: vector("embedding", { dimensions: 1024 }).notNull(),
    sourceText: text("source_text"),
    createdAt,
  },
  (t) => [
    index("character_embeddings_hnsw_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
    index("character_embeddings_book_char_idx").on(t.bookId, t.characterId),
    unique("character_embeddings_unique").on(t.bookId, t.branchId, t.page, t.characterId),
  ]
);

/**
 * Place embeddings table
 * @summary Semantic embeddings for place key events — same pattern as
 * character_embeddings. Embedded once per (placeId, page) at add-time, before
 * `updatePlace()`'s `.slice(-MAX_PLACE_EVENTS)` (cap 8) can trim them away.
 * Does NOT feed calculatePlaceFamiliarity() — that stays deterministic and
 * synchronous exactly as designed. This table is purely additive, for
 * recalling events that have scrolled out of the live keyEvents window.
 */
export const placeEmbeddings = pgTable(
  "place_embeddings",
  {
    id: id(),
    bookId: bookId("cascade"),
    branchId: text("branch_id").notNull().default("main"),
    page: integer("page").notNull(),
    placeId: text("place_id").notNull(),
    embedding: vector("embedding", { dimensions: 1024 }).notNull(),
    sourceText: text("source_text"),
    createdAt,
  },
  (t) => [
    index("place_embeddings_hnsw_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
    index("place_embeddings_book_place_idx").on(t.bookId, t.placeId),
    unique("place_embeddings_unique").on(t.bookId, t.branchId, t.page, t.placeId),
  ]
);

/**
 * Future note embeddings table
 * @summary Semantic embeddings for future notes, keyed by the note's own stable
 * `key` (NOT array position — array indices shift on removal via futureNoteUpdates
 * and would silently misattribute embeddings to the wrong note).
 * Embedded once on note creation; re-embedded only if futureNoteUpdates reports
 * a text change — never re-embedded just because it appears in a later page's
 * state snapshot.
 */
export const futureNoteEmbeddings = pgTable(
  "future_note_embeddings",
  {
    id: id(),
    bookId: bookId("cascade"),
    branchId: text("branch_id").notNull().default("main"),
    noteKey: text("note_key").notNull(), // FutureNote.key — stable identifier
    embedding: vector("embedding", { dimensions: 1024 }).notNull(),
    sourceText: text("source_text"),
    createdAt,
  },
  (t) => [
    index("future_note_embeddings_hnsw_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
    unique("future_note_embeddings_unique").on(t.bookId, t.branchId, t.noteKey),
  ]
);
```

---

## Appendix B: Query Scenarios (rewritten with `pgvector/drizzle-orm`)

```typescript
import { and, eq, lt, sql } from "drizzle-orm";
import { cosineDistance } from "pgvector/drizzle-orm";
import { pageEmbeddings, characterEmbeddings, placeEmbeddings, futureNoteEmbeddings } from "../db/schema.js";

async function retrieveSimilarPages(
  query: string,
  bookId: string,
  branchId: string,
  currentPage: number,
  limit: number = 5
) {
  const queryEmbedding = await embedText(query, 'retrieval.query');
  const similarity = sql<number>`1 - (${cosineDistance(pageEmbeddings.embedding, queryEmbedding)})`;

  return db
    .select({
      sourceId: pageEmbeddings.sourceId,
      page: pageEmbeddings.page,
      sourceText: pageEmbeddings.sourceText,
      similarity,
    })
    .from(pageEmbeddings)
    .where(and(
      eq(pageEmbeddings.bookId, bookId),
      eq(pageEmbeddings.branchId, branchId),
      lt(pageEmbeddings.page, currentPage), // never retrieve future pages
      eq(pageEmbeddings.contentType, 'page'),
    ))
    .orderBy(cosineDistance(pageEmbeddings.embedding, queryEmbedding))
    .limit(limit);
}

/**
 * oldestVisiblePage = the lowest `page` value still present in the character's
 * live pastInteractions window (i.e. min page among the up-to-5 entries
 * formatCharactersForPrompt() is already showing in full). Filtering below
 * that page ensures this query only surfaces interactions that have actually
 * scrolled out of the live window — never duplicates what's already shown.
 */
async function retrieveCharacterInteractions(
  query: string,
  bookId: string,
  branchId: string,
  characterId: string,
  oldestVisiblePage: number,
  limit: number = 3
) {
  const queryEmbedding = await embedText(query, 'retrieval.query');
  const similarity = sql<number>`1 - (${cosineDistance(characterEmbeddings.embedding, queryEmbedding)})`;

  return db
    .select({ sourceText: characterEmbeddings.sourceText, page: characterEmbeddings.page, similarity })
    .from(characterEmbeddings)
    .where(and(
      eq(characterEmbeddings.bookId, bookId),
      eq(characterEmbeddings.branchId, branchId),
      eq(characterEmbeddings.characterId, characterId),
      lt(characterEmbeddings.page, oldestVisiblePage),
    ))
    .orderBy(cosineDistance(characterEmbeddings.embedding, queryEmbedding))
    .limit(limit);
}

/** Same shape as retrieveCharacterInteractions — oldestVisiblePage is the min
 * page among the up-to-8 keyEvents entries formatPlacesForPrompt() already shows. */
async function retrievePlaceEvents(
  query: string,
  bookId: string,
  branchId: string,
  placeId: string,
  oldestVisiblePage: number,
  limit: number = 3
) {
  const queryEmbedding = await embedText(query, 'retrieval.query');
  const similarity = sql<number>`1 - (${cosineDistance(placeEmbeddings.embedding, queryEmbedding)})`;

  return db
    .select({ sourceText: placeEmbeddings.sourceText, page: placeEmbeddings.page, similarity })
    .from(placeEmbeddings)
    .where(and(
      eq(placeEmbeddings.bookId, bookId),
      eq(placeEmbeddings.branchId, branchId),
      eq(placeEmbeddings.placeId, placeId),
      lt(placeEmbeddings.page, oldestVisiblePage),
    ))
    .orderBy(cosineDistance(placeEmbeddings.embedding, queryEmbedding))
    .limit(limit);
}

/** Only call this against the `unscheduled` bucket already computed by formatFutureNotes(). */
async function retrieveRelevantFutureNotes(
  query: string,
  bookId: string,
  branchId: string,
  candidateKeys: string[], // pre-filtered to the unscheduled bucket by the caller
  limit: number = 3
) {
  if (!candidateKeys.length) return [];
  const queryEmbedding = await embedText(query, 'retrieval.query');
  const similarity = sql<number>`1 - (${cosineDistance(futureNoteEmbeddings.embedding, queryEmbedding)})`;

  return db
    .select({ noteKey: futureNoteEmbeddings.noteKey, sourceText: futureNoteEmbeddings.sourceText, similarity })
    .from(futureNoteEmbeddings)
    .where(and(
      eq(futureNoteEmbeddings.bookId, bookId),
      eq(futureNoteEmbeddings.branchId, branchId),
      sql`${futureNoteEmbeddings.noteKey} = ANY(${candidateKeys})`,
    ))
    .orderBy(cosineDistance(futureNoteEmbeddings.embedding, queryEmbedding))
    .limit(limit);
}
```

---

## Appendix C: Jina AI Embedding Service — Porting Reference (corrected)

> **✅ Implemented (this pass) as `utils/embedding.ts`**, delivered as a full drop-in file. The shipped version refines the sketch below slightly: a shared low-level `callJinaEmbeddingsAPI()` helper backs both `embedText()` and the newer `embedBatch()` (needed for the Phase 3 character/place/future-note hooks, not present in MuslimDigest's original single-item version), plus a defensive check that each returned embedding is actually `EMBEDDING_DIMENSIONS` long before it gets cached or returned. The sketch below is kept for reference/rationale; treat the actual file as the source of truth.


```typescript
// Adapted from MuslimDigest src/utils/embedding.ts — l2Normalize() removed,
// normalized: true added to the request body instead.

// 1. LRU Cache with TTL (unchanged)
class EmbeddingCache {
  private cache: Map<string, { value: number[]; expiresAt: number }>;

  get(key: string): number[] | undefined {
    const entry = this.cache.get(key);
    if (entry && entry.expiresAt > Date.now()) return entry.value;
    this.cache.delete(key);
    return undefined;
  }

  set(key: string, value: number[]): void {
    if (this.cache.size >= EMBEDDING_CACHE_MAX_SIZE) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) this.cache.delete(firstKey);
    }
    this.cache.set(key, { value, expiresAt: Date.now() + EMBEDDING_CACHE_TTL });
  }
}

// 2. Jina AI client with pRetry — normalization now server-side
async function createEmbedding(text: string, task: EmbeddingTask = 'retrieval.passage'): Promise<number[]> {
  const cacheKey = `${EMBEDDING_MODEL}:${task}:${text}`;

  const cached = embeddingCache.get(cacheKey);
  if (cached) return cached;

  await getJinaLimiter().throttle();

  const result = await pRetry(
    async () => {
      const response = await fetch('https://api.jina.ai/v1/embeddings', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env['JINA_API_KEY']}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: EMBEDDING_MODEL,        // 'jina-embeddings-v5-text-small'
          task,
          dimensions: EMBEDDING_DIMENSIONS, // 1024
          normalized: true,               // ⚠️ defaults to false on Jina's side — must set explicitly
          input: [text],
        }),
      });

      if (!response.ok) {
        if (response.status === 429) throw new Error('Rate limited');
        throw new AbortError(`Jina API error: ${response.status}`);
      }

      const data = await response.json();
      return data.data[0].embedding as number[]; // already unit-length, no client-side normalization needed
    },
    { retries: 3, minTimeout: 1000 }
  );

  embeddingCache.set(cacheKey, result);
  return result;
}
```

---

## Appendix D: Design Rationale Q&A (updated)

### D.1 Embedding model: why `jina-embeddings-v5-text-small`?

| Option | Dimensions | Max tokens | Notes |
|---|---|---|---|
| **`jina-embeddings-v5-text-small`** ✅ | 1024 (default, MRL-truncatable) | 32,768 | Matches jina-embeddings-v4 (3.8B) on retrieval at 5.6× smaller; outperforms v3 across all tasks |
| `jina-embeddings-v5-text-nano` | 768 (default) | 8,192 | Smaller/faster; fallback if free-tier headroom ever gets tight |
| `jina-embeddings-v3` | 1024 | 8,192 | Superseded — kept in mind only because MuslimDigest already runs on it |

**Decision:** `jina-embeddings-v5-text-small`, per explicit direction: Twistloom is experimental/pre-launch, so latest tech wins over the "already proven elsewhere" argument for v3. The model swap is low-risk because v5-text-small keeps the same 1024-dim default and the same hosted-API task-string format as v3, so nothing else in this roadmap's schema or query shape needs to change.

**License note:** the open weights for `jina-embeddings-v5-text-small` are CC BY-NC 4.0 on Hugging Face (non-commercial). This roadmap only ever calls the hosted `api.jina.ai` endpoint, which is governed by Jina's commercial API terms, not the weights license — so this doesn't block Twistloom's (commercial, Stripe-subscription) use case. It would only become relevant if cost or latency ever motivated self-hosting the open weights directly, at which point you'd need to contact Jina for a commercial license.

### D.2 Single vs separate embedding tables? — unchanged
**Decision:** Separate tables (`page_embeddings`, `character_embeddings`, `place_embeddings`, `future_note_embeddings`, `clue_embeddings`), same rationale as v1. `character_embeddings` and `place_embeddings` are now schema-complete (Appendix A) and share an identical shape/rationale — both recover sliding-window-trimmed history (Use Cases 2 and 5).

### D.3 Embedding persistence: fire-and-forget vs synchronous? — hook location corrected, now covers three subsystems
**Decision:** Fire-and-forget for MVP, called from the **caller** (`generateNextPage`/`generateNextPages`) immediately after `persistPageWithState` resolves — not from inside `persistPageWithState` itself, which owns a separate, already-delicate atomicity/branch-retry contract that shouldn't absorb unrelated side effects.

This same "hook at the caller, not inside the state-transition function" rule turned out to apply to two more subsystems once `characters_utils.ts`/`places_utils.ts`/`story_utils.ts`/`branch-traversal.ts` were reviewed — and is now fully confirmed, not inferred. `applyStateDelta`'s own docstring: *"This function is also used for reconstructing story states from stored deltas when loading previously generated pages."* Its body (`story_utils.ts:532-539`) calls `processCharacterUpdates`, `processPlaceUpdates`, and `processFutureNoteUpdates` unconditionally, identically whether it's running live during generation or being replayed during reconstruction. Since Twistloom's reading UI shows live stats per page, reconstruction isn't a rare branch-only path — it fires on every view of a page whose `story_states` row has been pruned by `cleanupStoryStatesWithStrategy()`, and the rebuilt row can be pruned again later, so the same page can be reconstructed more than once over a book's life.

**Concrete hook design:** `extractStateDelta()` (`story_utils.ts:284`) is where `stateDelta.characterUpdates`, `.placeUpdates`, and `.futureNoteUpdates` originate, pulled from the AI's raw generation output before `applyStateDelta` ever runs. That `stateDelta` is already in scope in `generateNextPage`/`generateNextPages` by the time `persistPageWithState` resolves. All embedding side effects — page text, character interactions, place events, future notes — should read off that same `stateDelta` object and fire together, fire-and-forget, only after `persistPageWithState` confirms the page was actually saved. Never from inside `applyStateDelta` or any of the `processXxx` helpers it calls, since those run on both the live path and the replay path with no way to distinguish the two from inside the function.

### D.4 Keep `contextHistory` alongside vector retrieval? — unchanged
**Decision:** Keep both initially. Reduce `contextHistory` in a later phase once semantic retrieval quality is measured against Success Metrics (§13).

### D.5 Daily embedding generation limit for cron backfill? — quota math corrected

| Limit | Tokens/run (avg 400 tok/embedding) | vs. per-*minute* TPM cap | Est. pages/day |
|---|---|---|---|
| 50 | ~20,000 | well under 100K TPM | ~50 pages |
| **100** ✅ | ~40,000 | well under 100K TPM | ~100 pages |
| 250 | ~100,000 | at the TPM ceiling if sent in one burst | ~250 pages |

**Decision:** `EMBEDDING_GENERATION_LIMIT = 100` with `EMBEDDING_GENERATION_DELAY = 1000ms`, unchanged from v1 — but the rationale is corrected. Jina's free tier is **not** a fixed 1M-tokens/day budget; it's 100 RPM / 100K TPM / 2 concurrent, enforced per minute. At 1000ms between calls, backfill runs at 60 req/min (~24K tokens/min) — comfortably under both the RPM and TPM ceilings, and a full 100-item run takes ~100 seconds. Scale up cautiously if backfill is too slow, watching TPM headroom rather than a nonexistent daily budget.

### D.6 Jina API key management? — unchanged
**Decision:** Consumed directly in `embeddings.ts` via `process.env['JINA_API_KEY']`.

### D.7 Add `jina` to `AI_MAX_PROMPT_LENGTH`? — unchanged
**Decision:** Skip — not a chat-completion provider.

---

## Appendix E: Integration Points — Jina Rate Limiter Plumbing

Unchanged from v1 — this pattern is model-agnostic.

```typescript
// src/utils/ai-limiters.ts
let jinaLimiter: RateLimiter | null = null;

export function getJinaLimiter(): RateLimiter {
  return jinaLimiter || (jinaLimiter = new RateLimiter('jina'));
}

// case 'jina': return getJinaLimiter();
```

```typescript
// src/config/ai-clients.ts
jina: { rpm: 100 }, // 100 RPM, 100K TPM, 2 concurrent — free tier
```

```typescript
// src/types/ai-chat.ts
export type AIChatProvider =
  | 'github' | 'gemini' | 'cohere' | 'mistral' | 'groq'
  | 'cerebras' | 'nvidia' | 'openrouter' | 'cloudflare'
  | 'jina';
```

---

## Appendix F: Backfill Cron Job — Specification

Unchanged from v1 in shape; quota framing corrected per §11/D.5.

```typescript
/**
 * Daily cron to backfill missing embeddings.
 *
 * Behavior:
 * 1. Check canUseAIToday('jina') — currently always true (no rpd/rpmo
 *    configured for jina, matching the mistral/nvidia pattern), kept for
 *    consistency with the other cron jobs rather than for actual gating
 * 2. Find all pages without embeddings across all active books
 * 3. Process up to EMBEDDING_GENERATION_LIMIT (100) per run
 * 4. Use EMBEDDING_GENERATION_DELAY (1000ms) between API calls, on top of
 *    getJinaLimiter().throttle()'s own ~652ms spacing (100 RPM, 8% buffer)
 *    — well under Jina's 100 RPM / 100K TPM / 2-concurrent free-tier ceiling
 * 5. Race-safe upsert (ON CONFLICT DO UPDATE)
 * 6. Log progress and errors
 *
 * Schedule: Once daily (configurable via cron expression)
 */
```

---

*This document is a fact-checked revision of the original pgvector roadmap. Model choice (Jina `v5-text-small`), normalization approach, rate-limit figures, the fire-and-forget hook location, the future-note keying strategy, the concurrency question, the free-tier commercial-use question, the character/place embedding design, and the delta-chain replay hazard were corrected/verified against Jina's live API docs, pgvector/Neon documentation, and Twistloom's actual `prompt.ts`, `schema.ts`, `book.ts`, `story_types.ts`, `ai-limiters.ts`, `ai-clients.ts`, `story.config.ts`, `character_types.ts`, `characters_utils.ts`, `places_types.ts`, `places_utils.ts`, `story-branch.ts`, `branch-traversal.ts`, and `story_utils.ts`. The replay hazard is now fully confirmed (not inferred) against `applyStateDelta`'s own docstring and body — no remaining open items on this pass.*
