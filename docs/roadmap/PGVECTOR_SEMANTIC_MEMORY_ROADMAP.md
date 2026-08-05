# pgvector Semantic Memory — Twistloom Implementation Roadmap (v2)

**Status:** Research / Ready for Phase 0
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
| 10 | No mention of concurrency cap | Jina free tier caps **2 concurrent requests** per key. Fire-and-forget page embedding + cron backfill sharing one `JINA_API_KEY` could collide on this if the existing `RateLimiter` class only throttles by RPM and not by concurrency. Worth a quick check of `ai-limiters.ts`. | §11, §13 |
| 11 | Self-hosting license | Not previously discussed. `jina-embeddings-v5-text-small`'s open weights on Hugging Face are **CC BY-NC 4.0** (non-commercial). This only matters if you ever self-host the model instead of calling `api.jina.ai` — the hosted API is governed by Jina's commercial API terms, not the weights license, so the roadmap's approach (hosted API only) is unaffected. Flagging so it doesn't surprise you later if cost/latency ever motivates self-hosting. | Appendix D.1 |

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

### Rate limit configuration (corrected)

```typescript
// Actual Jina free-tier limits (per API key), confirmed against live API docs:
//   100 RPM
//   100,000 TPM   (tokens per MINUTE — not a fixed daily budget)
//   2 concurrent requests
//
// The MuslimDigest RateLimiter pattern already throttles by RPM. Two things
// to double-check when porting it here:
//   1. Does RateLimiter also cap concurrency, or only requests/minute?
//      Jina's 2-concurrent-request ceiling is a HARD per-key cap — if
//      fire-and-forget page embedding and the cron backfill both fire at
//      once, RPM throttling alone won't prevent a 3rd/4th in-flight request.
//      If ai-limiters.ts doesn't already support a concurrency semaphore,
//      add a simple mutex(2) around Jina calls specifically.
//   2. EMBEDDING_GENERATION_DELAY = 1000ms between backfill calls naturally
//      caps backfill at 60 req/min — safely under 100 RPM, and (at ~400
//      tokens/embedding) ~24K tokens/min — safely under 100K TPM. No change
//      needed to the delay value, just to the "why" (per-minute, not "% of
//      a 1M/day budget" as v1 stated).
```

---

## 3. Porting MuslimDigest Patterns

| MuslimDigest file | Key patterns | Twistloom target | Change from v1 |
|---|---|---|---|
| `src/utils/embedding.ts` | Jina AI client, `createEmbedding()` with pRetry + AbortError, `getOrCreateEmbedding()` race-safe upsert, `buildClusterEmbeddingText()`, LRU cache with TTL | `src/services/embeddings.ts` | **Drop `l2Normalize()`** — use `normalized: true` instead |
| `src/utils/rate-limit.ts` | `RateLimiter` class (same pattern already exists in `ai-limiters.ts`) | Add `'jina'` provider | Verify it supports a concurrency cap, not just RPM (see §2) |
| `src/cron/embeddings.ts` | Daily backfill with `canUseAIToday()` gate, generation limit + delay, race-safe idempotent DB update | `src/cron/backfill-embeddings.ts` | Unchanged pattern; quota math corrected (§11) |
| `src/config/embedding.ts` | `EMBEDDING_MODEL`, `EMBEDDING_DIMENSION`, cache TTL/size | `src/config/embedding.ts` | `EMBEDDING_MODEL = 'jina-embeddings-v5-text-small'` |
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

### ⭐⭐⭐⭐⭐ USE CASE 2: Semantic character conversation retrieval

**Current:** Character context sends full `CharacterMemory` (bio, traits, relationshipToMC), capped past-interaction history, but no similarity-based retrieval.
**Target:** When a character re-appears, retrieve past interactions semantically relevant to the current situation.

> Note: this section is grounded against `story_types.ts` (`SceneCharacter.characterId` confirmed) but **not** against `character.ts` (not reviewed in this pass — `CharacterMemory`/`pastInteractions` shape wasn't independently verified). Send that file if you want this use case fully fact-checked the way Use Case 1 now is.

### ⭐⭐⭐⭐⭐ USE CASE 3: Semantic future note retrieval — refined scope

**Current:** `formatFutureNotes()` already buckets by temporal/state relevance (`becomingRelevant` / `upcomingScheduledEvents` / `unscheduled`) — this part is solid and should not be replaced.
**Target (narrowed from v1):** Within the `unscheduled` bucket specifically — open-ended notes with no schedule or state trigger — rank by semantic similarity to the current scene instead of dumping all of them. `becomingRelevant` notes are time-critical and should keep being shown in full regardless of similarity score.

### ⭐⭐⭐⭐⭐ USE CASE 4: Semantic clue/mystery threading

**Current:** Threads are tracked structurally; the AI must manually connect clues across pages.
**Target:** When a new clue is discovered, retrieve semantically related clues from anywhere in the story.

### ⭐⭐⭐⭐☆ USE CASE 5: Scene-of-place semantic recall
### ⭐⭐⭐⭐☆ USE CASE 6: Branch-specific semantic isolation
### ⭐⭐⭐⭐☆ USE CASE 7: AI self-consistency (style retrieval)
### ⭐⭐⭐⭐☆ USE CASE 8: Emotional callbacks for finales
### ⭐⭐⭐☆☆ USE CASE 9: Book similarity recommendations
### ⭐⭐⭐☆☆ USE CASE 10: Image prompt consistency

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
// In src/services/embeddings.ts
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
| Character dialogue + interactions | `character_embeddings` | Personality and relationship consistency | **P0** |
| Future notes text — **embedded once, on add/update via `futureNoteUpdates`, keyed by the note's stable `key`** | `future_note_embeddings` | Selective retrieval for the `unscheduled` bucket | **P0** |
| Clues (from threads) | `clue_embeddings` | Mystery connectivity | **P1** |
| Place descriptions on visit | `place_embeddings` | Environmental recall across revisits | **P1** |
| Emotional moments (high-guilt/fear pages) | `page_embeddings` (filtered) | Finale callbacks | **P1** |
| Book metadata (summary + hook + keywords) | `book_embeddings` | Recommendations | **P2** |

**Important correction on future notes:** `FutureNote` has a stable `key: string` field ("Unique key for targeted updates and removal via `futureNoteUpdates`"). Future notes live as a snapshot array (`storyStates.futureNotes`) on *every page's* state row — meaning the same note (same `key`) reappears in dozens of subsequent state snapshots as the story progresses. **Do not re-embed the full future-notes list on every page generation** — that would multiply API calls and rows for free (against a rate-limited free tier) and buys nothing, since the note's text doesn't change between snapshots. Instead, embed a future note exactly once when it's newly added via `futureNoteUpdates`, and re-embed only if `futureNoteUpdates` reports a text change — upserting on `noteKey`, not `noteIndex`.

### What NOT to embed (unchanged from v1)

| Content | Why |
|---|---|
| StoryState JSON | Too structured; use existing fields |
| HP / composure values | Numeric state doesn't benefit from semantic search |
| Inventory IDs | Better handled with relational data |
| Dates / calendarDate | Exact lookups > semantic search |
| Action text alone | Too short; embed with surrounding context |
| flag levels (trust: low) | Structured data, better in prompt directly |

### Embedding content format (confirmed field names)

```typescript
// buildPageEmbeddingText — field names confirmed against StoryPage/StoryScene in story_types.ts
// Deliberately no "Page N:" label: the page number lives in the structured `page` column and is
// added contextually at render time ("- Page 18 (similarity: 0.91): Scene: …"), so the embedded
// text stays pure semantic content.
function buildPageEmbeddingText(page: StoryPage): string {
  return [
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

### Phase 0 — Foundation & Jina Plumbing (est. 2-3 days)

1. Add `'jina'` to `AIChatProvider` type in `src/types/ai-chat.ts`.
2. Add Jina rate limits to `AI_RATE_LIMITS` in `src/config/ai-clients.ts`:
   ```typescript
   jina: { rpm: 100 }, // 100 RPM, 100K TPM, 2 concurrent — free tier, per API key
   ```
3. Add Jina limiter plumbing in `src/utils/ai-limiters.ts` — `jinaLimiter` singleton, `getJinaLimiter()`, case in `getRateLimiter()`. **Check whether `RateLimiter` enforces concurrency, not just RPM** — if not, add a size-2 semaphore around Jina calls.
4. Install packages:
   ```bash
   pnpm add pgvector
   ```
5. Add vector extension to `src/db/extensions.ts` — `ensureVectorExtension()` alongside `ensurePgTrgmExtension()`. Verify version ≥ 0.8.2 (§5).
6. Create `src/config/embedding.ts`:
   ```typescript
   export const EMBEDDING_MODEL = 'jina-embeddings-v5-text-small';
   export const EMBEDDING_DIMENSIONS = 1024;
   export const MAX_VECTOR_RESULTS_PER_QUERY = 5;
   export const MAX_VECTOR_RESULTS_FINALE = 15;
   export const EMBEDDING_SIMILARITY_THRESHOLD = 0.5;
   export const VECTOR_INDEX_TYPE = 'hnsw';
   export const EMBEDDING_CACHE_TTL = 5 * 60 * 1000;
   export const EMBEDDING_CACHE_MAX_SIZE = 100;
   export const EMBEDDING_GENERATION_LIMIT = 100; // per cron run
   export const EMBEDDING_GENERATION_DELAY = 1000; // ms between calls — keeps us at 60 req/min, well under 100 RPM / 100K TPM
   ```
7. Add `JINA_API_KEY` to `.env.local.example`.
8. Create `src/services/embeddings.ts` — port from MuslimDigest **minus** the `l2Normalize()` step; add `normalized: true` to the request body instead (Appendix C).

### Phase 1 — Drizzle Schema & Extension (est. 2 days)

1. Add embedding tables to `src/db/schema.ts` using existing `id()`/`bookId()` helpers and JSDoc table-comment convention (Appendix A).
2. `pnpm db:generate`, verify the migration doesn't quote the `vector(...)` type (a known Drizzle footgun on `ALTER TABLE ADD COLUMN` — not an issue for fresh `CREATE TABLE`, which this is).
3. Enable pgvector, confirm version.
4. `pnpm db:migrate`.
5. Create HNSW indexes (plain `CREATE INDEX` is fine for empty tables at this phase — see §5 for the `CONCURRENTLY` caveat on future changes).

### Phase 2 — Page embeddings (est. 3-5 days)

1. **Backfill script** (`src/cron/backfill-embeddings.ts`) — same shape as v1, quota math corrected (§11).
2. **On page creation** — hook location corrected from v1: **not** inside `persistPageWithState` (which owns a documented branch-retry/atomicity contract). Instead, fire-and-forget immediately after each call site awaits it:
   - In `generateNextPage` (prompt.ts:4271): after `const newPage = await persistPageWithState({...})`, before `return newPage`.
   - In `generateNextPages` (prompt.ts:~4402): inside the existing `try` block, right after `const newPage = await persistPageWithState({...})` and before `newPages.push(newPage)`.
   ```typescript
   const newPage = await persistPageWithState({ /* ... */ });
   embedPersistedPage(newPage, newState).catch(err =>
     console.error(`[${context}] ⚠️ Failed to embed page ${newPage.page}:`, getErrorMessage(err))
   ); // fire-and-forget, never awaited, never throws into the caller
   return newPage;
   ```
3. **Prompt integration** (`src/utils/prompt.ts`) — inject `RELEVANT PAST EVENTS` between `storyContext` and `formatRecentMajorEvents(plotFlags)` in `formatNextPageStoryContextPrompt` (confirmed exact location, §7). Keep `contextHistory` unchanged for now.
4. Create `src/services/vector-memory.ts` — `retrieveSimilarPages`, `embedPersistedPage`, `buildPageEmbeddingText`.

### Phase 3 — Character & future note embeddings (est. 3-5 days)

1. Character dialogue/interactions embedded per page generation (pending character.ts review — see Use Case 2 note, §4).
2. Future notes embedded **once, on `futureNoteUpdates` add/change**, keyed by `noteKey` — not on every page (§6).
3. Prompt integration: within `formatFutureNotes()`'s `unscheduled` bucket, rank by semantic similarity instead of dumping all; `becomingRelevant` stays fully shown regardless of similarity.

### Phase 4 — Clue & place embeddings (est. 2-3 days)

Unchanged from v1.

### Phase 5 — Finale enhancement & recommendations (est. 3-4 days)

Unchanged from v1.

---

## 9. Code Changes Map

### New files

| File | Purpose | Priority |
|---|---|---|
| `src/services/embeddings.ts` | Jina client, embed/embedBatch, LRU cache, pRetry — no manual normalization | **Phase 0** |
| `src/config/embedding.ts` | Centralized config | **Phase 0** |
| `src/services/vector-memory.ts` | Embed page, retrieve similar pages | **Phase 2** |
| `src/cron/backfill-embeddings.ts` | Daily backfill, quota-aware | **Phase 2** |

### Modified files

| File | Changes | Phase |
|---|---|---|
| `src/types/ai-chat.ts` | Add `'jina'` to `AIChatProvider` | **P0** |
| `src/config/ai-clients.ts` | Add `jina: { rpm: 100 }` | **P0** |
| `src/utils/ai-limiters.ts` | Add `jinaLimiter`, `getJinaLimiter()`; verify/add concurrency cap | **P0** |
| `src/db/extensions.ts` | `ensureVectorExtension()`, pin/verify pgvector ≥0.8.2 | **P0** |
| `src/db/schema.ts` | Add embedding tables (Appendix A) | **P1** |
| `.env.local.example` | Add `JINA_API_KEY` | **P0** |
| `src/utils/prompt.ts` | `generateNextPage` / `generateNextPages` — fire-and-forget embed after `persistPageWithState` resolves (**not** inside it) | **P2** |
| `src/utils/prompt.ts` | `formatNextPageStoryContextPrompt` — inject `RELEVANT PAST EVENTS` between `storyContext` and `formatRecentMajorEvents` | **P2** |
| `src/utils/prompt.ts` | `formatFutureNotes` — rank `unscheduled` bucket by similarity | **P3** |

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
    → [Phase 3] retrieveCharacterInteractions (character_embeddings)
    → [Phase 4] retrieveRelatedClues (clue_embeddings)
  → buildNextPagePrompt (MODIFIED as in §7)
  → (rest unchanged)

persistPageWithState (UNCHANGED — no embedding logic added here)

// In the CALLER (generateNextPage / generateNextPages), immediately after
// persistPageWithState resolves:
embedPersistedPage(newPage, newState)  // fire-and-forget, .catch()'d, never awaited
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
```

---

## 12. Risks and Mitigations

| Risk | Mitigation |
|---|---|
| **Embedding API latency** adds ~300-500ms to page generation | Embed asynchronously after page persistence; query embedding is the only blocking call |
| **Jina free tier RPM/TPM** (100 RPM / 100K TPM) | Shared rate limiter (`getJinaLimiter().throttle()`) |
| **Jina free tier concurrency cap (2 in-flight requests)** — *new* | Confirm/add a concurrency semaphore in `ai-limiters.ts`; RPM throttling alone doesn't prevent overrunning this |
| **pgvector CVE-2026-3172** (buffer overflow in parallel HNSW builds, versions 0.7.x/0.8.0/0.8.1) — *new* | Pin ≥ 0.8.2; verify `extversion` after every extension change |
| **Filtered-ANN recall degradation** — every query filters by `bookId`/`branchId` on top of the HNSW index — *new* | pgvector ≥0.8's iterative index scans handle this; same version pin as above covers both concerns |
| **Jina API/model deprecation** | Pin `jina-embeddings-v5-text-small` explicitly; abstract behind `EmbeddingProvider` interface so swapping models later (e.g., to `-nano` or a future v6) is a one-line change |
| **Cold start** (first page of new book has no prior embeddings) | Vector retrieval gracefully returns empty results; existing `contextHistory` covers the gap |
| **Storage growth** | ~2MB per book for page embeddings at 1024 dims — negligible on Neon even at scale |
| **Future-note embedding drift** — *new, corrected from v1* | Key on `FutureNote.key` (stable), not array index; embed only on `futureNoteUpdates`, not every page |
| **Race: cron backfill and page generation embed the same page** | `ON CONFLICT DO UPDATE` idempotency; both paths share the same rate limiter/semaphore |

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
 *   "source_text": "Scene: ...",
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
 * @summary Semantic embeddings for character dialogue/interactions, retrieved
 * when a character re-appears to surface relevant past exchanges.
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
import { pageEmbeddings, characterEmbeddings, futureNoteEmbeddings } from "../db/schema.js";

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

async function retrieveCharacterInteractions(
  query: string,
  bookId: string,
  branchId: string,
  characterId: string,
  currentPage: number,
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
      lt(characterEmbeddings.page, currentPage),
    ))
    .orderBy(cosineDistance(characterEmbeddings.embedding, queryEmbedding))
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
**Decision:** Separate tables (`page_embeddings`, `character_embeddings`, `future_note_embeddings`, `clue_embeddings`, `place_embeddings`), same rationale as v1.

### D.3 Embedding persistence: fire-and-forget vs synchronous? — hook location corrected
**Decision:** Fire-and-forget for MVP, called from the **caller** (`generateNextPage`/`generateNextPages`) immediately after `persistPageWithState` resolves — not from inside `persistPageWithState` itself, which owns a separate, already-delicate atomicity/branch-retry contract that shouldn't absorb unrelated side effects.

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
 * 1. Check canUseAIToday('jina') — skip if rate-limited
 * 2. Find all pages without embeddings across all active books
 * 3. Process up to EMBEDDING_GENERATION_LIMIT (100) per run
 * 4. Use EMBEDDING_GENERATION_DELAY (1000ms) between API calls —
 *    naturally caps at 60 req/min / ~24K tokens/min, well under
 *    Jina's 100 RPM / 100K TPM free-tier ceiling
 * 5. Race-safe upsert (ON CONFLICT DO UPDATE)
 * 6. Log progress and errors
 *
 * Schedule: Once daily (configurable via cron expression)
 */
```

---

*This document is a fact-checked revision of the original pgvector roadmap. Model choice (Jina `v5-text-small`), normalization approach, rate-limit figures, the fire-and-forget hook location, and the future-note keying strategy were corrected against Jina's live API docs, pgvector/Neon documentation, and Twistloom's actual `prompt.ts`/`schema.ts`/`book.ts`/`story_types.ts`. Use Case 2 (character embeddings) still needs `character.ts` for full verification — send it if you want that section held to the same standard as the rest.*
