# Twistloom LLM Optimization — Patches (v2)
> Updated after implementation audit. Patches P0–P5 and P7 are already applied.
> Only remaining work: P6 (character filter) and three new bug fixes.

---

## Applied Patches ✅

| Patch | What | Verified |
|-------|------|---------|
| P0 | Remove per-token debug `console.log` | ✅ Gone |
| P1 | TTFT + prompt size telemetry | ✅ `prompt-telemetry.ts` + `aiStreamSSE` wired |
| P2 | Fix Gemini `systemInstruction` field | ✅ Both streaming and non-streaming |
| P3 | Compact schema for structured-output providers | ✅ 2-line reminder replaces full template |
| P4 | Move static rules → system prompt | ✅ `RULES_PAGE_GENERATION` + `buildSystemPrompt(staticRules)` |
| P5 | Move JSON schema → system prompt | ✅ `options.systemPrompt +=  outputFormatPart` in `executePromptForJSON` |
| P7 | Gemini explicit cache module | ✅ `gemini.ts` built — but see B1 below |

### Bonus (not in original patches)
- `prompt_cache_retention: "24h"` on GitHub non-streaming ✅
- Separate `AI_CHAT_MODELS_EVALUATION` pool ✅
- `convertToGeminiSchema` moved to `gemini.ts` ✅

---

## Bug Fixes Still Needed

### B1 — CRITICAL: Wire `cachedContentId` into story generation calls
**File:** `utils/prompt.ts`

The Gemini cache module is built but `cachedContentId` is never forwarded to the AI call.
It's returned by `buildSystemPrompt` (via `buildBookMetaDocuments`) and spread into
`prepareNextPageGenerationSetup`'s return value — but then silently dropped when
`generateNextPage` and `generateNextPages` destructure without including it.

```ts
// In generateNextPage — current (broken):
const { prompt, config, systemPrompt, documents, fieldInstructions,
        thinkThenOutput, evaluatorPrompt, generationContext,
        advancedState, currentState, expectedPageNumber, action }
  = await prepareNextPageGenerationSetup(params, 1);

// Fix — add cachedContentId to the destructure:
const { prompt, config, systemPrompt, documents, cachedContentId,
        fieldInstructions, thinkThenOutput, evaluatorPrompt, generationContext,
        advancedState, currentState, expectedPageNumber, action }
  = await prepareNextPageGenerationSetup(params, 1);

// Then add to baseOptions:
baseOptions: {
  config,
  modelSelection: AI_CHAT_MODELS_WRITING,
  context: 'story-page-candidate',
  logPrompts: true,
  systemPrompt,
  documents,
  cachedContentId,  // ← add this one line
}
```

Apply the same fix to `generateNextPages` (same destructure pattern around line 3483).

**Impact:** Immediately activates Gemini explicit cache for all story page generation.
Given an active reader session (multiple pages in under 60 minutes), the second page
onward should hit the cache for the semi-static prefix. For a 3-candidate batch this
means ~63% fewer prefix tokens processed on Gemini.

---

### B2 — MEDIUM: Gemini cache entries accumulate without cleanup
**File:** `utils/gemini.ts`

`cachedContentId` encodes `(bookId, characters, places)`. On every page where a character
or place changes, a new entry is written to `contentCacheMap` and a new Gemini cache is
created on Google's servers. Old entries are never cleaned up.

**Fix — add a book-scoped reverse index:**

```ts
// In gemini.ts, add at module level:
const bookCacheIndex = new Map<string, string>(); // bookId → current cachedContentId

// Modify getOrCreateGeminiCache signature to accept optional bookId:
export async function getOrCreateGeminiCache(
  cachedContentId: string,
  model: string,
  systemInstruction: string,
  semiStaticContext: string,
  bookId?: string,           // ← new optional param
): Promise<string | null> {

  // ... existing checks ...

  // Before creating a new cache: clean up the previous one for this book
  if (bookId) {
    const prevId = bookCacheIndex.get(bookId);
    if (prevId && prevId !== cachedContentId) {
      const prev = contentCacheMap.get(prevId);
      if (prev?.cacheId) {
        await getGeminiClient().caches.delete({ name: prev.cacheId }).catch(() => {});
        contentCacheMap.delete(prevId);
      }
    }
  }

  // ... create cache as before ...

  if (bookId) bookCacheIndex.set(bookId, cachedContentId);

  return cache.name;
}
```

Then thread `book.id` from `buildSystemPrompt` all the way through to the
`getOrCreateGeminiCache` call. One approach: add `bookId` as a field in
`AIPromptDocuments` returned by `buildBookMetaDocuments`.

---

### B3 — MINOR: Telemetry `promptChars` misses documents
**File:** `utils/ai-chat-stream.ts` line 185

```ts
// Current (undercounts by 2 000–8 000+ chars):
const promptChars = (options.systemPrompt?.length ?? 0) + prompt.length;

// Fix:
const totalDocumentsLength = options.documents?.reduce(
  (sum, doc) => sum + (doc.title?.length ?? 0) + doc.snippet.length, 0
) ?? 0;
const promptChars = (options.systemPrompt?.length ?? 0) + prompt.length + totalDocumentsLength;
```

---

## Remaining Patch: P6 — Character Relevance Filter
**Status: 📋 Not yet implemented**
**File:** new function in `utils/prompt.ts` (or `utils/characters.ts`)

On long stories with 8+ characters, sending all characters every generation wastes
1 500–4 000 tokens. This filter keeps only characters that are narratively active
right now.

```ts
/**
 * Returns only the characters relevant to the current generation turn.
 * "Relevant" = any of: in current scene, recently introduced, active flags,
 * name appears in recent plot flags.
 * All others are safely omitted — they remain in state.characters for future turns.
 */
export function filterRelevantCharacters(
  characters: Record<string, CharacterMemory>,
  currentPage: CandidateGenerationPage,
  state: StoryState,
  recentPageWindow = 5,
): Record<string, CharacterMemory> {
  const threshold = state.page - recentPageWindow;
  const presentNames = new Set(currentPage.charactersPresent ?? []);
  const recentFlagText = state.plotFlags
    .filter(f => f.page >= threshold)
    .map(f => f.fact)
    .join(' ');

  return Object.fromEntries(
    Object.entries(characters).filter(([name, char]) =>
      presentNames.has(name) ||
      (char.introducedAtPage ?? 0) >= threshold ||
      char.narrativeFlags?.isMissing ||
      char.narrativeFlags?.isSuspicious ||
      char.narrativeFlags?.hasSecret ||
      char.status === 'active' ||
      recentFlagText.includes(name)
    )
  );
}
```

Use in `buildSystemPrompt` (or wherever `buildBookMetaDocuments` calls
`formatCharactersForPrompt`) by filtering `state.characters` before formatting.

---

## Next Optimizations After Bugs Are Fixed

### N1 — Parallel action candidate generation
**File:** wherever `generateNextPages` is called per-action in candidate generation

```ts
// Before (sequential — each action waits):
for (const action of page.actions) {
  await generateNextPages({ ...params, actionedPage: { ...page, action } });
}

// After (parallel — all actions run simultaneously):
await Promise.allSettled(
  page.actions.map(action =>
    generateNextPages({ ...params, actionedPage: { ...page, action } })
  )
);
// Wall-clock: 3× faster for typical 3-action pages
```

### N2 — Persist Gemini cache IDs across serverless cold starts

The current `contentCacheMap` is in-memory. Vercel function instances restart often.
Every cold start recreates the Gemini cache from scratch, wasting one roundtrip.

Store cache metadata in Redis (or a `gemini_caches` DB table):
```ts
{
  bookId: string,
  cachedContentId: string,   // hash of current (chars, places) state
  geminiCacheId: string,     // Gemini resource name like "cachedContents/abc123"
  expiresAt: timestamp,
}
```

On startup, load from Redis instead of starting empty.

### N3 — Non-streaming telemetry for `aiPrompt`

Background candidate generation uses `aiPrompt` (non-streaming), but there's no
TTFT or size logging for it. The wall-clock for background work is currently a
black box.

```ts
// Add to aiPrompt before the provider loop:
const _startAt = Date.now();
const _promptChars = systemPrompt.length + prompt.length + totalDocumentsLength;
console.log(`[${context}] 📏 Non-stream prompt ~${estimateTokens(_promptChars)} tokens`);

// After successful result:
console.log(`[${context}] ⏱ Non-stream total: ${Date.now() - _startAt}ms`);
```
