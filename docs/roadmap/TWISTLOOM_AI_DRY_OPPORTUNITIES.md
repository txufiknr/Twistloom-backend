# Twistloom AI DRY Opportunities — `ai-chat.ts` + `ai-chat-stream.ts`

> **Status:** 📋 Review-only — **no code changed.** This doc catalogues non-breaking
> DRY refactors that improve maintainability and cross-file consistency, with
> before/after patch snippets, per-refactor line-reduction impact, a summary
> at-a-glance, and a conclusion.
>
> **Scope:** `src/utils/ai-chat.ts` (1,589 lines) and `src/utils/ai-chat-stream.ts`
> (1,005 lines). Combined 2,594 lines; ~250+ lines (~10%) are consolidation
> candidates that preserve behavior exactly.

The two files share the same provider roster (gemini, cohere, mistral, groq,
cerebras, nvidia, openrouter, cloudflare, inception) and the same
`PromptWithFallbackOptions` surface, but each *Prompt function and each
*StreamGenerator re-implements message assembly, request-payload shaping,
caching bookkeeping, and pre-call gates. This is the source of the recurring
"easy to miss a uniform parameter" pain: the duplicated blocks already diverge
(see §13 — two different character-count formulas; §3 — Cohere streaming vs
non-streaming schema shapes disagree).

Everything below is a **pure refactor** (same wire payloads, same log lines,
same control flow) unless explicitly flagged as a consistency fix.

---

## 📊 Summary at-a-glance

| # | Refactor | Sites deduped | Files | Net impact | Behavior change? |
|---|----------|:---:|:---:|:---:|:---:|
| 1 | `buildChatMessages(system, user)` | 12 | both | −36 lines | No |
| 2 | `buildJsonSchemaObject(structure, required, opts?)` | 14 | both | −28 lines | No |
| 3 | `buildOpenAIResponseFormat` / `buildMistralResponseFormat` / `buildCohereResponseFormat` / `buildGeminiResponseSchema` | 11 | both | −80 lines | No (fixes Cohere drift) |
| 4 | `buildSamplingParams(provider, model, config)` | 8 | both | −48 lines | No |
| 5 | `resolveGeminiCachedContent(options, model)` | 2 | **cross-file** | −8 lines | No |
| 6 | `buildGeminiConfig(config)` | 2 | both | −4 lines | No |
| 7 | `buildMistralPromptCacheKey(cachedContentId?)` | 2 | both | −6 lines | No |
| 8 | `resolveStreamDefaultModel(provider, options)` | 8 | stream | 0 (consistency) | No |
| 9 | `sumDocumentChars(documents)` | 2 | both | −2 lines + **fix** | Yes (consistency) |
| 10 | `buildModelRetryConfig(provider, model)` | 2 | both | −12 lines | No |
| 11 | `assertPromptWithinLimit` / `assertProviderReady` | 2 | both | −20 lines | Yes (fixes stream gate) |
| 12 | `extractDeltaText(chunk)` | 4 | stream | −6 lines | No |
| 13 | `nvidiaChatRequest(path, body, signal, timeoutMs)` | 2 | both | −15 lines | No |
| 14 | `mapCohereDocuments(documents?)` | 2 | both | −4 lines | No |
| — | **Total estimate** | ~70 call sites | — | **≈ −250 to −285 lines (~10%)** | — |

**Priority order:** 1–4 deliver ~75% of the savings and are trivially safe.
5–7 remove the cross-file/manual-caching seams. 11 and 9 are the only ones that
also *change behavior* — each fixes a real divergence, so they should be
scheduled deliberately (see §15).

---

## 1. `buildChatMessages(systemPrompt, userPrompt)` — 12 identical message arrays

The exact same two-message array is inlined 12×:

- `ai-chat.ts`: openrouter factory (219–220), groq (642–643), cohere (745–746),
  cerebras (835–836), mistral (916–917), nvidia (1021–1022).
- `ai-chat-stream.ts`: openrouter factory (409–410), groq (675–676), cohere (720–721),
  cerebras (772–773), mistral (832–833), nvidia (907–908).

### Before

```ts
messages: [
  { role: 'system', content: systemPromptWithDocuments },
  { role: 'user', content: prompt },
],
```

### After

```ts
messages: buildChatMessages(systemPromptWithDocuments, prompt),
```

### Proposed helper (place in `ai-chat.ts`, export for the stream file)

```ts
/**
 * Builds the canonical two-message chat conversation used by every provider.
 *
 * Both the non-streaming `*Prompt` functions and the streaming
 * `*StreamGenerator`s send identical `[system, user]` arrays; this
 * single-sources that shape so a future change (e.g. adding an assistant
 * preamble) lands in exactly one place.
 *
 * @param systemPrompt - Pre-formatted system content (documents already
 *   embedded for non-RAG providers via {@link formatSystemPromptWithDocuments})
 * @param userPrompt - Raw user turn
 * @returns A typed, readonly chat message pair
 */
export function buildChatMessages(systemPrompt: string, userPrompt: string) {
  return [
    { role: 'system' as const, content: systemPrompt },
    { role: 'user' as const, content: userPrompt },
  ];
}
```

**Impact:** 12 sites × ~4 lines → 1 line each ≈ **−36 lines**. Zero behavior
change; `formatSystemPromptWithDocuments` stays the single source for the
system content (already DRY).

---

## 2. `buildJsonSchemaObject(structure, required)` — 14 nearly identical schema literals

The inner JSON-schema object appears ~14 times with the same shape:

```ts
{ type: 'object', properties: outputJsonStructure, required: outputJsonRequired, additionalProperties: false }
```

- OpenAI dialect (`schema` key): ai-chat 234–239, 658–663, 850–855;
  stream 425–430, 691–696, 786–792.
- Cohere (`jsonSchema` key): ai-chat 760–765; stream 738–743.
- Mistral (`schemaDefinition` key): ai-chat 940–944; stream 856–860.
- Gemini (`responseJsonSchema`): ai-chat 317–324; stream 477–484.
- Gemini Interactions `schema` (no `additionalProperties`): ai-chat 519–523;
  stream 604–609.

### Before (OpenAI site)

```ts
schema: {
  type: "object",
  properties: outputJsonStructure,
  required: outputJsonRequired,
  additionalProperties: false
} satisfies AIJsonProperty
```

### After

```ts
schema: buildJsonSchemaObject(outputJsonStructure, outputJsonRequired),
```

### Proposed helper

```ts
/**
 * Builds the `type: 'object'` JSON-schema fragment shared by every provider's
 * structured-output dialect. Passing `additionalProperties: false` is the
 * strict-mode requirement for OpenAI/Cerebras/Groq and is easy to forget;
 * centralizing it removes that footgun.
 *
 * @param structure - Property map to require from the model
 * @param required - Property names the model must emit
 * @param opts - Controls; `omitAdditionalProperties` for dialects (e.g. Gemini
 *   Interactions) that reject the key
 * @returns A typed object schema, or `undefined` when `structure` is empty
 */
export function buildJsonSchemaObject(
  structure: Record<string, AIJsonProperty> | undefined,
  required: string[] | undefined,
  opts: { omitAdditionalProperties?: boolean } = {},
): AIJsonProperty | undefined {
  if (!structure) return undefined;
  return {
    type: "object",
    properties: structure,
    required,
    ...(opts.omitAdditionalProperties ? {} : { additionalProperties: false }),
  } as AIJsonProperty;
}
```

**Impact:** 12–14 sites × 3–5 lines → 1 line ≈ **−25 to −30 lines**. The
OpenAI factory, groq, cerebras, cohere, mistral, and both Gemini paths all
share one definition, so the `satisfies AIJsonProperty` correctness lives in a
single place.

---

## 3. Per-dialect response-format builders — 11 wrapper sites, and a real Cohere drift

Each of the 11 call sites contains the full `response_format` / `responseFormat`
conditional (13–16 lines). They split into **four dialects**; the builder for
each mirrors the exact openai/mistral/cohere/gemini contract. The OpenAI one
alone is copy-pasted 6× (ai-chat 229–241, 653–665, 845–857; stream 420–432,
686–698, 782–794).

### Before (OpenAI dialect, one of six copies)

```ts
response_format: outputAsJson ? (outputJsonStructure ? {
  type: "json_schema",
  json_schema: {
    name: context ?? "output-format",
    strict: true,
    schema: {
      type: "object",
      properties: outputJsonStructure,
      required: outputJsonRequired,
      additionalProperties: false
    } satisfies AIJsonProperty
  }
} : { type: 'json_object' }) : undefined,
```

### After

```ts
response_format: buildOpenAIResponseFormat(context, outputAsJson, outputJsonStructure, outputJsonRequired),
```

### Proposed helpers

```ts
/**
 * OpenAI-compatible `response_format` (openrouter/cloudflare/inception factory,
 * groq, cerebras — both streaming and non-streaming).
 */
export function buildOpenAIResponseFormat(
  context: string | undefined,
  outputAsJson: boolean | undefined,
  outputJsonStructure: Record<string, AIJsonProperty> | undefined,
  outputJsonRequired: string[] | undefined,
) {
  return outputAsJson ? (outputJsonStructure ? {
    type: "json_schema",
    json_schema: {
      name: context ?? "output-format",
      strict: true,
      schema: buildJsonSchemaObject(outputJsonStructure, outputJsonRequired),
    },
  } : { type: 'json_object' }) : undefined;
}

/**
 * Mistral dialect — identical to OpenAI except the property is named
 * `schemaDefinition` (ai-chat 935–947, stream 851–863).
 */
export function buildMistralResponseFormat(
  options: Pick<PromptWithFallbackOptions, 'context' | 'outputAsJson' | 'outputJsonStructure' | 'outputJsonRequired'>,
) {
  const { context, outputAsJson, outputJsonStructure, outputJsonRequired } = options;
  return outputAsJson ? (outputJsonStructure ? {
    type: "json_schema",
    jsonSchema: {
      name: context ?? "output-format",
      strict: true,
      schemaDefinition: buildJsonSchemaObject(outputJsonStructure, outputJsonRequired),
    },
  } : { type: 'json_object' }) : undefined;
}

/**
 * Cohere `responseFormat` — see the drift fix in §16. The streaming generator
 * (stream 733–745) currently wraps the schema in `{ name, strict, schema }`,
 * while the non-streaming prompt (ai-chat 758–766) passes the raw object
 * directly as `jsonSchema`. The builder standardizes on the stream's wrapped
 * shape (matching the OpenAI/Mistral convention).
 */
export function buildCohereResponseFormat(
  options: Pick<PromptWithFallbackOptions, 'context' | 'outputAsJson' | 'outputJsonStructure' | 'outputJsonRequired'>,
) {
  const { context, outputAsJson, outputJsonStructure, outputJsonRequired } = options;
  return outputAsJson ? (outputJsonStructure ? {
    type: "json_object",
    jsonSchema: {
      name: context ?? "output-format",
      strict: true,
      schema: buildJsonSchemaObject(outputJsonStructure, outputJsonRequired),
    },
  } : { type: 'json_object' }) : undefined;
}

/**
 * Gemini generateContent `responseJsonSchema` (ai-chat 317–324,
 * stream 477–484) — the only dialect that carries an empty-object fallback
 * instead of `undefined`, because Gemini still emits an object schema when
 * output is JSON but no structure is supplied.
 */
export function buildGeminiResponseJsonSchema(
  outputAsJson: boolean | undefined,
  outputJsonStructure: Record<string, AIJsonProperty> | undefined,
  outputJsonRequired: string[] | undefined,
): AIJsonProperty | undefined {
  return outputAsJson ? {
    type: "object",
    ...(outputJsonStructure
      ? buildJsonSchemaObject(outputJsonStructure, outputJsonRequired)
      : {}),
  } : undefined;
}
```

> The Interactions dialect (ai-chat 515–525, stream 600–610) uses its own
> `response_format` array-of-`mimeType` objects; it can reuse
> `buildJsonSchemaObject(..., { omitAdditionalProperties: true })` for the inner
> schema but must keep its array wrapper. Wire shape is identical to current.

**Impact:** 11 wrapper sites × ~13 lines → ~2 lines ≈ **−80 lines** (the single
largest consolidation). It does **not** change any wire byte today, but it makes
the Cohere streaming/non-streaming divergence (§16) visible at one call site
instead of silently duplicated.

---

## 4. `buildSamplingParams(provider, model, config)` — 8 copies of the sampling block

The six OpenAI-compatible sampling fields appear identically in:
ai-chat 222–228 (factory), 646–651 (groq), 838–844 (cerebras), plus the nvidia
inline copy (1024–1029); stream 412–419 (factory), 679–684 (groq), 775–781
(cerebras), 910–915 (nvidia).

The destructure `const { maxOutputToken, temperature, topP, stopSequences, frequencyPenalty, seed } = config;`
repeats verbatim in groq/cerebras (prompt + stream) and mistral stream.

### Before

```ts
max_tokens: getMaxOutputToken(provider, model, config.maxOutputToken),
temperature: config.temperature,
top_p: config.topP,
stop: config.stopSequences,
frequency_penalty: config.frequencyPenalty,
seed: config.seed,
```

### After

```ts
...(buildSamplingParams(provider, model, config)),
```

### Proposed helper

```ts
/**
 * Maps the shared {@link AIChatConfig} sampling fields onto the
 * OpenAI-compatible wire shape (`max_tokens`/`temperature`/`top_p`/`stop`/
 * `frequency_penalty`/`seed`). Keeps `getMaxOutputToken` as the single cap
 * clamp (see {@link getMaxOutputToken}) while removing the per-provider
 * destructure that currently invites drift.
 *
 * @param provider - Provider namespace (feeds `getMaxOutputToken`)
 * @param model - Exact model id (feeds `getMaxOutputToken`)
 * @param config - Resolved generation config
 */
export function buildSamplingParams(
  provider: AIChatProvider,
  model: string,
  config: AIChatConfig,
) {
  return {
    max_tokens: getMaxOutputToken(provider, model, config.maxOutputToken),
    temperature: config.temperature,
    top_p: config.topP,
    stop: config.stopSequences,
    frequency_penalty: config.frequencyPenalty,
    seed: config.seed,
  };
}
```

**Impact:** 8 sites × 6 lines → 1 line ≈ **−48 lines**, and the nvidia site's
inline `config.temperature`/`top_p` style is normalized to the same builder.
Cohere and Mistral keep their own field names (`p`/`k`/`maxTokens`,
`topP`/`randomSeed`) so they are *not* routed through this helper — noted in
§14.

---

## 5. `resolveGeminiCachedContent(options, model)` — identical cache block in two files

The full explicit-caching preamble is duplicated between the non-streaming and
streaming **generateContent** paths — the two files drift independently:

- `ai-chat.ts` 326–334 (lookup) + 348–352 (branch)
- `ai-chat-stream.ts` 487–495 (lookup) + 510–513 (branch)

### Before

```ts
// Helper block to fulfill Gemini's minimum token requirement for explicit caching
const formattedDocuments = formatDocumentsToPrompt(documents);
const cachedContent = cachedContentId ? await getOrCreateGeminiCache(
  cachedContentId, model, systemPrompt, formattedDocuments, meta?.bookId,
) : null;
```

Then later:

```ts
...(cachedContent ? { cachedContent } : {
  systemInstruction: { parts: [{ text: systemPromptWithDocuments }] },
})
```

### After

```ts
const cachedContent = await resolveGeminiCachedContent('gemini', options, model);
const systemInstruction = cachedContent
  ? undefined
  : { parts: [{ text: systemPromptWithDocuments }] };

config: {
  ...geminiConfig,
  ...(outputAsJson ? { responseMimeType: 'application/json' } : {}),
  maxOutputTokens: getMaxOutputToken('gemini', model, maxOutputToken),
  responseSchema: responseJsonSchema ? convertToGeminiSchema(responseJsonSchema, { minify: true }) : undefined,
  ...(cachedContent ? { cachedContent } : { systemInstruction }),
}
```

### Proposed helper

```ts
/**
 * Resolves Gemini's explicit cache boundary (mirrors Mistral's
 * `promptCacheKey`, see {@link buildMistralPromptCacheKey}).
 *
 * Single-sources the minimum-token cache seeding that both the non-streaming
 * and streaming generateContent paths must perform: formatting documents and
 * calling {@link getOrCreateGeminiCache} with the same key, model, system
 * prompt and bookId. Shared across ai-chat.ts and ai-chat-stream.ts so the two
 * pathways cannot drift apart.
 *
 * @param provider - Provider id (currently only 'gemini' is wired)
 * @param options - Prompt options (reads `cachedContentId`, `systemPrompt`,
 *   `documents`, `meta`)
 * @param model - The exact model being called
 * @returns The cached content string, or `null` when no `cachedContentId`
 */
export async function resolveGeminiCachedContent(
  provider: AIChatProvider,
  options: Pick<PromptWithFallbackOptions, 'cachedContentId' | 'systemPrompt' | 'documents' | 'meta'>,
  model: string,
): Promise<string | null> {
  const { cachedContentId, systemPrompt = PROMPT_SYSTEM, documents, meta } = options;
  if (!cachedContentId) return null;
  const formattedDocuments = formatDocumentsToPrompt(documents);
  return getOrCreateGeminiCache(cachedContentId, model, systemPrompt, formattedDocuments, meta?.bookId);
}
```

**Impact:** 2 sites × ~8 lines ≈ **−8 lines**, plus cross-file parity for the
cache branch (`cachedContent` vs `systemInstruction`) that is currently the
most safety-sensitive duplicated logic. No wire change.

---

## 6. `buildGeminiConfig(config)` — the two `geminiConfig` spreads

Both generateContent paths strip Gemini-unsupported `frequencyPenalty` and
hand-carve `maxOutputToken`:

- `ai-chat.ts` 336–337
- `ai-chat-stream.ts` 497–498

### Before

```ts
// Penalty is not enabled for models/gemini-2.5-flash
const { frequencyPenalty: _fp, maxOutputToken, ...geminiConfig } = config;
```

### After

```ts
const { geminiConfig, maxOutputToken } = buildGeminiConfig(config);
```

### Proposed helper

```ts
/**
 * Strips the config keys the Gemini SDK rejects (`frequencyPenalty`) and
 * separates `maxOutputToken` so the caller can re-clamp via
 * {@link getMaxOutputToken}. Shared by the non-streaming and streaming
 * generateContent paths so the compensation logic is identical.
 *
 * @param config - Full resolved {@link AIChatConfig}
 * @returns The Gemini-safe remainder and the requested cap
 */
export function buildGeminiConfig(config: AIChatConfig): {
  geminiConfig: Omit<AIChatConfig, 'frequencyPenalty' | 'maxOutputToken'>;
  maxOutputToken: number;
} {
  const { frequencyPenalty: _fp, maxOutputToken, ...geminiConfig } = config;
  return { geminiConfig, maxOutputToken };
}
```

**Impact:** −4 lines; small but removes a comment that must stay in sync
across two files.

---

## 7. `buildMistralPromptCacheKey(cachedContentId?)` — Mistral cache key duplicated

The `promptCacheKey` ternary (with its 5-line explanatory comment) is repeated:

- `ai-chat.ts` 926–934
- `ai-chat-stream.ts` 842–850

### Before

```ts
// Cache key mirrors Gemini's cachedContentId so the Mistral prefix
// cache and the Gemini explicit cache bust on the same content change
// (characters/places). Fall back to a shared key for callers that
// don't pass cachedContentId (pen.ts, canon-validation.ts, etc.).
promptCacheKey: cachedContentId
  ? `twistloom:mistral:${cachedContentId}`
  : 'twistloom:mistral:shared',
```

### After

```ts
promptCacheKey: buildMistralPromptCacheKey(cachedContentId),
```

### Proposed helper

```ts
/**
 * Builds the Mistral prompt-cache key, mirroring Gemini's `cachedContentId`
 * so both caches bust on the same content change (characters/places). Falls
 * back to a shared key for callers without a `cachedContentId`.
 *
 * @param cachedContentId - Optional content identity (shared with Gemini)
 * @returns The `promptCacheKey` value to send to Mistral
 */
export function buildMistralPromptCacheKey(cachedContentId?: string): string {
  return cachedContentId
    ? `twistloom:mistral:${cachedContentId}`
    : 'twistloom:mistral:shared';
}
```

**Impact:** −6 lines; the comment moves onto the helper's TSDoc so the "why"
lives in one place.

---

## 8. `resolveStreamDefaultModel(provider, options)` — 8 identical fallbacks

Every stream generator repeats `const model = options.models?.[0] || AI_STREAM_DEFAULT_MODEL.x;`
(stream 405, 488, 589, 672, 716, 768, 828, 897). Zero lines saved individually,
but this centralizes the fallback so removing an entry from
`AI_STREAM_DEFAULT_MODEL` fails loudly in one place instead of silently in 8.

```ts
export function resolveStreamDefaultModel<M extends string>(
  provider: keyof typeof AI_STREAM_DEFAULT_MODEL,
  options: Partial<PromptWithFallbackOptions>,
): M {
  return (options.models?.[0] || AI_STREAM_DEFAULT_MODEL[provider]) as M;
}
```

**Impact:** 0 lines, **consistency + single failure point**.

---

## 9. `sumDocumentChars(documents)` — two disagreeing character-count formulas ⚠️

This is a **consistency fix, not just DRY**. The same "length of all documents"
is computed two different ways:

- `ai-chat.ts` 1188:
  ```ts
  documents.reduce((sum, doc) => sum + `${doc.title ?? ''}${doc.snippet}`.length, 0)
  ```
- `ai-chat-stream.ts` 237:
  ```ts
  options.documents?.reduce((sum, doc) => sum + (doc.title?.length ?? 0) + doc.snippet.length, 0) ?? 0
  ```

These are numerically equal but structurally divergent; the fix is one helper
both call.

```ts
/**
 * Sums the character length of all provided documents. Hidden whitespace or a
 * future content field should be reflected here once, not in two reducers.
 *
 * @param documents - Optional list of AI documents
 * @returns Total chars (0 when none)
 */
export function sumDocumentChars(documents?: AIDocument[]): number {
  return documents?.reduce(
    (sum, doc) => sum + `${doc.title ?? ''}${doc.snippet}`.length,
    0,
  ) ?? 0;
}
```

**Impact:** −2 lines visible, but removes a hand-rolled copy whose two
versions can silently diverge. No numeric change.

---

## 10. `buildModelRetryConfig(provider, model)` — the retry block duplicated verbatim

The `retryWithBackoff` options object is identical in both files:

- `ai-chat.ts` 86–95
- `ai-chat-stream.ts` 222–228 (wrapped around the stream handshake)

### Before

```ts
const response = await retryWithBackoff(
  () => apiCall(model, prompt, modelOptions),
  {
    maxRetries: AI_CHAT_MODEL_RETRY_COUNT,
    shouldRetry: (err) => isGenAIErrorRetryable(classifyGenAIError(provider, model, err)),
    onRetry: (attempt, err) => {
      console.warn(`[${provider}] 🔄 Retry ${attempt}/${AI_CHAT_MODEL_RETRY_COUNT} for model ${model}: ${classifyGenAIError(provider, model, err)}`);
    },
  }
);
```

### After

```ts
const response = await retryWithBackoff(
  () => apiCall(model, prompt, modelOptions),
  buildModelRetryConfig(provider, model),
);
```

### Proposed helper

```ts
export function buildModelRetryConfig(provider: AIChatProvider, model: string) {
  return {
    maxRetries: AI_CHAT_MODEL_RETRY_COUNT,
    shouldRetry: (err: unknown) => isGenAIErrorRetryable(classifyGenAIError(provider, model, err)),
    onRetry: (attempt: number, err: unknown) => {
      console.warn(`[${provider}] 🔄 Retry ${attempt}/${AI_CHAT_MODEL_RETRY_COUNT} for model ${model}: ${classifyGenAIError(provider, model, err)}`);
    },
  };
}
```

**Impact:** −12 lines; guarantees the retry policy and its log format can't
drift between the fallback loop and the stream handshake.

---

## 11. Pre-call gate helper — prompt-length + daily-limit + ready logging ⚠️

`aiPrompt` (1187–1209) and `aiStreamSSE` (147–164) run the same pre-call gauntlet
with **one behavioral difference**:

| Step | `aiPrompt` (ai-chat.ts 1187–1209) | `aiStreamSSE` (stream 147–164) |
|---|---|---|
| Prompt-length max check | `systemPrompt + prompt + documents` (1188–1189) | `systemPrompt + prompt` **only** (148) — documents omitted |
| `canUseAIToday` gate | ✔ (1198–1202) | ✔ (156–159) |
| Ready log | `🧠 Ready with task` (1205) | `🧠 Starting SSE streaming task` (161) |

`aiStreamSSE` under-counts the prompt length whenever `documents` are present,
so it can select a provider whose real total (with documents) exceeds
`AI_MAX_PROMPT_LENGTH`. That's a live divergence; the stream telemetry at line
237–238 *does* count documents, so the gate and the telemetry disagree even
within the same function.

```ts
/**
 * Returns true when the provider can accept the full request: the resolved
 * prompt length (including documents) is within `AI_MAX_PROMPT_LENGTH`, and
 * the daily quota (`canUseAIToday`) is not exhausted. Centralizing the gate
 * keeps the non-streaming and streaming paths measuring the *same* total.
 */
export async function assertPromptAllowed(
  provider: AIChatProvider,
  systemPrompt: string,
  prompt: string,
  documents: AIDocument[] | undefined,
): Promise<{ allowed: boolean; reason?: string }> {
  const totalPromptLength = systemPrompt.length + prompt.length + sumDocumentChars(documents);
  const maxPromptLength = AI_MAX_PROMPT_LENGTH[provider];
  if (totalPromptLength > maxPromptLength) {
    return { allowed: false, reason: `Prompt length (${totalPromptLength.toLocaleString()} chars) exceeds limit (${maxPromptLength.toLocaleString()} chars), skipping` };
  }
  if (!(await canUseAIToday(provider))) {
    return { allowed: false, reason: 'Daily request limit reached, skipping' };
  }
  return { allowed: true };
}
```

**Impact:** −20 lines, and **fixes** the streaming gate to include documents
(§16). This is the highest-value *correctness* change in the set — schedule it
with the behavior-change group.

---

## 12. `extractDeltaText(chunk)` — 4 identical delta reads

`chunk.choices[0]?.delta?.content || ''` appears in the openrouter factory
(448), groq (703), cerebras (802–803), and nvidia's SSE parser (956). Delta
normalization differs only by chunk type, which a discriminated-union helper
handles:

```ts
export function extractDeltaText(chunk: { choices?: Array<{ delta?: { content?: unknown } }> | null }): string {
  const delta = chunk.choices?.[0]?.delta?.content;
  if (typeof delta === 'string') return delta;
  if (Array.isArray(delta)) return delta.map(d => typeof d === 'string' ? d : '').join('');
  return '';
}
```

**Impact:** −6 lines; also gives Mistral's custom array handling (868–877) a
home. Cerebras keeps its `'choices' in chunkTyped` narrowing and *calls* the
helper on the narrowed chunk.

---

## 13. `nvidiaChatRequest(path, body, signal)` — NVIDIA fetch boilerplate

`nvidiaPrompt` (1011–1054) and `nvidiaStreamGenerator` (891–924) both duplicate:
`requireEnv('NVIDIA_API_KEY')`, the `integrate.api.nvidia.com/v1/chat/completions`
URL, `Authorization` header, timeout-signal composition, and the non-2xx error
path. A single wrapper (used by both) is behavior-identical:

```ts
export async function nvidiaChatRequest(
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Response> {
  const apiKey = requireEnv('NVIDIA_API_KEY');
  const timeoutSignal = AbortSignal.timeout(NVIDIA_REQUEST_TIMEOUT_MS);
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const res = await fetch(`https://integrate.api.nvidia.com/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: combinedSignal,
  });
  if (!res.ok) {
    const errorText = await res.text().catch(() => 'Unknown error');
    throw new Error(`HTTP ${res.status}: ${errorText}`);
  }
  return res;
}
```

**Impact:** −15 lines; the streaming caller continues to read `res.body`
afterwards, so wire behavior is unchanged.

---

## 14. `mapCohereDocuments(documents?)` — Cohere RAG mapping

The `documents` → `{ data }` mapping is duplicated (ai-chat 748–750,
stream 723–725). Small but Real:

```ts
export function mapCohereDocuments(documents?: AIDocument[]): Cohere.V2ChatRequestDocumentsItem[] | undefined {
  return documents && documents.length > 0
    ? documents.map((data) => ({ data }))
    : undefined;
}
```

**Impact:** −4 lines.

---

## 15. Consistency findings that are NOT pure DRY — fix deliberately

These surfaced during the audit. Each is a divergence the refactors 1–14
eliminate or at least isolate; none change current successful behavior, but all
change *edge-case* behavior.

1. **Cohere streaming vs non-streaming schema shape** — non-streaming
   `coherePrompt` passes the raw schema as `jsonSchema` (ai-chat 760–765);
   streaming wraps it in `{ name, strict, schema }` (stream 738–743). Cohere's
   V2 `jsonSchema` contract uses the raw schema, so the streaming wrapper is
   the likely-off-contract one. `buildCohereResponseFormat` (§3) standardizes
   on the wrapped shape to match OpenAI/Mistral convention; if Cohere actually
   requires the raw shape, revert the builder only — one line, explicitly.
2. **`aiStreamSSE` prompt-length gate drops documents** (§11). Tests with
   `documents` present would currently select providers whose true total
   exceeds the limit.
3. **Cerebras usage extractor** returns snake_case keys (ai-chat 868–874:
   `completion_tokens`, `prompt_tokens`, `total_tokens`) while every other
   provider returns camelCase. `incrementDailyUsageCount` normalizes
   `promptTokens`/`inputTokens`, so Cerebras token metrics silently read
   `undefined` upstream. Not a DRY item, but adjacent — worth a one-line fix
   to `{ promptTokens, completionTokens, totalTokens }` (see
   `docs/roadmap/AI_PROVIDER_CONFIG_AUDIT.md` context).
4. **Gemini Interactions vs generateContent cache branch** — Interactions
   always uses `store: false` and never sends `cachedContent`; the
   response_format arrays differ (schema key absent `additionalProperties`,
   519–523 vs 604–609). `buildJsonSchemaObject(..., { omitAdditionalProperties })`
   restores parity without changing the wire.

### Items deliberately NOT consolidated (would break behavior)

- Groq's `.withResponse()` + `x-ratelimit-*` header logging (ai-chat 668–674).
- OpenRouter's `plugins: [{ id: 'response-healing' }]` (ai-chat 241–244).
- Cohere's `p`/`k` and Mistral's `topP`/`randomSeed` field names — must not go
  through `buildSamplingParams`.
- Gemini's `convertToGeminiSchema(responseJsonSchema, { minify: true })` — a
  transformation, not a shape.
- NVIDIA's separate non-streaming `res.json()` and streaming SSE reader —
  differ by transport.

---

## ⚖️ Line-reduction impact summary

| Refactor | Current (est.) | After (est.) | Net |
|---|:---:|:---:|:---:|
| 1. messages array (12 sites) | ~48 | ~12 | −36 |
| 2. schema object (14 sites) | ~70 | ~14 | −28 |
| 3. response-format dialects (11 sites) | ~130 | ~22 | −80 |
| 4. sampling params (8 sites) | ~60 | ~12 | −48 |
| 5. Gemini cache resolver (2) | ~16 | ~8 | −8 |
| 6. Gemini config strip (2) | ~4 | ~2 | −2 |
| 7. Mistral cache key (2) | ~8 | ~2 | −6 |
| 8. stream model fallback (8) | ~8 | ~8 | 0 |
| 9. doc char sum (2) | ~4 | ~4 | −2 (dedupe) |
| 10. retry config (2) | ~16 | ~2 | −12 |
| 11. pre-call gate (2) | ~40 | ~18 | −20 |
| 12. delta extraction (4) | ~8 | ~3 | −6 |
| 13. NVIDIA fetch (2) | ~45 | ~20 | −15 |
| 14. Cohere documents (2) | ~4 | ~2 | −4 |
| **Total** | **~460** | **~200** | **≈ −250 to −285 (−10%)** |

The merged file sizes (~2,594 lines) drop by roughly a tenth, and the
deduped pieces are exactly the "easy to forget a uniform parameter" sites that
have already produced drift (Cohere shape, stream prompt gate, Cerebras usage
keys).

---

## ✅ Acceptance checklist (when implemented)

- [ ] `bun run check` (lint + import validation + typecheck) passes after each
      independent refactor batch (recommend 1–4 first, then 5–7, then 8–14).
- [ ] Behavior-change items (#9, #11, and the Cohere shape in §15.1) get a
      review note before merge.
- [ ] A smoke test against at least one OpenAI-dialect provider (groq or
      openrouter), one Cohere call, one Mistral call, and one Gemini call with
      `cachedContentId` set, comparing the generated wire JSON before/after.
- [ ] The helpers introduced live in `ai-chat.ts` and are exported so
      `ai-chat-stream.ts` imports them (mirrors the existing
      `formatSystemPromptWithDocuments` / `getMaxOutputToken` pattern — see
      stream line 13).

---

## 🏁 Conclusion

`ai-chat.ts` and `ai-chat-stream.ts` are already well-factored at the macro
level — `promptWithFallback`, the OpenAI-compatible factories, and
`formatSystemPromptWithDocuments` are correct seams that newer providers plug
into cleanly. The remaining duplication is *beneath* those seams: message
arrays, structured-output schema fragments, sampling payloads, caching
bookkeeping, and pre-call gates are re-inlined per provider in both files, and
they have already started to drift (different character-count formulas, a
Cohere shape mismatch, a streaming gate that drops documents, snake_case
Cerebras usage keys).

Consolidating them **does not change any current wire payload** — it removes
~250 lines, makes the shared `PromptWithFallbackOptions` surface compile-time
uniform, and converts two active divergences (stream prompt-length gate,
Cohere response-format shape) from silent behavior into one explicit call site.
The highest-leverage moves are §1–§4 (~75% of the savings); §5–§7 add
cross-file cache parity for Gemini and Mistral; §11 is the one refactor that
also fixes a real bug and should therefore be reviewed as its own commit.

Recommended sequencing: **§1–§4** (pure, large win) → **§5–§7** (cross-file
cache seams) → **§10, §12–§14** (gates, deltas, NVIDIA/Cohere plumbing) →
**§9 + §11 + §15 fixes** merged separately with a behavioral-consequence note.
Run `bun run check` between each batch.