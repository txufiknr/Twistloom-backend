# pgvector Semantic Memory — Twistloom Implementation Roadmap

**Status:** Research / Ready for Phase 0  
**Database:** Neon PostgreSQL + pgvector extension  
**Stack:** Drizzle ORM, TypeScript, Jina AI embeddings (free tier)  
**Pattern source:** MuslimDigest (`src/utils/embedding.ts`, `src/utils/rate-limit.ts`, `src/cron/embeddings.ts`)  
**Document grounded against:** `src/utils/prompt.ts`, `src/utils/story.ts`, `src/types/story.ts`, `src/config/story.ts`, `src/config/embedding.ts`, `src/types/prompt.ts`, `src/config/ai-clients.ts`, `src/utils/ai-limiters.ts`, `src/db/extensions.ts`, `src/types/ai-chat.ts`

---

## 0. Why pgvector for Twistloom

Twistloom is already on **Neon PostgreSQL** with **Drizzle ORM**. Adding `pgvector` requires no new infrastructure, no Pinecone/Weaviate/Milvus, no extra network calls to a vector database. It's a `CREATE EXTENSION vector` + a new table.

> **Vector databases are not "memory". They're semantic retrieval engines.**  
> They answer: *"What previous information is most relevant to the current situation?"*  
> Instead of: *"What happened on page 137?"*

---

## 1. Current Memory Architecture — Analysis

### What the prompt sends today (`src/utils/prompt.ts`)

When generating page N, the AI receives:

| Section | Source | Size/Cap |
|---|---|---|
| **contextHistory** | AI-summarized running summary from page 1 to N-1 | 300 words (`MAX_WORDS_SUMMARIZED_CONTEXT`) |
| **Previous Pages** | Last 3 pages full text + selected action + hints | 3 pages (`MAX_PAGE_HISTORY = 3`) |
| **Older Plot Flags** | Condensed bullet-points of flags beyond the sliding window | 15 max (`MAX_OLDER_PLOT_FLAGS`) |
| **Recent Major Events** | Last 5 major plot events | 5 max (`MAX_RECENT_MAJOR_EVENTS`) |
| **Current Facts** | Most recent value per fact key from `factsHistory` | Variable (every fact key) |
| **Future Notes** | All future notes, bucketed into 3 sections | 10 max (`MAX_FUTURE_NOTES`) |
| **Characters** | Full CharacterMemory for characters present | 6 max (`MAX_CHARACTERS`) |
| **Places** | Full PlaceMemory for current place | 6 max (`MAX_PLACES`) |
| **Active Threads** | All open threads with clues | 5 max (`MAX_ACTIVE_THREADS`) |

### Key limitations

1. **`contextHistory` is a single lossy summary** (`src/utils/prompt.ts:691`, `src/utils/story.ts:308`). Every page the AI compresses 300 words of running summary. Details from page 20 are barely recognizable by page 80. Semantic connections between early and late events are severed.

2. **Full-text window is only 3 pages** (`src/config/story.ts:98`). The AI literally cannot reference a detail from page 15 when generating page 84 unless it survived into `factsHistory`, plot flags, or `contextHistory`. Plot flags are structured ("page 18: [clue_found] found a key"), but the *emotional weight*, *sensory texture*, and *narrative framing* of the original scene are gone.

3. **Future notes are all sent to every prompt** (`src/utils/prompt.ts:2814-2823`). The system *buckets* them (Becoming Relevant / Future Payoffs / Unscheduled) but still serializes all `MAX_FUTURE_NOTES = 10` regardless of whether they relate to the current scene. A future note about "reveal hospital basement" is equally present whether the MC is in the hospital or in a forest.

4. **FactsHistory is structured, not semantic** (`src/types/story.ts:1437`). `key: "character.emma.trust"` → `value: "suspicious"` is deterministic and correct, but the *narrative context* around *how* and *why* that trust eroded is lost unless preserved in the 300-word summary.

5. **No semantic clustering or similarity search**. The AI cannot ask "what previous scene is most similar to what's happening now?" — it only knows chronological neighbors (last 3 pages). A scene in the hospital basement has no way to retrieve the *other* basement scene from page 23 that shared the same oppressive mood.

6. **Character/place retrieval is deterministic** — always sends full CharacterMemory for characters in `charactersPresent`, but cannot retrieve "past conversations with this character that are semantically similar to the current situation."

### What the LLM actually receives (approximate token count for a page-80 generation)

```
contextHistory            ~400 tokens  (300 words)
Previous 3 pages          ~900 tokens  (3 × 120 words + metadata)
Older plot flags          ~300 tokens
Recent major events       ~100 tokens
Current facts             ~300 tokens
Future notes              ~300 tokens
Characters present        ~200 tokens
Current place             ~100 tokens
Active threads            ~200 tokens
Ending plan + rules       ~200 tokens
Psychological profile     ~100 tokens
Narrative style           ~100 tokens
System prompt             ~800 tokens
Field instructions        ~400 tokens
Review checklist          ~600 tokens
Schema definition         ~300 tokens
──────────────────────────────────────
Total user prompt         ~5,000+ tokens
```

This is manageable today, but as books approach 200 pages, the `factsHistory` grows, `contextHistory` becomes more lossy, and the AI increasingly fails to recall early events.

---

## 2. Chosen Embedding Provider: Jina AI (free tier)

### Why Jina AI over OpenAI/Google

| Factor | OpenAI `text-embedding-3-small` | Google `text-embedding-004` | **Jina AI `jina-embeddings-v3`** |
|---|---|---|---|
| **Free tier** | No free tier (pay-as-you-go) | Limited free quota | **1M tokens/day free, 100 RPM** |
| **Dimensions** | 1536 | 768 | 1024 |
| **Cost** | ~$0.02/1M tokens | Variable | **Free for MVP** |
| **Context length** | 8191 tokens | ~512 tokens | **8192 tokens** |
| **L2 normalization** | Not built-in (must normalize) | Built-in | **Built-in (cosine-sim-ready)** |
| **API key required** | OpenAI API key | Google AI key | **Jina API key** |
| **Maturity in our stack** | Not used anywhere | Not used anywhere | **Already proven in MuslimDigest** |

Jina AI's `jina-embeddings-v3` model provides:
- **1024 dimensions** — good balance of precision and storage
- **8192 token context** — can embed full pages without truncation
- **1M tokens/day free** — more than enough for Twistloom's MVP (a 200-page book costs ~80K tokens to embed)
- **Built-in L2 normalization** — outputs are already normalized for cosine similarity
- **Rate limit**: 100 RPM on free tier — generous for non-burst workloads

### Embedding model details

| Property | Value |
|---|---|
| **Model ID** | `jina-embeddings-v3` |
| **Dimensions** | 1024 |
| **Max tokens** | 8192 |
| **Free tier RPM** | 100 |
| **Free tier daily token limit** | 1,000,000 |
| **Normalization** | Built-in L2 (no manual norm needed) |
| **Task prefix** | Supports `"Retrieval Query"` and `"Retrieval Passage"` task types |

### API endpoint

```
POST https://api.jina.ai/v1/embeddings
Authorization: Bearer <JINA_API_KEY>
Content-Type: application/json

{
  "model": "jina-embeddings-v3",
  "task": "retrieval.passage",  // or "retrieval.query" for search queries
  "dimensions": 1024,
  "input": ["text to embed"]
}
```

### Rate limit configuration (from MuslimDigest patterns)

```typescript
// MuslimDigest rate limit pattern:
// jina: { rpm: 100 } with no rpd (token budget handles daily cap)
// Plus separate EMBEDDING_GENERATION_LIMIT = 50 per cron run
// Plus EMBEDDING_GENERATION_DELAY = 1000ms between calls
```

---

## 3. Porting MuslimDigest Patterns

The following MuslimDigest source files contain proven implementations that will be adapted for Twistloom:

| MuslimDigest file | Key patterns | Twistloom target |
|---|---|---|
| `src/utils/embedding.ts` | Jina AI client, `l2Normalize()`, `createEmbedding()` with pRetry + AbortError, `getOrCreateEmbedding()` race-safe upsert, `buildClusterEmbeddingText()`, LRU cache with TTL | `src/services/embeddings.ts` |
| `src/utils/rate-limit.ts` | `RateLimiter` class (same pattern already exists in Twistloom's `ai-limiters.ts`) | Already ported — just add `'jina'` provider |
| `src/cron/embeddings.ts` | Daily backfill with `canUseAIToday()` gate, `EMBEDDING_GENERATION_LIMIT=50`, `EMBEDDING_GENERATION_DELAY=1000ms`, race-safe idempotent DB update | `src/cron/backfill-embeddings.ts` |
| `src/config/embedding.ts` | `EMBEDDING_MODEL`, `EMBEDDING_DIMENSION`, cache TTL/size | `src/config/story.ts` (add constants) |
| `src/db/schema.ts` | Custom `vector()` type import from `drizzle-orm/pg-core` | `src/db/schema.ts` (add tables) |
| `src/db/indexes.ts` | `ensureVectorIndexes()` with HNSW index creation | `src/db/extensions.ts` (add function) |

### Key implementation details from MuslimDigest

1. **LRU cache with TTL**: Cache embedding results in-memory to avoid redundant API calls within the same generation cycle
2. **pRetry with AbortError**: Retry on transient failures (network, 429) with exponential backoff; don't retry on 4xx errors
3. **L2 normalization**: Although Jina outputs are already normalized, MuslimDigest applies `l2Normalize()` as a safety measure
4. **Race-safe upsert**: Use `ON CONFLICT DO UPDATE` to handle concurrent backfill and page-generation writes
5. **Quota-aware backfill**: Check daily token/quota limits before running backfill; respect `EMBEDDING_GENERATION_LIMIT` per run
6. **Separation of task types**: Use `"retrieval.passage"` for stored embeddings, `"retrieval.query"` for search queries

---

## 4. pgvector in the Twistloom Stack

### Extension activation (one-time, in `src/db/extensions.ts`)

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

Added alongside existing `pg_trgm` extension in `ensureExtensions()`.

### Drizzle schema patterns

```typescript
import { vector } from "drizzle-orm/pg-core";

export const pageEmbeddings = pgTable("page_embeddings", {
  id: uuid("id").defaultRandom().primaryKey(),
  bookId: uuid("book_id").references(() => books.id).notNull(),
  branchId: text("branch_id").notNull().default("main"),
  page: integer("page").notNull(),
  // Jina jina-embeddings-v3: 1024 dimensions
  embedding: vector("embedding", { dimensions: 1024 }).notNull(),
  // Source text that was embedded (for debugging / regeneration)
  sourceText: text("source_text"),
  // What kind of content this embedding represents
  contentType: text("content_type", {
    enum: ["page", "character_dialogue", "place_description", "clue", "thread", "future_note", "emotional_moment", "key_event"]
  }).notNull(),
  // Reference ID to the source entity (page ID, character ID, etc.)
  sourceId: text("source_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Index for similarity search (HNSW)
// create index on page_embeddings using hnsw (embedding vector_cosine_ops);
```

### Embedding provider interface

```typescript
// In src/services/embeddings.ts
export interface EmbeddingProvider {
  embed(text: string, task?: 'retrieval.passage' | 'retrieval.query'): Promise<number[]>;
  embedBatch(texts: string[], task?: 'retrieval.passage' | 'retrieval.query'): Promise<number[][]>;
  dimensions: number;
}
```

### Query pattern

```sql
SELECT source_id, content_type, page,
       1 - (embedding <=> $query_embedding) AS similarity
FROM page_embeddings
WHERE book_id = $book_id
  AND branch_id = $branch_id
  AND page < $current_page  -- don't retrieve future pages
ORDER BY embedding <=> $query_embedding
LIMIT $top_k;
```

Drizzle equivalent:
```typescript
const results = await db
  .select()
  .from(pageEmbeddings)
  .where(
    and(
      eq(pageEmbeddings.bookId, bookId),
      eq(pageEmbeddings.branchId, branchId),
      lt(pageEmbeddings.page, currentPage),
    )
  )
  .orderBy(sql`embedding <=> ${queryEmbedding}::vector`)
  .limit(topK);
```

---

## 5. Use Cases — Prioritized for Twistloom

### ⭐⭐⭐⭐⭐ USE CASE 1: Replace `contextHistory` with semantic page retrieval

**Current:** A single 300-word AI summary that loses fidelity every page.  
**Target:** Instead of the lossy summary, embed every page's text and retrieve the most semantically relevant pages for the current scene.

**How it works:**

```
Current page: "I finally opened the old chapel beneath the school."

→ Embed current scene query (page text + key events + mood)
→ Cosine similarity search across all prior pages
→ Retrieve top 5 most semantically similar pages

Returns:
  - Page 18: "You found an old brass key with a church engraving."  (similarity: 0.91)
  - Page 41: "Father Gabriel warned you never to enter the underground chapel."  (similarity: 0.84)
  - Page 7:  "The school chapel felt wrong, even in daylight."  (similarity: 0.79)
```

**Instead of sending:** 300-word compressed summary of everything from page 1–83.  
**Send:** 5 full pages of text that are actually relevant to the current moment.

**Benefits for Twistloom:**
- Recurring clues naturally resurface without explicit prompt rules
- Callbacks happen organically — the AI "remembers" the chapel because the retrieved page text reminds it
- Emotional continuity across 100+ pages doesn't rely on the AI's ability to compress a summary
- Theme consistency — if the MC is experiencing psychological isolation, pages about isolation are retrieved, not combat pages

---

### ⭐⭐⭐⭐⭐ USE CASE 2: Semantic character conversation retrieval

**Current:** Character context sends full `CharacterMemory` (bio, traits, relationshipToMC) but *not* past conversations with semantic relevance. The `pastInteractions` array is capped at `MAX_PAST_INTERACTIONS = 5`.  
**Target:** When a character re-appears, retrieve past conversations and interactions that are semantically relevant to the current situation.

---

### ⭐⭐⭐⭐⭐ USE CASE 3: Semantic future note retrieval

**Current:** All `MAX_FUTURE_NOTES = 10` notes are sent to every prompt, bucketed but not filtered by relevance.  
**Target:** Retrieve only future notes that are semantically relevant to the current page.

---

### ⭐⭐⭐⭐⭐ USE CASE 4: Semantic clue/mystery threading

**Current:** Threads are tracked structurally (questions, clues, status) but the AI must manually connect clues across pages.  
**Target:** When a new clue is discovered, retrieve semantically related clues from any point in the story.

---

### ⭐⭐⭐⭐☆ USE CASE 5: Scene-of-place semantic recall

---

### ⭐⭐⭐⭐☆ USE CASE 6: Branch-specific semantic isolation

---

### ⭐⭐⭐⭐☆ USE CASE 7: AI self-consistency (style retrieval)

---

### ⭐⭐⭐⭐☆ USE CASE 8: Emotional callbacks for finales

---

### ⭐⭐⭐☆☆ USE CASE 9: Book similarity recommendations

---

### ⭐⭐⭐☆☆ USE CASE 10: Image prompt consistency

*(See original detailed descriptions for use cases 2–10 — unchanged from prior version.)*

---

## 6. What to Embed

### Excellent candidates

| Content | Embedding table | Why | Priority |
|---|---|---|---|
| Page text + key events + mood | `page_embeddings` | Primary semantic memory — replaces lossy contextHistory | **P0** |
| Character dialogue + interactions | `character_embeddings` | Personality and relationship consistency | **P0** |
| Future notes text | `future_note_embeddings` | Selective retrieval instead of sending all | **P0** |
| Clues (from threads) | `clue_embeddings` | Mystery connectivity | **P1** |
| Place descriptions on visit | `place_embeddings` | Environmental recall across revisits | **P1** |
| Emotional moments (high-guilt/fear pages) | `page_embeddings` (filtered) | Finale callbacks | **P1** |
| Book metadata (summary + hook + keywords) | `book_embeddings` | Recommendations | **P2** |

### What NOT to embed

| Content | Why |
|---|---|
| StoryState JSON | Too structured; use existing fields |
| HP / composure values | Numeric state doesn't benefit from semantic search |
| Inventory IDs | Better handled with relational data |
| Dates / calendarDate | Exact lookups > semantic search |
| Action text alone | Too short; embed with surrounding context |
| flag levels (trust: low) | Structured data, better in prompt directly |

### Embedding content format

Key insight: **concise natural-language summaries embed better than raw structured data.**

```typescript
// ✅ Good embedding text
function buildPageEmbeddingText(page: StoryPage): string {
  return [
    `Page ${page.page}:`,
    `Scene: ${page.text}`,
    `Mood: ${page.mood}`,
    `Key events: ${page.keyEvents?.join(', ') ?? ''}`,
    `Characters: ${page.charactersPresent?.map(c => c.characterId).join(', ') ?? ''}`,
  ].filter(Boolean).join('\n');
}
```

---

## 7. Architecture — Hybrid Memory

The strongest architecture combines structured state (Twistloom's existing `StoryState`) with semantic retrieval:

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

### Prompt injection point

The vector-retrieved context should be injected alongside (not replacing) the existing structured context. The most natural injection point is **within the `STORY CONTEXT` section** of `formatNextPageStoryContextPrompt` (`src/utils/prompt.ts:2759-2761`), after the `storyContext` line.

Suggested format:

```
RELEVANT PAST EVENTS (semantic retrieval):
- Page 18 (similarity: 0.91): You found an old brass key with a church engraving.
- Page 41 (similarity: 0.84): Father Gabriel warned you never to enter the underground chapel.
- Page 7  (similarity: 0.79): The school chapel felt wrong, even in daylight.
```

---

## 8. Implementation Phases

### Phase 0 — Foundation & Jina Plumbing (est. 2-3 days)

1. **Add `'jina'` to `AIChatProvider` type** in `src/types/ai-chat.ts`
2. **Add Jina rate limits** to `AI_RATE_LIMITS` in `src/config/ai-clients.ts`:
   ```typescript
   jina: { rpm: 100 }, // 100 RPM free tier; 1M tokens/day (token budget handles daily cap)
   ```
3. **Add Jina limiter plumbing** in `src/utils/ai-limiters.ts`:
   - Add `jinaLimiter` singleton variable
   - Add `getJinaLimiter()` function
   - Add `case 'jina'` to `getRateLimiter()` switch
4. **Install `pgvector` package:**
   ```bash
   pnpm add pgvector
   ```
5. **Add vector extension** to `src/db/extensions.ts`:
   - Create `ensureVectorExtension()` function alongside `ensurePgTrgmExtension()`
   - Call from `ensureExtensions()`
6. **Create `src/config/embedding.ts`** with centralized embedding config:
   ```typescript
   export const EMBEDDING_MODEL = 'jina-embeddings-v3';
   export const EMBEDDING_DIMENSIONS = 1024;
   export const MAX_VECTOR_RESULTS_PER_QUERY = 5;
   export const MAX_VECTOR_RESULTS_FINALE = 15;
   export const EMBEDDING_SIMILARITY_THRESHOLD = 0.5;
   export const VECTOR_INDEX_TYPE = 'hnsw';
   export const EMBEDDING_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
   export const EMBEDDING_CACHE_MAX_SIZE = 100;
   export const EMBEDDING_GENERATION_LIMIT = 100; // max embeddings per cron run
   export const EMBEDDING_GENERATION_DELAY = 1000; // ms between embedding API calls
   ```
7. **Add `JINA_API_KEY`** to `.env.local.example` (consumed directly in `embeddings.ts` via `process.env['JINA_API_KEY']`):
   ```
   JINA_API_KEY=jina_xxxxxxxxxx
   ```
8. **Create `src/services/embeddings.ts`** — port from MuslimDigest:
   - Jina AI client with `embed()` and `embedBatch()` methods
   - L2 normalization safety wrapper
   - LRU cache with TTL
   - pRetry with AbortError for transient failures
   - Task type support (`retrieval.passage` vs `retrieval.query`)
9. **Add `jina` config to `AI_MAX_PROMPT_LENGTH`** in `ai-clients.ts` (if needed for token budget tracking)

### Phase 1 — Drizzle Schema & Extension (est. 2 days)

1. **Add embedding tables** to `src/db/schema.ts`:
   - `page_embeddings` — page text + key events + mood
   - `character_embeddings` — character dialogue + interactions
   - `future_note_embeddings` — future notes
   - `clue_embeddings` — thread clues (P1, add later if preferred)
   - `place_embeddings` — place descriptions (P1, add later if preferred)
2. **Generate migration** with `pnpm db:generate`
3. **Enable pgvector on Neon:** Run `pnpm db:extensions` (updated with vector)
4. **Run migration:** `pnpm db:migrate`
5. **Create HNSW indexes** via `dbWrite.execute()` in `extensions.ts` or a new `src/db/indexes.ts`

### Phase 2 — Page embeddings (est. 3-5 days)

1. **Backfill script** (`src/cron/backfill-embeddings.ts`):
   - Iterate all active books
   - For each book, iterate all pages that lack embeddings
   - Respect `EMBEDDING_GENERATION_LIMIT` (e.g., 50 per run) and `EMBEDDING_GENERATION_DELAY` (1000ms)
   - Use Jina rate limiter (`getJinaLimiter().throttle()`)
   - Race-safe upsert with `ON CONFLICT (book_id, branch_id, page, content_type) DO UPDATE`
   - Check `canUseAIToday('jina')` before starting
2. **On page creation** (`src/services/book.ts`, `persistPageWithState`):
   - After page persists, fire-and-forget `embedPage(page, state)`
   - Do NOT block the response; run asynchronously
   - Log errors but never throw
3. **Prompt integration** (`src/utils/prompt.ts`):
   - In `formatNextPageStoryContextPrompt`:
     - Build query text from current page's text + mood + key events
     - Embed with `task: 'retrieval.query'`
     - Retrieve top 5 similar pages
     - Inject as `RELEVANT PAST EVENTS` section after `STORY CONTEXT`
   - Keep `contextHistory` at full 300 words initially; reduce later
4. **Create `src/services/vector-memory.ts`**:
   - `retrieveSimilarPages(query, bookId, branchId, currentPage, limit)`
   - `embedPersistedPage(page, state)` — fire-and-forget hook
   - `buildPageEmbeddingText(page, state)`

### Phase 3 — Character & future note embeddings (est. 3-5 days)

1. On each page generation, also embed character dialogue/interactions
2. On each page generation, embed future notes
3. **Prompt integration:**
   - Replace "send all future notes" with "send top 3-5 future notes by semantic similarity"
   - When `charactersPresent` includes a character, retrieve their top 2-3 relevant past interactions

### Phase 4 — Clue & place embeddings (est. 2-3 days)

1. Embed clues when added to threads
2. Embed place descriptions when first created and on significant revisits
3. **Prompt integration:**
   - When visiting a place, retrieve top 3 past visits' sensory details
   - When discovering a clue, retrieve related clues from anywhere in the story

### Phase 5 — Finale enhancement & recommendations (est. 3-4 days)

1. **Finale enhancement:**
   - When `isFinale === true`, retrieve top 10-15 most important/emotional pages
   - Inject as thematic anchors
2. **Book recommendations:**
   - Embed book summaries for all public books
   - Build `/api/books/:id/similar` endpoint using vector similarity

---

## 9. Code Changes Map

### New files

| File | Purpose | Priority |
|---|---|---|
| `src/services/embeddings.ts` | Jina AI client, embed/embedBatch, LRU cache, L2 norm, pRetry | **Phase 0** |
| `src/config/embedding.ts` | Centralized embedding config (`EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS`, etc.) | **Phase 0** |
| `src/services/vector-memory.ts` | High-level: embed page, retrieve similar pages, hybrid query builder | **Phase 2** |
| `src/cron/backfill-embeddings.ts` | Daily backfill for missing embeddings (quota-aware) | **Phase 2** |

### Modified files

| File | Changes | Phase |
|---|---|---|
| `src/types/ai-chat.ts` | Add `'jina'` to `AIChatProvider` union type | **P0** |
| `src/config/ai-clients.ts` | Add `jina: { rpm: 100 }` to `AI_RATE_LIMITS` | **P0** |
| `src/utils/ai-limiters.ts` | Add `jinaLimiter` singleton, `getJinaLimiter()`, case in `getRateLimiter()` | **P0** |
| `src/db/extensions.ts` | Add `ensureVectorExtension()` + call from `ensureExtensions()` | **P0** |
| `src/db/triggers.ts` | No changes needed (extensions live in `extensions.ts`) | — |
| `src/db/schema.ts` | Add `page_embeddings`, `character_embeddings`, `future_note_embeddings`, `clue_embeddings` tables | **P1** |
| `.env.local.example` | Add `JINA_API_KEY` env var (consumed directly in `embeddings.ts`) | **P0** |
| `src/services/book.ts` | In `persistPageWithState`: fire-and-forget page embedding | **P2** |
| `src/utils/prompt.ts` | Add `RELEVANT PAST EVENTS` section in `formatNextPageStoryContextPrompt` | **P2** |
| `src/utils/prompt.ts` | Replace "all future notes" with "relevant future notes" in `formatNextPageNarrativePrompt` | **P3** |

### Config additions (`src/config/embedding.ts`)

```typescript
/**
 * Centralized embedding configuration for Jina AI pgvector integration.
 * 
 * All embedding-related constants live here to keep a single source of truth
 * for model selection, dimensions, cache tuning, and backfill limits.
 */
export const EMBEDDING_MODEL = 'jina-embeddings-v3';
export const EMBEDDING_DIMENSIONS = 1024;
export const MAX_VECTOR_RESULTS_PER_QUERY = 5;
export const MAX_VECTOR_RESULTS_FINALE = 15;
export const EMBEDDING_SIMILARITY_THRESHOLD = 0.5; // 0-1, lower = more results
export const VECTOR_INDEX_TYPE = 'hnsw';
export const EMBEDDING_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
export const EMBEDDING_CACHE_MAX_SIZE = 100;

// Cron backfill limits (from MuslimDigest pattern)
export const EMBEDDING_GENERATION_LIMIT = 100; // max embeddings per cron run
export const EMBEDDING_GENERATION_DELAY = 1000; // ms between embedding API calls
```

---

## 10. Changes to Prompt Injection

### Current `formatNextPageStoryContextPrompt` (line 2722-2787)

```
CURRENT PHASE
MAIN CHARACTER (POV)
STORY CONTEXT: contextHistory (300 words max)
Recent Major Events
CURRENT FACTS
PREVIOUS PAGES: last 3 pages full text
CURRENT PAGE
CURRENT SITUATION
ACTION SELECTION
```

### After pgvector integration (Phase 2)

```
CURRENT PHASE
MAIN CHARACTER (POV)
STORY CONTEXT: contextHistory (300 words — still active, will reduce in phase 4)

RELEVANT PAST EVENTS (semantic):
- Page 18 (sim: 0.91): Full page text with action, hint, plot flag
- Page 41 (sim: 0.84): ...
- Page 7  (sim: 0.79): ...

Recent Major Events
CURRENT FACTS
PREVIOUS PAGES: last 3 pages full text
CURRENT PAGE
CURRENT SITUATION
ACTION SELECTION
```

### Current `formatNextPageNarrativePrompt` (line 2789-2830)

```
FUTURE NOTES:
  Becoming Relevant
  Future Payoffs & Scheduled Events
  Unscheduled
ACTIVE THREADS
ENDING PLAN
```

### After pgvector integration (Phase 3)

```
FUTURE NOTES RELEVANT TO THIS SCENE (semantic):
- Reveal Room 404 (page 35-40) — hidden experiment log (MAJOR)
- Nurse identity reveal (page 50+) — trigger condition: ...

(All 10 notes below, but bucketed by relevance to current page)

ACTIVE THREADS (with semantic clue retrieval for characters present)
ENDING PLAN
```

---

## 11. Performance & Cost Considerations

### Embedding cost (Jina free tier)

| Content | Avg tokens/page | Cost per page (Jina free tier) |
|---|---|---|
| Page text embedding | ~200 tokens | **Free** (up to 1M tokens/day) |
| Page + metadata | ~400 tokens | **Free** |
| Per book (200 pages) | ~80,000 tokens | **Free** (0.08% of daily quota) |
| Query embedding | ~100 tokens | **Free** |

Total: **$0.00 for MVP phase.** Only upgrade to paid tier if usage exceeds 1M tokens/day.

### Query latency

- `pgvector` HNSW index: sub-10ms for 10k+ vectors
- Jina embedding API call: ~100-500ms per query (varies by input length)
- Total added latency per page generation: ~200-600ms

### Index type: HNSW vs IVFFlat

| Index | Build time | Query speed | Accuracy | Recommended for |
|---|---|---|---|---|
| **HNSW** | Slower build | Fastest queries | Highest | Production, many writes |
| **IVFFlat** | Fast build | Slower queries | Lower | Prototyping, few writes |

**Recommendation:** Start with HNSW for all embedding tables. The book size (max 200 pages) means the index is tiny regardless.

### Cache strategy (from MuslimDigest)

- **In-memory LRU cache** with configurable TTL (5 min default) and max size (100 entries)
- Cache key = `model:task:text_hash` — avoids redundant API calls within same generation
- Batch embedding: if multiple embedding operations are needed per page (page text + character interactions + future notes), batch them into a single API call
- The embedding of the *current page* (before it's persisted) only needs to be computed once per generation

### Jina token budget monitoring

- Track daily token usage via `usage` table with `provider = 'jina'` and `context = 'embedding'`
- Cron backfill respects `EMBEDDING_GENERATION_LIMIT = 50` per run, not daily token limit
- Jina's 100 RPM is generous — the limiter's `throttle()` ensures we never exceed it
- If backfill + page generation overlap, they share the same rate limiter singleton

---

## 12. Integration into `generateNextPage` / `generateNextPages`

### Current flow (`src/utils/prompt.ts`)

```
prepareNextPageGenerationSetup
  → prepareNextPageGenerationContext
    → advanceStoryState (state + action → new state)
    → getPreviousPages (fetch last 3 from DB)
  → buildNextPagePrompt
    → formatNextPageTaskPrompt
    → formatNextPageStoryContextPrompt (contextHistory + last 3 pages)
    → formatNextPageNarrativePrompt (future notes, threads, ending)
  → buildNextPageFieldInstructions
  → buildNextPageEvaluatorPrompt

executePromptForJSON (AI call)

resolvePageDelta (extract state changes from AI output)
  → extractStateDelta
  → applyStateDelta

persistPageWithState (save to DB)
```

### After pgvector integration

```
prepareNextPageGenerationSetup
  → prepareNextPageGenerationContext (unchanged)
  → vectorRetrieveSemanticContext (NEW)
    → embedCurrentSceneQuery (task: 'retrieval.query')
    → retrieveSimilarPages (page_embeddings)
    → retrieveRelevantFutureNotes (future_note_embeddings) — Phase 3
    → retrieveCharacterInteractions (character_embeddings) — Phase 3
    → retrieveRelatedClues (clue_embeddings) — Phase 4
  → buildNextPagePrompt
    → formatNextPageTaskPrompt (unchanged)
    → formatNextPageStoryContextPrompt (MODIFIED: add RELEVANT PAST EVENTS)
    → formatNextPageNarrativePrompt (MODIFIED: filtered future notes)
  → (rest unchanged)

persistPageWithState (MODIFIED: after save, fire-and-forget embed page)
```

### Persistence hook

After `persistPageWithState` succeeds, fire-and-forget the embedding:

```typescript
// In persistPageWithState or a middleware handler
async function embedPersistedPage(page: PersistedStoryPage, state: StoryState): Promise<void> {
  try {
    await getJinaLimiter().throttle();
    const embeddingText = buildPageEmbeddingText(page, state);
    const embedding = await embedText(embeddingText, 'retrieval.passage');
    
    await db.insert(pageEmbeddings).values({
      bookId: page.bookId,
      branchId: page.branchId,
      page: page.page,
      embedding: `[${embedding.join(',')}]`,
      sourceText: embeddingText,
      contentType: 'page',
      sourceId: page.id,
    }).onConflictDoUpdate({
      target: [pageEmbeddings.bookId, pageEmbeddings.branchId, pageEmbeddings.page, pageEmbeddings.contentType],
      set: { embedding: `[${embedding.join(',')}]`, sourceText: embeddingText },
    });
  } catch (error) {
    console.error(`[Embeddings] Failed to embed page ${page.page}:`, getErrorMessage(error));
  }
}
```

---

## 13. Risks and Mitigations

| Risk | Mitigation |
|---|---|
| **Embedding API latency** adds ~300-500ms to page generation | Embed asynchronously after page persistence; query embedding is the only blocking call |
| **Jina free tier rate limit** (100 RPM) | Rate limiter (`getJinaLimiter().throttle()`) prevents 429s; 100 RPM is generous for our volume |
| **Jina free tier daily token limit** (1M tokens/day) | Track via `usage` table; backfill respects `EMBEDDING_GENERATION_LIMIT = 50` per cron run |
| **Jina API deprecation / model change** | Pin `jina-embeddings-v3`; abstract provider behind `EmbeddingProvider` interface |
| **Cold start** (first page of new book has no prior embeddings) | Vector retrieval gracefully returns empty results; fall through to existing contextHistory |
| **Storage growth** (200 pages × 1024 floats × multiple tables) | ~2MB per book for page embeddings — negligible on Neon |
| **Branch proliferation** (many branches share similar early pages) | Embed once per page per branch; deduplication via unique constraint on `(bookId, branchId, page, contentType)` |
| **Vector index maintenance on every page write** | HNSW handles incremental inserts well; no rebuild needed |
| **Accidental future-page retrieval** (embedding query retrieves pages that haven't been read yet) | Always filter `page < currentPage` in the WHERE clause |
| **Race condition: cron backfill and page generation embed same page** | `ON CONFLICT DO UPDATE` ensures idempotency; both paths use same rate limiter |

---

## 14. Success Metrics

- **Before:** AI can't reference details from more than ~10 pages ago with reliability
- **After:** AI consistently references details from 50+ pages ago when semantically relevant
- **Token savings:** `contextHistory` can be reduced from 300 words to ~100 words (or eliminated)
- **Future note relevance:** Only 3-5 relevant notes sent per prompt instead of all 10
- **Character consistency:** Character dialogue references specific past interactions, not generic patterns
- **Ending quality:** Final pages reference events from across the entire book, not just recent pages
- **Cost:** $0 for MVP (Jina free tier); upgrade only if >1M tokens/day

---

## 15. Relationship to Other Roadmap Items

| Feature | Vector synergy |
|---|---|
| **Candidate generation** (`CANDIDATE_GENERATION_ENHANCEMENT_ROADMAP.md`) | Per-branch embeddings ensure candidates stay in their timeline |
| **Branch traversal** (`BRANCH_TRAVERSAL_FUTURE_IMPROVEMENTS.md`) | Branch-aware retrieval prevents cross-branch contamination |
| **Book search** (`BOOK_SEARCH_ENHANCEMENT_ROADMAP.md`) | Semantic book similarity replaces / augments tag-based search |
| **Custom actions** (`TWISTLOOM_CUSTOM_ACTIONS_ROADMAP.md`) | Custom actions can embed user intent and retrieve matching past scenes |
| **Psychological profile results** (`TWISTLOOM_VS_80DAYS_ROADMAP.md`) | Embed the post-ending "psychological autopsy" for shareable results |
| **Cover image generation** | Embed page descriptions for consistent visual prompts across branches |

---

## Appendix A: Example Drizzle Schema

```typescript
import { pgTable, uuid, integer, text, timestamp, vector, index } from "drizzle-orm/pg-core";

export const pageEmbeddings = pgTable("page_embeddings", {
  id: uuid("id").defaultRandom().primaryKey(),
  bookId: uuid("book_id").notNull().references(() => books.id, { onDelete: "cascade" }),
  branchId: text("branch_id").notNull().default("main"),
  page: integer("page").notNull(),
  embedding: vector("embedding", { dimensions: 1024 }).notNull(), // Jina jina-embeddings-v3
  sourceText: text("source_text"),
  sourceId: text("source_id"),
  contentType: text("content_type", {
    enum: ["page", "character_dialogue", "place_description", "clue", "thread", "future_note", "emotional_moment", "key_event"]
  }).notNull().default("page"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("page_embeddings_hnsw_idx").using("hnsw", table.embedding.op("vector_cosine_ops")),
  index("page_embeddings_book_branch_idx").on(table.bookId, table.branchId),
  unique("page_embeddings_book_branch_page_unique").on(table.bookId, table.branchId, table.page, table.contentType),
]);

export const characterEmbeddings = pgTable("character_embeddings", {
  id: uuid("id").defaultRandom().primaryKey(),
  bookId: uuid("book_id").notNull().references(() => books.id, { onDelete: "cascade" }),
  branchId: text("branch_id").notNull().default("main"),
  page: integer("page").notNull(),
  characterId: text("character_id").notNull(),
  embedding: vector("embedding", { dimensions: 1024 }).notNull(),
  sourceText: text("source_text"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("character_embeddings_hnsw_idx").using("hnsw", table.embedding.op("vector_cosine_ops")),
  index("character_embeddings_book_char_idx").on(table.bookId, table.characterId),
  unique("character_embeddings_unique").on(table.bookId, table.branchId, table.page, table.characterId),
]);

export const futureNoteEmbeddings = pgTable("future_note_embeddings", {
  id: uuid("id").defaultRandom().primaryKey(),
  bookId: uuid("book_id").notNull().references(() => books.id, { onDelete: "cascade" }),
  branchId: text("branch_id").notNull().default("main"),
  noteIndex: integer("note_index").notNull(),
  embedding: vector("embedding", { dimensions: 1024 }).notNull(),
  sourceText: text("source_text"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("future_note_embeddings_hnsw_idx").using("hnsw", table.embedding.op("vector_cosine_ops")),
  unique("future_note_embeddings_unique").on(table.bookId, table.branchId, table.noteIndex),
]);
```

## Appendix B: Query Scenarios

### Retrieve pages most similar to current scene
```typescript
async function retrieveSimilarPages(
  query: string,
  bookId: string,
  branchId: string,
  currentPage: number,
  limit: number = 5
): Promise<SimilarPageResult[]> {
  const queryEmbedding = await embedText(query, 'retrieval.query');
  
  return db.execute(sql`
    SELECT source_id, page, source_text, 
           1 - (embedding <=> ${queryEmbedding}::vector) AS similarity
    FROM page_embeddings
    WHERE book_id = ${bookId}
      AND branch_id = ${branchId}
      AND page < ${currentPage}
      AND content_type = 'page'
    ORDER BY embedding <=> ${queryEmbedding}::vector
    LIMIT ${limit}
  `);
}
```

### Retrieve character interactions most similar to current situation
```typescript
async function retrieveCharacterInteractions(
  query: string,
  bookId: string,
  branchId: string,
  characterId: string,
  currentPage: number,
  limit: number = 3
): Promise<SimilarInteractionResult[]> {
  const queryEmbedding = await embedText(query, 'retrieval.query');
  
  return db.execute(sql`
    SELECT source_id, source_text, page,
           1 - (embedding <=> ${queryEmbedding}::vector) AS similarity
    FROM character_embeddings
    WHERE book_id = ${bookId}
      AND branch_id = ${branchId}
      AND character_id = ${characterId}
      AND page < ${currentPage}
    ORDER BY embedding <=> ${queryEmbedding}::vector
    LIMIT ${limit}
  `);
}
```

### Retrieve relevant future notes for current scene
```typescript
async function retrieveRelevantFutureNotes(
  query: string,
  bookId: string,
  branchId: string,
  limit: number = 3
): Promise<SimilarFutureNoteResult[]> {
  const queryEmbedding = await embedText(query, 'retrieval.query');
  
  return db.execute(sql`
    SELECT source_id, source_text,
           1 - (embedding <=> ${queryEmbedding}::vector) AS similarity
    FROM future_note_embeddings
    WHERE book_id = ${bookId}
      AND branch_id = ${branchId}
    ORDER BY embedding <=> ${queryEmbedding}::vector
    LIMIT ${limit}
  `);
}
```

## Appendix C: Jina AI Embedding Service — Porting Reference from MuslimDigest

The following pseudocode shows the MuslimDigest patterns to adapt for `src/services/embeddings.ts`:

```typescript
// Ported pattern from MuslimDigest src/utils/embedding.ts

// 1. LRU Cache with TTL
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

// 2. L2 Normalization (safety wrapper)
function l2Normalize(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  if (norm === 0) return vector;
  return vector.map(v => v / norm);
}

// 3. Jina AI Client with pRetry
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
          model: EMBEDDING_MODEL,
          task,
          dimensions: EMBEDDING_DIMENSIONS,
          input: [text],
        }),
      });
      
      if (!response.ok) {
        if (response.status === 429) throw new Error('Rate limited');
        throw new AbortError(`Jina API error: ${response.status}`);
      }
      
      const data = await response.json();
      return l2Normalize(data.data[0].embedding);
    },
    { retries: 3, minTimeout: 1000 }
  );
  
  embeddingCache.set(cacheKey, result);
  return result;
}
```

---

## Appendix D: Design Rationale Q&A

The following design decisions were evaluated during planning. This section captures the rationale for posterity.

### D.1 Embedding model: why `jina-embeddings-v3`?

| Option | Dimensions | Max tokens | Notes |
|---|---|---|---|
| **`jina-embeddings-v3`** ✅ | 1024 | 8192 | Latest, supports task types, proven in MuslimDigest |
| `jina-embeddings-v2-base-en` | 768 | 8192 | Slightly smaller, English-optimized |

**Decision:** `jina-embeddings-v3`.

**Rationale:** Same 1024-dim model used in MuslimDigest — well-tested in our stack. Task-type support (`retrieval.passage` vs `retrieval.query`) improves retrieval quality by letting Jina optimize the embedding for search vs storage. No reason to downgrade to v2.

---

### D.2 Single vs separate embedding tables?

| Approach | Pros | Cons |
|---|---|---|
| **Single table** | One migration, simpler queries | All content mixed; must filter by content_type on every query |
| **Separate tables** ✅ | Cleaner separation, per-table indexes, no content_type filter | More migrations, cross-type queries need UNION |

**Decision:** Separate tables (`page_embeddings`, `character_embeddings`, `future_note_embeddings`, `clue_embeddings`, `place_embeddings`).

**Rationale:** MuslimDigest's proven pattern. Twistloom's content types are distinct enough (page vs character vs future note) that cross-type queries are rare. Per-table HNSW indexes are cleaner and more performant than filtering a single giant table.

---

### D.3 Embedding persistence: fire-and-forget vs synchronous?

| Strategy | Latency impact | Reliability |
|---|---|---|
| **Fire-and-forget** ✅ | None | Silent failures possible; cron as safety net |
| **Synchronous** | +300-500ms per generation | Guaranteed immediate availability |
| **Queue-based** | None | Infrastructure complexity |

**Decision:** Fire-and-forget for MVP (Phase 2), with cron backfill as safety net.

**Rationale:** Page generation is user-facing — blocking on an embedding API call adds unacceptable latency. The page text is already persisted in the `pages` table; the embedding is a cache that can be rebuilt from cron if it fails. If silent failures become a problem after MVP, switch to a queue-based approach.

---

### D.4 Keep `contextHistory` alongside vector retrieval?

| Approach | Tokens | Safety net |
|---|---|---|
| **Keep both** ✅ | ~400 extra tokens per prompt | Redundant — model can cross-reference |
| **Replace entirely** | Token savings | Cold start risk for early pages |

**Decision:** Keep both initially (Phase 2). Reduce `contextHistory` from 300 to 150 words in Phase 3. Remove entirely in Phase 4 after measuring recall quality.

**Rationale:** Phased deprecation minimizes risk. The 300-word contextHistory is only ~400 tokens — negligible compared to the 5,000+ total prompt. Keeping it gives the model a fallback while we validate that semantic retrieval actually catches the relevant past events. Once we're confident (measured via Success Metrics in §14), we shrink and eventually remove it.

---

### D.5 Daily embedding generation limit for cron backfill?

| Limit | Tokens/run (avg 400 tok/embedding) | % of daily quota | Estimated pages/day |
|---|---|---|---|
| 50 | ~20,000 | 2% | ~50 pages |
| **100** ✅ | ~40,000 | 4% | ~100 pages |
| 250 | ~100,000 | 10% | ~250 pages |
| 500 | ~200,000 | 20% | ~500 pages |

**Decision:** `EMBEDDING_GENERATION_LIMIT = 100` with `EMBEDDING_GENERATION_DELAY = 1000ms`.

**Rationale:** 2x MuslimDigest's proven limit of 50. Jina's 1M tokens/day free tier gives us headroom (100 embeddings × 400 tokens = 40K tokens = 4% of daily quota). At 1000ms delay, a full run takes ~100 seconds — fast enough to clear a book's backlog within a single cron cycle. Scale up to 250 if backfill is too slow.

---

### D.6 Jina API key management?

| Approach | Pattern |
|---|---|
| `src/config/constants.ts` | Centralized, follows existing API key pattern |
| **`process.env['JINA_API_KEY']` in `embeddings.ts`** ✅ | Direct env var consumption, no import needed |

**Decision:** Consumed directly in `embeddings.ts` via `process.env['JINA_API_KEY']`, added to `.env.local.example`.

**Rationale:** The embedding service is a self-contained module with exactly one API key — no need to add it to the global constants file. This keeps the key's usage scope tight (only `embeddings.ts` ever reads it) and makes the module more portable if extracted later.

---

### D.7 Add `jina` to `AI_MAX_PROMPT_LENGTH`?

**Decision:** Skip. Jina embeddings are not used for chat completions — `AI_MAX_PROMPT_LENGTH` is only relevant for LLM providers. The embedding input length (~400 tokens) is well within Jina's 8192-token limit, so no configuration is needed.

---

## Appendix E: Integration Points — Jina Rate Limiter Plumbing

### Changes to `src/utils/ai-limiters.ts`

```typescript
// 1. Add singleton variable (after line 133)
let jinaLimiter: RateLimiter | null = null;

// 2. Add getter function (after getCloudflareLimiter)
export function getJinaLimiter(): RateLimiter {
  return jinaLimiter || (jinaLimiter = new RateLimiter('jina'));
}

// 3. Add case in getRateLimiter switch (line 214)
case 'jina': return getJinaLimiter();
```

### Changes to `src/config/ai-clients.ts`

```typescript
// Add to AI_RATE_LIMITS (after cloudflare entry, line 96)
jina: { rpm: 100 }, // 100 RPM free tier; 1M tokens/day (token-based, not request-based)
```

### Changes to `src/types/ai-chat.ts`

```typescript
// Add 'jina' to AIChatProvider union (line 11-30)
export type AIChatProvider =
  | 'github'
  | 'gemini'
  | 'cohere'
  | 'mistral'
  | 'groq'
  | 'cerebras'
  | 'nvidia'
  | 'openrouter'
  | 'cloudflare'
  | 'jina';  // NEW: Jina AI embeddings
```

---

## Appendix F: Backfill Cron Job — Specification

### `src/cron/backfill-embeddings.ts`

Port from MuslimDigest `src/cron/embeddings.ts`:

```typescript
/**
 * Daily cron to backfill missing embeddings.
 * 
 * Behavior:
 * 1. Check canUseAIToday('jina') — skip if quota exhausted
 * 2. Find all pages without embeddings across all active books
 * 3. Process up to EMBEDDING_GENERATION_LIMIT per run
 * 4. Use EMBEDDING_GENERATION_DELAY between API calls
 * 5. Race-safe upsert (ON CONFLICT DO UPDATE)
 * 6. Log progress and errors
 * 
 * Schedule: Once daily (configurable via cron expression)
 * 
 * @example
 * ```bash
 * pnpm dev:cron:backfill-embeddings
 * ```
 */
```

---

*This document provides a comprehensive blueprint for implementing pgvector-based semantic memory in Twistloom using Jina AI (free tier) and proven MuslimDigest patterns. The recommended approach is to start with Phase 0 (Jina plumbing + pgvector extension), then Phase 1 (schema), then Phase 2 (page embeddings as a replacement for lossy contextHistory). See Appendix D for design rationale on key decisions.*
