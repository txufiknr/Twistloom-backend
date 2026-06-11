# Twistloom LLM Optimization — Drop-in Patches

Patches are ordered **easiest/lowest-risk first**.
Each patch is self-contained — apply any subset independently.

---

## P0 — Remove Production SSE Chunk Debug Log
**File:** `utils/ai-chat-stream.ts` · **Risk:** None · **Impact:** Throughput ⬆

Every streaming token emits a `console.log`. On a 1 000-token response that's 1 000
synchronous I/O calls inside the hot streaming path. Remove it entirely.

```ts
// BEFORE (line ~207)
console.log(`[${provider}] 🧩 SSE chunk:`, chunk);
controller.enqueue(encoder.encode(createTextChunkEvent(chunk)));

// AFTER
controller.enqueue(encoder.encode(createTextChunkEvent(chunk)));
```

---

## P1 — Prompt Size + TTFT Telemetry
**File:** `utils/ai-chat-stream.ts` · **Risk:** None · **Impact:** Observability ⬆

Without measurements you cannot prioritise anything downstream. Add a tiny
telemetry helper and wire it into `aiStreamSSE`.

### 1-a. New helper file: `utils/prompt-telemetry.ts`

```ts
/**
 * Rough token estimator — assumes ~4 chars per token (GPT-4 average).
 * Good enough for planning; not for billing.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface GenerationTelemetry {
  provider: string;
  model: string;
  context?: string;
  promptChars: number;
  estimatedPromptTokens: number;
  requestStartedAt: number;
  firstTokenAt: number | null;
  completedAt: number | null;
  ttftMs: number | null;
  generationMs: number | null;
}

export function logGenerationTelemetry(t: GenerationTelemetry): void {
  console.log(
    `[telemetry] 📊 ${t.provider}/${t.model}` +
    ` | prompt ~${t.estimatedPromptTokens.toLocaleString()} tokens (${t.promptChars.toLocaleString()} chars)` +
    (t.ttftMs != null ? ` | TTFT ${t.ttftMs}ms` : '') +
    (t.generationMs != null ? ` | gen ${t.generationMs}ms` : '') +
    (t.context ? ` | ctx: ${t.context}` : '')
  );

  // ── TTFT quality gate (for future alerting) ──────────────────────────────
  if (t.ttftMs != null) {
    if      (t.ttftMs < 1000) console.log(`[telemetry] ✅ TTFT EXCELLENT`);
    else if (t.ttftMs < 2000) console.log(`[telemetry] 🟢 TTFT GOOD`);
    else if (t.ttftMs < 3000) console.log(`[telemetry] 🟡 TTFT ACCEPTABLE`);
    else                      console.log(`[telemetry] 🔴 TTFT POOR`);
  }
}
```

### 1-b. Wire into `aiStreamSSE` (inside the inner model loop)

```ts
// Add at the top of the model loop body, just after createStartEvent:
const requestStartedAt = Date.now();
let firstTokenAt: number | null = null;
const promptChars = (options.systemPrompt?.length ?? 0) + prompt.length;

// Inside the chunk loop, on first non-empty chunk:
if (!firstTokenAt && chunk.length > 0) {
  firstTokenAt = Date.now();
}

// After createEndEvent / providerSucceeded = true:
logGenerationTelemetry({
  provider,
  model,
  context: options.context,
  promptChars,
  estimatedPromptTokens: estimateTokens((options.systemPrompt ?? '') + prompt),
  requestStartedAt,
  firstTokenAt,
  completedAt: Date.now(),
  ttftMs: firstTokenAt ? firstTokenAt - requestStartedAt : null,
  generationMs: firstTokenAt ? Date.now() - firstTokenAt : null,
});
```

### 1-c. Wire into `executePromptForJSON` (`utils/prompt.ts`)

```ts
// At the top of executePromptForJSON, before calling aiPrompt:
const _promptStart = Date.now();
const _totalPromptChars = finalPrompt.length + (configs.baseOptions?.systemPrompt?.length ?? PROMPT_SYSTEM.length);
console.log(
  `[executePromptForJSON] 📏 Prompt size: ~${estimateTokens(_totalPromptChars).toLocaleString()} tokens` +
  ` (${_totalPromptChars.toLocaleString()} chars) | context: ${configs.baseOptions?.context ?? 'unknown'}`
);
```

---

## P2 — Fix Gemini `systemInstruction` Field
**File:** `utils/ai-chat-stream.ts` · **Risk:** Low · **Impact:** Cache hits ⬆⬆ + correctness

Gemini has a dedicated `systemInstruction` field. When you concatenate the system
prompt into `contents[0].parts[0].text`, you:
- Prevent Gemini's automatic system-message caching
- Lose the semantic separation the model expects
- Break any future explicit `ai.caches.create()` integration

```ts
// BEFORE — in geminiStreamGenerator
const systemPromptWithDocuments = formatSystemPromptWithDocuments('gemini', options);
const response = await getGeminiClient().models.generateContentStream({
  model: options.models?.[0] || 'gemini-2.5-flash',
  contents: [{ parts: [{ text: `${systemPromptWithDocuments}\n\n${prompt}` }] }],
  config: { ...config, responseSchema } satisfies GenerateContentConfig,
});

// AFTER
const systemPromptWithDocuments = formatSystemPromptWithDocuments('gemini', options);
const response = await getGeminiClient().models.generateContentStream({
  model: options.models?.[0] || 'gemini-2.5-flash',
  // System prompt in its own field — Gemini caches this automatically
  systemInstruction: { parts: [{ text: systemPromptWithDocuments }] },
  contents: [{ parts: [{ text: prompt }] }],
  config: { ...config, responseSchema } satisfies GenerateContentConfig,
});
```

Apply the same fix to the non-streaming Gemini call in `ai-chat.ts` (wherever
`geminiPrompt` or similar is defined).

---

## P3 — Remove Duplicate Schema from Prompt Text
**File:** `utils/prompt.ts` · **Risk:** Low · **Impact:** ~1 000–2 000 tokens saved per request

`executePromptForJSON` sends the JSON schema **twice**:
1. As readable text via `outputFormatPart` appended to the prompt.
2. As a structured API parameter via `outputJsonStructure` (passed to each provider
   that supports it natively — GitHub, Groq, Cerebras, Mistral, Gemini).

For providers that already receive the schema as a structured parameter, the text
copy is pure waste. Use a shorter "field names only" hint instead.

```ts
// In executePromptForJSON, replace the current outputFormatPart logic:

const supportsStructuredOutput = Boolean(
  configs.baseOptions?.config &&          // has config
  configs.requiredFields?.length           // schema is specified
);

// When structured output is active, send only a compact field-list reminder
// instead of the full verbose JSON template. Saves ~1 000–2 000 tokens.
const outputFormatPart = supportsStructuredOutput
  ? `OUTPUT FORMAT: Respond with valid JSON matching the schema provided.
Required fields: ${configs.requiredFields.join(', ')}`
  : `OUTPUT FORMAT (JSON):\n${jsonStructure.trim()}`;

// Everything else in executePromptForJSON stays the same.
```

> **Note:** Keep the full `jsonStructure` text for Cohere and NVIDIA which have limited
> structured-output support. You can check `configs.baseOptions?.modelSelection` to
> decide, or just let this be a flag on `AIPromptForJsonParams`.

---

## P4 — Move Static Rules into System Prompt (Stable Prefix)
**File:** `utils/prompt.ts` · **Risk:** Medium (test generation quality) · **Impact:** Cache hits ⬆⬆⬆

This is the most impactful architectural patch.

**The problem:** `RULES_ROUTE_MEMORY`, `RULES_FUTURE_NOTES`, `RULES_STORY_CONSISTENCY`,
and `RULES_DIFFICULTY_SCALING` are four large static string constants currently
injected deep inside `formatNextPageNarrativePrompt()` — which runs AFTER all dynamic
content (psychological flags, hidden state, threads, ending plan). 

Since prompt caching works by matching the **prefix**, any dynamic content before
these rules breaks their cacheability. Moving all static rules into the **system prompt**
fixes this entirely. The system prompt is the same across all story pages (and with P2
applied, Gemini caches it at the session level).

```ts
// In prompt.ts, update buildSystemPrompt:

function buildSystemPrompt(book?: Book, state?: StoryState): { systemPrompt: string, documents: AIDocument[] } {

  // Assemble all STATIC content into the system prompt so providers
  // can cache it once and reuse across every page generation.
  const staticRules = [
    RULES_ROUTE_MEMORY,
    RULES_STORY_CONSISTENCY,
    RULES_DIFFICULTY_SCALING,
    // RULES_FUTURE_NOTES is tiny — include it too
    RULES_FUTURE_NOTES,
  ].join('\n\n---\n');

  const systemPrompt = `${PROMPT_SYSTEM}\n\n---\n${staticRules}`;

  return {
    systemPrompt,
    documents: buildBookMetaDocuments(book, state)
  };
}
```

Then in `formatNextPageNarrativePrompt`, **remove** the four rules injections:

```ts
function formatNextPageNarrativePrompt(params: BuildNextPagePromptParams): string {
  const { advancedState: state } = params;
  const { flags, psychologicalProfile, hiddenState, threads, memoryIntegrity, futureNotes } = state;
  const stateInfo = getStoryStateInfo(state);
  const { currentPage, phase } = stateInfo;

  // REMOVED: RULES_ROUTE_MEMORY, RULES_FUTURE_NOTES, RULES_STORY_CONSISTENCY, RULES_DIFFICULTY_SCALING
  // (now in system prompt — see buildSystemPrompt)

  return `NARRATIVE STYLE & PROSE ATMOSPHERE:
${createNarrativeStyle(state).instructions}

PSYCHOLOGICAL FLAGS (Accumulated):
${formatPsychologicalFlags(flags, memoryIntegrity)}

PSYCHOLOGICAL PROFILE (Structured behavioral analysis):
${formatPsychologicalProfile(psychologicalProfile)}

Goal: Make the MC feel "This story knows exactly how I think and is using it against me."

HIDDEN STATE (Influence writing, don't reveal):
${formatHiddenState(hiddenState, currentPage)}

ROUTE MEMORY (Influence writing, don't reveal):
${formatRouteContext(state)}

FUTURE NOTES:
${formatFutureNotes(futureNotes, currentPage, phase)}

---
${formatThreadsPrompt(threads, stateInfo)}

---
${formatEndingPrompt(state)}`;
}
```

> **Why this matters for non-Gemini providers:** Groq, Cerebras, GitHub, Mistral, NVIDIA
> all do automatic prompt caching on the system message. Once cached, every subsequent
> request that uses the same system prompt skips re-processing those ~800 tokens of rules.
> With P2 (Gemini fix) applied as well, all 7 providers benefit simultaneously.

---

## P5 — Move JSON Schema to System Prompt (Static Prefix Completion)
**File:** `utils/prompt.ts` · **Risk:** Medium · **Impact:** Cache hits ⬆⬆ + token savings

`nextPageOutputFormat` is a pure static string (its interpolated values like `MAX_WORDS_PER_PAGE`
are module-level constants, resolved once at import time). It's ~800–1 200 chars.
Currently it lands at the VERY END of the user message via `executePromptForJSON`, which
makes it impossible to cache.

Two-step approach:

### 5-a. Export format constants that `executePromptForJSON` can inject

```ts
// In prompt.ts, add near the top of the file (after format string definitions):

/**
 * Pre-compiled static strings for the system prompt.
 * These are evaluated once at module load — all interpolated values
 * (MAX_WORDS_PER_PAGE, moods, etc.) are module-level constants.
 */
export const NEXT_PAGE_OUTPUT_FORMAT_STATIC = nextPageOutputFormat;
export const FIRST_BOOK_OUTPUT_FORMAT_STATIC = firstBookOutputFormat;
```

### 5-b. Append schemas to system prompt in `buildSystemPrompt`

```ts
// In buildSystemPrompt, for next-page generation context,
// include the schema as part of the static system prompt block:

function buildSystemPrompt(
  book?: Book,
  state?: StoryState,
  includeSchema?: 'next-page' | 'book-creation'
): { systemPrompt: string, documents: AIDocument[] } {

  const staticRules = [
    RULES_ROUTE_MEMORY,
    RULES_STORY_CONSISTENCY,
    RULES_DIFFICULTY_SCALING,
    RULES_FUTURE_NOTES,
  ].join('\n\n---\n');

  const schema = includeSchema === 'next-page'
    ? `\n\n---\nEXPECTED JSON OUTPUT FORMAT:\n${NEXT_PAGE_OUTPUT_FORMAT_STATIC}`
    : includeSchema === 'book-creation'
    ? `\n\n---\nEXPECTED JSON OUTPUT FORMAT:\n${FIRST_BOOK_OUTPUT_FORMAT_STATIC}`
    : '';

  const systemPrompt = `${PROMPT_SYSTEM}\n\n---\n${staticRules}${schema}`;

  return {
    systemPrompt,
    documents: buildBookMetaDocuments(book, state)
  };
}
```

Then in `prepareNextPageGenerationSetup` pass `'next-page'` to `buildSystemPrompt`:

```ts
const { systemPrompt, documents } = buildSystemPrompt(book, advancedState, 'next-page');
```

And in `executePromptForJSON`, gate `outputFormatPart` to only render when the schema
was NOT already placed in the system prompt:

```ts
// Add an option to AIPromptForJsonParams:
// schemaInSystemPrompt?: boolean

const outputFormatPart = params.schemaInSystemPrompt
  ? ''  // Already in system prompt — skip redundant text
  : `OUTPUT FORMAT (JSON):\n${jsonStructure.trim()}`;
```

> With P3 + P5 combined, the user message shrinks by ~1 500–3 000 tokens on every
> story page request. Over a 40-page story with 3 candidates each, that's 180 000+
> fewer tokens processed.

---

## P6 — Active Character Relevance Filter
**File:** `utils/prompt.ts` · **Risk:** Low–Medium · **Impact:** Token reduction ✂️ for long stories

As the story progresses, `state.characters` accumulates characters who may no longer
appear in the active narrative. All of them are currently formatted and sent every
generation. A simple filter keeps only characters that are: currently present in the
scene, referenced in recent pages or facts, or have `isMissing = true` / active
`narrativeFlags`.

```ts
/**
 * Filters the character map to only characters relevant to the current generation.
 * 
 * "Relevant" means at least one of:
 * 1. Present in the current page's charactersPresent list
 * 2. Introduced recently (within last N pages)
 * 3. Have an active narrative flag (suspicious, missing, has secret)
 * 4. Appear in recent plot flags by name
 * 
 * Archives the rest to Cold Memory — they're still in state.characters
 * but just not sent to the model this turn.
 */
export function filterRelevantCharacters(
  characters: Record<string, CharacterMemory>,
  currentPage: CandidateGenerationPage,
  state: StoryState,
  recentPageCount: number = 5,
): Record<string, CharacterMemory> {
  const recentPageThreshold = state.page - recentPageCount;
  const presentNames = new Set(currentPage.charactersPresent ?? []);

  // Collect names mentioned in recent plot flags
  const recentFlagText = state.plotFlags
    .filter(f => f.page >= recentPageThreshold)
    .map(f => f.fact)
    .join(' ');

  return Object.fromEntries(
    Object.entries(characters).filter(([name, char]) => {
      if (presentNames.has(name)) return true;
      if ((char.introducedAtPage ?? 0) >= recentPageThreshold) return true;
      if (char.narrativeFlags?.isMissing) return true;
      if (char.narrativeFlags?.isSuspicious) return true;
      if (char.narrativeFlags?.hasSecret) return true;
      if (char.status === 'active') return true;
      // Name appears in recent plot flags
      if (recentFlagText.includes(name)) return true;
      return false;
    })
  );
}
```

Usage in `formatNextPageStoryContextPrompt` (or wherever character data is formatted
for the prompt): replace `state.characters` with `filterRelevantCharacters(...)`.

---

## P7 — Gemini Explicit Context Cache (Per-Story)
**File:** new `utils/gemini-cache.ts` + `utils/prompt.ts` · **Risk:** Medium-High · **Impact:** TTFT ⬇⬇ for Gemini

This requires P2 (correct systemInstruction field) to be applied first.

Gemini's explicit caching lets you pre-upload the stable prefix of a prompt and reuse it
across many requests. For Twistloom, the ideal cache per story contains:
- System prompt (persona + rules + schema)
- Book-level semi-static context (theme, MC base bio, world summary)

The cache survives ~60 minutes by default (configurable up to 24h), making it ideal for
active reading sessions.

### 7-a. Cache manager

```ts
// utils/gemini-cache.ts
import { getGeminiClient } from './ai-clients.js';

interface GeminiCacheEntry {
  cacheId: string;         // Gemini cache resource name
  prefixHash: string;      // SHA-256 of the cached content
  createdAt: number;       // Unix ms
  expiresAt: number;       // Unix ms
}

// In-memory cache store (replace with Redis for multi-process setups)
const storyCacheMap = new Map<string, GeminiCacheEntry>();

const CACHE_TTL_SECONDS = 3600; // 1 hour

/**
 * Returns a stable hash of the content that will be cached.
 * If the hash changes (e.g. story summary updated), we invalidate.
 */
function hashContent(content: string): string {
  // Simple djb2 hash — good enough for cache key comparison.
  // Replace with crypto.createHash('sha256') if you want collision safety.
  let h = 5381;
  for (let i = 0; i < content.length; i++) {
    h = (h * 33) ^ content.charCodeAt(i);
  }
  return (h >>> 0).toString(16);
}

/**
 * Gets or creates a Gemini explicit cache for the given storyId.
 * The cache contains system instructions + semi-static story context.
 * 
 * Returns the cache name to pass as `cachedContent` in generateContent calls.
 */
export async function getOrCreateGeminiCache(
  storyId: string,
  model: string,
  systemInstruction: string,
  semiStaticContext: string,   // book summary, MC base info, world summary
): Promise<string | null> {
  const prefixContent = systemInstruction + semiStaticContext;
  const prefixHash = hashContent(prefixContent);
  const now = Date.now();

  const existing = storyCacheMap.get(storyId);
  if (existing && existing.prefixHash === prefixHash && existing.expiresAt > now + 60_000) {
    // Cache is valid — reuse it
    return existing.cacheId;
  }

  // Gemini requires minimum ~1 024 tokens to cache (32k chars is a safe lower bound)
  // If our prefix is too short, explicit caching won't engage — skip it gracefully.
  if (prefixContent.length < 8_000) {
    return null;
  }

  try {
    const ai = getGeminiClient();
    const cache = await ai.caches.create({
      model,
      config: {
        ttl: `${CACHE_TTL_SECONDS}s`,
        systemInstruction: { parts: [{ text: systemInstruction }] },
        contents: [{
          role: 'user',
          parts: [{ text: semiStaticContext }],
        }],
      },
    });

    if (!cache.name) return null;

    storyCacheMap.set(storyId, {
      cacheId: cache.name,
      prefixHash,
      createdAt: now,
      expiresAt: now + CACHE_TTL_SECONDS * 1000,
    });

    console.log(`[gemini-cache] 💾 Created cache for story ${storyId}: ${cache.name}`);
    return cache.name;

  } catch (err) {
    // Non-fatal — fall back to regular request
    console.warn(`[gemini-cache] ⚠️ Failed to create cache:`, err);
    return null;
  }
}

export function invalidateGeminiCache(storyId: string): void {
  storyCacheMap.delete(storyId);
}
```

### 7-b. Use cache in geminiStreamGenerator

```ts
// In geminiStreamGenerator, after building systemPromptWithDocuments and prompt:

// Build the semi-static portion (book summary + MC base — NOT recent pages or action)
const semiStaticContext = buildGeminiSemiStaticContext(options); // you define this helper

const cachedContent = await getOrCreateGeminiCache(
  options.storyId ?? '',          // pass storyId through options
  options.models?.[0] ?? 'gemini-2.5-flash',
  systemPromptWithDocuments,
  semiStaticContext,
);

const response = await getGeminiClient().models.generateContentStream(
  cachedContent
    ? {
        // Cache hit path — send only the dynamic suffix
        model: options.models?.[0] || 'gemini-2.5-flash',
        cachedContent,
        contents: [{ parts: [{ text: prompt /* dynamic only */ }] }],
        config: { ...config, responseSchema },
      }
    : {
        // Cache miss path — full request
        model: options.models?.[0] || 'gemini-2.5-flash',
        systemInstruction: { parts: [{ text: systemPromptWithDocuments }] },
        contents: [{ parts: [{ text: prompt }] }],
        config: { ...config, responseSchema },
      }
);
```

---

## Summary Table

| Patch | File(s)              | Risk    | Tokens Saved | TTFT Impact | When to apply        |
|-------|----------------------|---------|--------------|-------------|----------------------|
| P0    | ai-chat-stream.ts    | None    | 0 (IO only)  | ⬆⬆ streaming speed | Immediately          |
| P1    | new + stream + prompt| None    | 0            | Visibility  | Immediately          |
| P2    | ai-chat-stream.ts    | Low     | ~0           | ⬆⬆ Gemini cache | This week            |
| P3    | prompt.ts            | Low     | ~1 500/req   | ⬆           | This week            |
| P4    | prompt.ts            | Medium  | ~0 (cache)   | ⬆⬆⬆ all providers | This week         |
| P5    | prompt.ts            | Medium  | ~1 500/req   | ⬆⬆         | This week            |
| P6    | prompt.ts            | Low-Med | varies (0–3k)| ⬆ late-game | After P4             |
| P7    | new + stream         | Med-High| Gemini only  | ⬆⬆⬆ Gemini | After P2             |
