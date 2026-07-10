# pgvector Semantic Memory — Twistloom Implementation Roadmap

**Status:** Research / Not started  
**Database:** Neon PostgreSQL + pgvector extension  
**Stack:** Drizzle ORM, TypeScript, OpenAI / Google embeddings  
**Document grounded against:** `src/utils/prompt.ts`, `src/utils/story.ts`, `src/types/story.ts`, `src/config/story.ts`, `src/types/prompt.ts`, `TODO-vector-semantic.md`

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

## 2. pgvector in the Twistloom Stack

### Extension activation (one-time)

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

### Drizzle schema patterns

```typescript
import { vector } from "drizzle-orm/pg-core";

export const pageEmbeddings = pgTable("page_embeddings", {
  id: uuid("id").defaultRandom().primaryKey(),
  bookId: uuid("book_id").references(() => books.id).notNull(),
  branchId: text("branch_id").notNull().default("main"),
  page: integer("page").notNull(),
  // Embedding dimension depends on the model
  embedding: vector("embedding", { dimensions: 1536 }).notNull(),
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

// Index for similarity search (IVFFlat or HNSW)
// create index on page_embeddings using hnsw (embedding vector_cosine_ops);
```

### Embedding providers

Twistloom already abstracts AI providers via `src/config/ai-clients.ts`. The embedding layer should follow the same pattern:

```typescript
// Conceptual embedding interface
export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  dimensions: number;
}
```

Recommended providers:
- **OpenAI `text-embedding-3-small`** — 1536 dimensions, cheapest, best for general semantic search
- **Google `text-embedding-004`** — 768 dimensions, good if you're already using Gemini
- **OpenAI `text-embedding-3-large`** — 3072 dimensions, best quality but more expensive

Strategy: start with `text-embedding-3-small` (1536d, ~$0.02/1M tokens). The dims are fixed at schema creation time.

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

## 3. Use Cases — Prioritized for Twistloom

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

**Implementation:**
- Phase 1: Backfill embedding for all existing pages (cron job)
- Phase 2: On each page generation, embed the current page after persistence
- Phase 3: On prompt building, embed the current scene query, retrieve top K pages, inject into `STORY CONTEXT` section

---

### ⭐⭐⭐⭐⭐ USE CASE 2: Semantic character conversation retrieval

**Current:** Character context sends full `CharacterMemory` (bio, traits, relationshipToMC) but *not* past conversations with semantic relevance. The `pastInteractions` array is capped at `MAX_PAST_INTERACTIONS = 5`.  
**Target:** When a character re-appears, retrieve past conversations and interactions that are semantically relevant to the current situation.

**How it works:**

```
Current page: Emma becomes suspicious.
→ Embed: "Emma questions my whereabouts, her eyes narrowing"
→ Search character_embeddings WHERE character_id = 'emma'
→ Retrieve top 3 past interactions:
  - Page 24: "Emma noticed your lies about the basement."  (0.88)
  - Page 15: "Emma caught you sneaking back after midnight."  (0.76)
  - Page 5:  "Emma showed you the hidden passage."  (0.42)
```

**Benefits:**
- Characters feel surprisingly consistent — Emma's suspicion builds from real past events
- The AI can reference specific past interactions rather than generic "based on past interactions" rules
- Reduces the need for manual `pastInteractions` management in prompts

---

### ⭐⭐⭐⭐⭐ USE CASE 3: Semantic future note retrieval

**Current:** All `MAX_FUTURE_NOTES = 10` notes are sent to every prompt, bucketed but not filtered by relevance.  
**Target:** Retrieve only future notes that are semantically relevant to the current page.

**How it works:**

```
Current page: MC enters the hospital basement.
→ Embed: "hospital basement, sterile smell, flickering lights"
→ Search future_note_embeddings
→ Retrieve:
  - "Reveal Room 404: the hidden experiment log"  (0.89)
  - "Nurse's true identity surfaces in the basement"  (0.81)
  - "The recorder left by the previous victim"  (0.73)
  - ""   (0.12)  ← note about "school festival" filtered out
```

**Benefits:**
- Huge token savings — only 3-4 relevant notes instead of all 10
- The AI naturally advances relevant story beats without being distracted by unrelated ones
- More precise foreshadowing — the AI sees notes that matter *now*

---

### ⭐⭐⭐⭐⭐ USE CASE 4: Semantic clue/mystery threading

**Current:** Threads are tracked structurally (questions, clues, status) but the AI must manually connect clues across pages. The system stores clues as structured `{ clue: string, isFalse: boolean }` but can't retrieve "clues that are semantically similar to the current object."  
**Target:** When a new clue is discovered, retrieve semantically related clues from any point in the story.

**How it works:**

```
Current page: MC finds an old cassette tape.
→ Embed: "cassette tape with handwritten label"
→ Search clue_embeddings
→ Retrieve:
  - Page 12: "Tape recorder in the principal's office"  (0.87)
  - Page 34: "Voice recording of the murder confession"  (0.82)
  - Page 28: "Police evidence log mentions audio evidence"  (0.71)
```

**Benefits:**
- The AI naturally connects clues without explicit prompt engineering
- Mystery threads feel designed, not coincidental
- Reduces "the AI forgot about the tape recorder" issues on page 60+

---

### ⭐⭐⭐⭐☆ USE CASE 5: Scene-of-place semantic recall

**Current:** PlaceMemory stores `keyEvents: PastEvent[]` (capped at `MAX_PLACE_EVENTS = 8`) and `traits`. These are structured, not semantic.  
**Target:** When revisiting a place, retrieve past visits' emotional weight, sensory details, and atmosphere.

**How it works:**

```
MC returns to the hospital basement on page 83.
→ Embed: current hospital basement scene description
→ Search place_embeddings WHERE place_id = 'hospital_basement'
→ Retrieve:
  - Page 35: "The smell of bleach, broken elevator, power outage"  (0.91)
  - Page 41: "Bloody wheelchair, strange humming, cold draft"  (0.88)
  - Page 50: "Struggled with the orderly, knocked over chemical bottles"  (0.76)
```

**Benefits:**
- Places feel lived-in and textured across dozens of revisits
- The AI can describe the hospital basement differently each time while maintaining consistency
- Trauma tags applied to places naturally resurface

---

### ⭐⭐⭐⭐☆ USE CASE 6: Branch-specific semantic isolation

**Current:** Branching is handled by `branchId`. Context is stored in StoryState per branch, but there's no mechanism to prevent cross-branch semantic leakage in memory.  
**Target:** Each branch has its own embedding namespace. Query `WHERE branch_id = 'branch_a' AND book_id = 'book_x'`.

**Benefits:**
- AI never accidentally references events from another branch
- Each alternative fate feels self-contained
- Enables branch-aware retrieval for the multiverse candidate generation system (`generateNextPages`)

---

### ⭐⭐⭐⭐☆ USE CASE 7: AI self-consistency (style retrieval)

**Current:** Writing style is maintained only through the system prompt and `NarrativeStyle.instructions`.  
**Target:** Before generating a page, retrieve the last 3-5 pages from the same branch to serve as style anchors. Also retrieve pages with similar `sceneType`/`mood` combos to ensure consistent pacing and prose texture.

**How it works:**

```
Before writing a "horror" sceneType page:
→ Retrieve past pages with sceneType = 'horror'
→ The AI sees how it previously described fear, tension, and sensory detail
→ Prose stays consistent with earlier horror scenes
```

**Benefits:**
- The model becomes more stylistically self-consistent
- Reduces "different vibe" complaints across pages with the same scene type
- Especially valuable for long books where the model's "memory" of its own voice decays

---

### ⭐⭐⭐⭐☆ USE CASE 8: Emotional callbacks for finales

**Current:** Near ending, the system sends `Recent Major Events` (last 5) and `contextHistory`. But the most emotionally impactful moments might be from 80+ pages ago.  
**Target:** For finale generation, retrieve the top 30 most important/emotional moments across the entire book. Inject the top 5-7 as thematic anchors.

**Benefits:**
- Endings can reference promises made, betrayals suffered, and clues discovered 100 pages ago
- The final page feels like a genuine culmination, not just "the last generation"
- `viableEnding` outline becomes more achievable because the AI has concrete past events to resolve

---

### ⭐⭐⭐☆☆ USE CASE 9: Book similarity recommendations

**Current:** Recommendations are probably tag-based (`keywords`).  
**Target:** Embed the entire book's `summary` + `hook` + `keywords`. Recommend books by cosine similarity.

**Benefits:**
- Much better than tag matching
- Captures thematic similarity that tags miss
- Low implementation effort (one-time indexing)

---

### ⭐⭐⭐☆☆ USE CASE 10: Image prompt consistency

**Current:** Cover image generation via `generateAndUpdateBookCoverImage` uses story state.  
**Target:** When generating page-level images, retrieve previous visual descriptions for character appearance consistency.

---

## 4. What to Embed

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

// ✅ Good character memory embedding
function buildCharacterEmbeddingText(character: CharacterMemory, interaction: PastInteraction): string {
  return [
    `Character: ${character.knownName} (${character.role})`,
    `Status: ${character.status}`,
    `Interaction: ${interaction.interaction}`,
    `Relationship: ${character.relationshipToMC?.context ?? ''}`,
  ].filter(Boolean).join('\n');
}
```

---

## 5. Architecture — Hybrid Memory

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

## 6. Implementation Phases

### Phase 0 — Foundation (est. 2-3 days)

1. **Enable pgvector on Neon:** One SQL command `CREATE EXTENSION vector;`
2. **Add Drizzle schema** for `page_embeddings`, `character_embeddings`, `future_note_embeddings`, `clue_embeddings`
3. **Create embedding provider abstraction** (`src/services/embeddings.ts`):
   - `embedText(text: string): Promise<number[]>`
   - `embedBatch(texts: string[]): Promise<number[][]>`
   - Provider selection (start with OpenAI `text-embedding-3-small`)
4. **Add Drizzle `pgvector` dependency:** `drizzle-orm` supports `vector` column type via `pg-core`

### Phase 1 — Page embeddings (est. 3-5 days)

1. **Backfill:** Write a script to embed all existing pages for all active books
2. **On page creation:** After `persistPageWithState`, embed the new page and store the embedding
3. **First prompt integration:**
   - In `formatNextPageStoryContextPrompt`, before the `PREVIOUS PAGES` section:
     - Embed the current page's `text` + `keyEvents` + `mood` as the query
     - Retrieve top 5 semantically similar pages from prior pages (same `bookId` + `branchId`)
     - Inject as a `RELEVANT PAST EVENTS` section
4. **Gradually reduce `contextHistory` reliance:** Start by adding vector results *alongside* existing context. Later phases can deprecate `contextHistory` entirely.

### Phase 2 — Character & future note embeddings (est. 3-5 days)

1. On each page generation, also embed character dialogue/interactions and store in `character_embeddings`
2. On each page generation, embed future notes and store in `future_note_embeddings`
3. **Prompt integration:**
   - Replace "send all future notes" with "send top 3-5 future notes by semantic similarity to current page"
   - When `charactersPresent` includes a character, also retrieve their top 2-3 semantically relevant past interactions

### Phase 3 — Clue & place embeddings (est. 2-3 days)

1. Embed clues when added to threads
2. Embed place descriptions when first created and on significant revisits
3. **Prompt integration:**
   - When visiting a place, retrieve top 3 past visits' sensory details
   - When discovering a clue, retrieve related clues from anywhere in the story

### Phase 4 — Finale enhancement (est. 2-3 days)

1. When generating finale pages (`isFinale === true`), retrieve top 10-15 most important/emotional pages across the entire book
2. Inject as thematic anchors in the prompt
3. The AI can now reference promises, betrayals, and clues from across the entire narrative arc

### Phase 5 — Book recommendations (est. 1-2 days)

1. Embed book summaries for all public books
2. Build a `/api/books/:id/similar` endpoint using vector similarity

---

## 7. Code Changes Map

### New files

| File | Purpose |
|---|---|
| `src/services/embeddings.ts` | Embedding provider abstraction, batch embedding, retry logic |
| `src/db/migrations/*-add-pgvector.sql` | Migration to add pgvector extension and tables |
| `src/services/vector-memory.ts` | High-level: embed page, retrieve similar pages, hybrid query builder |
| `src/cron/backfill-embeddings.ts` | One-time backfill script for existing books |

### Modified files

| File | Changes |
|---|---|
| `src/db/schema.ts` | Add `page_embeddings`, `character_embeddings`, `future_note_embeddings`, `clue_embeddings` tables |
| `src/utils/prompt.ts` | In `formatNextPageStoryContextPrompt` (line 2722), add vector retrieval section. In `formatNextPageNarrativePrompt` (line 2789), replace "all future notes" with "relevant future notes" |
| `src/utils/story.ts` | `extractStateDelta` (line 284): add embedding persistence step. `applyStateDelta` (line 476): add embedding cleanup for removed items |
| `src/types/story.ts` | No major type changes needed — embeddings are a separate persistence layer |
| `src/config/story.ts` | Add `MAX_VECTOR_RESULTS_PER_QUERY`, `EMBEDDING_DIMENSIONS`, `EMBEDDING_SIMILARITY_THRESHOLD` |
| `src/config/ai-clients.ts` | Add embedding model configuration |
| `src/services/book.ts` | In `persistPageWithState`: trigger embedding after page persistence |
| `src/services/book-controller.ts` | Serialize embedding results in enriched page response (optional) |

### Config additions (`src/config/story.ts`)

```typescript
export const EMBEDDING_MODEL = 'text-embedding-3-small';
export const EMBEDDING_DIMENSIONS = 1536;
export const MAX_VECTOR_RESULTS_PER_QUERY = 5;
export const MAX_VECTOR_RESULTS_FINALE = 15;
export const EMBEDDING_SIMILARITY_THRESHOLD = 0.5; // 0-1, lower = more results
export const VECTOR_INDEX_TYPE = 'hnsw'; // or 'ivfflat'
```

---

## 8. Changes to Prompt Injection

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

### After pgvector integration

```
CURRENT PHASE
MAIN CHARACTER (POV)
STORY CONTEXT: contextHistory (shorter, 150 words — less critical now)

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

### After pgvector integration

```
FUTURE NOTES RELEVANT TO THIS SCENE (semantic):
- Reveal Room 404 (page 35-40) — hidden experiment log (MAJOR)
- Nurse identity reveal (page 50+) — trigger condition: ...

(All 10 notes below, but bucketed by relevance to current page)

ACTIVE THREADS (with semantic clue retrieval for characters present)
ENDING PLAN
```

---

## 9. Performance & Cost Considerations

### Embedding cost

| Content | Avg tokens/page | Cost per page (text-embedding-3-small @ $0.02/1M) |
|---|---|---|
| Page text embedding | ~200 tokens | ~$0.000004 |
| Page + metadata | ~400 tokens | ~$0.000008 |
| Per book (200 pages) | ~80,000 tokens | ~$0.0016 |
| Query embedding | ~100 tokens | ~$0.000002 |

Total: **~$0.002 per book** for all embeddings. Negligible.

### Query latency

- `pgvector` HNSW index: sub-10ms for 10k+ vectors
- Embedding API call: ~100-300ms per query
- Total added latency per page generation: ~200-500ms

### Index type: HNSW vs IVFFlat

| Index | Build time | Query speed | Accuracy | Recommended for |
|---|---|---|---|---|
| **HNSW** | Slower build | Fastest queries | Highest | Production, many writes |
| **IVFFlat** | Fast build | Slower queries | Lower | Prototyping, few writes |

**Recommendation:** Start with HNSW for all embedding tables. The book size (max 200 pages) means the index is tiny regardless.

### Cache strategy

- Cache embedding results for the current page in memory during generation
- The embedding of the *current* page (before it's persisted) only needs to be computed once per generation
- Batch embedding: if multiple embedding operations are needed per page (page text + character interactions + future notes), batch them into a single API call

---

## 10. Integration into `generateNextPage` / `generateNextPages`

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
    → embedCurrentSceneQuery
    → retrieveSimilarPages (page_embeddings)
    → retrieveRelevantFutureNotes (future_note_embeddings)
    → retrieveCharacterInteractions (character_embeddings, for charactersPresent)
    → retrieveRelatedClues (clue_embeddings, if new clue discovered)
  → buildNextPagePrompt
    → formatNextPageTaskPrompt (unchanged)
    → formatNextPageStoryContextPrompt (MODIFIED: add RELEVANT PAST EVENTS section)
    → formatNextPageNarrativePrompt (MODIFIED: filtered future notes, enriched threads)
  → (rest unchanged)

persistPageWithState (MODIFIED: after save, embed and store vectors)
```

### Persistence hook

After `persistPageWithState` succeeds, fire-and-forget the embedding:

```typescript
// In persistPageWithState or a middleware handler
async function embedPersistedPage(page: PersistedStoryPage, state: StoryState) {
  const embeddingText = buildPageEmbeddingText(page, state);
  const [embedding] = await embedBatch([embeddingText]);
  
  await db.insert(pageEmbeddings).values({
    bookId: page.bookId,
    branchId: page.branchId,
    page: page.page,
    embedding: `[${embedding.join(',')}]`,
    sourceText: embeddingText,
    contentType: 'page',
    sourceId: page.id,
  });
}
```

---

## 11. Risks and Mitigations

| Risk | Mitigation |
|---|---|
| **Embedding API latency** adds ~300ms to page generation | Embed asynchronously after page persistence; query embedding is the only blocking call |
| **Cold start** (first page of new book has no prior embeddings) | Vector retrieval gracefully returns empty results; fall through to existing contextHistory |
| **Embedding drift** (OpenAI changes model, vectors become incompatible) | Pin the model version (`text-embedding-3-small-0125`); regenerate if model changes |
| **Storage growth** (200 pages × 1536 floats × multiple tables) | ~3MB per book for page embeddings alone — negligible on Neon |
| **Branch proliferation** (many branches share similar early pages) | Embed once per page per branch; deduplication via `(bookId, branchId, page)` unique constraint |
| **Vector index maintenance on every page write** | HNSW handles incremental inserts well; no rebuild needed |
| **Accidental future-page retrieval** (embedding query retrieves pages that haven't been read yet) | Always filter `page < currentPage` in the WHERE clause |

---

## 12. Success Metrics

- **Before:** AI can't reference details from more than ~10 pages ago with reliability
- **After:** AI consistently references details from 50+ pages ago when semantically relevant
- **Token savings:** `contextHistory` can be reduced from 300 words to ~100 words (or eliminated)
- **Future note relevance:** Only 3-5 relevant notes sent per prompt instead of all 10
- **Character consistency:** Character dialogue references specific past interactions, not generic patterns
- **Ending quality:** Final pages reference events from across the entire book, not just recent pages

---

## 13. Relationship to Other Roadmap Items

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
  embedding: vector("embedding", { dimensions: 1536 }).notNull(),
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
  const queryEmbedding = await embedText(query);
  
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
  const queryEmbedding = await embedText(query);
  
  return db.execute(sql`
    SELECT source_id, source_text, page,
           1 - (embedding <=> ${queryEmbedding}::vector) AS similarity
    FROM character_embeddings
    WHERE book_id = ${bookId}
      AND branch_id = ${branchId}
      AND source_id = ${characterId}
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
  const queryEmbedding = await embedText(query);
  
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

---

*This document provides a comprehensive blueprint for implementing pgvector-based semantic memory in Twistloom. The recommended approach is to start with Phase 0 + Phase 1 (page embeddings as a replacement for lossy contextHistory), measure the improvement, then progressively add character/future note/clue embeddings.*
